import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/integrations/mcp-server.js";
import { Store } from "../src/state/store.js";
test("official MCP protocol binds one task and shares path protection and budget", async () => {
  const base = path.resolve("../cache/tests");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, "mcp-"));
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace);
  mkdirSync(path.join(root, "data"));
  writeFileSync(path.join(workspace, "value.ts"), "export const value = 1");
  writeFileSync(path.join(workspace, ".env"), "FAKE_SECRET=never-read");
  writeFileSync(
    path.join(root, "data", "profiles.json"),
    JSON.stringify([
      {
        id: "test",
        source: workspace,
        execution: { mode: "trusted-host", acknowledged: true },
        checks: [{ name: "check", file: process.execPath, args: ["-e", "0"] }],
      },
    ]),
  );
  const store = new Store(path.join(root, "data"));
  store.save({
    id: "bound",
    profileId: "test",
    requirement: "Read test source",
    acceptance: ["safe"],
    workspace,
    status: "queued",
    branch: "fixture",
    round: 0,
    baseRevision: "",
    revision: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const server = createMcpServer(root, "bound", store),
    client = new Client({ name: "protocol-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    assert.deepEqual(
      (await client.listTools()).tools.map((t) => t.name).sort(),
      [
        "file_read",
        "repository_search",
        "verification_evidence",
        "verification_run",
      ],
    );
    const read = await client.callTool({
      name: "file_read",
      arguments: { path: "value.ts" },
    });
    assert.equal(read.isError, undefined);
    const denied = await client.callTool({
      name: "file_read",
      arguments: { path: ".env" },
    });
    assert.equal(denied.isError, true);
    const traversal = await client.callTool({
      name: "file_read",
      arguments: { path: "../escape" },
    });
    assert.equal(traversal.isError, true);
    assert.equal(store.get("bound").budget?.tools, 3);
    const invalid = await client.callTool({
      name: "repository_search",
      arguments: { query: "" },
    });
    assert.equal(invalid.isError, true);
    assert.equal(store.get("bound").budget?.tools, 3);
  } finally {
    await client.close();
    await server.close();
    store.close();
  }
});
