# NewAgent 测试状态交接

更新时间：2026-10-05

用途：交给另一个对话继续分析 NewAgent 的测试、评测和可写简历指标。本文将自动化/协议验证与真实模型结果分开，失败、部分记录和未运行项目均保留。

## 当前代码状态

- 仓库：E:\newagent\app
- 基线：main / e4658db
- 当前分支：codex/sandbox-harness-rag
- 本地有未提交修改和新增文件；没有推送，没有创建 PR。
- 运行数据、评测语料和缓存位于 E:\newagent\data、E:\newagent\cache、E:\newagent\upstream。
- 早期校准使用本地 Ollama Qwen3 1.7B 标签（模型元数据约 2.0B、Q4_K_M）。旧版17个成功任务约¥1.12；最新修复版保留集18次 DeepSeek-V4-Flash 任务约¥1.88。含先前诊断与中断批次余量，全部调用累计费用估算约¥4.05，实际账单未核对；RAG 臂使用 CPU Qwen3-Embedding-0.6B，不产生付费 Embedding 调用。Model/Embedding 缓存仍在 E 盘。

## 源码标注复核

Codex 已将 30 条检索问题逐条对照实际索引的固定源码快照复核。30/30 个目标文件和符号均可接受；17 条行范围适合收窄；Q28 的措辞存在歧义并附了建议改写。逐题证据见 [检索标注第二轮复核](reports/RETRIEVAL-LABEL-SECOND-PASS.md)。

这次是 AI 独立核源，不是真人签字。retrieval-questions.ts 与结果文件的 humanReviewed=false 保持不变。已有分数只按文件路径和允许符号评估，不衡量精确行命中；行范围修订不会重算历史分数。若改写 Q28，应创建新批次，不能覆盖 retrieval-v2。

## 自动化测试与工程验证

|检查|状态|结果与边界|
|---|---|---|
|npm run verify|通过，2026-10-05 最近一次运行|类型检查通过；npm test 为 48/48、0 失败；生产构建通过。此命令不调用真实生成模型。|
|npm run test:fixtures|通过，2026-10-05 本次运行|订单 fixture 独立验收与 HTTP+SQLite 集成通过；10/10 个预置缺陷均被检测。它是程序验收 fixture，不是模型修复成绩。原始汇总位于 E:\newagent\data\eval\fixture-validation.json。|
|真实 Docker 沙箱 smoke|记录通过，最近报告 2026-10-03|7/7 检查通过：非 root/无宿主凭证和 socket、禁网、Review 只读、开发写快照、只读 rootfs/权限限制、超时清理、取消清理。报告位于 E:\newagent\cache\sandbox-smoke。|
|Docker 当前在线状态|在线，2026-10-04 只读确认|提升权限的 docker ps 显示 app-qdrant-1 Up 12 hours。普通受限进程访问 dockerDesktopLinuxEngine 命名管道被拒绝；任务在提升权限的宿主编排下仍使用配置的 Docker Linux 容器，未回退宿主执行。|
|固定跨文件沙箱工作流|协议 fixture 通过|两次记录均经历检查失败、返修、独立只读 Review 通过并进入 ready_for_pr；修改检查配置后旧证据失效。realModel=false，不是模型能力评测。报告位于 E:\newagent\cache\sandbox-workflow。|
|Qdrant 服务 smoke|真实服务通过，2026-10-02|两次记录均通过健康检查、upsert/query、仓库隔离和删除；使用固定 Embedding fixture，收费模型调用 0。报告位于 E:\newagent\cache\qdrant-smoke。|
|MCP|协议验证通过|官方 SDK InMemoryTransport、任务绑定/权限边界测试通过；本地 stdio 握手和受控读取也包含在最新 48 项测试中。没有接入任意外部 MCP 服务。|
|Embedding|记录通过|本地 Qwen3-Embedding-0.6B 真实调用，1024 维；批量池化一致性与缓存命中通过；新 RAG 配对中 Dense 6/6 成功。CPU 服务在评测后已停止，权重与缓存保留在 E 盘。|
|12 题仓库缺陷集预检|记录通过|覆盖 3 个固定 Node/TypeScript 仓库、6 个开发任务和 6 个保留任务；参考版本验收通过，受控缺陷版本验收失败。不是自然历史 Issue，也未运行上游完整测试矩阵。|
|DeepSeek Flash 保留集三臂评测|18/18 条结果保存|6题×single-no-rag/single-rag/adaptive-rag×1次；功能通过分别6/6、6/6、5/6；Gate分别6/6、5/6、2/6。受控缺陷、每臂单重复；不等于完整72次矩阵。RAG命中目标Top-3为12/12，未提高端到端 Gate。报告：reports/HOLDOUT-STRATEGY-RESULTS.md。|
|Review 质量专项|未完成|没有带人工判定的 Review 精确率、召回率、有效发现率或误报阻断数。JSON 格式和只读协议测试不等于 Review 准确率。|
|完整演示/发布|未完成|没有完成真实模型驱动的完整跨文件演示；没有推送或 PR。|

48 项 npm 测试覆盖权限与路径边界、源码/配置/环境证据失效、共享预算与恢复、取消和超时、敏感信息脱敏、索引增删与降级、Qdrant 删除恢复、MCP、Review 输出校验、工作流检查与失败恢复，以及重启 Worker 复用宿主凭证覆盖的回归。测试通过说明这些测试场景成立，不等价于完整安全审计。

## 更早的校准与基线记录

|批次|记录状态|结果|是否可与新版结果合并|
|---|---|---|---|
|repository-eval/calibration-v1|计划 9 次，记录 4 次后中断|功能验收 0/4、Gate 0/4、contract smoke 4/4|否；修复模型输出截断与精确编辑工具期间停止，interruption.json 明确 formalResults=false。|
|repository-eval/calibration-v2|计划 9 次，仅记录 1 次|功能验收 0/1、Gate 0/1、contract smoke 1/1|否；在采样/输出长度校准期间停止。|
|repository-eval/calibration-v3|计划 9 次，仅记录 2 次|功能验收 0/2、Gate 0/2、contract smoke 1/2|否；为计入 SDK 拒绝的工具调用预算而停止。|
|local-eval/calibration-DnBZpf|完整 9 次|合成订单任务三种策略均功能验收 0/3、Gate 0/3|否；只用关键词 RAG，不是固定仓库集或单 Agent 消融。|
|2026-10-01 real-eval|完整 6 次|Direct Pi 与旧版 NewAgent 的功能验收都是 3/3；严格提交 Gate 为 1/3 与 2/3|仅作旧系统小样本基线。保护测试策略与 Review 输出错误影响严格结果，不能当作新版 Docker/RAG 成绩。|
|2026-10-01 native-quality|单次完整任务|DeepSeek Flash 任务耗时 173.1 秒，进入 ready_for_pr；检查通过、Review pass|单个不同任务的一次演示，不能推总体通过率。|

旧基线方法、每题结果和缺陷说明见 reports/REAL-EVAL-REPORT.md 与 reports/NATIVE-QUALITY-RUN.md。

## 本地生成模型批次

下列功能通过数均来自独立验收。诊断批次使用三个开发任务；不同代码/prompt/profile 的历史批次不应合并成一个成功率。所有调用均为本地模型，无收费 API。

|批次|记录状态|独立功能验收|解释|
|---|---:|---:|---|
|calibration-v4|完整 9/9|0/9|三任务校准的完整记录。|
|calibration-v5|部分 4/9|0/4，Gate 0/4|提示/权限配置不兼容且任务要求编辑受保护测试，不可并入 v4。|
|formal-v1|部分 5/72|无通过|旧正式矩阵未完成。|
|formal-v2|部分 25/72|无通过|记录中有 1 项 Harness 故障（恢复索引的重复键问题，随后加入回归测试）；不能作为完整正式对照。|
|formal-v3|仅预检记录 1/72|无有效模型样本|Docker Linux daemon 连接失败，基础设施故障后停止；不是模型失败。|
|diagnostic-v1|完整 6/6|0/6；Reflexion off/on 各 0/3|配对诊断。|
|diagnostic-v2|完整 6/6|0/6；两组各 0/3|空回复恢复后的配对诊断，仍无功能通过。|
|diagnostic-v3|中断 3/6|不可汇总|代码变更期间停止，保留 interruption.json。|
|diagnostic-v4|完整 6/6|0/6；两组各 0/3|Reflexion 未显示修复收益。|
|diagnostic-v5|完整 6/6|0/6；Gate 0/6|4K 客户端上下文、2048 输出上限；Reflexion on 调用更多工具和时间。|
|diagnostic-v6|完整 6/6|0/6；两组各 0/3|Reflexion on 平均 119 秒/96 工具，off 85 秒/68 工具，未改善验收。|
|sampling-diagnostic-v1|完整 3/3|0/3|presence_penalty 0.3；平均 159 秒、165 工具。保留 1.5。|
|context-diagnostic-v1|完整 6/6|No-RAG 与 RAG 各 0/3|RAG 臂平均 216 秒/104 工具；No-RAG 107 秒/87 工具。|
|rag-diagnostic-v1|完整 3/3|0/3|优化前单 Agent + RAG 诊断。|
|rag-diagnostic-v2|完整 3/3|0/3|优化后单 Agent + RAG 诊断；效率数据见下节，但未提高功能验收。|
|window-diagnostic-v1|完整 3/3|0/3|8K 客户端窗口平均 123 秒/116 工具；保留 4K 预算。|

### 32K 单题对照与 SiliconFlow 复测结果

single-case-diagnostic-v9/v10 是同一个 dlv-falsy-values 开发任务的一次配对对照，数据集、运行时源码、评测 Harness、32K 客户端上下文、采样、沙箱和独立验收相同：

|批次|模型|功能验收 / Gate|耗时|结果|
|---|---|---:|---:|---|
|single-case-diagnostic-v9|本地 Qwen3 1.7B|0/1 / 0/1|269.5 秒|25 次工具尝试、3 轮修复；最终 Diff 为空。|
|single-case-diagnostic-v10|DeepSeek Flash 官方 API|1/1 / 1/1|31.5 秒|11 次工具尝试、0 轮修复；最小修改通过独立验收，但曾 4 次传入无效 run_check 名称。|

这是每配置 1 次、仅 1 道题，不能当作总体成功率。它显示把 Qwen 从 4K 扩到 32K 没有解决本题；系统侧的无效工具输入和修复反馈问题也仍需修。

SiliconFlow DeepSeek-V4-Flash 已在 256K 客户端窗口下重跑三个旧失败任务：single-case-diagnostic-v14/v15/v16 的独立功能验收与交付 Gate 均为 3/3。合计总 usage 119,404 tokens，峰时价格估算约 ¥0.17，实际账单尚未核对。三题为 single-no-rag，每配置每题仅一次，不是总体模型胜率。过程有 14 次未配置 run_check 名称和 1 次重复失败输入；详细逐题数据见本地评测说明。批次 v11 保留一次 Docker pipe 权限失败，usage 为 0；提升权限确认 daemon 在线后，v14-v16 成功在容器内运行。此前 Direct DeepSeek 的 32K dlv 样本是另一 provider/配置，不与本批次合并。

### 六题开发集 RAG / no-RAG 配对

v17-v28 对固定六题开发集每题各运行一次 single-rag 和 single-no-rag；两臂的 dataset、runtime、evaluation Harness、模型、256K客户端窗口、采样、检查、权限和预算哈希一致。Dense 检索均成功，单次 RAG 检索把变异目标实现文件放进初始前三候选的 5/6 题。

|配置|功能验收 / Gate|目标文件候选命中|中位耗时|中位工具尝试|中位总 usage|中位费用估算|
|---|---:|---:|---:|---:|---:|---:|
|single-rag|6/6 / 6/6|5/6|96.7 秒|11|40,117 tokens|¥0.069|
|single-no-rag|6/6 / 6/6|不适用|56.7 秒|11.5|39,313 tokens|¥0.057|

这个开发样本里 RAG 没有提高通过数，索引更新使整体任务变慢；no-RAG 对简单单文件缺陷更省时。RAG 的目标文件候选命中仍说明它能提供定位证据；后续六题保留集三臂对照显示目标文件 Top-3 命中12/12，但 RAG 未改善 Gate，细节见保留集报告。两批每题每臂均只运行一次，不是稳定成功率估计。

前六题共出现 66 次 run_check 无效名称和 3 次重复失败输入。收紧工具 schema 后对 mitt-unknown-handler 做了一对 RAG/no-RAG 复测：无效检查名称均为 0；RAG 工具尝试从 19 降到 10，no-RAG 从 14 降到 6，两次均通过验收和 Gate。每种策略只有一个修复前后样本，应视为针对性验证，不当作普遍错误率下降。

此前开发集等 SiliconFlow 生成任务共17次，费用估算约¥1.12。恢复 Harness 修复后另完成18次保留集三臂对照，估算约¥1.88；含旧诊断和中断批次的保守余量累计约¥4.05，实际账单未核对。RAG 使用本地 CPU Qwen3-Embedding-0.6B。完整72次矩阵、Review 人工判定和多重复稳定性评测仍未完成。逐题结果与费用口径见[保留集评测报告](reports/HOLDOUT-STRATEGY-RESULTS.md)与[本地评测说明](LOCAL-EVALUATION.md)。

formal-v1、formal-v2、formal-v3 是多次未完成的正式矩阵尝试，不是可相加的独立全量实验。原计划 12 任务 × 3 配置 × 2 次，即 72 次，没有任何一个完整正式批次完成。

Reflexion 单次合成提示协议 smoke 为 1/1，1.26 秒返回结构化结果且引用输入证据；它只验证输出协议，不证明代码修复能力。

## 检索评测

|批次|记录|结果|状态|
|---|---:|---|---|
|repository-eval/retrieval-v1（旧基线）|90/90|Keyword R@5 22/30、MRR@10 0.437；Dense 17/30、0.314；Hybrid 20/30、0.429|运行完整但目标未真人复核；后续按兼容符号重新计分作为 retrieval-v2 对照。|
|retrieval-v1|50/90|在 Q17 停止|chunks-v4 拆分 CommonJS 符号后，旧目标仍只标 module，部分精确符号标签失效；interruption.json 将 aggregate=false，不能使用部分分数。|
|retrieval-v2|90/90|Keyword R@5 22/30、MRR@10 0.454；Dense 19/30、0.395；Hybrid 25/30、0.477|三种模式各跑 30 题。目标经 AI 核源但没有真人复核；仅作暂定文件/符号级结果。|

兼容符号口径下的旧基线：Keyword 22/30、MRR 0.437；Dense 17/30、0.314；Hybrid 20/30、0.429。新 Hybrid 比该基线高 5/30 个命中、MRR 高 0.048；但题目由 Agent 草拟、标签未真人审定，而且 Q1–Q3、Q11–Q15、Q21–Q25 分别共用粗粒度符号目标。不得称为人工金标准、精确片段命中率或通用 RAG 准确率。不同模式延迟计时范围不一致，也不据此宣传速度胜出。

RAG 诊断的工作量数据：v1 → v2 在同一 3 个开发任务中，平均耗时 252.2 → 108.7 秒，工具调用总数 122 → 59，输入 Token 总数 112,073 → 34,357，初始上下文包含目标文件从 2/3 → 3/3。两批验收仍均 0/3，因此只能说这次固定样本中检索上下文/工具使用开销下降，不能说 Agent 修复效果提升。

## 简历可用边界

可优先描述：Docker 隔离实现及 7 项实测检查；46 项自动化测试和类型检查/构建通过；独立验收 fixture 检出 10/10 预置缺陷；构建 12 题、3 仓库的受控评测集。

检索 25/30 与 RAG 诊断消耗下降需附上样本、口径和 AI 未真人确认的限制。不要写“模型修复成功率提升”“多 Agent 胜过单 Agent”“Review 准确率”“完整 72 次评测完成”。

## 原始证据

- 工程验证：[升级验证记录](reports/UPGRADE-VALIDATION.md)
- 逐题源码依据：[检索标注第二轮复核](reports/RETRIEVAL-LABEL-SECOND-PASS.md)
- 原始待确认表：[检索标注复核表](reports/RETRIEVAL-LABEL-REVIEW.md)
- 说明与运行边界：[本地评测说明](LOCAL-EVALUATION.md)
- 检索和 MCP：[检索与 MCP](RETRIEVAL-MCP.md)
- 模型批次在 E:\newagent\data\repository-eval 与 E:\newagent\data\repository-eval-v2 的各批次 report.md 和逐任务目录。
- retrieval-v2 原始记录：E:\newagent\data\repository-eval-v2\retrieval-v2\results.json。

## Ragas 分层评测状态（2026-10-05）

|项目|状态|证据/限制|
|---|---|---|
|Python 环境与依赖|通过|Python 3.11；Ragas 0.4.3；独立 E 盘虚拟环境；带哈希锁文件安装；`pip check` 无依赖冲突。|
|离线评测测试|通过|`npm run test:ragas`：23 项通过，1 项因当前 Windows 无符号链接权限跳过。覆盖 JSONL 契约、密钥/路径脱敏、源码引用、预算拒绝、Usage 缺失、缓存隔离、恢复、工具轨迹关联、评分错误和人工复核证据。|
|项目验证|通过|`npm run verify`：类型检查、48 项 TypeScript 测试及生产构建通过；不调用收费模型。|
|新鲜检索数据|完成|30 题 × 3 模式，90 条结果，保存 Top-5 实际片段；Qwen3-Embedding-0.6B CPU、Qdrant Dense + SQLite FTS。标签 AI 核源，未真人确认。|
|Ragas 分层评分|预算内部分完成|检索校准 9 条、Agent 校准 3 条、历史轨迹 12/18 条评分、窄工具任务 3/3、剩余检索 33 条有至少一项结果；58 个样本未运行，1 个样本部分评分。|
|预算与 Usage|按上限停止|322 次请求有 Usage，1 次在发送前因超限拒绝；保守估算 ¥2.975172/¥3，实际平台账单未核对。|
|Agent Judge 与程序标签|存在不一致|12 条完整轨迹均值 0.75；相对功能验收有 1 个假阳性、3 个假阴性。Ragas Judge 不能代替功能验收和 Gate。|
|窄工具任务|通过|ToolCallAccuracy 3/3；读取、符号搜索、读取后精确修改的隔离文件检查均通过。|

完整逐题结果和原始评判输出位于 `E:\newagent\data\ragas\ragas-v1\`。预算账本为 `E:\newagent\data\ragas\ledger-v1.json`；同一账本跨重启保留，不得通过重建 batch 清零。

预算停机时 Instructor 曾把本地预算拒绝包装成连接错误；账本中的 `budget_refused` 是权威原因。评测结束后已按账本校正唯一指标结果和 `run-state.json`，并在 manifest 保留执行期 runtime hash 与事后修正 hash；评分输出未重算。
