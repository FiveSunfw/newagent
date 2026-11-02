import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { Store } from "../state/store.js";
import { acquireProcessLock } from "../state/process-lock.js";
import { PiAgent, parseReview } from "../model-provider/pi.js";
import { git } from "../exec/execution.js";
import { profileSchema, type Review, type Task } from "../protocol/types.js";
import {
  configureLocalRun,
  evaluationRoot,
  localHealth,
  readJson,
  saveJson,
} from "./local-environment.js";
const dataset = z
  .object({
    cases: z.array(
      z.object({
        id: z.string(),
        repository: z.string(),
        profile: profileSchema,
        referenceRevision: z.string(),
        seededRevision: z.string(),
        mutation: z.array(
          z.object({ file: z.string(), before: z.string(), after: z.string() }),
        ),
      }),
    ),
  })
  .parse(readJson(path.join(evaluationRoot, "dataset.json")));
const root = path.join(evaluationRoot, "review-v1");
mkdirSync(root, { recursive: true });
const releaseLock = acquireProcessLock(root);
configureLocalRun(root);
await localHealth();
const samples = [
  ...dataset.cases.map((c) => ({ c, clean: false })),
  ...dataset.cases
    .filter((c) =>
      ["mitt-wildcard", "stringify-nonfinite", "dlv-falsy-values"].includes(
        c.id,
      ),
    )
    .map((c) => ({ c, clean: true })),
];
const store = new Store(path.join(root, "data"));
const agent = new PiAgent(root);
const results = [];
try {
  for (const { c, clean } of samples) {
    const sample = c.id + (clean ? "-clean" : "-seeded");
    const resultPath = path.join(root, sample + ".json");
    if (existsSync(resultPath)) {
      results.push(readJson(resultPath));
      continue;
    }
    const workspace = path.join(root, "workspaces", sample);
    mkdirSync(path.dirname(workspace), { recursive: true });
    if (!existsSync(path.join(workspace, ".git")))
      await git(path.dirname(workspace), [
        "clone",
        "--no-hardlinks",
        "--",
        c.profile.source,
        workspace,
      ]);
    await git(workspace, [
      "checkout",
      clean ? c.referenceRevision : c.seededRevision,
    ]);
    const task: Task = store.list().find((t) => t.id === sample) ?? {
      id: sample,
      profileId: sample,
      workspace,
      status: "reviewing",
      round: 0,
      branch: "readonly",
      requirement:
        "Independently review implementation correctness against public API documentation",
      acceptance: ["Evidence-based findings"],
      baseRevision: clean ? c.referenceRevision : c.seededRevision,
      revision: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.save(task);
    const profile = {
      ...c.profile,
      id: sample,
      strategy: "adaptive-rag" as const,
    };
    const truth = clean
      ? []
      : c.mutation.map((m) => {
          const content = readFileSync(path.join(workspace, m.file), "utf8");
          const index = m.after ? content.indexOf(m.after) : -1;
          return {
            file: m.file,
            line: index < 0 ? null : content.slice(0, index).split("\n").length,
          };
        });
    const started = Date.now();
    let review: Review | undefined,
      error: string | undefined,
      repaired = false;
    const controller = new AbortController();
    try {
      const prompt =
        'Review this repository\'s implementation and callers against its README public API contract. Inspect actual source with read-only tools. Do not propose speculative abstractions or dependency upgrades. Return only JSON: {"findings":[{"id":"R1","severity":"blocking|suggestion","file":"relative path","line":1,"problem":"...","evidence":"...","recommendation":"..."}],"verdict":"pass|changes_requested"}. Blocking findings require a concrete functional failure, accurate location, and evidence. You may return no findings when the code is correct.';
      const text = await agent.run(
        task,
        profile,
        "reviewer",
        prompt,
        controller.signal,
        (kind, body) => {
          if (kind === "run_budget") store.save(task);
          store.event(task.id, kind, body);
        },
      );
      try {
        review = parseReview(text);
      } catch {
        repaired = true;
        const repair = await agent.run(
          task,
          profile,
          "reviewer",
          "Repair the format only; do not invent findings. Return exactly one valid review JSON with findings and verdict pass or changes_requested. Original:\n" +
            text,
          controller.signal,
          (kind, body) => {
            if (kind === "run_budget") store.save(task);
            store.event(task.id, kind, body);
          },
        );
        review = parseReview(repair);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const blocking =
      review?.findings.filter((f) => f.severity === "blocking") ?? [];
    const valid = blocking.filter((f) => {
      if (path.isAbsolute(f.file) || f.file.split(/[\\/]/).includes(".."))
        return false;
      const resolved = path.resolve(workspace, f.file);
      if (!resolved.startsWith(workspace + path.sep)) return false;
      if (!existsSync(resolved) || !statSync(resolved).isFile()) return false;
      if (
        !realpathSync(resolved).startsWith(realpathSync(workspace) + path.sep)
      )
        return false;
      return f.line <= readFileSync(resolved, "utf8").split("\n").length;
    });
    const matches = truth.map((t) =>
      valid.filter(
        (f) =>
          path
            .relative(workspace, path.resolve(workspace, f.file))
            .split(path.sep)
            .join("/") === t.file &&
          (t.line === null || Math.abs(f.line - t.line) <= 5),
      ),
    );
    const matchedIds = new Set(matches.flat().map((f) => f.id));
    const record = {
      sample,
      repository: c.repository,
      clean,
      truth,
      review,
      error,
      formatRepair: repaired,
      durationMs: Date.now() - started,
      groundTruthCount: truth.length,
      detectedByLocation: matches.filter((m) => m.length > 0).length,
      blockingCount: blocking.length,
      matchedBlockingCount: matchedIds.size,
      unmatchedBlockingCount: blocking.length - matchedIds.size,
      invalidLocations: blocking.length - valid.length,
      humanAdjudicated: false,
      scoringScope:
        "Automatic file/line (+/-5) match proxy; deleted anchors with unknown lines use file-only matching. Unmatched findings are candidates for human adjudication, not proven false positives.",
      events: store.events(task.id),
    };
    saveJson(resultPath, record);
    results.push(record);
    saveJson(path.join(root, "results.json"), {
      realModel: true,
      samples: samples.length,
      humanAdjudicated: false,
      results,
    });
    console.log(
      JSON.stringify({
        sample,
        detected: record.detectedByLocation,
        blocking: blocking.length,
        error,
        durationMs: record.durationMs,
      }),
    );
  }
} finally {
  store.close();
  releaseLock();
}
