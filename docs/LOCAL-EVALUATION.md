# 本地模型真实评测

运行数据、Ollama、模型、Embedding 与缓存保存在 E:\newagent。早期校准使用 Ollama newagent-qwen3-1.7b（Q4_K_M）和 CPU Qwen3-Embedding-0.6B；最新 SiliconFlow DeepSeek-V4-Flash 测试经用户授权运行，费用按 token usage 估算，实际账单未核对。RAG 臂使用 E 盘本地 Qwen3-Embedding-0.6B，未调用付费 Embedding API。Docker 使用 Linux 引擎，Qdrant 运行于 internal 网络，向量数据使用 Docker Linux volume。

首次建立 v2 数据集时执行一次：

```powershell
$env:NEWAGENT_EVAL_DATASET_VERSION='v2'
npm run eval:local:download
npm run eval:local:setup
```

v2 数据、仓库快照、Qwen Embedding 权重和缓存均在 E 盘。启动评测前确认 Docker Desktop 使用 Linux 容器且 Qdrant 在线；RAG 还要求本机 Qwen 服务监听 127.0.0.1:18091、Embedding 缓存代理监听 127.0.0.1:18092。本轮结束后 CPU 服务已停止，权重与向量缓存保留；这些评测 wrapper 不会静默切回付费 Embedding 或宿主执行。运行新批次时使用新名称；脚本拒绝覆盖已有结果：

```powershell
$env:NEWAGENT_EVAL_DATASET_VERSION='v2'
$env:NEWAGENT_RETRIEVAL_BATCH='retrieval-v2'
npm run eval:local:retrieval

$env:NEWAGENT_EVAL_BATCH='rag-diagnostic-v2'
npm run eval:local:rag-diagnostic
npm run eval:local:report -- rag-diagnostic-v2

$env:NEWAGENT_EVAL_BATCH='window-diagnostic-v1'
$env:NEWAGENT_EVAL_CONTEXT_WINDOW='8192'
npm run eval:local:window-diagnostic
npm run eval:local:report -- window-diagnostic-v1
```

Reflexion 配对和采样诊断见 `diagnostic-v6` 与 `sampling-diagnostic-v1`。单次 Run 有 100 次工具调用、3 轮修复和 30 分钟上限；超时、基础设施错误与功能验收失败分开记录。固定样本、协议测试和真实模型成绩分开报告。完整正式矩阵 12 题 × 3 配置 × 2 次共 72 次仍未完成；2026-10-05 已另行完成 6 个保留任务 × 3 配置 × 1 次的 18 次单重复对照，结果见下文。早期 Qwen3 1.7B 开发集校准为 0/9；之后 DeepSeek Flash 的真实任务结果必须按新批次单独报告。

## 运行配置与结果边界

`data/retrieval.json` 配置本机 CPU Embedding、Qdrant internal transport、1024 维向量、180 秒 Embedding 超时及 Qwen3-Embedding query instruction。文档向量使用源码原文；查询以 `Instruct: ...\nQuery: ...` 编码。配置变更会更新 collection/index version。Ollama alias `/api/show` 和运行中 `/api/ps` 均显示 `num_ctx=8192`；评测 manifest 同时记录 Pi SDK 客户端预算。4K 是原对照，8K 单独实验且未显示质量收益。

检索问题共 30 条，目标 path/symbol 已核对源码但由 Agent 草拟，仍为 `humanReviewed=false`。CommonJS 符号采用兼容集合匹配旧 `module` chunk、新 `module.exports` 和具名函数 chunk；这不是人工金标准。Review 专项的 12 个缺陷样本和 3 个参考版本仍未人工判定。

`retrieval-v2/results.json` 保存完整 90 条检索记录；Hybrid Recall@5 25/30、MRR@10 0.477，旧 baseline 用兼容符号集合重算为 20/30、0.429。标注尚未人工审核，不能写成生产仓库准确率。

`rag-diagnostic-v1` 到 `rag-diagnostic-v2` 保持相同 3 个开发任务、模型、4K SDK 上下文和验收。开发上下文命中目标实现文件的次数从2/3提高到3/3；实现文件优先和复用刚更新的源快照后，平均耗时从252秒降到109秒，工具调用从122降到59，输入 Token 从112,073降到34,357，压缩从26次降到5次；功能验收仍为0/3。RAG 效率改善没有转化成代码修复成功。

`window-diagnostic-v1` 的 SDK 上下文调到 8K 后为 0/3，通过耗时和工具调用均未优于 4K 对照。`sampling-diagnostic-v1` 把 presence penalty 降至 0.3 也未改善。Reflexion 保持默认关闭；本地 1.7B 的所有开发集诊断尚无功能通过。

`retrieval-v1`（v2 数据目录）是符号标注版本不匹配后中止的 partial 批次，保留作审计，不聚合为完整成绩。完整 72 次正式对照、人工检索标注、Review 判定、完整演示和 PR 演示均未完成。

## SiliconFlow DeepSeek Flash 旧失败任务复测结果

2026-10-04 用硅基流动托管的 DeepSeek Flash 重跑了 Qwen3 1.7B 之前未通过的三个开发任务：mitt-wildcard、dlv-falsy-values、stringify-nonfinite。服务端使用 OpenAI 兼容地址 https://api.siliconflow.cn/v1 和模型 ID deepseek-ai/DeepSeek-V4-Flash；硅基流动官方示例使用相同的模型 ID、地址和工具调用格式（[Chat Completions 文档](https://docs.siliconflow.cn/docs/api/chat-completions-post)）。

只需把 API Key 放在进程环境变量 NEWAGENT_API_KEY。运行脚本会先校验变量是否存在，再用 GET /v1/models 确认该账户能看到目标模型；它不会打印或保存密钥。生成请求在宿主编排 worker 中运行，密钥不写进评测模型配置，也不会传入 Docker 容器。

每题单独运行，按顺序逐个核对 usage 与账单：

    .\scripts\run-siliconflow-single-case.ps1 -CaseId mitt-wildcard
    .\scripts\run-siliconflow-single-case.ps1 -CaseId dlv-falsy-values
    .\scripts\run-siliconflow-single-case.ps1 -CaseId stringify-nonfinite

每题上限为 24 次工具调用、3 轮修复、10 分钟；使用 256K 客户端窗口、2048 最大输出、关闭模型思考输出、single-no-rag。256K 是客户端保留上下文的上限，不代表每次请求都使用或计费 256K。SiliconFlow 的 /v1/models 只返回模型 ID，没有服务端 context_length 字段；本次实际单题总 usage 28,640–52,722 tokens，不能据此宣称请求填满了 256K。常规时段的费用估算按输入 ¥3/M、缓存命中 ¥0.3/M、输出 ¥9/M 计算；三题合计约 ¥0.17。实际扣款尚未在账户账单核对，以账单为准（[官方价格公告](https://docs.siliconflow.cn/docs/release-notes/overview)）。

|批次|任务|功能验收 / Gate|工具尝试 / 修复|耗时|输入 / 缓存读取 / 输出 tokens|费用估算|
|---|---|---:|---:|---:|---:|---:|
|single-case-diagnostic-v14|mitt-wildcard|1/1 / 1/1|12 / 0|63.6 秒|14,527 / 22,528 / 987|¥0.059|
|single-case-diagnostic-v15|dlv-falsy-values|1/1 / 1/1|9 / 0|59.4 秒|10,973 / 16,384 / 1,283|¥0.049|
|single-case-diagnostic-v16|stringify-nonfinite|1/1 / 1/1|15 / 0|45.8 秒|10,651 / 40,704 / 1,367|¥0.056|

三题均为固定仓库快照中的受控缺陷，不是自然历史 Issue；每题只运行一次，不能据此声称总体成功率提升。三题共有 14 次 run_check 使用了未配置的检查名，另有 1 次重复失败工具输入；虽然最终独立验收和 Gate 都通过，工具名描述/约束仍值得修正。本批次是 single-no-rag，没有调用本地 Qwen Embedding。

批次 single-case-diagnostic-v11 保留一次 Docker 权限导致的 infrastructure_failure，模型 usage 为 0。提升权限后只读 docker ps 确认 Docker Desktop Linux daemon 和 Qdrant 容器在线，v14 至 v16 在隔离容器中完成。重跑数据没有覆盖 v11。

### 六道开发题 RAG / no-RAG 配对

v17-v19 与 v20-v22 是原有三道题；v23-v25 与 v26-v28 补齐其余三道开发题。12 次运行使用相同数据集、运行源码、评测 Harness、模型、采样、验收、256K 客户端上限和工具预算；唯一实验变量为 single-rag 或 single-no-rag。每任务每臂运行一次，都是控制植入缺陷的固定仓库快照。

|配置|功能验收 / Gate|RAG 首轮目标实现文件命中|Dense 成功|中位耗时|中位工具尝试|中位总 usage|中位费用估算|
|---|---:|---:|---:|---:|---:|---:|---:|
|single-rag|6/6 / 6/6|5/6|6/6|96.7 秒|11|40,117 tokens|¥0.069|
|single-no-rag|6/6 / 6/6|不适用|不适用|56.7 秒|11.5|39,313 tokens|¥0.057|

RAG 命中了 5/6 个由缺陷变异路径定义的目标实现文件，但没有提高这组六题的验收通过数；中位耗时多 40 秒（约 71%），中位 Token 用量高约 2%，中位费用高约 21%。RAG 索引更新平均约 38 秒，Dense 与 FTS 混合查询耗时 0.8–1.3 秒。对这些小型单文件缺陷，no-RAG 更快；保留 RAG 给路径不明确或跨文件任务可能更合理。以上仅是 6 题、每臂一次的开发集结果，不能外推保留集或自然 Issue。

### run_check 名称约束修正验证

前六题共记录 66 次 run_check 使用未配置名称。现在工具 schema 将参数限制为 profile 实际配置的检查名，并在描述中列出合法名称。对 mitt-unknown-handler 的各一对复测中，RAG 误用检查名从 13 次降至 0，工具尝试从 19 降至 10；no-RAG 从 6 次降至 0，工具尝试从 14 降至 6。两次复测都通过验收与 Gate，但每种策略只有一个前后样本，属于针对性修复验证而非稳定效果估计。新 RAG 复测还出现 1 次有效分类的 source_match 编辑失败；不会将所有工具失败一概归入模型问题。

六题配对运行 usage 合计约 0.83 元估算；schema 修正的两个复测约 0.13 元；加上最初三次单题约 0.17 元，早期 SiliconFlow 请求约 1.12 元估算。账单尚未与平台控制台核对。具体结果在 E:\newagent\data\repository-eval-v2 的 single-case-diagnostic-v14 至 v30 中；v11 为零 usage 的 Docker 基础设施失败记录。

## 六题保留集三臂真实模型对照（2026-10-05）

修复评测恢复 Worker 漏传凭证环境后，在同一新 Harness hash 下完成 18 次对照，涵盖 `mitt-dispatch-snapshot`、`mitt-once-integration`、`stringify-key-comparator`、`stringify-cycle-recovery`、`dlv-null-traversal`、`dlv-options-integration`。每题单 Agent no-RAG、单 Agent RAG、adaptive-RAG 各运行一次。三臂均使用 Docker Linux、同一组独立验收和 24 工具预算、3 轮修复、10 分钟限制；客户端上下文 cap 为 262,144，服务端窗口未核实。RAG 两臂使用本地 CPU Qwen3-Embedding-0.6B，没有付费 Embedding API。

|配置|功能验收 / Gate|中位耗时|中位 Agent 工具调用|中位总 usage|中位费用估算|六题费用估算|
|---|---:|---:|---:|---:|---:|---:|
|single-no-rag|6/6 / 6/6|66.6 秒|10.5|39,093 tokens|¥0.0759|¥0.4783|
|single-rag|6/6 / 5/6|133.1 秒|11|38,118 tokens|¥0.0879|¥0.5975|
|adaptive-rag|5/6 / 2/6|154.6 秒|19|61,444 tokens|¥0.1316|¥0.8057|

RAG 的 Dense 检索 12/12 成功，两个 RAG-enabled 策略的初始 Top-3 均至少命中一个植入变异目标文件（12/12）；但对照中 RAG 中位耗时比 no-RAG 高约 100%，中位费用高约 16%，功能通过数持平且 Gate 少 1 题。adaptive-RAG 相对 no-RAG 中位耗时高约 132%、中位费用高约 73%，功能少 1 题、Gate 少 4 题。索引更新中位数 24.3 秒，混合查询中位数 0.80 秒。详细逐题结果、失败轨迹和口径见[保留集三臂评测报告](reports/HOLDOUT-STRATEGY-RESULTS.md)。

这组受控缺陷、单重复样本不证明自然 Issue 上的泛化效果；不应写成 RAG 或多 Agent 提升成功率。single-rag 有一题因工具预算耗尽而 Gate 失败；adaptive-rag 有一题检索专家非法 JSON 导致功能失败，另有三题在独立功能验收已通过后仍因 Review/预算限制未过 Gate。三次真实 checkpoint 任务均完成 Worker 重启；两次完整过 Gate，adaptive-RAG 一次因后续预算耗尽未过 Gate。

评测期间发现恢复子进程未复用宿主凭证覆盖，已修复并添加假密钥重启回归测试。修复后 `npm run verify` 通过 48/48，`npm run test:fixtures` 通过 10/10；实际 SiliconFlow 账单未核对。

## Ragas 分层评测（2026-10-05）

新增 Python 3.11 / Ragas 0.4.3 离线评测模块。虚拟环境位于 `E:\newagent\tools\ragas-venv`，pip 缓存、Qwen 权重、Embedding 向量缓存、样本、结果与调用日志都在 `E:\newagent`。依赖使用独立 `scripts/ragas/requirements.in` 和带哈希的 `requirements.lock`；普通 `npm run verify` 不启动收费评测。

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/ragas/start-local-embedding.ps1
npm run eval:ragas:export
npm run eval:ragas:run
npm run eval:ragas:report
npm run test:ragas
```

`eval:ragas:export` 新建 30 题 × 关键词/Dense/Hybrid 的真实 Top-5 片段批次，并导入 18 条修复版保留集轨迹和 3 条窄工具任务；如果检索原始批次已生成而后续导出失败，可显式设置 `NEWAGENT_RAGAS_REUSE_RETRIEVAL=1` 复用原文，不重复跑检索。真实模型 API 调用仅由 `eval:ragas:run` 启动，读取环境变量 `NEWAGENT_API_KEY`；所有生成/评判请求共用 `E:\newagent\data\ragas\ledger-v1.json`，单并发、请求前最坏费用预留上限 ¥3，Usage 缺失或预算超限即停止。当前批次使用 SiliconFlow `deepseek-ai/DeepSeek-V4-Flash`、本地 CPU Qwen3-Embedding-0.6B（1024 维）和 Docker 内网 Qdrant；provider 实际模型上下文窗口仍未核实。

本批原始检索共 90/90 条，带实际片段文本，文件/符号 Recall@5 与 MRR@10 为：关键词 22/30、0.454；Dense 19/30、0.395；Hybrid 25/30、0.477。标签由 AI 核源但未经真人审核。Q8 的历史目标指向 `mitt/README.md`，而 README 没说明省略 handler 时的行为；参考答案只说明文档未覆盖，并进入人工复核队列。

费用预算内完成了 9 个检索校准模式样本、3 条 Agent 校准轨迹、18 条历史轨迹的导入（12 条可评分、6 条因缺工具结果标记不完整）、3 条窄工具任务，以及 33 个剩余检索问答模式样本（其中 1 条部分评分）。总计 322 次付费请求均获得 Usage，另有 1 次预算拒绝请求在发送前被拦截；保守估算 ¥2.975172，最后一笔 ¥0.027102 预留会超过 ¥3 上限，因此停止，58 个样本无结果。输入 563,615 tokens、输出 142,703 tokens、缓存输入 21,760 tokens；使用普通非优惠费率且不抵扣缓存，真实账单未与平台核对。

已完成的有效检索评分数：ContextPrecision 每模式 `10/30、11/30、11/30`，均值依次 `0.770、0.905、0.779`；ContextRecall `10/30、11/30、11/30`，均值 `0.900、0.909、1.000`；Faithfulness 同样为 `10/30、11/30、11/30`，均值 `0.601、0.702、0.616`。这些是 30 题迭代集的部分评分，不是独立保留集或提升证明。完整 Agent 轨迹评分均值 `0.75`（12 条），相对程序功能验收有 1 个假阳性和 3 个假阴性；真实功能验收 `17/18`，交付 Gate `13/18`。窄工具任务 ToolCallAccuracy `3/3`，隔离文件状态检查 `3/3` 通过。Ragas 分数不替代独立代码验收或 Gate。

逐题结果、原始评分输出、请求 ID 与 Usage 在 `E:\newagent\data\ragas\ragas-v1\`：`report.md`、`scores.jsonl`、`scores.csv`、`review_queue.jsonl`、`raw-llm-calls.jsonl`、`manifest.json`。6 条不完整历史轨迹、58 条预算内未评分样本、参考答案审核状态及同模型自评偏差均保留在报告中。

预算拒绝时 Instructor 将本地拒绝包装成 `Connection error`；事后依据账本把唯一对应行和 `run-state.json` 分类为 `budget_refused`，原包装错误保留且没有重算分数。`manifest.json` 保留实际执行期 runtime hash，并单独记录评测后分类修正及其代码哈希；当前代码和执行期代码不同，复跑需创建新导出批次。
