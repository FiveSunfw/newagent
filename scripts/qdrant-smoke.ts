import assert from "node:assert/strict";
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { internalQdrantFetch } from "../src/retrieval/docker-transport.js";
import { QdrantDense, retrievalConfigSchema } from "../src/retrieval/dense.js";
import { chunkFile } from "../src/retrieval/chunks.js";
const root = path.resolve("..");
const image = JSON.parse(
  readFileSync(path.join(root, "data", "sandbox.json"), "utf8").replace(
    /^\uFEFF/,
    "",
  ),
).image;
const transport = internalQdrantFetch(root, image);
assert.equal((await transport("http://127.0.0.1:6333/healthz")).status, 200);
const version = `protocol-${randomUUID()}`;
const config = retrievalConfigSchema.parse({
  qdrant: "http://127.0.0.1:6333",
  embedding: {
    endpoint: "https://fixture.invalid/v1",
    model: "fixture-vectors",
    dimensions: 3,
    version,
  },
});
// Protocol fixture vectors only. No external request, real embedding or retrieval-quality claim.
const fixture: typeof fetch = async (_url, init) => {
  const input = JSON.parse(String(init?.body)).input as string[];
  return new Response(
    JSON.stringify({
      data: input.map((text, index) => ({
        index,
        embedding: text.includes("total") ? [1, 0, 0] : [0, 1, 0],
      })),
    }),
    { status: 200 },
  );
};
const dense = new QdrantDense(config, "fake-fixture-key", fixture, transport);
const chunks = [
  ...chunkFile(
    "smoke",
    "money.ts",
    "export function total() { return 100; }",
    version,
  ),
  ...chunkFile("smoke", "cart.ts", "export class Cart {}", version),
];
try {
  await dense.upsert(chunks);
  const found = await dense.search("total", "smoke", 2);
  assert.equal(found[0], chunks[0].id);
  assert.equal(
    (await dense.search("total", "another-repository", 2)).length,
    0,
  );
  await dense.remove([chunks[0].id]);
  assert.equal(
    (await dense.search("total", "smoke", 2)).includes(chunks[0].id),
    false,
  );
  const base = path.join(root, "cache", "qdrant-smoke");
  mkdirSync(base, { recursive: true });
  const reportPath = path.join(
    mkdtempSync(path.join(base, "run-")),
    "report.json",
  );
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        qdrantReal: true,
        embeddingFixture: true,
        paidModelCalls: 0,
        collection: dense.collection,
        checks: ["health", "upsert/query", "repository isolation", "delete"],
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      reportPath,
      qdrantReal: true,
      embeddingFixture: true,
      paidModelCalls: 0,
    }),
  );
} finally {
  await transport(`http://127.0.0.1:6333/collections/${dense.collection}`, {
    method: "DELETE",
  });
}
