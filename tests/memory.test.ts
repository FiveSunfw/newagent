import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LongTermMemory, type MemoryTransport } from "../src/memory/service.js";

function configured(userId = "alice") {
  mkdirSync("../cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve("../cache/tests/memory-"));
  mkdirSync(path.join(root, "data"));
  writeFileSync(
    path.join(root, "data/memory.json"),
    JSON.stringify({
      enabled: true,
      userId,
      collection: "newagent_memory_test",
      model: "test",
      baseUrl: "https://example.invalid",
      timeoutMs: 1000,
    }),
  );
  return root;
}
test("memory isolates user/project scopes and accepts preferences and unverified experience", async () => {
  const calls: Record<string, unknown>[] = [];
  const transport: MemoryTransport = async (input) => {
    calls.push(input);
    return { results: [] };
  };
  const alice = new LongTermMemory(configured(), undefined, transport);
  const bob = new LongTermMemory(configured("bob"), undefined, transport);
  await alice.execute({
    action: "remember",
    scope: "user",
    text: "偏好两个空格缩进",
    key: "indent",
  });
  await alice.execute({
    action: "remember",
    profileId: "p1",
    text: "这项目使用四个空格",
  });
  await alice.execute({
    action: "remember",
    profileId: "p2",
    kind: "experience",
    status: "hypothesis",
    text: "怀疑异常来自外部接口超时",
  });
  await bob.execute({ action: "search", scope: "user", query: "缩进" });
  assert.equal(new Set(calls.map((call) => call.namespace)).size, 4);
  await alice.execute({
    action: "update",
    scope: "user",
    memoryId: "00000000-0000-4000-8000-000000000001",
    text: "用户纠正的经验内容",
  });
  assert.equal((calls[4].metadata as Record<string, unknown>).kind, undefined);
  assert.equal(
    (calls[2].metadata as Record<string, unknown>).status,
    "hypothesis",
  );
  await assert.rejects(
    alice.execute({ action: "remember", text: "something" }),
    /profileId/,
  );
  await assert.rejects(
    alice.execute({
      action: "remember",
      scope: "user",
      text: "api_key=sk-12345678901234567890",
    }),
    /Credentials/,
  );
});
test("style preferences are included across tasks even when semantic search has no match", async () => {
  const transport: MemoryTransport = async (input) =>
    input.op === "preferences"
      ? {
          results: [
            {
              id: "pref1",
              memory: "使用两个空格缩进",
              metadata: {
                kind: "preference",
                status: "declared",
                scope: "project",
                key: "indent",
              },
            },
          ],
        }
      : { results: [] };
  const memory = new LongTermMemory(configured(), undefined, transport);
  const context = await memory.context("新增健康接口", "project1");
  assert.match(context, /两个空格/);
  assert.match(context, /current user instructions/);
  assert.match(context, /declared/);
});
test("automatic extraction uses user statements only and skips one-off tasks", async () => {
  const calls: Record<string, unknown>[] = [];
  const memory = new LongTermMemory(configured(), undefined, async (input) => {
    calls.push(input);
    return { results: [] };
  });
  await memory.capture("新增健康接口", "project");
  assert.equal(calls.length, 0);
  await memory.capture("以后代码注释用中文", "project");
  assert.equal(calls[0].op, "capture");
  assert.equal(
    (calls[0].metadata as Record<string, unknown>).status,
    "inferred",
  );
});
test("missing configuration disables memory without calling a backend", async () => {
  const memory = new LongTermMemory(
    path.resolve("../cache/not-configured-memory"),
  );
  assert.equal(memory.enabled(), false);
  assert.equal(await memory.context("task", "project"), "");
});
