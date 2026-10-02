import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { Store } from "../src/state/store.js";
import { git, inside, revision, execute } from "../src/exec/execution.js";
import { Workflow } from "../src/core/workflow.js";
import { parseReview, protectedFile, type Agent } from "../src/model-provider/pi.js";
import { profileSchema, type Task, type Profile } from "../src/protocol/types.js";
const tempRoot =
  process.env.NEWAGENT_TEST_ROOT ?? path.resolve("../cache/tests");
mkdirSync(tempRoot, { recursive: true });
test("workspace traversal and protected paths", () => {
  const dir = mkdtempSync(path.join(tempRoot, "paths-"));
  assert.throws(() => inside(dir, "../secret"));
  assert.throws(() => inside(dir, path.resolve(dir, "a")));
  const p = profileSchema.parse({
    id: "p",
    source: dir,
    checks: [{ name: "test", file: process.execPath, args: [] }],
  });
  assert.equal(protectedFile(".github/workflows/ci.yml", p), true);
  assert.equal(protectedFile("src/x.ts", p), false);
});
test("review contradiction is rejected", () => {
  assert.throws(() =>
    parseReview(
      JSON.stringify({
        verdict: "pass",
        findings: [
          {
            id: "1",
            severity: "blocking",
            file: "a.ts",
            line: 1,
            problem: "bug",
            evidence: "proof",
            recommendation: "fix",
          },
        ],
      }),
    ),
  );
  assert.equal(parseReview('{"verdict":"pass","findings":[]}').verdict, "pass");
});
test("executor distinguishes nonzero and timeout", async () => {
  const cwd = mkdtempSync(path.join(tempRoot, "exec-"));
  const fail = await execute(process.execPath, ["-e", "process.exit(3)"], cwd);
  assert.equal(fail.exitCode, 3);
  const timeout = await execute(
    process.execPath,
    ["-e", "setTimeout(()=>{},10000)"],
    cwd,
    undefined,
    50,
  );
  assert.equal(timeout.timedOut, true);
});
test("actual check failure drives repair and independent review", async () => {
  const root = mkdtempSync(path.join(tempRoot, "workflow-"));
  const source = path.join(root, "source");
  mkdirSync(source);
  writeFileSync(path.join(source, "value.txt"), "bad");
  await git(source, ["init"]);
  await git(source, ["config", "user.name", "Test"]);
  await git(source, ["config", "user.email", "test@localhost"]);
  await git(source, ["add", "."]);
  await git(source, ["commit", "-m", "fixture"]);
  mkdirSync(path.join(root, "data"));
  writeFileSync(
    path.join(root, "data", "profiles.json"),
    JSON.stringify([
      {
        id: "test",
        source,
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
  const store = new Store(path.join(root, "data"));
  let developers = 0,
    reviewers = 0;
  const agent: Agent = {
    async run(t: Task, _p: Profile, role) {
      if (role === "developer") {
        developers++;
        writeFileSync(
          path.join(t.workspace, "value.txt"),
          developers === 1 ? "still bad" : "good",
        );
        return "done";
      }
      reviewers++;
      return '{"findings":[],"verdict":"pass"}';
    },
  };
  const flow = new Workflow(root, store, agent);
  const task = flow.create({
    profileId: "test",
    requirement: "make value good",
    acceptance: ["value is good"],
  });
  flow.run(task.id);
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 30));
    const current = store.get(task.id);
    if (["ready_for_pr", "blocked"].includes(current.status)) break;
  }
  assert.equal(store.get(task.id).status, "ready_for_pr");
  assert.equal(developers, 2);
  assert.equal(reviewers, 1);
  const checks = store.checks(task.id);
  assert.equal(checks[0].passed, false);
  assert.equal(checks[1].passed, true);
  assert.notEqual(checks[0].revision, checks[1].revision);
  store.close();
});
test("restart pauses incomplete execution and preserves evidence", () => {
  const root = mkdtempSync(path.join(tempRoot, "restart-"));
  const store = new Store(path.join(root, "data"));
  const task: Task = {
    id: "id",
    profileId: "p",
    requirement: "test",
    acceptance: ["a"],
    status: "developing",
    round: 1,
    workspace: "x",
    branch: "b",
    baseRevision: "base",
    revision: "rev",
    createdAt: "now",
    updatedAt: "now",
  };
  store.save(task);
  new Workflow(root, store, {
    async run() {
      return "";
    },
  });
  assert.equal(store.get("id").status, "paused");
  store.close();
});
test("fingerprint changes for untracked source but ignores build artifacts", () => {
  const root = mkdtempSync(path.join(tempRoot, "hash-"));
  writeFileSync(path.join(root, "a.ts"), "one");
  const initial = revision(root);
  mkdirSync(path.join(root, "dist"));
  writeFileSync(path.join(root, "dist", "a.js"), "generated");
  writeFileSync(path.join(root, "tsconfig.tsbuildinfo"), "compiler cache");
  assert.equal(revision(root), initial);
  writeFileSync(
    path.join(root, "tsconfig.tsbuildinfo"),
    "updated compiler cache",
  );
  assert.equal(revision(root), initial);
  writeFileSync(path.join(root, "b.ts"), "two");
  assert.notEqual(revision(root), initial);
});
import { createServer } from "node:http";
import { PiAgent } from "../src/model-provider/pi.js";
test("real Pi SDK integrates with an explicit local protocol fixture", async () => {
  const root = mkdtempSync(path.join(tempRoot, "sdk-"));
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace);
  writeFileSync(path.join(workspace, "hello.ts"), "export const hello = 1;");
  mkdirSync(path.join(root, "data", "pi"), { recursive: true });
  let requests = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests++;
      const parsed = JSON.parse(body) as {
        messages: unknown[];
        tools: { function: { name: string } }[];
      };
      assert.ok(parsed.messages.length);
      assert.ok(parsed.tools.some((t) => t.function.name === "read_file"));
      assert.ok(!parsed.tools.some((t) => t.function.name === "bash"));
      if (requests === 1) {
        res.setHeader("Content-Type", "text/event-stream");
        res.write(
          "data: " +
            JSON.stringify({
              id: "fixture",
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: "read-1",
                        type: "function",
                        function: {
                          name: "read_file",
                          arguments: '{"path":"hello.ts"}',
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            }) +
            "\n\n",
        );
        res.write(
          "data: " +
            JSON.stringify({
              id: "fixture",
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            }) +
            "\n\n",
        );
        res.end("data: [DONE]\n\n");
        return;
      }
      res.setHeader("Content-Type", "text/event-stream");
      res.write(
        "data: " +
          JSON.stringify({
            id: "fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: "fixture-model",
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  content:
                    "Protocol fixture response; no real model inference.",
                },
                finish_reason: null,
              },
            ],
          }) +
          "\n\n",
      );
      res.write(
        "data: " +
          JSON.stringify({
            id: "fixture",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 10,
              total_tokens: 20,
            },
          }) +
          "\n\n",
      );
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  writeFileSync(
    path.join(root, "data", "model.json"),
    JSON.stringify({ provider: "fixture", model: "fixture-model" }),
  );
  writeFileSync(
    path.join(root, "data", "pi", "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: "openai-completions",
          apiKey: "fixture-only",
          models: [
            {
              id: "fixture-model",
              name: "Protocol fixture",
              reasoning: false,
              input: ["text"],
              contextWindow: 32000,
              maxTokens: 1000,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  const task: Task = {
    id: "sdk",
    profileId: "p",
    workspace,
    requirement: "read code",
    acceptance: ["read"],
    status: "developing",
    round: 0,
    branch: "b",
    baseRevision: "",
    revision: "",
    createdAt: "now",
    updatedAt: "now",
  };
  const profile = profileSchema.parse({
    id: "p",
    source: workspace,
    checks: [{ name: "noop", file: process.execPath }],
  });
  try {
    const response = await new PiAgent(root).run(
      task,
      profile,
      "developer",
      "Return a short response.",
      new AbortController().signal,
      () => {},
    );
    assert.match(response, /Protocol fixture/);
    assert.equal(requests, 2);
    const reviewer = await new PiAgent(root).run(
      task,
      profile,
      "reviewer",
      "Inspect code.",
      new AbortController().signal,
      () => {},
    );
    assert.match(reviewer, /Protocol fixture/);
    assert.equal(requests, 3);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("stale workspace cannot be published", async () => {
  const root = mkdtempSync(path.join(tempRoot, "stale-"));
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace);
  writeFileSync(path.join(workspace, "a.ts"), "one");
  const store = new Store(path.join(root, "data"));
  writeFileSync(
    path.join(root, "data", "profiles.json"),
    JSON.stringify([
      {
        id: "p",
        source: workspace,
        checks: [{ name: "noop", file: process.execPath }],
      },
    ]),
  );
  const task: Task = {
    id: "stale",
    profileId: "p",
    requirement: "test",
    acceptance: ["a"],
    status: "ready_for_pr",
    round: 0,
    workspace,
    branch: "b",
    baseRevision: "base",
    revision: revision(workspace),
    createdAt: "now",
    updatedAt: "now",
  };
  store.save(task);
  writeFileSync(path.join(workspace, "a.ts"), "two");
  const flow = new Workflow(root, store, {
    async run() {
      throw new Error("not called");
    },
  });
  await assert.rejects(() => flow.publish(task.id), /Workspace changed/);
  store.close();
});
test("cancelled command terminates and does not report success", async () => {
  const root = mkdtempSync(path.join(tempRoot, "cancel-"));
  const controller = new AbortController();
  const running = execute(
    process.execPath,
    ["-e", "setTimeout(()=>{},10000)"],
    root,
    controller.signal,
  );
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(running, /cancelled/);
});
test("invalid review location and schema are rejected", () => {
  assert.throws(() =>
    parseReview(
      '{"findings":[{"id":"x","severity":"blocking","file":"a.ts","line":0,"problem":"x","evidence":"y","recommendation":"z"}],"verdict":"changes_requested"}',
    ),
  );
  assert.throws(() => parseReview("looks good"));
});
import { GitHub } from "../src/integrations/github.js";
import { acquireProcessLock } from "../src/state/process-lock.js";
test("one process owns runtime; release permits restart", () => {
  const root = mkdtempSync(path.join(tempRoot, "lock-"));
  const release = acquireProcessLock(root);
  assert.throws(() => acquireProcessLock(root), /already running/);
  release();
  acquireProcessLock(root)();
});
test("GitHub validates external CI results and keeps missing evidence visible", async () => {
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        req.url?.includes("check-runs")
          ? { check_runs: [] }
          : { state: "success", statuses: [] },
      ),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Missing address");
  const p = profileSchema.parse({
    id: "p",
    source: "local",
    checks: [{ name: "check", file: process.execPath }],
    github: { owner: "owner", repo: "repo" },
  });
  try {
    const ci = await new GitHub(undefined, `http://127.0.0.1:${addr.port}`).ci(
      p,
      "sha",
    );
    assert.equal(ci.checks.length, 0);
    assert.equal(ci.status.statuses.length, 0);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
import { resolveTask, taskSummary } from "../src/tui/terminal-extension.js";
test("terminal resolves task IDs without choosing an ambiguous task", () => {
  const tasks = [{ id: "abcd-one" }, { id: "abcd-two" }] as Task[];
  assert.equal(resolveTask(tasks, "abcd-one", undefined), "abcd-one");
  assert.throws(() => resolveTask(tasks, "abcd", undefined), /不唯一/);
  assert.throws(() => resolveTask(tasks, undefined, undefined), /选择任务/);
});
test("terminal summary includes blocking evidence and actual version", () => {
  const t: Task = {
    id: "task",
    profileId: "p",
    requirement: "feature",
    acceptance: ["criterion"],
    status: "blocked",
    round: 2,
    workspace: "x",
    branch: "b",
    baseRevision: "base",
    revision: "actual-version",
    error: "test failed",
    createdAt: "now",
    updatedAt: "now",
  };
  const text = taskSummary(t);
  assert.match(text, /test failed/);
  assert.match(text, /actual-version/);
  assert.match(text, /criterion/);
});

test("review accepts one fenced JSON result with explanation but rejects ambiguity", () => {
  const json = JSON.stringify({ findings: [], verdict: "pass" });
  const fenced = "\x60\x60\x60json\n" + json + "\n\x60\x60\x60";
  assert.equal(parseReview("Evidence checked.\n" + fenced).verdict, "pass");
  assert.throws(() => parseReview(fenced + "\n" + fenced), /Ambiguous/);
});

test("review extracts one plain JSON object and rejects multiple results", () => {
  const json = JSON.stringify({ findings: [], verdict: "pass" });
  assert.equal(parseReview("Verified evidence.\n" + json).verdict, "pass");
  assert.throws(
    () => parseReview("Results: " + json + "\n" + json),
    /exactly one/,
  );
});

test("native Pi preparation and validation never invoke a developer; static fallback and format retry are recorded", async () => {
  const root = mkdtempSync(path.join(tempRoot, "native-quality-"));
  const source = path.join(root, "source");
  mkdirSync(source);
  writeFileSync(path.join(source, "value.txt"), "bad");
  await git(source, ["init"]);
  await git(source, ["config", "user.name", "Test"]);
  await git(source, ["config", "user.email", "test@localhost"]);
  await git(source, ["add", "."]);
  await git(source, ["commit", "-m", "fixture"]);
  mkdirSync(path.join(root, "data"));
  writeFileSync(
    path.join(root, "data", "profiles.json"),
    JSON.stringify([
      {
        id: "native",
        source,
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
  let reviews = 0;
  const agent: Agent = {
    async run(_task, _profile, role, prompt) {
      assert.equal(
        role,
        "reviewer",
        "native mode must never spawn development",
      );
      reviews++;
      if (reviews === 1) {
        assert.match(prompt, /AI static\/style review/);
        assert.match(prompt, /cohesive responsibilities/);
        return '{"findings":[],"verdict":"approved"}';
      }
      return '{"findings":[],"verdict":"pass"}';
    },
  };
  const store = new Store(path.join(root, "data"));
  const flow = new Workflow(root, store, agent);
  try {
    const task = flow.create({
      profileId: "native",
      requirement: "Improve code quality",
      acceptance: ["value is good"],
    });
    flow.run(task.id, undefined, "prepare");
    await flow.waitForRun();
    assert.equal(store.get(task.id).status, "paused");
    assert.equal(reviews, 0);
    flow.run(task.id, undefined, "validate");
    await flow.waitForRun();
    assert.equal(store.get(task.id).status, "blocked");
    assert.equal(
      reviews,
      0,
      "failed checks return to the current Pi, not another developer",
    );
    writeFileSync(path.join(task.workspace, "value.txt"), "good");
    flow.run(task.id, undefined, "validate");
    await flow.waitForRun();
    assert.equal(store.get(task.id).status, "ready_for_pr");
    assert.equal(reviews, 2);
    assert.ok(
      store.events(task.id).some((e) => e.kind === "static_review_fallback"),
    );
    assert.ok(
      store.events(task.id).some((e) => e.kind === "review_format_failure"),
    );
    writeFileSync(path.join(task.workspace, "value.txt"), "changed");
    await assert.rejects(flow.publish(task.id), /Workspace changed/);
  } finally {
    await flow.shutdown();
    store.close();
  }
});
