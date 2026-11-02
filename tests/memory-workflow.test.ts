import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Workflow } from "../src/core/workflow.js";
import { Store } from "../src/state/store.js";
import { git } from "../src/exec/execution.js";
import { LongTermMemory } from "../src/memory/service.js";

test("workflow loads preferences, records outcomes, and survives memory outages", async () => {
  mkdirSync("../cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve("../cache/tests/memory-workflow-")),
    source = path.join(root, "source");
  mkdirSync(source);
  writeFileSync(path.join(source, "value.txt"), "before");
  await git(source, ["init"]);
  await git(source, ["config", "user.name", "Test"]);
  await git(source, ["config", "user.email", "test@localhost"]);
  await git(source, ["add", "."]);
  await git(source, ["commit", "-m", "fixture"]);
  mkdirSync(path.join(root, "data"));
  writeFileSync(
    path.join(root, "data/memory.json"),
    JSON.stringify({
      enabled: true,
      userId: "test",
      collection: "newagent_memory_test",
      model: "test",
      baseUrl: "https://example.invalid",
    }),
  );
  writeFileSync(
    path.join(root, "data/profiles.json"),
    JSON.stringify([
      {
        id: "test",
        source,
        strategy: "single-no-rag",
        execution: { mode: "trusted-host", acknowledged: true },
        checks: [
          {
            name: "value",
            file: process.execPath,
            args: [
              "-e",
              "if(require('fs').readFileSync('value.txt','utf8')!=='good')process.exit(1)",
            ],
          },
        ],
      },
    ]),
  );
  let unavailable = false;
  const records: Record<string, unknown>[] = [];
  const memory = new LongTermMemory(root, undefined, async (input) => {
    if (unavailable) throw Error("test memory unavailable");
    if (input.op === "remember") records.push(input);
    return {
      results:
        input.op === "preferences"
          ? [
              {
                id: "style",
                memory: "新增注释使用中文",
                metadata: {
                  kind: "preference",
                  status: "declared",
                  scope: "project",
                  key: "comments",
                },
              },
            ]
          : [],
    };
  });
  const store = new Store(path.join(root, "data"));
  const workflow = new Workflow(
    root,
    store,
    {
      async run(task, _profile, _role, prompt) {
        if (!unavailable) assert.match(prompt, /新增注释使用中文/);
        writeFileSync(path.join(task.workspace, "value.txt"), "good");
        return "done";
      },
    },
    undefined,
    memory,
  );
  try {
    const first = workflow.create({
      profileId: "test",
      requirement: "Implement fixture change",
      acceptance: ["value is good"],
    });
    workflow.run(first.id);
    await workflow.waitForRun();
    assert.equal(store.get(first.id).status, "ready_for_pr");
    assert.equal(records.length, 1);
    assert.equal(
      (records[0].metadata as Record<string, unknown>).kind,
      "experience",
    );
    unavailable = true;
    const second = workflow.create({
      profileId: "test",
      requirement: "Implement another fixture change",
      acceptance: ["value is good"],
    });
    workflow.run(second.id);
    await workflow.waitForRun();
    assert.equal(store.get(second.id).status, "ready_for_pr");
    assert.ok(
      store.events(second.id).some((event) => event.kind === "memory_error"),
    );
  } finally {
    await workflow.shutdown();
    store.close();
  }
});
