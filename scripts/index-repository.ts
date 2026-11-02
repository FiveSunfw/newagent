import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { CHUNK_VERSION, chunkFile, hashText } from "../src/retrieval/chunks.js";
import { QdrantDense, retrievalConfigSchema } from "../src/retrieval/dense.js";
import { internalQdrantFetch } from "../src/retrieval/docker-transport.js";
import { RepositoryIndex } from "../src/retrieval/repository-index.js";
import { inside } from "../src/exec/execution.js";
import { privateEntry } from "../src/exec/snapshot.js";
import { isIndexableFile } from "../src/retrieval/file-selection.js";

// Explicit administrator-only, read-only source preparation. Not an Agent tool.
const [sourceArgument, repository, authorization] = process.argv.slice(2);
if (
  !sourceArgument ||
  !repository ||
  !/^[a-zA-Z0-9_-]+$/.test(repository) ||
  !["--plan", "--allow-local-embedding"].includes(authorization)
)
  throw Error(
    "Usage: index-repository SOURCE REPOSITORY --plan|--allow-local-embedding",
  );
const root = path.resolve(process.env.NEWAGENT_ROOT ?? "..");
const source = realpathSync(sourceArgument);
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: source, encoding: "utf8", windowsHide: true },
)
  .split("\0")
  .filter(Boolean)
  .filter(
    (file) =>
      !file
        .split(/[\\/]/)
        .some((part) => privateEntry(part) || part === ".codegraph") &&
      existsSync(inside(source, file)),
  );
const reader = {
  async list() {
    return [...new Set(files)];
  },
  async read(file: string) {
    return readFileSync(inside(source, file), "utf8");
  },
};
const config = retrievalConfigSchema.parse(
  JSON.parse(
    readFileSync(path.join(root, "data", "retrieval.json"), "utf8").replace(
      /^\uFEFF/,
      "",
    ),
  ),
);
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(
    new URL(config.embedding.endpoint).hostname,
  )
)
  throw Error(
    "This command only authorizes local Embedding; no paid endpoint is allowed",
  );
const version = `${CHUNK_VERSION}:${hashText(JSON.stringify(config.embedding))}`;
const options = {
  typescriptOnly: config.typescriptOnlyRepositories.includes(repository),
};
const manifest: Array<{
  path: string;
  hash: string;
  chunks: Array<{
    id: string;
    symbol: string;
    parentId?: string;
    role?: string;
    kind?: string;
    startLine: number;
    endLine: number;
  }>;
}> = [];
for (const file of await reader.list()) {
  if (!isIndexableFile(file, options)) continue;
  const content = await reader.read(file);
  const chunks = chunkFile(repository, file, content, version);
  manifest.push({
    path: file,
    hash: hashText(content),
    chunks: chunks.map(
      ({ id, symbol, parentId, role, kind, startLine, endLine }) => ({
        id,
        symbol,
        parentId,
        role,
        kind,
        startLine,
        endLine,
      }),
    ),
  });
}
const chunks = manifest.flatMap((file) => file.chunks);
const output = path.join(root, "data", "retrieval", repository);
mkdirSync(output, { recursive: true });
writeFileSync(
  path.join(output, "manifest.json"),
  JSON.stringify({ source, repository, version, files: manifest }, null, 2),
);
const summary = {
  source,
  repository,
  version,
  files: manifest.length,
  chunks: chunks.length,
  parents: chunks.filter((chunk) => chunk.role === "parent").length,
  vectors: chunks.filter((chunk) => chunk.role !== "parent").length,
};
console.log(JSON.stringify({ stage: "plan", ...summary }));
if (authorization === "--plan") process.exit(0);
const image = JSON.parse(
  readFileSync(path.join(root, "data", "sandbox.json"), "utf8").replace(
    /^\uFEFF/,
    "",
  ),
).image as string;
const transport =
  config.transport === "docker-internal"
    ? internalQdrantFetch(root, image)
    : fetch;
const health = await transport(config.qdrant.replace(/\/$/, "") + "/healthz");
if (!health.ok) throw Error(`Qdrant health: HTTP ${health.status}`);
const dense = new QdrantDense(
  config,
  process.env.NEWAGENT_EMBEDDING_API_KEY ?? "local-embedding",
  fetch,
  transport,
);
let completed = 0;
const progressReader = {
  list: reader.list,
  async read(file: string) {
    const content = await reader.read(file);
    console.log(
      JSON.stringify({
        stage: "indexing",
        file,
        completed: completed++,
        total: manifest.length,
      }),
    );
    return content;
  },
};
const index = new RepositoryIndex(
  path.join(root, "data", "retrieval"),
  repository,
  progressReader,
  version,
  dense,
  options,
);
try {
  const indexed = await index.update();
  if (!indexed.dense)
    throw Error(`Vector indexing incomplete: ${indexed.reasons.join("; ")}`);
  for (const file of manifest)
    if (hashText(await reader.read(file.path)) !== file.hash)
      throw Error(
        `Source changed during indexing: ${file.path}; rerun before relying on the manifest`,
      );
  const queries = [
    "buildApp health database redis",
    "RiotOAuthService getSession",
    "firstKillInRound",
  ];
  const probes = [];
  for (const query of queries) {
    const result = await index.search(query, 3, undefined, [], true);
    if (result.mode !== "hybrid")
      throw Error(`Dense search failed: ${result.reason}`);
    probes.push({ query, hits: result.hits });
  }
  const report = {
    ...summary,
    collection: dense.collection,
    indexed,
    probes,
    completedAt: new Date().toISOString(),
    paidEmbeddingCalls: 0,
  };
  writeFileSync(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      stage: "complete",
      ...summary,
      collection: dense.collection,
      report: path.join(output, "report.json"),
    }),
  );
} finally {
  index.close();
}
