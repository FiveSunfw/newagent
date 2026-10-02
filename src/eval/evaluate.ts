import { acquireProcessLock } from "../state/process-lock.js";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../state/store.js";
import { PiAgent } from "../model-provider/pi.js";
import { Workflow } from "../core/workflow.js";
import { git, revision } from "../exec/execution.js";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
if (!existsSync(path.join(root, "data", "model.json")))
  throw new Error("Configure real model before evaluation");
const mode = process.argv[2] ?? "workflow";
if (!["workflow", "direct"].includes(mode))
  throw new Error("Mode must be workflow or direct");
const cases = JSON.parse(
  readFileSync(path.join(root, "data", "eval", "cases.json"), "utf8"),
) as {
  id: string;
  profileId: string;
  requirement: string;
  acceptance: string[];
}[];
const releaseLock = acquireProcessLock(root);
const store = new Store(path.join(root, "data"));
const agent = new PiAgent(root);
const flow = new Workflow(root, store, agent);
const output = [];
try {
  for (const c of cases) {
    const started = Date.now();
    const task = flow.create(c);
    let error: string | undefined;
    try {
      if (mode === "workflow") {
        flow.run(task.id);
        while (true) {
          await new Promise((r) => setTimeout(r, 200));
          const t = store.get(task.id);
          if (["ready_for_pr", "blocked", "paused"].includes(t.status)) {
            error = t.error;
            break;
          }
        }
      } else {
        const profile = flow.profile(task);
        mkdirSync(path.dirname(task.workspace), { recursive: true });
        await git(path.dirname(task.workspace), [
          "clone",
          "--no-hardlinks",
          profile.source,
          task.workspace,
        ]);
        task.baseRevision = await git(task.workspace, ["rev-parse", "HEAD"]);
        await git(task.workspace, ["checkout", "-b", task.branch]);
        await agent.run(
          task,
          profile,
          "developer",
          `${c.requirement}\nAcceptance:\n${c.acceptance.join("\n")}`,
          new AbortController().signal,
          (k, b) => store.event(task.id, k, b),
        );
        task.revision = revision(task.workspace);
        store.save(task);
        await flow.checks(task, profile, "check", new AbortController().signal);
        await flow.checks(
          task,
          profile,
          "acceptance",
          new AbortController().signal,
        );
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const current = store.get(task.id);
    const checks = store
      .checks(task.id)
      .filter(
        (x) =>
          existsSync(task.workspace) && x.revision === revision(task.workspace),
      );
    const passed =
      !error &&
      checks.some((x) => x.kind === "acceptance") &&
      checks.every((x) => x.passed);
    output.push({
      caseId: c.id,
      taskId: task.id,
      mode,
      passed,
      status: current.status,
      error,
      durationMs: Date.now() - started,
      checks,
    });
    console.log(c.id, passed ? "PASS" : "FAIL");
    writeFileSync(
      path.join(root, "data", "eval", mode + "-latest.json"),
      JSON.stringify(
        {
          mode,
          finishedAt: new Date().toISOString(),
          completed: output.length,
          passed: output.filter((x) => x.passed).length,
          results: output,
        },
        null,
        2,
      ),
    );
  }
} finally {
  await flow.shutdown();
  store.close();
  releaseLock();
}
