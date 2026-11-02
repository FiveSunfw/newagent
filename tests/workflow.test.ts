import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { Store } from "../src/state/store.js";
import { git, inside, revision, execute } from "../src/exec/execution.js";
import { Workflow } from "../src/core/workflow.js";
import {
  parseReview,
  protectedFile,
  type Agent,
} from "../src/model-provider/pi.js";
import {
  profileSchema,
  type Task,
  type Profile,
} from "../src/protocol/types.js";
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
    execution: { mode: "trusted-host", acknowledged: true },
    checks: [{ name: "test", file: process.execPath, args: [] }],
  });
  assert.equal(p.reflexion, false);
  const limited = profileSchema.parse({
    id: "limited",
    source: dir,
    execution: { mode: "trusted-host", acknowledged: true },
    checks: [{ name: "test", file: process.execPath, args: [] }],
    runLimits: { tools: 24, repairs: 3, durationMs: 600000 },
  });
  assert.equal(limited.runLimits?.tools, 24);
  assert.throws(() =>
    profileSchema.parse({
      id: "invalid-limit",
      source: dir,
      execution: { mode: "trusted-host", acknowledged: true },
      checks: [{ name: "test", file: process.execPath, args: [] }],
      runLimits: { tools: 101 },
    }),
  );
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
        reflexion: true,
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
  const store = new Store(path.join(root, "data"));
  let developers = 0,
    reviewers = 0,
    reflectors = 0;
  const developerTurns = new Map<string, number>();
  const developerPrompts: string[] = [];
  const agent: Agent = {
    async run(t: Task, profile: Profile, role, prompt) {
      if (role === "developer") {
        developers++;
        const taskTurn = (developerTurns.get(t.profileId) ?? 0) + 1;
        developerTurns.set(t.profileId, taskTurn);
        developerPrompts.push(prompt);
        const remainsBad =
          t.profileId === "test" ? taskTurn <= 3 : taskTurn === 1;
        writeFileSync(
          path.join(t.workspace, "value.txt"),
          remainsBad ? "still bad" : "good",
        );
        if (taskTurn === 1) throw new Error("Agent returned no result");
        return "done";
      }
      if (role === "reflector") {
        reflectors++;
        assert.equal(profile.reflexion, true);
        assert.match(prompt, /Program evaluator failed/);
        assert.match(prompt, /diff excerpt/);
        assert.match(prompt, /O1/);
        return JSON.stringify({
          diagnosis: "The first edit did not satisfy the executable check.",
          evidenceIds: ["O1"],
          lessons: ["Treat the failed check output as the repair target."],
          doNotRepeat: 0,
          nextSteps: ["Make the smallest change that satisfies the check."],
          uncertainty: "The exact cause still needs source inspection. ".repeat(
            10,
          ),
        });
      }
      assert.equal(role, "reviewer");
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
  assert.equal(developers, 4);
  assert.equal(reviewers, 1);
  assert.equal(reflectors, 2);
  assert.match(developerPrompts[1], /Reflexion memory/);
  assert.match(developerPrompts[2], /Reflexion memory/);
  assert.match(developerPrompts[3], /Reflexion memory/);
  assert.equal(store.get(task.id).reflections?.length, 1);
  assert.deepEqual(
    store.get(task.id).reflections?.[0].reflection.doNotRepeat,
    [],
  );
  assert.equal(
    store.get(task.id).reflections?.[0].reflection.uncertainty.length,
    160,
  );
  assert.ok(
    store.events(task.id).some((event) => event.kind === "reflexion_saved"),
  );
  assert.ok(
    store.events(task.id).some((event) => event.kind === "reflexion_repeated"),
  );
  assert.ok(
    store.events(task.id).some((event) => event.kind === "reflexion_skipped"),
  );
  assert.ok(
    store
      .events(task.id)
      .some((event) => event.kind === "developer_attempt_failure"),
  );
  const checks = store.checks(task.id);
  assert.equal(checks[0].passed, false);
  assert.equal(checks[1].passed, false);
  assert.equal(checks[2].passed, false);
  assert.equal(checks[3].passed, true);
  assert.equal(checks[0].revision, checks[1].revision);
  assert.equal(checks[1].revision, checks[2].revision);
  assert.notEqual(checks[2].revision, checks[3].revision);
  const profilesPath = path.join(root, "data", "profiles.json");
  const profiles = JSON.parse(readFileSync(profilesPath, "utf8")) as unknown[];
  profiles.push({
    id: "test-no-reflexion",
    source,
    strategy: "single-no-rag",
    reflexion: false,
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
  });
  writeFileSync(profilesPath, JSON.stringify(profiles));
  const noReflexionTask = flow.create({
    profileId: "test-no-reflexion",
    requirement: "make value good without Reflexion",
    acceptance: ["value is good"],
  });
  flow.run(noReflexionTask.id);
  await flow.waitForRun();
  assert.equal(store.get(noReflexionTask.id).status, "ready_for_pr");
  assert.equal(developers, 6);
  assert.equal(reflectors, 2);
  assert.equal(store.get(noReflexionTask.id).reflections, undefined);
  assert.ok(
    !store
      .events(noReflexionTask.id)
      .some((event) => event.kind.startsWith("reflexion_")),
  );
  assert.ok(
    developerPrompts
      .slice(4)
      .every((prompt) => !prompt.includes("Reflexion memory")),
  );
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
    reflections: [
      {
        trial: 1,
        sourceRevision: "ref",
        createdAt: new Date().toISOString(),
        observations: [
          { id: "O1", source: "evaluator", fact: "Acceptance failed." },
        ],
        reflection: {
          diagnosis: "The first attempt missed the acceptance behavior.",
          evidenceIds: ["O1"],
          lessons: ["Use the failure output to guide the next edit."],
          doNotRepeat: [],
          nextSteps: ["Inspect the current implementation."],
          uncertainty: "Root cause is not yet confirmed.",
        },
      },
    ],
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
  assert.equal(store.get("id").reflections?.length, 1);
  store.close();
});
test("single-agent strategy passes real checks without invoking a reviewer", async () => {
  const root = mkdtempSync(path.join(tempRoot, "single-"));
  const source = path.join(root, "source");
  mkdirSync(source);
  writeFileSync(path.join(source, "value.txt"), "bad");
  await git(source, ["init"]);
  await git(source, ["config", "user.name", "Test"]);
  await git(source, ["config", "user.email", "test@localhost"]);
  await git(source, ["add", "."]);
  await git(source, ["commit", "-m", "Single-agent fixture"]);
  mkdirSync(path.join(root, "data"));
  writeFileSync(
    path.join(root, "data", "profiles.json"),
    JSON.stringify([
      {
        id: "single",
        source,
        strategy: "single-no-rag",
        execution: { mode: "trusted-host", acknowledged: true },
        checks: [
          {
            name: "value",
            file: process.execPath,
            args: [
              "-e",
              "require('node:assert/strict').equal(require('node:fs').readFileSync('value.txt','utf8'),'good')",
            ],
          },
        ],
      },
    ]),
  );
  const store = new Store(path.join(root, "data"));
  let calls = 0;
  const agent: Agent = {
    async run(task, _profile, role) {
      assert.equal(role, "developer");
      calls++;
      writeFileSync(path.join(task.workspace, "value.txt"), "good");
      return "done";
    },
  };
  const flow = new Workflow(root, store, agent);
  try {
    const task = flow.create({
      profileId: "single",
      requirement: "Fix value",
      acceptance: ["value is good"],
    });
    flow.run(task.id);
    await flow.waitForRun();
    assert.equal(store.get(task.id).status, "ready_for_pr");
    assert.equal(calls, 1);
    assert.ok(store.get(task.id).verificationFingerprint);
    assert.equal(store.checks(task.id)[0].passed, true);
    assert.equal(store.get(task.id).review, undefined);
  } finally {
    await flow.shutdown();
    store.close();
  }
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
  let floodTools = false;
  let repeatInvalid = false;
  let repeatRead = false;
  let expectNoTools = false;
  let expectNoCheckTool = false;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests++;
      const parsed = JSON.parse(body) as {
        messages: unknown[];
        tools?: {
          function: {
            name: string;
            parameters?: unknown;
            description?: string;
          };
        }[];
      };
      assert.ok(parsed.messages.length);
      if (expectNoTools) assert.equal(parsed.tools?.length ?? 0, 0);
      else {
        assert.ok(parsed.tools?.some((t) => t.function.name === "read_file"));
        const check = parsed.tools?.find(
          (tool) => tool.function.name === "run_check",
        );
        if (expectNoCheckTool) assert.equal(check, undefined);
        else {
          assert.ok(check);
          assert.match(
            JSON.stringify(check.function.parameters),
            /"const":"noop"/,
          );
          assert.match(check.function.description ?? "", /noop/);
        }
      }
      assert.ok(!(parsed.tools ?? []).some((t) => t.function.name === "bash"));
      if (requests <= 2 || floodTools || repeatInvalid || repeatRead) {
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
                    tool_calls: floodTools
                      ? Array.from({ length: 102 }, (_, index) => ({
                          index,
                          id: `invalid-${index}`,
                          type: "function",
                          function: {
                            name: "read_file",
                            arguments: JSON.stringify({
                              path: "hello.ts",
                              startLine: index + 1,
                            }),
                          },
                        }))
                      : [
                          {
                            index: 0,
                            id: "read-1",
                            type: "function",
                            function: {
                              name: "read_file",
                              arguments: repeatRead
                                ? '{"path":"hello.ts"}'
                                : repeatInvalid
                                  ? '{"apiKey":"fixture-sensitive-input"}'
                                  : requests === 1
                                    ? '{"path":"hello.ts"}'
                                    : '{"apiKey":"fixture-sensitive-input"}',
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
    execution: { mode: "trusted-host", acknowledged: true },
    checks: [{ name: "noop", file: process.execPath }],
  });
  try {
    const observed: { kind: string; body: unknown }[] = [];
    const response = await new PiAgent(root).run(
      task,
      profile,
      "developer",
      "Return a short response.",
      new AbortController().signal,
      (kind, body) => observed.push({ kind, body }),
    );
    assert.match(response, /Protocol fixture/);
    assert.equal(requests, 3);
    assert.equal(
      task.budget?.tools,
      2,
      "SDK-rejected arguments still consume the shared budget",
    );
    assert.ok(
      observed.some((e) => {
        if (e.kind !== "tool_failure" || !e.body || typeof e.body !== "object")
          return false;
        const b = e.body as { failureCategory?: string };
        return b.failureCategory === "invalid_arguments";
      }),
      JSON.stringify(observed, null, 2),
    );
    assert.ok(
      !JSON.stringify(observed).includes("fixture-sensitive-input"),
      "SDK validation messages must not persist raw arguments",
    );
    assert.ok(
      !JSON.stringify(observed).includes('"path":"hello.ts"'),
      "tool arguments are never stored in events",
    );
    expectNoCheckTool = true;
    let reviewer = "";
    try {
      reviewer = await new PiAgent(root).run(
        task,
        profile,
        "reviewer",
        "Inspect code.",
        new AbortController().signal,
        () => {},
      );
    } finally {
      expectNoCheckTool = false;
    }
    assert.match(reviewer, /Protocol fixture/);
    assert.equal(requests, 4);
    assert.equal(task.budget?.tools, 2);
    expectNoTools = true;
    let reflectionResponse = "";
    try {
      reflectionResponse = await new PiAgent(root).run(
        task,
        profile,
        "reflector",
        "Reflect on these verifier observations and return JSON.",
        new AbortController().signal,
        () => {},
      );
    } finally {
      expectNoTools = false;
    }
    assert.match(reflectionResponse, /Protocol fixture/);
    assert.equal(requests, 5);
    assert.equal(
      task.budget?.tools,
      2,
      "Tool-free reflection must not consume tool calls",
    );
    task.budget!.startedAt = Date.now() - 1800001;
    await assert.rejects(
      new PiAgent(root).run(
        task,
        profile,
        "developer",
        "Expired run",
        new AbortController().signal,
        () => {},
      ),
      (error: unknown) =>
        error instanceof Error && "kind" in error && error.kind === "timeout",
    );
    assert.equal(
      requests,
      5,
      "Expired runs must not issue another model request",
    );
    task.budget = { startedAt: Date.now(), tools: 0, repairs: 0 };
    repeatInvalid = true;
    const repeatedEvents: { kind: string; body: unknown }[] = [];
    await assert.rejects(
      new PiAgent(root).run(
        task,
        profile,
        "developer",
        "Repeated-invalid-input fixture",
        new AbortController().signal,
        (kind, body) => repeatedEvents.push({ kind, body }),
      ),
      (error: unknown) =>
        error instanceof Error &&
        "kind" in error &&
        error.kind === "invalid_input",
    );
    assert.equal(
      task.budget.tools,
      2,
      "A repeated failed call stops before exhausting the run budget",
    );
    assert.ok(
      repeatedEvents.some(
        (event) =>
          event.kind === "tool_failure" &&
          JSON.stringify(event.body).includes("repeated_failed_input"),
      ),
    );
    assert.ok(
      !JSON.stringify(repeatedEvents).includes("fixture-sensitive-input"),
    );
    repeatInvalid = false;
    task.budget = { startedAt: Date.now(), tools: 0, repairs: 0 };
    repeatRead = true;
    const repeatedReadEvents: { kind: string; body: unknown }[] = [];
    await assert.rejects(
      new PiAgent(root).run(
        task,
        profile,
        "developer",
        "Repeated unchanged read fixture",
        new AbortController().signal,
        (kind, body) => repeatedReadEvents.push({ kind, body }),
      ),
      (error: unknown) =>
        error instanceof Error &&
        "kind" in error &&
        error.kind === "invalid_input",
    );
    assert.equal(
      task.budget.tools,
      4,
      "Repeated unchanged reads stop after a small bounded number of calls",
    );
    assert.ok(
      repeatedReadEvents.some(
        (event) =>
          event.kind === "tool_failure" &&
          JSON.stringify(event.body).includes("repeated_successful_read"),
      ),
    );
    repeatRead = false;
    task.budget = { startedAt: Date.now(), tools: 0, repairs: 0 };
    floodTools = true;
    await assert.rejects(
      new PiAgent(root).run(
        task,
        profile,
        "developer",
        "Budget flood fixture",
        new AbortController().signal,
        () => {},
      ),
      (error: unknown) =>
        error instanceof Error && "kind" in error && error.kind === "budget",
    );
    assert.equal(task.budget.tools, 100);
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
        execution: { mode: "trusted-host", acknowledged: true },
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
    execution: { mode: "trusted-host", acknowledged: true },
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
