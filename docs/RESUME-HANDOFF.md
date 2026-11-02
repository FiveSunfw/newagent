# NewAgent 求职项目简历润色交接

用途：交给后续简历润色对话，基于已有证据判断项目亮点和简历写法。没有岗位 JD，因此按 Agent 工程岗位的一般表述整理；不得把架构能力或评测计划写成模型效果。

## 项目概况

NewAgent 是 TypeScript 的代码交付 Agent。保留 Pi Coding Agent SDK、Fastify/本机服务、SQLite 和原生终端入口。本轮基于 `main / e4658db`，当前功能分支为 `codex/sandbox-harness-rag`。没有向 GitHub 推送代码，也没有向评测用的三个上游仓库提 PR。

用户在本对话中明确的目标是补足执行隔离、统一 Harness、仓库检索、MCP 和真实评测，同时保留人工 PR 确认。早期校准使用本地 Ollama Qwen3 1.7B 与本地 Qwen3 Embedding；之后用户创建 SiliconFlow API Key 并授权在约16元额度内跑旧失败任务和开发集对照。个人具体编码比例、项目日期、团队规模和简历中应使用的个人所有权动词未确认，定稿前向用户确认。

## 有证据支持的亮点

| 方向 | 可确认事实 | 可写边界 |
|---|---|---|
| 执行隔离 | Linux Docker 执行层默认禁网、非 root、drop capabilities、只读根文件系统、限制 CPU/内存/PID；任务代码由受控文件工具读写；Review 使用只读视图；不向容器挂载 Docker socket 和模型凭证。真实 Docker smoke 的 7 项隔离检查通过。 | 可以写“实现并验证 Docker 沙箱”。运行器为受控快照容器，不要写成已实现长期任务容器或真正 Git worktree。 |
| Harness 与交付证据 | Developer、Reviewer、Retrieval 专家走同一个权限/执行入口；一次 Run 共享 100 次工具调用、3 次修复、30 分钟预算；SDK 参数校验失败也计数。任务事件写入 SQLite，发布证据绑定工作区源码指纹、检查配置和执行环境；重启时暂停未结束阶段，恢复后重新验证。 | 可以写预算、来源证据和恢复设计。不要声称完整父子调用图、全局主 Agent 预算或恢复后功能任务已经成功。 |
| 仓库 RAG | TypeScript/JavaScript AST（含 CommonJS 导出/具名函数）、Markdown 标题和其它文本切分；SQLite FTS5 + Qdrant Dense + RRF；Qwen3 Embedding 查询指令、增量索引/删除、实现文件优先的开发上下文。 | `retrieval-v2` 暂定30题的 Hybrid Recall@5 为25/30，旧 baseline 用兼容符号标签重算为20/30；MRR@10 为0.477 vs 0.429。标签仍未人工审核；仅可写“本地检索对照结果”，不能写成通用准确率或模型修复收益。 |
| MCP | 使用官方 TypeScript SDK 实现本地 stdio MCP；握手、受限读取、任务权限绑定和共享执行层有自动化协议验证。 | 可以写“实现本地 MCP 接入及协议验证”；不要说接入任意外部 MCP 服务。 |
| 固定评测集 | 构建 12 个固定仓库任务，来自 3 个公开 Node/TypeScript 生态仓库：`developit/mitt`、`epoberezkin/fast-json-stable-stringify`、`developit/dlv`。包含 6 个开发集、6 个保留集、受控植入缺陷、两项跨文件集成 fixture 和独立验收程序。正确基线通过、缺陷版本失败均已预检。 | 可以写“搭建固定评测集与独立验收 Harness”。这是受控缺陷修复，不是自然历史 issue，不要称作真实线上缺陷修复成绩。 |
| 工程验证 | 最新 `npm run verify`：48 项测试通过，TypeScript 类型检查通过，生产构建通过。实际 Docker smoke 7 项通过；另有 Qdrant 检索/删除、SQLite 索引更新、MCP stdio 的服务与协议验证。 | 只陈述跑过的验证；单测/协议测试通过不能代替模型任务通过或人工 Review 质量。 |

## 真实评测结果与边界

- 本地模型校准 `calibration-v4`：9 次任务运行，功能验收 **0/9**，超时 **0**。后续 `calibration-v5` 是旧提示下的 exploratory / incomplete 批次，仅保存4/9结果，功能和交付 Gate 均0/4，不并入可比结果。
- Reflexion 配对诊断使用相同模型、独立验收、工具/修复/时限，3个开发任务分别运行 off/on 共6次。`diagnostic-v1`、`v2`、`v4`、`v5` 均为功能验收 **0/6**。`diagnostic-v3` 在改动源码时中断，只保存3/6，已标为不可聚合。
- `diagnostic-v5`（上下文4096、单次输出上限2048）：off 为0/3通过、平均67秒、52次工具调用；on 为0/3通过、平均131秒、128次工具调用。on 组9次反思调用、保存4条经验；功能收益没有出现，Token 与时间更高，因此普通 profile 的 Reflexion 默认关闭，保留显式 opt-in。它在 v2 中让Dlv任务少耗工具，但仍3轮失败；不能写“Reflexion提升修复成功率”。
- 后续 `diagnostic-v6` 的 Reflexion off/on 仍均为0/3通过；off 平均85秒/68工具，on 119秒/96工具。`sampling-diagnostic-v1` 将 `presence_penalty` 降至0.3后仍0/3，平均159秒/165工具，未优于1.5。`window-diagnostic-v1` 将 SDK context 从4K调至8K后仍0/3，平均123秒/116工具，也未优于4K控制。Ollama alias `/api/show` 与运行时 `/api/ps` 显示 `num_ctx=8192`；评测同时记录 SDK 的4096/8192客户端预算。
- 同批对照显示空最终回复、错误代码编辑和重复读取仍是主要失败。重复读取护栏已将v2中Dlv off臂的100次预算循环，在后续运行中压至17–20次工具调用；独立验收仍未通过。小模型提示协议 smoke 合法，不代表真实任务能力。
- 检索专项 `retrieval-v1`：真实本地 Embedding、Qdrant 与 SQLite/FTS 共完成 30 个问题 × 3 种模式 = **90 次检索**。暂定 Recall@5：关键词 **22/30（0.733）**、Dense **17/30（0.567）**、混合 **20/30（0.667）**；MRR@10 分别为 **0.437、0.314、0.429**。关键词在这组问题中最好，不能写“混合 RAG 提升召回率”。标注尚未人工审核，Dense 延迟只计候选检索、关键词/混合还包含 Docker 源码新鲜度核验，因此延迟不能横向当作端到端比较。
- `retrieval-v2` 使用 Qwen3 Embedding query instruction、源码原文 document embedding 和 CommonJS 函数级 chunk，完成30题×3模式共90次。按兼容符号集合重算后关键词/Dense/Hybrid Recall@5 为22/30、19/30、25/30；MRR@10 为0.454、0.395、0.477。问题与可接受符号仍未人工审核，不能宣称生产仓库准确率。
- `rag-diagnostic-v1` / `rag-diagnostic-v2` 是同3个开发任务的 RAG-only 诊断，功能验收均0/3。初始候选包含受控缺陷目标文件从2/3提高到3/3；source-first context 与索引后快照复用把平均时间从252秒降到109秒、工具调用从122降到59、输入 Token 从112,073降到34,357、压缩从26次降到5次；但仍无正确 Diff。可作为小样本检索/工具效率优化证据，不是修复成功率提升。
- 正式对照的计划是 12 任务 × 3 配置 × 2 次 = 72 次，**目前没有完成**。`formal-v2` 记录了 25/72 项，其中 1 项恢复案例因 AST 同一物理行重复 `module` chunk ID 触发 Harness 故障；该故障已修复，新增测试并通过验证。其余 24 次功能通过为 0。真实进程重启/恢复路径在两项中触发，但任务没有获得功能验收通过。
- `formal-v3` 在第一项运行的 Docker 预检中停止，错误为 `docker_engine` 管道不存在，模型调用为 0。未完成的批次不代表模型失败，报告中与模型失败分开归类。
- Review 专项没有结果文件；**没有** Review 召回率、误报率或准确率可供简历引用。恢复任务、单测通过和格式校验也不能替代这个专项评测。
- 早期本地模型/Embedding 校准 API 费用为0（电费未估算），但之后已授权 SiliconFlow 评测。2026-10-04 在六个固定开发集受控缺陷上，用 SiliconFlow DeepSeek-V4-Flash、256K客户端窗口做 single-rag/no-RAG 配对，每题每臂运行1次：两组独立验收/Gate 都为6/6；RAG Dense 运行6/6、初始 top-3 包含变异目标实现文件5/6。RAG与no-RAG中位耗时分别96.7秒和56.7秒，中位Token用量40,117和39,313，中位费用估算¥0.069和¥0.057。此小样本显示简单缺陷上RAG未提高通过率且更慢；可作为路由取舍，不是RAG提升质量的证据。六题均不是自然历史Issue；当时保留集尚未运行，后续对照见下文。
- 2026-10-05 在六道保留集受控缺陷上，以修复后的同一 Harness hash 跑 single-no-rag / single-rag / adaptive-rag 共18次、每题每配置1次。no-RAG 功能验收/Gate 6/6；RAG 为6/6、5/6；adaptive 为5/6、2/6。三臂中位耗时分别66.6/133.1/154.6秒，中位费用估算¥0.0759/¥0.0879/¥0.1316。RAG Top-3目标文件命中12/12、Dense成功12/12，但没提高通过数；adaptive 的专家 JSON 和共享预算造成失败。受控样本不能外推自然 Issue，完整逐题结果见 `docs/reports/HOLDOUT-STRATEGY-RESULTS.md`。
- 六题中 run_check 使用未配置名称66次。将合法检查名加入工具参数schema后，在mitt-unknown-handler各做1次RAG/no-RAG验证，未知名称调用降至0；工具尝试分别从19降至10、14降至6，两次均过验收。样本太小，只能当作定向工程修复验证。
- 早期17次 SiliconFlow 运行费用估算约¥1.12；修复后保留集18次估算约¥1.88。连同此前诊断和中断批次的保守余量，本轮累计估算约¥4.05，实际账单未核对。完整72次矩阵、人工 Review 质量专项与重复复现实验仍未完成。

报告及逐任务原始记录位于 E 盘：

- `calibration-v4/report.md`
- `retrieval-v1/results.json`
- `formal-v2/report.md` 与 `formal-v2/duplicate-chunk-diagnosis.json`
- `formal-v3/report.md`
- `E:\newagent\data\repository-eval-v2\diagnostic-v1\report.md`
- `E:\newagent\data\repository-eval-v2\diagnostic-v2\report.md`
- `E:\newagent\data\repository-eval-v2\diagnostic-v3\interruption.json`（中断，不可聚合）
- `E:\newagent\data\repository-eval-v2\diagnostic-v4\report.md`
- `E:\newagent\data\repository-eval-v2\diagnostic-v5\report.md`
- `E:\newagent\data\repository-eval-v2\diagnostic-v6\report.md`
- `E:\newagent\data\repository-eval-v2\sampling-diagnostic-v1\report.md`
- `E:\newagent\data\repository-eval-v2\context-diagnostic-v1\report.md`
- `E:\newagent\data\repository-eval-v2\rag-diagnostic-v1\report.md` 与 `rag-diagnostic-v2\report.md`
- `E:\newagent\data\repository-eval-v2\window-diagnostic-v1\report.md`
- `E:\newagent\data\repository-eval-v2\retrieval-v2\results.json`
- `E:\newagent\data\repository-eval-v2\retrieval-v1\results.json`（CommonJS 符号标签不兼容的 partial，50条，不聚合）
- `E:\newagent\data\repository-eval-v2\retrieval-v1\interruption.json`（记录中止原因与标签口径）
- `E:\newagent\data\repository-eval-v2\reflexion-smoke.json`（合成协议 smoke）

Docker Linux daemon、Qdrant、Ollama、Embedding 与缓存代理已恢复；E 盘 v2 固定评测集已通过参考/缺陷预检。完整72次正式矩阵尚未完成；DeepSeek Flash 的六题保留集三臂对照已完成，但每臂仅一次且都是受控缺陷。具体运行步骤与结果边界见 [LOCAL-EVALUATION.md](LOCAL-EVALUATION.md)。

## 可作为草稿的简历表述

下面的表述都需要先确认用户的实际个人贡献，再选用。

**优先方向：沙箱和验证证据**

> 为 TypeScript 代码交付 Agent 实现默认 Linux Docker 执行沙箱，加入非 root、禁网、资源限额及 Review 只读边界；通过 7 项真实隔离检查验证，并将发布验证关联到源码指纹、检查配置和执行环境。

**次优先方向：评测工程**

> 搭建覆盖 3 个开源 Node/TypeScript 仓库的 12 题受控缺陷评测集，划分开发集与保留集，编写独立验收脚本并固定模型、沙箱和预算；补充 RAG 检索对照与 Usage/失败记录。正式 72 次模型对照尚未完成，不附成功率提升结论。

**可选方向：RAG 技术实现（不写效果提升）**

> 实现 AST/Markdown 仓库切分、Qdrant Dense + SQLite FTS5 + RRF 检索及增量索引；用本地 Embedding 对 30 条暂定检索问题进行对照，发现当前关键词基线 Recall@5 高于 Dense 与混合检索。

如果版面只够放两条，先放沙箱/证据绑定和评测集/Harness；RAG 可以并入第二条或留作面试展开。正式模型收益、Review 准确度和“提升效率/成功率”的数字，目前都不应写进简历。

## 面试可讲的真实失败案例

1. 模型生成同一行多个 JavaScript 顶层表达式时，AST 切块得到重复 module ID，恢复后的 SQLite 索引写入报唯一键冲突。定位到相同符号/物理行范围，按范围去重、提升索引版本并补回归测试；`npm run verify` 通过。该 Harness 失败已从模型成绩中单列。
2. Dense 冷索引在 CPU Embedding 上触发 30 秒请求超时；为本地配置明确提高至 180 秒，同时保留首次失败记录、仍受单任务 30 分钟预算限制，并验证向量批次一致性与缓存命中。
3. 检索结果显示暂定关键词 Recall@5 高于 Dense 和混合模式，因此不宣称“启用 RAG 即提升效果”；人工复核标注、扩充更有区分度的检索问题、优化混合权重是后续工作。

## 后续润色对话应先确认

1. 申请的岗位/岗位 JD，以及简历语言、版面和目标字数。
2. 该仓库的起止时间、团队规模、用户本人负责的模块，以及哪些代码本人能讲解和维护；不可默认把协作产出全部归为个人独立完成。
3. 是否继续完整72次矩阵/重复复现、人工复核30条检索标签并运行 Review 专项。当前 DeepSeek 指标只适用于六题受控保留集，不外推成总体模型成功率；检索标签仍未真人确认，Review 准确率仍没有数据。

## Ragas 分层评测新增证据（2026-10-05）

Ragas 0.4.3 已真实接入并运行，不再是计划功能。固定批次包含 30 条仓库问答、18 条修复版历史 Agent 轨迹和 3 条真实窄工具任务；收费请求受持久化 ¥3 账本限制，估算 ¥2.975172，实际平台账单未核对。预算内评分了 12 条完整 Agent 轨迹、3 条窄工具任务，并对检索问题完成部分回答/上下文评分；58 个样本未运行。

可以作为工程亮点的是：保存真实 Top-5 检索原文，分开计算 ContextPrecision、ContextRecall、Faithfulness 与 AgentGoalAccuracyWithReference；将原始评判输出、请求 ID、Usage 和独立功能验收/Gate 关联保存；预算超限前拒绝下一次请求。实测中 Hybrid 暂定文件/符号 Recall@5 为 25/30，关键词 22/30，Dense 19/30；标签未真人复核，且问题属于迭代集，不能宣称独立保留集提升。Agent Judge 对独立验收出现 1 个假阳性和 3 个假阴性。窄工具任务 3/3 通过，但样本只有三题。

逐题证据：`E:\newagent\data\ragas\ragas-v1\report.md`、`scores.jsonl`、`scores.csv`、`review_queue.jsonl` 和 `raw-llm-calls.jsonl`。简历只能描述已实现的评测流程及明确样本范围的实测值；不可把部分评分写成全量评测、人工金标准、泛化成功率或真实账单金额。

评测达到预算上限时，Instructor 将预算拒绝包装成连接错误；最终记录已按持久账本更正，分数未改。manifest 分开保存了实际执行期源码 hash 和评测后分类修正 hash。由于运行代码已在评分后修正，后续复跑需创建新批次，不要覆盖 v1 或声称新代码参与了 v1 结果。
