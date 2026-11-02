import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { Store } from "../state/store.js";
import { acquireProcessLock } from "../state/process-lock.js";
import { Workflow } from "../core/workflow.js";
import { PiAgent } from "../model-provider/pi.js";
import { files, git, revision } from "../exec/execution.js";
import { TaskExecution } from "../exec/task-execution.js";
import { executeWorkerWithRecovery } from "./worker-launch.js";
import { profileSchema } from "../protocol/types.js";
import {
  configureLocalRun,
  configureDeepseekRun,
  configureSiliconFlowRun,
  deepseekHealth,
  evaluationContextWindow,
  evaluationDatasetVersion,
  evaluationRoot,
  evaluationSampling,
  localEmbeddingHealth,
  localHealth,
  readJson,
  saveJson,
  siliconFlowHealth,
} from "./local-environment.js";

const mode = process.argv[2];
if (
  mode !== "calibration" &&
  mode !== "formal" &&
  mode !== "diagnostic" &&
  mode !== "sampling-diagnostic" &&
  mode !== "context-diagnostic" &&
  mode !== "rag-diagnostic" &&
  mode !== "window-diagnostic" &&
  mode !== "single-case-diagnostic" &&
  mode !== "single-case-holdout-diagnostic"
)
  throw new Error(
    "Use calibration, diagnostic, sampling-diagnostic, context-diagnostic, rag-diagnostic, window-diagnostic, single-case-diagnostic, single-case-holdout-diagnostic or formal",
  );
const datasetPath = path.join(evaluationRoot, "dataset.json");
const dataset = z
  .object({
    version: z.string(),
    provenance: z.string(),
    cases: z.array(
      z.object({
        id: z.string(),
        repository: z.string(),
        split: z.string(),
        category: z.string(),
        requirement: z.string(),
        profile: profileSchema,
        upstream: z.object({ repo: z.string(), sha: z.string() }),
        seededRevision: z.string(),
      }),
    ),
  })
  .parse(readJson(datasetPath));
if (dataset.version !== `repository-eval-${evaluationDatasetVersion}`)
  throw new Error(
    "Dataset version does not match NEWAGENT_EVAL_DATASET_VERSION; refusing a mixed or stale run",
  );
if (dataset.version === "repository-eval-v1")
  throw new Error(
    "Frozen v1 prompts conflict with the corrected evaluation harness. Create repository-eval-v2 for new runs.",
  );
const datasetHash = createHash("sha256")
  .update(readFileSync(datasetPath))
  .digest("hex");
const runtimeHash = createHash("sha256");
for (const directory of [
  "core",
  "exec",
  "model-provider",
  "protocol",
  "retrieval",
  "state",
  "integrations",
]) {
  const root = path.resolve("src", directory);
  for (const file of files(root)
    .filter((file) => file.endsWith(".ts"))
    .sort())
    runtimeHash
      .update(directory + "/" + file + "\0")
      .update(readFileSync(path.join(root, file)));
}
const runtimeSourceHash = runtimeHash.digest("hex");
const baseSampling = evaluationSampling(
  process.env.NEWAGENT_EVAL_PRESENCE_PENALTY === undefined
    ? 1.5
    : Number(process.env.NEWAGENT_EVAL_PRESENCE_PENALTY),
);
const evaluationModel =
  process.env.NEWAGENT_EVAL_MODEL?.trim() ?? "newagent-qwen3-1.7b";
const singleCaseModes = new Set([
  "single-case-diagnostic",
  "single-case-holdout-diagnostic",
]);
const isHostedDeepseek = new Set([
  "deepseek-flash",
  "siliconflow-deepseek-flash",
]).has(evaluationModel);
if (
  !new Set([
    "newagent-qwen3-1.7b",
    "deepseek-flash",
    "siliconflow-deepseek-flash",
  ]).has(evaluationModel)
)
  throw new Error(
    "NEWAGENT_EVAL_MODEL must be newagent-qwen3-1.7b, deepseek-flash or siliconflow-deepseek-flash",
  );
if (isHostedDeepseek && !singleCaseModes.has(mode))
  throw new Error("Hosted DeepSeek is enabled only for bounded single-case diagnostics");
const topP = z
  .number()
  .finite()
  .min(0)
  .max(1)
  .parse(
    process.env.NEWAGENT_EVAL_TOP_P === undefined
      ? isHostedDeepseek
        ? 1
        : 0.8
      : Number(process.env.NEWAGENT_EVAL_TOP_P),
  );
if (isHostedDeepseek && topP !== 1)
  throw new Error("Hosted DeepSeek comparison fixes top_p at 1; use NEWAGENT_EVAL_TOP_P=1");
const sampling = { ...baseSampling, topP };
const contextWindow = evaluationContextWindow(
  process.env.NEWAGENT_EVAL_CONTEXT_WINDOW === undefined
    ? 32768
    : Number(process.env.NEWAGENT_EVAL_CONTEXT_WINDOW),
);
const singleCaseStrategy =
  singleCaseModes.has(mode)
    ? z
        .enum(["single-no-rag", "single-rag", "adaptive-rag"])
        .parse(process.env.NEWAGENT_EVAL_STRATEGY ?? "single-no-rag")
    : undefined;
if (
  !singleCaseModes.has(mode) &&
  process.env.NEWAGENT_EVAL_STRATEGY !== undefined
)
  throw new Error(
    "NEWAGENT_EVAL_STRATEGY is only valid for single-case diagnostic modes",
  );
const toolLimit =
  evaluationModel === "siliconflow-deepseek-flash"
    ? z
        .number()
        .int()
        .positive()
        .max(100)
        .parse(Number(process.env.NEWAGENT_EVAL_TOOL_LIMIT ?? 24))
    : 100;
const repairLimit = 3;
const durationMs =
  evaluationModel === "siliconflow-deepseek-flash" ? 600000 : 1800000;
const evaluationConfigHash = createHash("sha256")
  .update(readFileSync(path.resolve("src/eval/local-environment.ts")))
  .update(readFileSync(path.resolve("../data/sandbox.json")))
  .update(readFileSync(path.resolve("../data/retrieval.json")))
  .update(readFileSync(path.resolve("../data/embedding/model-manifest.json")))
  .update(
    JSON.stringify({
      sampling,
      contextWindow,
      evaluationModel,
      singleCaseStrategy,
      limits: { tools: toolLimit, repairs: repairLimit, durationMs },
    }),
  )
  .digest("hex");
const evaluationHarnessHash = createHash("sha256");
for (const file of [
  "src/eval/run-repository-eval.ts",
  "src/eval/worker-launch.ts",
  "src/eval/local-worker.ts",
  "src/eval/local-environment.ts",
  "src/eval/repository-cases.ts",
  "src/eval/retrieval-questions.ts",
  "src/eval/evaluate-retrieval.ts",
  "src/eval/evaluate-review.ts",
  "src/core/harness.ts",
  "src/exec/task-execution.ts",
  "tests/harness.test.ts",
  "tests/worker-launch.test.ts",
  "tests/task-execution.test.ts",
  "tests/workflow.test.ts",
  "package.json",
  "package-lock.json",
  "scripts/report-local-eval.mjs",
])
  evaluationHarnessHash
    .update(file + "\0")
    .update(readFileSync(path.resolve(file)));
const evalHarnessHash = evaluationHarnessHash.digest("hex");
const localModelAlias =
  contextWindow >= 32768
    ? "newagent-qwen3-1.7b-32k"
    : "newagent-qwen3-1.7b";
const health =
  evaluationModel === "siliconflow-deepseek-flash"
    ? singleCaseStrategy !== "single-no-rag"
      ? await localEmbeddingHealth()
      : {
          embedding: { status: "not-required-single-no-rag" },
          models: { models: [] as { name: string; digest: string }[] },
          backendContextWindow: undefined,
        }
    : await localHealth(localModelAlias);
const providerHealth =
  evaluationModel === "deepseek-flash"
    ? await deepseekHealth()
    : evaluationModel === "siliconflow-deepseek-flash"
      ? await siliconFlowHealth()
      : undefined;
const strategies = ["single-no-rag", "single-rag", "adaptive-rag"] as const;
type Strategy = (typeof strategies)[number];
const eligibleCases =
  mode === "calibration" ||
  mode === "diagnostic" ||
  mode === "sampling-diagnostic" ||
  mode === "context-diagnostic" ||
  mode === "rag-diagnostic" ||
  mode === "window-diagnostic"
    ? dataset.cases.filter((c) =>
        ["mitt-wildcard", "stringify-nonfinite", "dlv-falsy-values"].includes(
          c.id,
        ),
      )
    : dataset.cases;
const singleCaseId =
  process.argv[3]?.trim() ?? process.env.NEWAGENT_EVAL_CASE_ID?.trim();
if (singleCaseModes.has(mode) && !singleCaseId)
  throw new Error(
    "Single-case diagnostic requires one case ID argument",
  );
if (!singleCaseModes.has(mode) && singleCaseId)
  throw new Error(
    "A case ID argument is only valid for single-case diagnostic modes",
  );
const selected =
  singleCaseModes.has(mode)
    ? eligibleCases.filter((c) => c.id === singleCaseId)
    : eligibleCases;
const requiredSingleCaseSplit =
  mode === "single-case-holdout-diagnostic" ? "holdout" : "development";
if (
  singleCaseModes.has(mode) &&
  (selected.length !== 1 || selected[0].split !== requiredSingleCaseSplit)
)
  throw new Error(
    "Single-case mode requires exactly one case in its designated split",
  );
if (
  (mode === "diagnostic" ||
    mode === "sampling-diagnostic" ||
    mode === "context-diagnostic" ||
    mode === "rag-diagnostic" ||
    mode === "window-diagnostic" ||
    mode === "single-case-diagnostic") &&
  selected.some((c) => c.split !== "development")
)
  throw new Error("Diagnostic mode may use development cases only");
const replicates = mode === "formal" ? 2 : 1;
const assignments =
  mode === "diagnostic"
    ? selected.flatMap((c) =>
        [false, true].map((reflexion) => ({
          c,
          strategy: "single-no-rag" as const,
          reflexion,
        })),
      )
    : mode === "sampling-diagnostic"
      ? selected.map((c) => ({
          c,
          strategy: "single-no-rag" as const,
          reflexion: false,
        }))
      : mode === "context-diagnostic"
        ? selected.flatMap((c) =>
            (["single-no-rag", "single-rag"] as const).map((strategy) => ({
              c,
              strategy,
              reflexion: false,
            })),
          )
        : mode === "rag-diagnostic"
          ? selected.map((c) => ({
              c,
              strategy: "single-rag" as const,
              reflexion: false,
            }))
        : mode === "window-diagnostic"
          ? selected.map((c) => ({
              c,
              strategy: "single-no-rag" as const,
              reflexion: false,
            }))
          : singleCaseModes.has(mode)
            ? selected.map((c) => ({
                c,
                strategy: singleCaseStrategy ?? "single-no-rag",
                reflexion: false,
              }))
          : selected.flatMap((c) =>
              strategies.map((strategy) => ({
                c,
                  strategy,
                  reflexion: false,
                })),
              );
const batchName = process.env.NEWAGENT_EVAL_BATCH ?? mode + "-v1";
if (!new RegExp(`^${mode}-v[1-9][0-9]*$`).test(batchName))
  throw new Error("Invalid batch name");
const batch = path.join(evaluationRoot, batchName);
mkdirSync(batch, { recursive: true });
const releaseLock = acquireProcessLock(batch);
try {
  const manifest = {
    mode,
    version: dataset.version,
    datasetHash,
    runtimeSourceHash,
    evaluationConfigHash,
    evalHarnessHash,
    provenance: dataset.provenance,
    health,
    providerHealth,
    providerContextWindow:
      (providerHealth && "contextWindow" in providerHealth
        ? providerHealth.contextWindow
        : undefined) ??
      (evaluationModel === "newagent-qwen3-1.7b"
        ? health.backendContextWindow
        : null),
    tasks: selected.length,
    caseFilter: singleCaseId ?? null,
    model: evaluationModel,
    modelProvider:
      evaluationModel === "deepseek-flash"
        ? "deepseek"
        : evaluationModel === "siliconflow-deepseek-flash"
          ? "siliconflow"
          : "local-ollama",
    strategies,
    assignmentPlan: assignments.map(({ c, strategy, reflexion }) => ({
      case: c.id,
      strategy,
      reflexion,
    })),
    replicates,
    runs: assignments.length * replicates,
    limits: {
      tools: toolLimit,
      repairs: repairLimit,
      durationMinutes: durationMs / 60000,
      durationMs,
    },
    reflexion: {
      diagnostic:
        mode === "diagnostic"
          ? "Matched single-no-rag runs with Reflexion disabled/enabled"
          : "Disabled for standard arms; enable explicitly in profile configuration",
      maxStoredExperiences: 3,
      maxReflectorCallsPerTask: mode === "diagnostic" ? 3 : 0,
      reflectorTools: 0,
      reflectorCallsCountAgainstSharedToolBudget: false,
      overallDeadlineMinutes: 30,
    },
    context: contextWindow,
    backendContextWindow: health.backendContextWindow,
    maxOutputTokens: 2048,
    temperature: 0.7,
    topP: sampling.topP,
    presencePenalty: sampling.presencePenalty,
    sampling,
    apiCost: evaluationModel === "newagent-qwen3-1.7b" ? 0 : null,
    costScope:
      evaluationModel === "newagent-qwen3-1.7b"
        ? "Local model and embedding; no paid API. Electricity not estimated."
        : evaluationModel === "siliconflow-deepseek-flash"
          ? "SiliconFlow token usage only; reconcile actual CNY billing with the account"
          : "DeepSeek provider-reported token usage; billed amount must be checked in the account ledger.",
    reviewRouting:
      "Single-agent arms have deterministic gates only; adaptive arm adds independent Review and on-demand retrieval expert. Report functional acceptance and delivery gate separately.",
    timeoutPolicy:
      durationMs / 60000 +
      "-minute run budget; incomplete_timeout is not labeled a code defect. Late completed writes are independently rechecked. Provider/input truncation is reported separately.",
  };
  const manifestPath = path.join(batch, "manifest.json");
  if (existsSync(manifestPath)) {
    const prior = z
      .object({
        datasetHash: z.string(),
        runtimeSourceHash: z.string().optional(),
        evaluationConfigHash: z.string().optional(),
        evalHarnessHash: z.string().optional(),
        caseFilter: z.string().nullable().optional(),
        model: z.string().optional(),
        health: z.object({
          models: z.object({
            models: z.array(z.object({ name: z.string(), digest: z.string() })),
          }),
        }),
        maxOutputTokens: z.number(),
        context: z.number().optional(),
        backendContextWindow: z.number().optional(),
        temperature: z.number(),
        topP: z.number(),
        presencePenalty: z.number(),
        sampling: z
          .object({
            temperature: z.number(),
            topP: z.number(),
            presencePenalty: z.number(),
            maxOutputTokens: z.number(),
          })
          .optional(),
      })
      .parse(readJson(manifestPath));
    if (
      prior.datasetHash !== datasetHash ||
      prior.runtimeSourceHash !== runtimeSourceHash ||
      prior.evaluationConfigHash !== evaluationConfigHash ||
      prior.evalHarnessHash !== evalHarnessHash ||
      prior.caseFilter !== (singleCaseId ?? null) ||
      prior.model !== evaluationModel ||
      prior.health.models.models.find((m) =>
        m.name.startsWith("newagent-qwen3-1.7b"),
      )?.digest !==
        health.models.models.find((m) =>
          m.name.startsWith("newagent-qwen3-1.7b"),
        )?.digest ||
      prior.context !== contextWindow ||
      prior.backendContextWindow !== health.backendContextWindow ||
      prior.maxOutputTokens !== 2048 ||
      prior.temperature !== sampling.temperature ||
      prior.topP !== sampling.topP ||
      prior.presencePenalty !== sampling.presencePenalty ||
      JSON.stringify(prior.sampling) !== JSON.stringify(sampling)
    )
      throw new Error(
        "Dataset/runtime/configuration changed; cannot resume this batch",
      );
  } else saveJson(manifestPath, manifest);
  console.log(JSON.stringify(manifest));
  for (let replicate = 1; replicate <= replicates; replicate++)
    for (const { c, strategy, reflexion } of assignments) {
      const reflexionLabel = reflexion ? "reflexion-on" : "reflexion-off";
      const runId =
        mode === "diagnostic"
          ? `${c.id}-${strategy}-${reflexionLabel}-${replicate}`
          : `${c.id}-${strategy}-${replicate}`;
      const root = path.join(batch, runId);
      mkdirSync(root, { recursive: true });
      if (existsSync(path.join(root, "result.json"))) {
        console.log(
          JSON.stringify({
            event: "already-recorded",
            case: c.id,
            strategy,
            reflexion,
            replicate,
          }),
        );
        continue;
      }
      configureLocalRun(root, sampling, contextWindow);
      if (evaluationModel === "deepseek-flash")
        configureDeepseekRun(root, sampling, contextWindow);
      if (evaluationModel === "siliconflow-deepseek-flash")
        configureSiliconFlowRun(root, sampling, contextWindow);
      // Separate vector namespaces: prior attempts must not bias another arm.
      const profile = {
        ...c.profile,
        ...(evaluationModel === "siliconflow-deepseek-flash"
          ? {
              runLimits: {
                tools: toolLimit,
                repairs: repairLimit,
                durationMs,
              },
            }
          : {}),
        id: `${batchName}-${c.id}-${strategy}-${reflexionLabel}-${replicate}`,
        strategy,
        reflexion,
      };
      saveJson(path.join(root, "data", "profiles.json"), [profile]);
      let store = new Store(path.join(root, "data"));
      let task = store.list()[0];
      if (!task) {
        const flow = new Workflow(root, store, new PiAgent(root));
        task = flow.create({
          profileId: profile.id,
          requirement: c.requirement,
          acceptance: [
            "The fixed external acceptance and contract smoke checks must pass",
            "Preserve public API and protected upstream files",
            "Tests, fixtures and validation commands are fixed evidence; do not modify them",
          ],
        });
        store.event(task.id, "evaluation_assignment", {
          case: c.id,
          strategy,
          reflexion,
          replicate,
          datasetHash,
          split: c.split,
        });
        await flow.shutdown();
      }
      store.close();
      const started = Date.now();
      console.log(
        JSON.stringify({
          event: "start",
          case: c.id,
          strategy,
          reflexion,
          replicate,
          taskId: task.id,
        }),
      );
      const worker = path.resolve("src/eval/local-worker.ts");
      const args = [
        path.resolve("node_modules/tsx/dist/cli.mjs"),
        worker,
        root,
        task.id,
        ...(c.category === "recovery" ? ["recovery"] : []),
      ];
      const workerEnvironment: Record<string, string> = {};
      if (evaluationModel === "deepseek-flash") {
        const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
        if (!apiKey)
          throw new Error(
            "DeepSeek comparison requires DEEPSEEK_API_KEY in the parent process",
          );
        // The worker runs on the host; TaskExecution never forwards this key into Docker.
        workerEnvironment.DEEPSEEK_API_KEY = apiKey;
        if (process.env.NODE_OPTIONS)
          workerEnvironment.NODE_OPTIONS = process.env.NODE_OPTIONS;
      }
      if (evaluationModel === "siliconflow-deepseek-flash") {
        const apiKey = process.env.NEWAGENT_API_KEY?.trim();
        if (!apiKey)
          throw new Error(
            "SiliconFlow comparison requires NEWAGENT_API_KEY in the parent process",
          );
        // The model request runs in this host worker; TaskExecution never forwards the key into Docker.
        workerEnvironment.NEWAGENT_API_KEY = apiKey;
        if (process.env.NODE_OPTIONS)
          workerEnvironment.NODE_OPTIONS = process.env.NODE_OPTIONS;
      }
      const workerRun = await executeWorkerWithRecovery({
        file: process.execPath,
        args,
        cwd: path.resolve("."),
        timeoutMs: 1860000,
        initialLog: path.join(root, "worker.log"),
        resumeLog: path.join(root, "resume.log"),
        environment: workerEnvironment,
        resumeExitCode: c.category === "recovery" ? 69 : undefined,
        onResume: () =>
          console.log(
            JSON.stringify({
              event: "resume-after-checkpoint",
              case: c.id,
              strategy,
              replicate,
            }),
          ),
      });
      const {
        initial: execution,
        final: finalExecution,
        restarted,
      } = workerRun;
      if (restarted && finalExecution.exitCode !== 0)
        console.log(
          JSON.stringify({
            event: "worker-exit",
            case: c.id,
            exitCode: finalExecution.exitCode,
          }),
        );
      store = new Store(path.join(root, "data"));
      try {
        task = store.get(task.id);
        let functionalAcceptance = false,
          contractSmoke = false;
        const independent = [];
        if (existsSync(path.join(task.workspace, ".git"))) {
          const boundary = new TaskExecution(root, task, profile);
          for (const check of [...profile.checks, ...profile.acceptance]) {
            const result = await boundary.command(
              check.file,
              check.args,
              new AbortController().signal,
              120000,
              path.join(root, check.name + ".log"),
            );
            independent.push({ name: check.name, ...result });
            if (check.name === "independent-acceptance")
              functionalAcceptance = result.exitCode === 0 && !result.timedOut;
            if (check.name === "contract-smoke")
              contractSmoke = result.exitCode === 0 && !result.timedOut;
          }
        }
        const events = store.events(task.id);
        const usages = events
          .filter((e) => e.kind === "agent_usage")
          .map((e) =>
            z
              .object({
                role: z.string(),
                purpose: z.enum(["assistant", "compaction"]).optional(),
                usage: z
                  .object({
                    input: z.number(),
                    output: z.number(),
                    cacheRead: z.number(),
                    cacheWrite: z.number(),
                    totalTokens: z.number(),
                  })
                  .passthrough(),
                stopReason: z.string(),
              })
              .parse(e.body),
          );
        const toolAttempts = events.filter((e) => e.kind === "agent_tool");
        const toolFailures = events.filter((e) => e.kind === "tool_failure");
        const failureCategories: Record<string, number> = {};
        for (const failure of toolFailures) {
          const parsed = z
            .object({ failureCategory: z.string() })
            .passthrough()
            .safeParse(failure.body);
          if (parsed.success)
            failureCategories[parsed.data.failureCategory] =
              (failureCategories[parsed.data.failureCategory] ?? 0) + 1;
        }
        const repeatedInputCalls = toolAttempts.filter(
          (attempt) =>
            z
              .object({ repeatedInput: z.boolean().optional() })
              .passthrough()
              .parse(attempt.body).repeatedInput,
        ).length;
        const repeatedFailedCalls = toolFailures.filter(
          (failure) =>
            z
              .object({ repeatedIdenticalFailure: z.boolean().optional() })
              .passthrough()
              .parse(failure.body).repeatedIdenticalFailure,
        ).length;
        const usage = usages.reduce(
          (a, e) => ({
            input: a.input + e.usage.input,
            output: a.output + e.usage.output,
            cacheRead: a.cacheRead + e.usage.cacheRead,
            cacheWrite: a.cacheWrite + e.usage.cacheWrite,
            totalTokens: a.totalTokens + e.usage.totalTokens,
          }),
          {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
          },
        );
        const reflectionCalls = usages.filter(
          (usage) =>
            usage.role === "reflector" && usage.purpose !== "compaction",
        ).length;
        const reflectionsSaved = events.filter(
          (event) => event.kind === "reflexion_saved",
        ).length;
        const reflectionsSkipped = events.filter(
          (event) => event.kind === "reflexion_skipped",
        ).length;
        const reflectionFailures = events.filter((event) =>
          [
            "reflexion_failed",
            "reflexion_rejected",
            "reflexion_repeated",
          ].includes(event.kind),
        ).length;
        const attemptFailureTypes = events
          .filter((event) => event.kind === "developer_attempt_failure")
          .map((event) =>
            z.object({ errorType: z.string() }).safeParse(event.body),
          )
          .filter((result) => result.success)
          .map((result) => result.data.errorType);
        const diff = existsSync(path.join(task.workspace, ".git"))
          ? await git(task.workspace, ["diff", task.baseRevision, "--"])
          : "";
        const record = {
          model: evaluationModel,
          modelProvider:
            evaluationModel === "deepseek-flash"
              ? "deepseek"
              : evaluationModel === "siliconflow-deepseek-flash"
                ? "siliconflow"
                : "local-ollama",
          sampling,
          caseId: c.id,
          repository: c.repository,
          split: c.split,
          category: c.category,
          strategy,
          reflexionEnabled: profile.reflexion,
          replicate,
          task,
          functionalAcceptance,
          contractSmoke,
          deliveryGate: task.status === "ready_for_pr",
          durationMs: Date.now() - started,
          outcome:
            task.errorType === "timeout" || finalExecution.timedOut
              ? "incomplete_timeout"
              : /Docker Linux daemon unavailable|Sandbox image unavailable|Sandbox cleanup failed/.test(
                    task.error ?? "",
                  )
                ? "infrastructure_failure"
                : /UNIQUE constraint failed: retrieval_chunks\.id/.test(
                      task.error ?? "",
                    )
                  ? "harness_failure"
                  : finalExecution.exitCode !== 0
                    ? "worker_failure"
                    : task.error
                      ? "failed"
                      : "completed",
          workerExitCode: execution.exitCode,
          finalWorkerExitCode: finalExecution.exitCode,
          toolAttempts: events.filter((e) => e.kind === "agent_tool").length,
          recovery: {
            requested: c.category === "recovery",
            checkpointTriggered: existsSync(
              path.join(root, "restart-checkpoint.json"),
            ),
            restarted,
          },
          sourceFingerprint: existsSync(task.workspace)
            ? revision(task.workspace)
            : null,
          tools: task.budget?.tools ?? 0,
          repairs: task.budget?.repairs ?? 0,
          usage,
          reflexion: {
            calls: reflectionCalls,
            experiencesSaved: reflectionsSaved,
            skippedAfterRepeat: reflectionsSkipped,
            issues: reflectionFailures,
            maxExperiences: 3,
          },
          agentAttemptFailures: {
            total: attemptFailureTypes.length,
            emptyModelResponses: attemptFailureTypes.filter(
              (type) => type === "empty_model_response",
            ).length,
            repeatedInvalidInputs: attemptFailureTypes.filter(
              (type) => type === "invalid_input",
            ).length,
          },
          usageRecords: usages.length,
          assistantMessages: usages.filter((e) => e.stopReason !== "compaction")
            .length,
          compactionUsageRecords: usages.filter(
            (e) => e.stopReason === "compaction",
          ).length,
          outputLimitHits: usages.filter((e) => e.stopReason === "length")
            .length,
          toolMetrics: {
            attempts: toolAttempts.length,
            failures: toolFailures.length,
            failureRate: toolAttempts.length
              ? toolFailures.length / toolAttempts.length
              : 0,
            pathErrors:
              (failureCategories.path_argument ?? 0) +
              (failureCategories.path_not_found ?? 0),
            invalidArgumentErrors: failureCategories.invalid_arguments ?? 0,
            sourceMatchErrors: failureCategories.source_match ?? 0,
            policyDenied: failureCategories.policy_denied ?? 0,
            loopGuardFailures: failureCategories.repeated_successful_read ?? 0,
            repeatedInputCalls,
            repeatedInputRate: toolAttempts.length
              ? repeatedInputCalls / toolAttempts.length
              : 0,
            repeatedFailedCalls,
            failureCategories,
            fingerprintScope:
              "HMAC fingerprints are per PiAgent.run and never include raw arguments",
          },
          retrieval: events.filter((e) =>
            ["retrieval_context", "retrieval", "retrieval_expert"].includes(
              e.kind,
            ),
          ),
          humanCodeInterventions: 0,
          independent,
          checks: store.checks(task.id),
          events,
          diff,
          untrackedFiles: existsSync(path.join(task.workspace, ".git"))
            ? (
                await git(task.workspace, [
                  "ls-files",
                  "--others",
                  "--exclude-standard",
                ])
              )
                .split("\n")
                .filter(Boolean)
            : [],
        };
        saveJson(path.join(root, "result.json"), record);
        if (
          ["infrastructure_failure", "harness_failure"].includes(record.outcome)
        )
          throw new Error(
            "Evaluation stopped on infrastructure failure; result retained. Restore the execution environment before resuming.",
          );
        console.log(
          JSON.stringify({
            event: "completed",
            case: c.id,
            strategy,
            replicate,
            functionalAcceptance,
            deliveryGate: record.deliveryGate,
            tools: record.tools,
            durationMs: record.durationMs,
            error: task.error,
          }),
        );
      } finally {
        store.close();
      }
    }
} finally {
  releaseLock();
}
