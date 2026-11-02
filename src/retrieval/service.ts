import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { QdrantDense, retrievalConfigSchema } from "./dense.js";
import { CHUNK_VERSION, hashText } from "./chunks.js";
import { RepositoryIndex, type RepositoryReader } from "./repository-index.js";
import { internalQdrantFetch } from "./docker-transport.js";
import { sandboxSchema } from "../exec/sandbox.js";
type IndexSummary = Awaited<ReturnType<RepositoryIndex["update"]>>;
const indexedWorkspaces = new Map<
  string,
  { scope: string; version: string; generation: number; summary: IndexSummary }
>();
export async function searchRepository(
  root: string,
  repository: string,
  reader: RepositoryReader,
  query: string,
  limit = 10,
  signal?: AbortSignal,
) {
  const configPath = path.join(root, "data", "retrieval.json");
  const config = existsSync(configPath)
    ? retrievalConfigSchema.parse(
        JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, "")),
      )
    : undefined;
  const authorized = process.env.NEWAGENT_ALLOW_EMBEDDING === "1";
  const credential = process.env.NEWAGENT_EMBEDDING_API_KEY;
  let dense: QdrantDense | undefined;
  if (config && authorized && credential) {
    let qdrantFetch = fetch;
    if (config.transport === "docker-internal") {
      const sandbox = sandboxSchema.parse(
        JSON.parse(
          readFileSync(path.join(root, "data", "sandbox.json"), "utf8").replace(
            /^\uFEFF/,
            "",
          ),
        ),
      );
      if (sandbox.mode !== "docker")
        throw new Error(
          "Internal retrieval transport requires Docker image configuration",
        );
      qdrantFetch = internalQdrantFetch(root, sandbox.image);
    }
    dense = new QdrantDense(config, credential, fetch, qdrantFetch);
  }
  const version = `${CHUNK_VERSION}:${config ? hashText(JSON.stringify(config.embedding)) : "keyword"}`;
  const index = new RepositoryIndex(
    path.join(root, "data", "retrieval"),
    repository,
    reader,
    version,
    dense,
    {
      typescriptOnly:
        config?.typescriptOnlyRepositories.includes(repository) ?? false,
    },
  );
  try {
    const updateStartedAt = Date.now();
    const state = reader.indexState?.();
    const cacheKey = `${path.resolve(root)}\0${repository}`;
    const scopeVersion = `${version}:${config?.typescriptOnlyRepositories.includes(repository) ?? false}:${Boolean(dense)}`;
    const previous = indexedWorkspaces.get(cacheKey);
    const reusable =
      state &&
      previous?.scope === state.scope &&
      previous.version === scopeVersion;
    const changed = reusable
      ? [...state.changes]
          .filter(([, generation]) => generation > previous.generation)
          .map(([file]) => file)
      : undefined;
    const indexed =
      reusable && !changed?.length
        ? { ...previous.summary, updated: 0, deleted: 0 }
        : await index.update(signal, false, changed);
    if (state && (!dense || indexed.dense))
      indexedWorkspaces.set(cacheKey, {
        scope: state.scope,
        version: scopeVersion,
        generation: state.generation,
        summary: indexed,
      });
    const indexUpdateMs = Date.now() - updateStartedAt;
    const results = await index.search(query, limit, signal);
    return {
      indexed,
      indexUpdateMs,
      ...results,
      ...(dense
        ? {}
        : {
            reason: !config
              ? "Embedding configuration missing; keyword fallback"
              : !authorized
                ? "Embedding network not authorized; keyword fallback"
                : "Embedding credential missing; keyword fallback",
          }),
    };
  } finally {
    index.close();
  }
}
