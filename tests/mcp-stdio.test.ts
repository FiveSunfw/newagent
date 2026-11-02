import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Store } from "../src/state/store.js";
test("local stdio handshake and bound file read do not require model configuration", async () => {
  const base = path.resolve("../cache/tests");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, "stdio-"));
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace);
  mkdirSync(path.join(root, "data"));
  mkdirSync(path.join(root, "cache", "tmp"), { recursive: true });
  writeFileSync(path.join(workspace, "value.ts"), "export const value = 42;");
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
    requirement: "Read controlled source",
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
  store.close();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      path.resolve("node_modules/tsx/dist/cli.mjs"),
      path.resolve("src/integrations/mcp-server.ts"),
      "bound",
    ],
    env: {
      NEWAGENT_ROOT: root,
      PATH: process.env.PATH ?? "",
      NODE_DISABLE_COMPILE_CACHE: "1",
      TEMP: path.join(root, "cache", "tmp"),
      TMP: path.join(root, "cache", "tmp"),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "stdio-test", version: "1" });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 4);
    const result = await client.callTool({
      name: "file_read",
      arguments: { path: "value.ts" },
    });
    assert.notEqual(result.isError, true);
    assert.match(JSON.stringify(result.content), /value = 42/);
  } finally {
    await client.close();
  }
});
