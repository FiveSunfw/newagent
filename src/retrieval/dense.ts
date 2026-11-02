import { z } from "zod";
import { hashText, type Chunk } from "./chunks.js";
export const retrievalConfigSchema = z.object({
  typescriptOnlyRepositories: z.array(z.string().min(1)).default([]),
  transport: z.enum(["http", "docker-internal"]).default("docker-internal"),
  qdrant: z
    .url()
    .refine(
      (value) =>
        ["localhost", "127.0.0.1", "[::1]"].includes(new URL(value).hostname),
      "Qdrant must be local",
    ),
  embedding: z.object({
    endpoint: z.url(),
    model: z.string().min(1),
    dimensions: z.number().int().positive().max(8192),
    version: z.string().min(1),
    queryInstruction: z.string().trim().min(1).max(512).optional(),
    timeoutMs: z.number().int().positive().max(180000).default(30000),
  }),
});
export type RetrievalConfig = z.infer<typeof retrievalConfigSchema>;
export interface DenseIndex {
  upsert(chunks: Chunk[], signal?: AbortSignal): Promise<void>;
  remove(ids: string[], signal?: AbortSignal): Promise<void>;
  search(
    query: string,
    repository: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<string[]>;
}
export class QdrantDense implements DenseIndex {
  readonly collection: string;
  private collectionReady = false;
  constructor(
    readonly config: RetrievalConfig,
    private embeddingKey: string | undefined,
    private request = fetch,
    private qdrantRequest = request,
  ) {
    this.collection = `newagent_${hashText(JSON.stringify(config.embedding)).slice(0, 24)}`;
  }
  private async json(
    url: string,
    method: string,
    body: unknown,
    signal?: AbortSignal,
  ) {
    const response = await this.qdrantRequest(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any([
        AbortSignal.timeout(15000),
        ...(signal ? [signal] : []),
      ]),
    });
    if (!response.ok)
      throw new Error(`Qdrant ${method}: HTTP ${response.status}`);
    return response.json();
  }
  private async embeddings(
    texts: string[],
    signal?: AbortSignal,
    query = false,
  ): Promise<number[][]> {
    // The local CPU encoder can time out on 32 padded documents. Keep model
    // requests small while retaining 32-point Qdrant writes.
    if (texts.length > 4) {
      const vectors: number[][] = [];
      for (let start = 0; start < texts.length; start += 4)
        vectors.push(
          ...(await this.embeddings(
            texts.slice(start, start + 4),
            signal,
            query,
          )),
        );
      return vectors;
    }
    if (!this.embeddingKey)
      throw new Error(
        "Embedding credential missing; dense retrieval unavailable",
      );
    const inputs =
      query && this.config.embedding.queryInstruction
        ? texts.map(
            (text) =>
              `Instruct: ${this.config.embedding.queryInstruction}\nQuery: ${text}`,
          )
        : texts;
    const response = await this.request(
      this.config.embedding.endpoint.replace(/\/$/, "") + "/embeddings",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.embeddingKey}`,
        },
        body: JSON.stringify({
          model: this.config.embedding.model,
          input: inputs,
        }),
        signal: AbortSignal.any([
          AbortSignal.timeout(this.config.embedding.timeoutMs),
          ...(signal ? [signal] : []),
        ]),
      },
    );
    if (!response.ok) throw new Error(`Embedding HTTP ${response.status}`);
    const result = z
      .object({
        data: z
          .array(
            z.object({
              index: z.number().int().nonnegative(),
              embedding: z
                .array(z.number().finite())
                .length(this.config.embedding.dimensions),
            }),
          )
          .length(inputs.length),
      })
      .parse(await response.json());
    const ordered = result.data.sort((a, b) => a.index - b.index);
    if (ordered.some((row, index) => row.index !== index))
      throw new Error("Invalid embedding indices");
    return ordered.map((row) => row.embedding);
  }
  async upsert(chunks: Chunk[], signal?: AbortSignal) {
    chunks = chunks.filter((chunk) => chunk.role !== "parent");
    if (!chunks.length) return;
    const collection = `${this.config.qdrant.replace(/\/$/, "")}/collections/${this.collection}`;
    if (!this.collectionReady) {
      const inspected = await this.qdrantRequest(collection, {
        signal: AbortSignal.any([
          AbortSignal.timeout(15000),
          ...(signal ? [signal] : []),
        ]),
      });
      if (inspected.status === 404)
        await this.json(
          collection,
          "PUT",
          {
            vectors: {
              size: this.config.embedding.dimensions,
              distance: "Cosine",
            },
          },
          signal,
        );
      else if (!inspected.ok)
        throw new Error(`Qdrant collection: HTTP ${inspected.status}`);
      this.collectionReady = true;
    }
    for (let index = 0; index < chunks.length; index += 32) {
      const batch = chunks.slice(index, index + 32),
        vectors = await this.embeddings(
          batch.map((chunk) => chunk.content),
          signal,
        );
      await this.json(
        collection + "/points?wait=true",
        "PUT",
        {
          points: batch.map((chunk, i) => ({
            id: chunk.id,
            vector: vectors[i],
            payload: {
              repository: chunk.repository,
              path: chunk.path,
              fileHash: chunk.fileHash,
              indexVersion: chunk.indexVersion,
              symbol: chunk.symbol,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              parentId: chunk.parentId ?? null,
              kind: chunk.kind ?? null,
            },
          })),
        },
        signal,
      );
    }
  }
  async remove(ids: string[], signal?: AbortSignal) {
    if (!ids.length) return;
    await this.json(
      `${this.config.qdrant.replace(/\/$/, "")}/collections/${this.collection}/points/delete?wait=true`,
      "POST",
      { points: ids },
      signal,
    );
  }
  async search(
    query: string,
    repository: string,
    limit: number,
    signal?: AbortSignal,
  ) {
    const [vector] = await this.embeddings([query], signal, true);
    const result = await this.json(
      `${this.config.qdrant.replace(/\/$/, "")}/collections/${this.collection}/points/query`,
      "POST",
      {
        query: vector,
        limit,
        filter: { must: [{ key: "repository", match: { value: repository } }] },
      },
      signal,
    );
    return z
      .object({
        result: z.object({ points: z.array(z.object({ id: z.string() })) }),
      })
      .parse(result)
      .result.points.map((p) => p.id);
  }
}
