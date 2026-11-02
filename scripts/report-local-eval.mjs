import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const datasetVersion =
  process.env.NEWAGENT_EVAL_DATASET_VERSION?.trim() || "v1";
if (!/^v[1-9][0-9]*$/.test(datasetVersion))
  throw new Error("NEWAGENT_EVAL_DATASET_VERSION must look like v2");
const base = path.resolve(
  "..",
  "data",
  datasetVersion === "v1"
    ? "repository-eval"
    : `repository-eval-${datasetVersion}`,
);
const name = process.argv[2] ?? "formal-v1";
if (
  !/^(formal|calibration|diagnostic|sampling-diagnostic|context-diagnostic|rag-diagnostic|window-diagnostic)-v[1-9][0-9]*$/.test(
    name,
  )
)
  throw new Error("Invalid batch name");
const batch = path.join(base, name);
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const manifest = read(path.join(batch, "manifest.json"));
const dataset = read(path.join(base, "dataset.json"));
const targetFilesByCase = new Map(
  dataset.cases.map((item) => [
    item.id,
    new Set((item.mutation ?? []).map((mutation) => mutation.file)),
  ]),
);
const results = readdirSync(batch, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => path.join(batch, e.name, "result.json"))
  .filter(existsSync)
  .map(read);
const mean = (numbers) =>
  numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : 0;
const configurations = results.length
  ? [
      ...new Map(
        results.map((result) => [
          JSON.stringify([result.strategy, result.reflexionEnabled ?? null]),
          {
            strategy: result.strategy,
            reflexionEnabled: result.reflexionEnabled ?? null,
          },
        ]),
      ).values(),
    ]
  : manifest.strategies.map((strategy) => ({
      strategy,
      reflexionEnabled: null,
    }));
const rows = configurations.map(({ strategy, reflexionEnabled }) => {
  const r = results.filter(
    (result) =>
      result.strategy === strategy &&
      (result.reflexionEnabled ?? null) === reflexionEnabled,
  );
  const instrumented = r.filter((result) => result.toolMetrics);
  const retrievalRuns = r.flatMap((result) => {
    const event = result.events?.find(
      (item) => item.kind === "retrieval_context",
    );
    if (!event) return [];
    const targetFiles = targetFilesByCase.get(result.caseId) ?? new Set();
    const files = Array.isArray(event.body?.files) ? event.body.files : [];
    return [files.some((file) => targetFiles.has(file.path))];
  });
  return {
    strategy,
    reflexionEnabled,
    recorded: r.length,
    functional: r.filter((r) => r.functionalAcceptance).length,
    gate: r.filter((r) => r.deliveryGate).length,
    timeout: r.filter((r) => r.outcome === "incomplete_timeout").length,
    infrastructureFailures: r.filter(
      (r) => r.outcome === "infrastructure_failure",
    ).length,
    harnessFailures: r.filter((r) => r.outcome === "harness_failure").length,
    averageMs: mean(r.map((r) => r.durationMs)),
    tools: r.reduce((a, r) => a + r.tools, 0),
    repairs: r.reduce((a, r) => a + r.repairs, 0),
    input: r.reduce((a, r) => a + r.usage.input, 0),
    output: r.reduce((a, r) => a + r.usage.output, 0),
    cacheRead: r.reduce((a, r) => a + r.usage.cacheRead, 0),
    cacheWrite: r.reduce((a, r) => a + r.usage.cacheWrite, 0),
    outputLimitHits: r.reduce((a, r) => a + r.outputLimitHits, 0),
    humanInterventions: r.reduce((a, r) => a + r.humanCodeInterventions, 0),
    needsHumanDecision: r.filter((r) => r.task.status === "blocked").length,
    retrievalContextRuns: retrievalRuns.length,
    retrievalTargetFileHits: retrievalRuns.filter(Boolean).length,
    reflectionCalls: r.reduce(
      (a, result) => a + (result.reflexion?.calls ?? 0),
      0,
    ),
    reflexionExperiences: r.reduce(
      (a, result) => a + (result.reflexion?.experiencesSaved ?? 0),
      0,
    ),
    reflectionSkipped: r.reduce(
      (a, result) => a + (result.reflexion?.skippedAfterRepeat ?? 0),
      0,
    ),
    agentAttemptFailures: r.reduce(
      (a, result) => a + (result.agentAttemptFailures?.total ?? 0),
      0,
    ),
    emptyModelResponses: r.reduce(
      (a, result) =>
        a + (result.agentAttemptFailures?.emptyModelResponses ?? 0),
      0,
    ),
    repeatedInputStops: r.reduce(
      (a, result) =>
        a + (result.agentAttemptFailures?.repeatedInvalidInputs ?? 0),
      0,
    ),
    reflectionIssues: r.reduce(
      (a, result) => a + (result.reflexion?.issues ?? 0),
      0,
    ),
    toolMetricsCoverage: instrumented.length,
    toolAttempts: instrumented.length
      ? instrumented.reduce((a, r) => a + r.toolMetrics.attempts, 0)
      : null,
    toolFailures: instrumented.length
      ? instrumented.reduce((a, r) => a + r.toolMetrics.failures, 0)
      : null,
    parameterPathErrors: instrumented.length
      ? instrumented.reduce(
          (a, r) =>
            a + r.toolMetrics.invalidArgumentErrors + r.toolMetrics.pathErrors,
          0,
        )
      : null,
    loopGuardFailures: instrumented.length
      ? instrumented.reduce(
          (a, r) => a + (r.toolMetrics.loopGuardFailures ?? 0),
          0,
        )
      : null,
    repeatedInputs: instrumented.length
      ? instrumented.reduce((a, r) => a + r.toolMetrics.repeatedInputCalls, 0)
      : null,
    repeatedFailedInputs: instrumented.length
      ? instrumented.reduce((a, r) => a + r.toolMetrics.repeatedFailedCalls, 0)
      : null,
  };
});
const lines = [
  "# 本地真实模型评测",
  "",
  `批次：${name}；已记录 ${results.length}/${manifest.runs}。${results.length === manifest.runs ? "任务记录完整。" : "当前为部分记录，不能作为完整对照结论。"}`,
  "",
  "模型：Qwen3 1.7B 标签，Ollama 元数据为 2.0B / Q4_K_M；实际调用本机 Ollama。Embedding 为本机 CPU Qwen3-Embedding-0.6B，Qdrant Dense + SQLite FTS + RRF。没有收费 API 调用。",
  "",
  `上下文：Pi SDK 客户端预算 ${manifest.context ?? "未记录"} tokens；Ollama 模型 alias 配置 num_ctx=${manifest.backendContextWindow ?? "未记录"}。`,
  "",
  `数据 SHA256：\`${manifest.datasetHash}\`；运行源码 SHA256：\`${manifest.runtimeSourceHash}\`。`,
  "",
  `采样参数：temperature=${manifest.sampling?.temperature ?? manifest.temperature}，top_p=${manifest.sampling?.topP ?? manifest.topP}，presence_penalty=${manifest.sampling?.presencePenalty ?? manifest.presencePenalty}，max_output_tokens=${manifest.sampling?.maxOutputTokens ?? manifest.maxOutputTokens}。`,
  "",
  manifest.tasks === 12
    ? "12 个任务来自 3 个固定版本的小型公开 Node/TypeScript 工具库；6 个开发任务、6 个保留任务。缺陷是受控植入，两项跨文件任务含新增集成 fixture，不代表自然历史 issue 或大型仓库能力。正确版本通过、植入版本失败已逐项验证。未运行上游完整依赖测试矩阵。"
    : `${manifest.tasks} 个固定开发集任务；本批次仅用于提示/工具诊断，不代表完整对照或保留集效果。`,
  "",
  ...(manifest.assignmentPlan?.length
    ? [
        `任务配置：${manifest.assignmentPlan.map((item) => `${item.case}=${item.strategy}${item.reflexion === undefined ? "" : item.reflexion ? "/Reflexion-on" : "/Reflexion-off"}`).join("；")}`,
        "",
      ]
    : []),
  ...(manifest.reflexion
    ? [
        manifest.mode === "diagnostic"
          ? "Reflexion on/off 配置使用同一模型、验收和预算。开启时的反思模型调用计入 Token Usage 与总时限，不增加工具调用预算。"
          : "标准对照的全部配置关闭 Reflexion；开启它需单独指定 profile，并计入 Token Usage 与总时限，不增加工具调用预算。",
        "",
      ]
    : []),
  "每个任务统一 Docker 工具边界、独立外部验收、100 次共享工具调用、3 次修复、30 分钟。单 Agent 两组使用程序交付 Gate，多 Agent 组额外使用独立 Review；功能验收率与 Gate 分开解读。超时归为未完成，不能解释成代码缺陷。",
  "",
  "|配置|已记录|功能通过|Gate通过|超时未完成|基础设施故障|Harness故障|平均秒|工具总数|修复总数|反思调用/经验|输入 Token|输出 Token|缓存读/写|输出截断|人工改码|",
  "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
];
for (const r of rows)
  lines.push(
    `|${r.strategy} / Reflexion ${r.reflexionEnabled === null ? "n/a" : r.reflexionEnabled ? "on" : "off"}|${r.recorded}|${r.functional}|${r.gate}|${r.timeout}|${r.infrastructureFailures}|${r.harnessFailures}|${(r.averageMs / 1000).toFixed(1)}|${r.tools}|${r.repairs}|${r.reflectionCalls}/${r.reflexionExperiences}|${r.input}|${r.output}|${r.cacheRead}/${r.cacheWrite}|${r.outputLimitHits}|${r.humanInterventions}|`,
  );
const retrievalRows = rows.filter((row) => row.retrievalContextRuns > 0);
if (retrievalRows.length)
  lines.push(
    "",
    "## 初始 RAG 目标路径覆盖",
    "",
    ...retrievalRows.map(
      (row) =>
        `- ${row.strategy}：初始上下文包含至少一个受控缺陷目标文件 ${row.retrievalTargetFileHits}/${row.retrievalContextRuns} 次；这是固定样本路径覆盖，不代表模型修复成功或人工审查质量。`,
    ),
  );
lines.push(
  "",
  "## 工具调用诊断",
  "",
  "错误率按SDK tool_execution_start尝试数作为分母；参数/路径错误及精确重复调用均来自带每会话HMAC指纹的轨迹，不保留原始参数。不同Agent会话的指纹不能相互关联。",
);
for (const r of rows)
  lines.push(
    r.toolMetricsCoverage === 0
      ? `- ${r.strategy}：本批次未记录工具错误遥测，不能按0次解释。`
      : `- ${r.strategy}：工具遥测覆盖${r.toolMetricsCoverage}/${r.recorded}；尝试${r.toolAttempts}，执行错误${r.toolFailures}，参数/路径错误${r.parameterPathErrors}，重复读取护栏${r.loopGuardFailures}，相同输入重复${r.repeatedInputs}，重复失败输入${r.repeatedFailedInputs}。`,
  );
lines.push("", "## Reflexion 诊断", "");
for (const r of rows)
  lines.push(
    `- ${r.strategy} / Reflexion ${r.reflexionEnabled === null ? "n/a" : r.reflexionEnabled ? "on" : "off"}：调用${r.reflectionCalls}，保存经验${r.reflexionExperiences}，失败/拒绝/重复${r.reflectionIssues}，重复后跳过${r.reflectionSkipped}次。`,
  );
lines.push("", "## 开发调用恢复", "");
for (const r of rows)
  lines.push(
    `- ${r.strategy} / Reflexion ${r.reflexionEnabled === null ? "n/a" : r.reflexionEnabled ? "on" : "off"}：可恢复的开发调用失败${r.agentAttemptFailures}，其中空最终回复${r.emptyModelResponses}、重复无效输入停止${r.repeatedInputStops}。`,
  );
lines.push(
  "",
  `单独归类的已记录故障：基础设施 ${results.filter((r) => r.outcome === "infrastructure_failure").length}，Harness ${results.filter((r) => r.outcome === "harness_failure").length}。故障结果保留在已分配任务中。`,
  "Token 合计包含 Pi SDK assistant 回复和压缩摘要的 provider Usage；缓存字段按 provider 实报。时间包含容器启动、检索、模型和检查。电费未估算。人工改码为零不等于任务不需要人工处理，PR 未发布。",
  "",
  "## 失败案例",
  "",
);
for (const r of rows)
  lines.push(
    `- ${r.strategy}：实际人工改码 ${r.humanInterventions} 次；${r.needsHumanDecision}/${r.recorded} 个已记录任务处于 blocked，需人工决策后才能继续。`,
  );
for (const r of results.filter((r) => !r.functionalAcceptance).slice(0, 4))
  lines.push(
    `- ${r.caseId} / ${r.strategy} / ${r.replicate}：${r.outcome}；${r.task.error ?? "独立验收失败"}；工具 ${r.tools}、修复 ${r.repairs}、输出截断 ${r.outputLimitHits}。原始事件、Diff 和外部验收日志在同名任务目录。`,
  );
for (const kind of ["retrieval", "review"]) {
  const name =
    kind === "retrieval"
      ? process.env.NEWAGENT_RETRIEVAL_BATCH?.trim() || "retrieval-v1"
      : "review-v1";
  const file = path.join(base, name, "results.json");
  if (existsSync(file)) {
    const data = read(file);
    lines.push(
      "",
      `## ${kind === "retrieval" ? "检索" : "Review"}专项`,
      "",
      `真实调用记录：${data.results.length} 条。人工确认标注/判定：${data.humanReviewed ?? data.humanAdjudicated}。自动位置匹配和源代码核对只作为暂定结果。详见 ${file}。`,
    );
    if (kind === "retrieval")
      lines.push(
        "延迟计时范围不同：Dense 是候选 ID 检索和固定语料元数据查询，关键词/混合包含 Docker 源码新鲜度核验，不能据此判断端到端速度优势。",
      );
    if (kind === "retrieval")
      for (const mode of ["keyword", "dense", "hybrid"]) {
        const rs = data.results.filter((r) => r.mode === mode);
        lines.push(
          `- ${mode}：n=${rs.length}，Recall@5=${mean(rs.map((r) => r.recallAt5)).toFixed(3)}，MRR@10=${mean(rs.map((r) => r.mrrAt10)).toFixed(3)}，平均延迟 ${mean(rs.map((r) => r.latencyMs)).toFixed(0)}ms。`,
        );
      }
    else {
      const rs = data.results;
      const truth = rs.reduce((n, r) => n + r.groundTruthCount, 0);
      const detected = rs.reduce((n, r) => n + r.detectedByLocation, 0);
      const matched = rs.reduce((n, r) => n + r.matchedBlockingCount, 0);
      const blocking = rs.reduce((n, r) => n + r.blockingCount, 0);
      lines.push(
        `- 位置匹配代理：已知缺陷 ${detected}/${truth}；阻塞发现位置匹配 ${matched}/${blocking}；非法位置 ${rs.reduce((n, r) => n + r.invalidLocations, 0)}；输出失败 ${rs.filter((r) => r.error).length}。未匹配发现不能直接称为误报。`,
      );
    }
  }
}
lines.push(
  "",
  "## 结果边界",
  "",
  "不设必须提升的目标。完整运行之前不判断多 Agent 是否更好。小模型工具参数错误、文本建议但未写文件、输出截断与超时需分别统计；协议测试通过不能代替模型任务通过。30 条检索问题由 Agent 草拟并核对源码，尚未人工标注确认；Review 误报也待人工判定。",
  "",
);
writeFileSync(path.join(batch, "report.md"), lines.join("\n"));
writeFileSync(
  path.join(batch, "summary.json"),
  JSON.stringify(
    { recorded: results.length, expected: manifest.runs, rows },
    null,
    2,
  ),
);
console.log(path.join(batch, "report.md"));
