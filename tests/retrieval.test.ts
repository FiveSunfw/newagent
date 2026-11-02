import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { CHUNK_VERSION, chunkFile, rrf } from "../src/retrieval/chunks.js";
import { RepositoryIndex } from "../src/retrieval/repository-index.js";
import { selectInitialCodeContext } from "../src/retrieval/context-selection.js";
import {
  QdrantDense,
  retrievalConfigSchema,
  type DenseIndex,
} from "../src/retrieval/dense.js";
import { retrievalQuery } from "../src/retrieval/query.js";
import { searchRepository } from "../src/retrieval/service.js";
import { hashText } from "../src/retrieval/chunks.js";
test("failed vector deletion is retried after index process restart", async () => {
  const location = directory(),
    source = new Map([["cart.ts", "export class Cart {}"]]);
  let fail = true;
  const vectors = new Set<string>();
  const dense: DenseIndex = {
    async upsert(chunks) {
      for (const chunk of chunks) vectors.add(chunk.id);
    },
    async remove(ids) {
      if (fail) throw Error("temporary Qdrant outage");
      for (const id of ids) vectors.delete(id);
    },
    async search() {
      return [...vectors];
    },
  };
  const reader = {
    async list() {
      return [...source.keys()];
    },
    async read(file: string) {
      const text = source.get(file);
      if (text === undefined) throw Error("ENOENT");
      return text;
    },
  };
  const initial = new RepositoryIndex(location, "repo", reader, "v1", dense);
  await initial.update();
  source.clear();
  const deleted = await initial.update();
  assert.equal(deleted.deleted, 1);
  assert.equal(vectors.size, 1);
  initial.close();
  fail = false;
  const resumed = new RepositoryIndex(location, "repo", reader, "v1", dense);
  try {
    await resumed.update();
    assert.equal(vectors.size, 0);
    assert.equal((await resumed.search("Cart")).hits.length, 0);
  } finally {
    resumed.close();
  }
});
function directory() {
  const base = path.resolve("../cache/tests");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(path.join(base, "retrieval-"));
}
test("warm RAG queries skip repository scans, refresh writes, and validate candidate source", async () => {
  const root = directory();
  const source = new Map(
    Array.from({ length: 40 }, (_, i) => [
      `f${i}.ts`,
      `export const value${i} = '${i === 0 ? "needle" : "other"}';`,
    ]),
  );
  const changes = new Map<string, number>();
  let generation = 0,
    scope = "first-workspace",
    lists = 0,
    hashes = 0,
    reads = 0,
    batches = 0;
  const reader = {
    async list() {
      lists++;
      return [...source.keys()];
    },
    async read(file: string) {
      reads++;
      const value = source.get(file);
      if (value === undefined) throw Error("ENOENT");
      return value;
    },
    async fingerprints(files: string[]) {
      hashes++;
      return Object.fromEntries(
        files
          .filter((file) => source.has(file))
          .map((file) => [file, hashText(source.get(file)!)]),
      );
    },
    async readMany(files: string[]) {
      batches++;
      return Object.fromEntries(
        files
          .filter((file) => source.has(file))
          .map((file) => [file, source.get(file)!]),
      );
    },
    indexState() {
      return { scope, generation, changes };
    },
  };
  await searchRepository(root, "warm-test", reader, "needle", 1);
  const afterInitial = { lists, hashes, reads };
  await searchRepository(root, "warm-test", reader, "needle", 1);
  assert.deepEqual({ lists, hashes, reads }, afterInitial);
  assert.equal(batches, 2);
  source.set("new.ts", "export const added = 'freshMarker';");
  changes.set("new.ts", ++generation);
  const added = await searchRepository(
    root,
    "warm-test",
    reader,
    "freshMarker",
    1,
  );
  assert.equal(added.hits[0].path, "new.ts");
  assert.equal(lists, afterInitial.lists);
  assert.equal(reads, afterInitial.reads + 1);
  source.delete("new.ts");
  changes.set("new.ts", ++generation);
  assert.equal(
    (await searchRepository(root, "warm-test", reader, "freshMarker", 1)).hits
      .length,
    0,
  );
  // An external edit is checked against the matched source even without a write notification.
  source.set("f0.ts", "export const value0 = 'externalChange';");
  const live = await searchRepository(root, "warm-test", reader, "needle", 1);
  assert.equal(live.hits[0].source, "live");
  assert.match(live.hits[0].content, /externalChange/);
  scope = "resumed-workspace";
  await searchRepository(root, "warm-test", reader, "externalChange", 1);
  assert.equal(lists, afterInitial.lists + 1);
});
test("TS-only migration removes legacy vectors and FTS results and stays scoped", async () => {
  const location = directory();
  const source = new Map([
    ["app.ts", "export function health() { return 'ok'; }"],
    ["view.tsx", "export const Health = () => <div>health</div>;"],
    ["legacy.py", "def health(): return 'legacy'"],
    ["README.md", "# health legacy"],
    ["old.js", "export function health() {}"],
  ]);
  const reader = {
    async list() {
      return [...source.keys()];
    },
    async read(file: string) {
      return source.get(file)!;
    },
  };
  const vectors = new Map<string, string>();
  const dense: DenseIndex = {
    async upsert(chunks) {
      for (const chunk of chunks) vectors.set(chunk.id, chunk.path);
    },
    async remove(ids) {
      for (const id of ids) vectors.delete(id);
    },
    async search() {
      return [...vectors.keys()];
    },
  };
  const initial = new RepositoryIndex(
    location,
    "filtered",
    reader,
    CHUNK_VERSION,
    dense,
  );
  await initial.update();
  initial.close();
  assert.ok([...vectors.values()].includes("legacy.py"));
  const migrated = new RepositoryIndex(
    location,
    "filtered",
    reader,
    CHUNK_VERSION,
    dense,
    { typescriptOnly: true },
  );
  try {
    assert.ok(
      (await migrated.search("health")).hits.every((hit) =>
        /\.tsx?$/.test(hit.path),
      ),
      "Old results are excluded before migration finishes",
    );
    const updated = await migrated.update();
    assert.equal(updated.deleted, 3);
    assert.equal(updated.files, 2);
    assert.ok([...vectors.values()].every((file) => /\.tsx?$/.test(file)));
    assert.ok(
      (await migrated.search("health")).hits.every((hit) =>
        /\.tsx?$/.test(hit.path),
      ),
    );
    assert.equal((await migrated.update()).updated, 0);
  } finally {
    migrated.close();
  }
  const unfiltered = new RepositoryIndex(
    directory(),
    "other",
    reader,
    CHUNK_VERSION,
  );
  try {
    assert.equal((await unfiltered.update()).files, 5);
  } finally {
    unfiltered.close();
  }
});
test("classes retain parents and qualified methods; long methods split on if/else", () => {
  const source = [
    "export class Cart {",
    "  total(flag: boolean) {",
    "    if (flag) {",
    ...Array.from({ length: 105 }, (_, i) => `      const yes${i} = ${i};`),
    "    } else {",
    ...Array.from({ length: 105 }, (_, i) => `      const no${i} = ${i};`),
    "    }",
    "  }",
    "  reset() { return 0; }",
    "}",
  ].join("\n");
  const chunks = chunkFile("repo", "cart.ts", source, CHUNK_VERSION);
  const cart = chunks.find((chunk) => chunk.symbol === "Cart")!;
  const method = chunks.find((chunk) => chunk.symbol === "Cart.total")!;
  assert.equal(cart.role, "parent");
  assert.equal(method.parentId, cart.id);
  assert.equal(method.role, "parent");
  assert.ok(chunks.some((chunk) => chunk.symbol.includes("/if")));
  assert.ok(chunks.some((chunk) => chunk.symbol.includes("/else")));
  const ids = new Set(chunks.map((chunk) => chunk.id));
  assert.equal(ids.size, chunks.length);
  const lines = source.split("\n");
  for (const chunk of chunks) {
    assert.equal(
      chunk.content,
      lines.slice(chunk.startLine - 1, chunk.endLine).join("\n"),
    );
    if (chunk.parentId) assert.ok(ids.has(chunk.parentId));
    if (chunk.role === "leaf") assert.ok(chunk.endLine - chunk.startLine < 100);
  }
});
test("a method hit expands its class and live edits never return stale parents", async () => {
  let source = "export class Cart {\n  total() { return 'uniqueValue'; }\n}";
  const reader = {
    async list() {
      return ["cart.ts"];
    },
    async read() {
      return source;
    },
  };
  const index = new RepositoryIndex(
    directory(),
    "hierarchy",
    reader,
    CHUNK_VERSION,
  );
  try {
    await index.update();
    const first = (await index.search("uniqueValue")).hits[0];
    assert.equal(first.symbol, "Cart.total");
    assert.equal(first.parents?.[0].symbol, "Cart");
    assert.equal(first.parents?.[0].complete, true);
    source = source.replace("uniqueValue", "updatedValue");
    const live = (await index.search("uniqueValue")).hits[0];
    assert.equal(live.source, "live");
    assert.match(live.parents![0].content, /updatedValue/);
    assert.doesNotMatch(live.parents![0].content, /uniqueValue/);
    await index.update();
    assert.equal((await index.search("uniqueValue")).hits.length, 0);
  } finally {
    index.close();
  }
});
test("same-line JavaScript statements keep one chunk and update without SQL collisions", async () => {
  let content = "module.exports = value => value; module.exports.extra = 1;";
  const reader = {
    async list() {
      return ["index.js"];
    },
    async read() {
      return content;
    },
  };
  const index = new RepositoryIndex(
    directory(),
    "inline",
    reader,
    CHUNK_VERSION,
  );
  try {
    await index.update();
    const first = await index.search("extra");
    assert.equal(first.hits.length, 1);
    assert.equal(first.hits[0].symbol, "module");
    assert.equal(first.hits[0].startLine, 1);
    assert.equal(first.hits[0].content, content);
    content = "module.exports = value => value + 1; module.exports.extra = 2;";
    await index.update();
    const changed = await index.search("extra");
    assert.equal(changed.hits.length, 1);
    assert.equal(changed.hits[0].content, content);
  } finally {
    index.close();
  }
});
test("AST functions/classes and Markdown headings retain line evidence", () => {
  const source =
    "export function total(price: number) {\n return price * 100;\n}\nexport class Cart { items = []; }\n";
  const chunks = chunkFile("repo", "money.ts", source, "v1");
  assert.equal(chunks[0].symbol, "total");
  assert.equal(chunks[0].startLine, 1);
  assert.equal(chunks[0].endLine, 3);
  assert.equal(chunks[1].symbol, "Cart");
  const windowsMarkdown = chunkFile(
    "repo",
    "README.md",
    "# Setup\r\ninstall\r\n# Tests\r\nrun",
    "v2",
  );
  assert.deepEqual(
    windowsMarkdown.map((c) => c.symbol),
    ["Setup", "Tests"],
  );
  assert.equal(windowsMarkdown[1].startLine, 3);
  assert.ok(
    windowsMarkdown[0].content.includes("\r\n"),
    "Keep verbatim source evidence",
  );
  assert.deepEqual(
    chunkFile(
      "repo",
      "README.md",
      "# Setup\nnpm ci\n# Tests\nnpm test",
      "v1",
    ).map((c) => c.symbol),
    ["Setup", "Tests"],
  );
  assert.equal(
    chunkFile("repo", "blob.txt", "binary\0content", "v1").length,
    0,
  );
  assert.equal(
    rrf([
      ["a", "b"],
      ["b", "c"],
    ])[0].id,
    "b",
  );
});
test("CommonJS exports and nested functions receive distinct source chunks", () => {
  const source = [
    "module.exports = function stableStringify(data) {",
    "  return (function stringify(node) {",
    "    if (typeof node === 'number') return isFinite(node) ? '' + node : 'null';",
    "    return JSON.stringify(node);",
    "  })(data);",
    "};",
  ].join("\n");
  const chunks = chunkFile("repo", "index.js", source, CHUNK_VERSION);
  assert.ok(chunks.some((chunk) => chunk.symbol === "module.exports"));
  assert.ok(chunks.some((chunk) => chunk.symbol === "stableStringify"));
  const stringify = chunks.find((chunk) => chunk.symbol === "stringify");
  assert.ok(stringify);
  assert.equal(stringify.path, "index.js");
  assert.match(stringify.content, /isFinite\(node\)/);
});
test("initial retrieval query omits evaluation-only edit and test directives", () => {
  assert.equal(
    retrievalQuery(
      "Wildcard subscribers receive payload and event type in the wrong order. Restore the emit contract. Use the fixed independent acceptance and contract smoke; do not edit tests, fixtures, or configuration.",
    ),
    "Wildcard subscribers receive payload and event type in the wrong order. Restore the emit contract.",
  );
  const behavioralConstraint =
    "Non-finite values serialize as null without changing finite numbers.";
  assert.equal(retrievalQuery(behavioralConstraint), behavioralConstraint);
});
test("code-change context prioritizes implementation chunks over tests and docs", () => {
  const hit = (file: string) => ({
    id: file,
    repository: "repo",
    path: file,
    symbol: "module",
    startLine: 1,
    endLine: 2,
    fileHash: "hash",
    indexVersion: CHUNK_VERSION,
    content: "source",
    score: 1,
    source: "indexed" as const,
  });
  const candidates = [
    hit("test/example.js"),
    hit("README.md"),
    hit("src/index.ts"),
  ];
  assert.deepEqual(
    selectInitialCodeContext(
      candidates,
      "Fix the incorrect return behavior.",
    ).map((candidate) => candidate.path),
    ["src/index.ts", "test/example.js", "README.md"],
  );
  assert.deepEqual(
    selectInitialCodeContext(candidates, "Where is the usage documented?").map(
      (candidate) => candidate.path,
    ),
    ["test/example.js", "README.md", "src/index.ts"],
  );
});
test("a caller that just updated the source snapshot can skip duplicate reads", async () => {
  let reads = 0;
  const reader = {
    async list() {
      return ["index.js"];
    },
    async read() {
      reads++;
      return "module.exports = function total() { return 1; };";
    },
  };
  const index = new RepositoryIndex(
    directory(),
    "fresh",
    reader,
    CHUNK_VERSION,
  );
  try {
    await index.update();
    reads = 0;
    const result = await index.search("total", 10, undefined, [], true);
    assert.equal(reads, 0);
    assert.equal(result.hits[0].source, "indexed");
  } finally {
    index.close();
  }
});
test("Qdrant uses raw documents and task instructions for query embeddings", async () => {
  const chunk = {
    id: "chunk-id",
    repository: "mitt",
    path: "src/index.ts",
    symbol: "WildcardHandler",
    startLine: 12,
    endLine: 19,
    fileHash: "file-hash",
    indexVersion: "chunks-v4:test",
    content: "export type WildcardHandler = () => void;",
  };
  const embedded: string[][] = [];
  const config = retrievalConfigSchema.parse({
    transport: "http",
    qdrant: "http://127.0.0.1:6333",
    embedding: {
      endpoint: "http://127.0.0.1:18092/v1",
      model: "local-test",
      dimensions: 2,
      version: "test",
      queryInstruction:
        "Given a software repository query, retrieve relevant source code or repository documentation.",
    },
  });
  const dense = new QdrantDense(
    config,
    "local-only",
    async (_input, init) => {
      const inputs = JSON.parse(String(init?.body)).input as string[];
      embedded.push(inputs);
      return new Response(
        JSON.stringify({
          data: inputs.map((_, index) => ({
            index,
            embedding: [0.1, 0.2],
          })),
        }),
      );
    },
    async (input, init) => {
      if (!init?.method) return new Response(null, { status: 404 });
      if (String(input).endsWith("/points/query"))
        return new Response(JSON.stringify({ result: { points: [] } }));
      return new Response("{}");
    },
  );
  await dense.upsert([
    { ...chunk, id: "context-parent", role: "parent" },
    chunk,
  ]);
  await dense.search("find wildcard handler", "mitt", 5);
  assert.deepEqual(embedded, [
    [chunk.content],
    [
      "Instruct: Given a software repository query, retrieve relevant source code or repository documentation.\nQuery: find wildcard handler",
    ],
  ]);
});
test("incremental add/update/delete excludes credentials and replaces stale source", async () => {
  const source = new Map([
    ["money.ts", "export function total() { return 1; }"],
    [".env", "fake-key"],
  ]);
  const reader = {
    async list() {
      return [...source.keys()];
    },
    async read(file: string) {
      const content = source.get(file);
      if (content === undefined) throw Error("ENOENT");
      return content;
    },
  };
  const index = new RepositoryIndex(directory(), "repo", reader, "v1");
  try {
    assert.equal((await index.update()).files, 1);
    assert.equal((await index.update()).updated, 0);
    let result = await index.search("total");
    assert.equal(result.mode, "keyword");
    assert.match(result.reason ?? "", /missing/);
    assert.equal(result.hits[0].source, "indexed");
    source.set("money.ts", "export function total() { return 2; }");
    result = await index.search("total");
    assert.equal(result.hits[0].source, "live");
    assert.match(result.hits[0].content, /return 2/);
    assert.equal((await index.update()).updated, 1);
    source.set("cart.ts", "export class Cart {} ");
    assert.equal((await index.update()).updated, 1);
    source.delete("money.ts");
    assert.equal((await index.update()).deleted, 1);
    assert.equal((await index.search("total")).hits.length, 0);
    assert.equal((await index.search('" OR .env')).hits.length, 0);
  } finally {
    index.close();
  }
});

test("CPU embeddings use bounded batches and reuse collection inspection", async () => {
  const sizes: number[] = [];
  let inspections = 0;
  const pointIds: string[] = [];
  const config = retrievalConfigSchema.parse({
    transport: "http",
    qdrant: "http://127.0.0.1:6333",
    embedding: {
      endpoint: "http://127.0.0.1:18092/v1",
      model: "fixture",
      dimensions: 2,
      version: "batch-test",
    },
  });
  const dense = new QdrantDense(
    config,
    "fixture",
    async (_url, init) => {
      const input = JSON.parse(String(init?.body)).input as string[];
      sizes.push(input.length);
      return new Response(
        JSON.stringify({
          data: input.map((_, index) => ({ index, embedding: [index, 1] })),
        }),
      );
    },
    async (_url, init) => {
      if (!init?.method) {
        inspections++;
        return new Response("{}");
      }
      const body = JSON.parse(String(init.body));
      if (body.points)
        pointIds.push(...body.points.map((point: { id: string }) => point.id));
      return new Response("{}");
    },
  );
  const chunks = Array.from(
    { length: 9 },
    (_, index) =>
      chunkFile(
        "batch",
        `f${index}.ts`,
        `export function f${index}() { return ${index}; }`,
        CHUNK_VERSION,
      )[0],
  );
  await dense.upsert(chunks);
  await dense.upsert([chunks[0]]);
  assert.deepEqual(sizes, [4, 4, 1, 1]);
  assert.equal(inspections, 1);
  assert.deepEqual(pointIds, [
    ...chunks.map((chunk) => chunk.id),
    chunks[0].id,
  ]);
});
test("Dense failure explicitly falls back to FTS; remote orphan IDs never become evidence", async () => {
  const reader = {
    async list() {
      return ["cart.ts"];
    },
    async read() {
      return "export class Cart {}";
    },
  };
  const dense: DenseIndex = {
    async upsert() {
      throw Error("Qdrant unavailable");
    },
    async remove() {},
    async search() {
      throw Error("Qdrant unavailable");
    },
  };
  const index = new RepositoryIndex(directory(), "repo", reader, "v1", dense);
  try {
    const updated = await index.update();
    assert.equal(updated.dense, false);
    const result = await index.search("Cart");
    assert.equal(result.mode, "keyword");
    assert.match(result.reason ?? "", /Qdrant unavailable/);
    assert.equal(result.hits.length, 1);
  } finally {
    index.close();
  }
  const orphan: DenseIndex = {
    async upsert() {},
    async remove() {},
    async search() {
      return ["00000000-0000-0000-0000-000000000000"];
    },
  };
  const second = new RepositoryIndex(directory(), "repo", reader, "v1", orphan);
  try {
    await second.update();
    const result = await second.search("unrelated");
    assert.equal(result.mode, "hybrid");
    assert.equal(result.hits.length, 0);
  } finally {
    second.close();
  }
});
