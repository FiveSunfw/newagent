import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TaskExecution } from "../src/exec/task-execution.js";
import { profileSchema, type Task } from "../src/protocol/types.js";
test("literal search preserves line numbers and never reads package credentials", async () => {
  const base = path.resolve("../cache/tests");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, "literal-"));
  writeFileSync(path.join(root, "source.txt"), "header\ntarget\nfooter");
  writeFileSync(path.join(root, ".npmrc"), "target=fake-secret");
  const profile = profileSchema.parse({
    id: "test",
    source: root,
    execution: { mode: "trusted-host", acknowledged: true },
    checks: [{ name: "noop", file: process.execPath }],
  });
  const task: Task = {
    id: "literal",
    profileId: "test",
    workspace: root,
    requirement: "Search current source",
    acceptance: ["correct lines"],
    status: "developing",
    round: 0,
    branch: "test",
    baseRevision: "",
    revision: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const execution = new TaskExecution(root, task, profile);
  assert.deepEqual(await execution.search("target"), [
    { path: "source.txt", line: 2, text: "target" },
  ]);
  await assert.rejects(execution.read(".npmrc"), /Private/);
  assert.equal(
    execution.workspaceRootRelativeSuggestion(
      `${path.basename(root)}/source.txt`,
    ),
    "source.txt",
  );
  await execution.edit("source.txt", "target", "updated");
  assert.equal(await execution.read("source.txt"), "header\nupdated\nfooter");
  assert.deepEqual(await execution.readMany(["source.txt"]), {
    "source.txt": "header\nupdated\nfooter",
  });
  const fingerprints = await execution.fingerprints(["source.txt"]);
  assert.match(fingerprints["source.txt"], /^[a-f0-9]{64}$/);
  assert.ok(execution.indexState().changes.has("source.txt"));
  assert.equal(
    new TaskExecution(root, task, profile, true).indexState().generation,
    execution.indexState().generation,
  );
  await assert.rejects(execution.readMany([".npmrc"]), /Private/);
  await assert.rejects(execution.fingerprints(["../outside.ts"]), /Outside/i);
  await execution.write("windows-crlf.txt", "alpha\r\nbeta\r\n");
  await execution.edit("windows-crlf.txt", "alpha\nbeta", "alpha!\nbeta!");
  assert.equal(await execution.read("windows-crlf.txt"), "alpha!\r\nbeta!\r\n");
  await assert.rejects(
    execution.edit("source.txt", "missing", "bad"),
    /exactly one/,
  );
  await assert.rejects(execution.edit("source.txt", "", "bad"), /empty/);
  await assert.rejects(
    execution.edit("source.txt", "header", "header"),
    /before and after are identical/,
  );
  await execution.write("source.txt", "repeat repeat");
  await assert.rejects(
    execution.edit("source.txt", "repeat", "bad"),
    /exactly one/,
  );
  const reviewer = new TaskExecution(root, task, profile, true);
  await assert.rejects(
    reviewer.edit("source.txt", "repeat repeat", "bad"),
    /Read-only/,
  );
  await assert.rejects(execution.edit(".npmrc", "target", "bad"), /Private/);
});
