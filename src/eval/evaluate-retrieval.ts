import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { profileSchema, type Task } from "../protocol/types.js";
import { TaskExecution } from "../exec/task-execution.js";
import { QdrantDense, retrievalConfigSchema } from "../retrieval/dense.js";
import { internalQdrantFetch } from "../retrieval/docker-transport.js";
import { RepositoryIndex } from "../retrieval/repository-index.js";
import {
  CHUNK_VERSION,
  chunkFile,
  hashText,
  type Chunk,
} from "../retrieval/chunks.js";
import { sandboxSchema } from "../exec/sandbox.js";
import {
  configureLocalRun,
  evaluationRoot,
  localEmbeddingHealth,
  projectRoot,
  readJson,
  saveJson,
} from "./local-environment.js";
import { retrievalQuestions } from "./retrieval-questions.js";
const retrievalBatch =
  process.env.NEWAGENT_RETRIEVAL_BATCH?.trim() || "retrieval-v1";
if (!/^(?:retrieval|ragas-retrieval)-v[1-9][0-9]*$/.test(retrievalBatch))
  throw new Error(
    "NEWAGENT_RETRIEVAL_BATCH must look like retrieval-v2 or ragas-retrieval-v1",
  );
const root = path.join(evaluationRoot, retrievalBatch);
mkdirSync(root, { recursive: true });
if (existsSync(path.join(root, "results.json")))
  throw new Error(
    `Retrieval results already exist at ${root}; choose a new batch name to preserve them`,
  );
configureLocalRun(root);
await localEmbeddingHealth();
const config = retrievalConfigSchema.parse(
  readJson(path.join(root, "data", "retrieval.json")),
);
const sandbox = sandboxSchema.parse(
  readJson(path.join(root, "data", "sandbox.json")),
);
if (sandbox.mode !== "docker")
  throw new Error("Retrieval evaluation requires Docker");
const dense = new QdrantDense(
  config,
  "local-only",
  fetch,
  internalQdrantFetch(root, sandbox.image),
);
const captureContent = process.env.NEWAGENT_RETRIEVAL_CAPTURE_CONTENT === "1";
const retrievalTopK = 10; // Preserve the existing MRR@10 computation; Ragas consumes the first five.
const version = `${CHUNK_VERSION}:${hashText(JSON.stringify(config.embedding))}`;
const results = [];
for (const repository of [
  "mitt",
  "fast-json-stable-stringify",
  "dlv",
] as const) {
  const source = path.join(projectRoot, "upstream", "eval", repository);
  const upstream = z
    .object({ repo: z.string(), sha: z.string().regex(/^[a-f0-9]{40}$/) })
    .parse(readJson(path.join(source, "upstream.json")));
  const sourceRevision = upstream.sha;
  const profile = profileSchema.parse({
    id: `quality-${repository}`,
    source,
    checks: [{ name: "noop", file: "node", args: ["-e", "0"] }],
  });
  const task: Task = {
    id: profile.id,
    profileId: profile.id,
    workspace: source,
    status: "queued",
    round: 0,
    branch: "readonly",
    requirement: "Retrieval evaluation",
    acceptance: ["Read-only"],
    baseRevision: "",
    revision: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const reader = new TaskExecution(root, task, profile, true);
  await reader.preflight();
  const chunks: Chunk[] = [];
  const sourceHash = createHash("sha256");
  for (const file of (await reader.list()).sort()) {
    const content = await reader.read(file);
    sourceHash.update(file.replaceAll("\\", "/") + "\0").update(content).update("\0");
    if (/\.(?:[cm]?[jt]sx?|md|json|ya?ml)$/i.test(file))
      chunks.push(...chunkFile(profile.id, file, content, version));
  }
  const sourceContentHash = sourceHash.digest("hex");
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const matchesTarget = (
    chunk: Chunk,
    question: (typeof retrievalQuestions)[number],
  ) => {
    const acceptableSymbols = ("acceptableSymbols" in question
      ? question.acceptableSymbols
      : undefined) ?? [question.symbol];
    return (
      chunk.path === question.path && acceptableSymbols.includes(chunk.symbol)
    );
  };
  const referenceSourceByQuestion = new Map<string, Chunk>();
  for (const question of retrievalQuestions.filter((q) => q.repository === repository)) {
    const referenceSource = chunks.find((chunk) =>
      matchesTarget(chunk, question),
    );
    if (!referenceSource)
      throw new Error(`Invalid target label: ${question.id}`);
    referenceSourceByQuestion.set(question.id, referenceSource);
  }
  const keyword = new RepositoryIndex(
    path.join(root, "keyword"),
    profile.id,
    reader,
    version,
  );
  const hybrid = new RepositoryIndex(
    path.join(root, "hybrid"),
    profile.id,
    reader,
    version,
    dense,
  );
  try {
    await keyword.update();
    const updated = await hybrid.update();
    const status = z
      .object({ reasons: z.array(z.string()).optional() })
      .passthrough()
      .parse(updated);
    if (status.reasons?.length)
      throw new Error(`Dense indexing failed: ${status.reasons.join(";")}`);
    for (const question of retrievalQuestions.filter(
      (q) => q.repository === repository,
    ))
      for (const mode of ["keyword", "dense", "hybrid"] as const) {
        const started = Date.now();
        const hits =
          mode === "dense"
            ? (await dense.search(question.query, profile.id, retrievalTopK))
                .map((id) => byId.get(id))
                .filter((c): c is Chunk => !!c)
            : (
                await (mode === "keyword" ? keyword : hybrid).search(
                  question.query,
                  retrievalTopK,
                  undefined,
                  [],
                  true,
                )
              ).hits;
        const position = hits.findIndex((chunk) =>
          matchesTarget(chunk, question),
        );
        const referenceSource = referenceSourceByQuestion.get(question.id);
        if (!referenceSource)
          throw new Error(`Reference chunk disappeared for ${question.id}`);
        const record = {
          questionId: question.id,
          repository,
          mode,
          sourceRevision,
          sourceContentHash,
          indexVersion: version,
          retrievalTopK,
          ragasContextTopK: 5,
          referenceSource: {
            path: referenceSource.path,
            symbol: referenceSource.symbol,
            startLine: referenceSource.startLine,
            endLine: referenceSource.endLine,
            indexVersion: referenceSource.indexVersion,
            ...(captureContent ? { content: referenceSource.content } : {}),
          },
          recallAt1: position === 0 ? 1 : 0,
          recallAt5: position >= 0 && position < 5 ? 1 : 0,
          recallAt10: position >= 0 && position < 10 ? 1 : 0,
          mrrAt10: position < 0 ? 0 : 1 / (position + 1),
          latencyMs: Date.now() - started,
          latencyScope:
            mode === "dense"
              ? "Embedding + vector IDs + fixed-corpus metadata lookup; no source reread"
              : "Search + Docker source freshness validation",
          hits: hits.map((c) => ({
            path: c.path,
            symbol: c.symbol,
            startLine: c.startLine,
            endLine: c.endLine,
            indexVersion: c.indexVersion,
            ...(captureContent ? { content: c.content } : {}),
          })),
        };
        results.push(record);
        saveJson(path.join(root, "results.json"), {
          realEmbedding: true,
          humanReviewed: false,
          captureContent,
          ragasContextTopK: 5,
          retrievalTopK,
          sourceRevision,
          ragasBatch: retrievalBatch.startsWith("ragas-retrieval-"),
          scope:
            "Provisional 30-question source-checked labels; human confirmation pending. Small utility repositories with repeated target symbols.",
          embedding: config.embedding,
          questions: retrievalQuestions,
          results,
        });
        console.log(
          JSON.stringify({
            question: question.id,
            mode,
            rank: position + 1,
            latencyMs: record.latencyMs,
          }),
        );
      }
  } finally {
    keyword.close();
    hybrid.close();
  }
}
