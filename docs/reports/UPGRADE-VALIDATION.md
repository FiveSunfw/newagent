# NewAgent 升级验证记录

基线 main/e4658db；功能分支 codex/sandbox-harness-rag。未推送，未创建或合并 PR。当前是部分实现与验证记录，整个补齐计划尚未完成。

## 已实现

Docker 默认执行边界与明确 trusted-host；任务快照过滤、非 root/资源/网络/权限限制；开发读写搜索与配置检查、只读 Review、默认终端宿主工具禁用；累计预算与持久化恢复计数；源码/配置/环境证据绑定；工具事件与大输出制品；AST/Markdown/行切分、SQLite FTS5、Qdrant Dense 接口与 RRF、增量索引与显式降级；官方 SDK 本地 MCP；按需只读检索专家。

## 真实服务与协议结果

- Docker Linux 引擎与 E 盘磁盘位置实际确认。
- 7 项 Docker 隔离 smoke 通过，TaskExecution 路径和检查源码不可变性通过。
- 跨文件固定开发 fixture：检查失败 → 返修 → 独立只读 Review → ready_for_pr；配置变更使发布证据失效。此结果是协议 fixture，不是模型效果。
- 空依赖 npm fixture 的 Linux 依赖卷准备通过；第三方/native/workspace 尚未验收。
- Qdrant 真实 upsert/query、仓库过滤、删除通过，固定 Embedding fixture，收费调用 0。
- MCP 官方 SDK InMemoryTransport 测试通过；真实 stdio 握手与文件读取通过。

具体运行 JSON 在 E 盘 cache 的 sandbox-smoke、sandbox-workflow、qdrant-smoke 下；运行数据不提交。最新 `npm run verify`：类型检查、48 项测试和生产构建通过；检索删除恢复、CommonJS AST 切块、query instruction、真实 stdio 与中文流式输出均包含在验证中。2026-10-03 真实 Docker 隔离 7 项全部通过；实际 Embedding 1024 维、批量池化一致性与缓存命中通过。

## 两个失败与改进案例

1. 原执行器对环境变量按 KEY 脱敏，删除 GIT_CONFIG_KEY_0 却保留 GIT_CONFIG_COUNT，导致 git init 失败。现在先移除整组继承 Git 配置，再显式注入必要认证。工作流回归恢复通过，密钥仍不记录。
2. Qdrant 只读系统启动时 snapshots/tmp 无法创建，NTFS bind 还出现存储安全警告。现在快照和数据都落到 Linux 数据卷，保留服务非 root 与只读系统。internal 网络下宿主发布端口未生成；普通 bridge 方案被自动审批拒绝，因此使用同内部网络的受限代理，真实健康和 collection 操作通过。

## 评测与预算

早期校准因用户余额有限使用 E 盘本地 Qwen3 1.7B 与 CPU Qwen3-Embedding-0.6B。用户随后授权使用 SiliconFlow 的 DeepSeek-V4-Flash 完成旧失败案例及开发集 RAG/no-RAG 对照；17 个成功评测任务运行按常规时段 token 单价估算约 ¥1.12，实际账单尚未核对。RAG Embedding 均由本地 Qwen 执行，不产生付费 Embedding 调用。相关批次位于 E 盘 repository-eval-v2。

12个固定仓库任务、独立验收、开发/保留划分已建立，参考版本通过且受控缺陷版本失败逐项验证。`calibration-v4` 三任务本地模型校准9次，功能验收0/9；没有收费API调用。之后的 `calibration-v5` 明确标记为 exploratory / incomplete，只保存4/9结果，功能验收0/4、交付Gate 0/4、契约 smoke 1/4；其任务提示仍要求新增受保护测试目录中的测试，不是针对本轮修正后的可比复测，不能并入校准成绩。`repository-eval-v2/diagnostic-v1` 完成6/6配对运行，off/on 两组功能验收均0/3；on 组在 `dlv-falsy-values` 中写入过1条反思，但最终仍失败，另2次反思重复。轨迹还显示5次空最终回复，促使加入验收后恢复；`diagnostic-v1` 是修正前基线。30条真实Embedding检索对照完成，暂定Recall@5为关键词0.733、Dense 0.567、混合0.667；问题由Agent草拟且目标已核源码，仍待人工标注确认。

随后 `diagnostic-v2` 在空回复恢复代码下也完成6/6，功能验收仍0/6。off 组工具调用总数125，on 组66；但 on 组仍0/3通过，不能称为成功率提升。off 的 `dlv-falsy-values` 有94/100次工具调用是重复 `read_file`。`diagnostic-v3` 在源码再次修正期间记录3/6后停止；`interruption.json` 标记为不可聚合。完整的 `diagnostic-v4` 仍是0/6功能通过；off/on平均耗时94/119秒，工具调用64/108。off 的 `dlv` 仍到100次预算；on 组保存5条经验但也未通过。本地 Ollama 实际配置上下文4096，之前评测却声明8192；`diagnostic-v5` 已将声明对齐到4096并把输出上限减至2048。

`diagnostic-v5` 已完成6/6，功能和交付Gate均0/6。off平均67秒、52工具调用；on平均131秒、128工具调用，反思调用9次、保存4条经验，仍0/3通过。输出截断从v4的off/on 2/1次变为v5的1/0次，但小样本不能证明这是配置带来的稳定改善。普通 profile 的 Reflexion 已改为默认关闭并可显式开启；标准对照也关闭，后续只有在新模型/提示再次显示收益时才默认启用。

`diagnostic-v6` 完成6/6；Reflexion off/on 功能验收仍均0/3。off 平均85秒、68工具；on 平均119秒、96工具，仍无功能收益。`sampling-diagnostic-v1` 将 `presence_penalty` 从1.5调到0.3，仍0/3通过，平均159秒、165工具调用，比v6 off更差。`context-diagnostic-v1` 的三题 no-RAG 与 RAG 臂均0/3；RAG 平均216秒、104工具，no-RAG 107秒、87工具，初始结果多为测试和README。

`retrieval-v2` 完成30题 × 3种检索模式，共90次。按兼容 CommonJS 符号集合重算：关键词/Dense/Hybrid 的 Recall@5 为22/30、19/30、25/30，MRR@10 为0.454、0.395、0.477；旧 baseline 用相同兼容标签重算为Recall@5 22/30、17/30、20/30，MRR@10 0.437、0.314、0.429。新批次更改了 CommonJS chunking、Qwen3 Embedding 查询指令和 document 原文编码；标签未人工审核，结果只能视为 provisional。

`rag-diagnostic-v1` 和 `rag-diagnostic-v2` 在相同的3题、模型、验收、采样与4K SDK context下，功能验收均为0/3。初始RAG候选包含受控缺陷目标文件的覆盖从2/3提高到3/3；v1 平均252秒、122工具、输入112,073 Token，v2 平均109秒、59工具、输入34,357 Token；压缩事件从26降至5。source-first 上下文和索引后快照复用减少了空转，但仍不能声称提高修复成功率。`window-diagnostic-v1` 把 SDK context 调到8K，仍0/3，平均123秒、116工具，高于4K no-RAG 诊断的107秒、87工具，因此保持4K客户端预算。

正式批次保留两项历史故障：`formal-v2` 记录25/72项，其中一个进程恢复样本出现 `retrieval_chunks.id` 重复键；之后已修索引并加入同一物理行多表达式回归测试。`formal-v3` 曾因 Docker Linux 管道不存在而在首项预检停止；该基础设施故障已于2026-10-04恢复，Docker Linux、Qdrant 与本地服务均重新确认。完整72次正式矩阵仍未完成；早期 Qwen3 1.7B 开发集校准为0/9，2026-10-05 的 DeepSeek Flash 保留集结果见下节。人工 Review 判定和完整演示尚未完成。运行说明见[LOCAL-EVALUATION.md](../LOCAL-EVALUATION.md)。

## 32K 配对诊断与 SiliconFlow 复测结果

2026-10-04 对 dlv-falsy-values 进行一次相同 Harness 的 32K 配对诊断：本地 Qwen3 1.7B 功能验收 0/1、Gate 0/1，269.5 秒、25 次工具尝试和 3 轮修复，最终 Diff 为空；DeepSeek Flash 官方 API 功能验收 1/1、Gate 1/1，31.5 秒、11 次工具尝试、0 轮修复，独立验收通过。数据集、运行源码、评测 Harness、采样、沙箱和验收配置一致。DeepSeek 轨迹有 4 次 run_check 工具名无效。样本每配置只有 1 次，不能推导整体模型排名。

SiliconFlow 专用 provider 使用模型 ID deepseek-ai/DeepSeek-V4-Flash 和 Base URL https://api.siliconflow.cn/v1。NEWAGENT_API_KEY 只在宿主 worker 中经 Pi Runtime 内存凭据覆盖使用；不保存进模型配置或 Docker 环境。每题限制24次工具、3轮修复、10分钟，使用256K客户端窗口、2048最大输出、关闭思考输出、single-no-rag；本次模型列表接口仅返回模型 ID，manifest 的 providerContextWindow 留空，因此256K是客户端窗口设置，不是服务端最大值的验证。

v14 mitt-wildcard、v15 dlv-falsy-values、v16 stringify-nonfinite 的独立功能验收和交付 Gate 均通过（3/3）；耗时分别63.6、59.4、45.8秒，Agent 工具尝试分别12、9、15次，均无修复轮。总 usage 119,404 tokens；按硅基流动常规时段官方单价估算约¥0.17，实际账单未核对。三题均为控制植入缺陷的固定快照、每题单次运行且single-no-rag；不能外推总体模型成功率，也不是与此前4K/32K Qwen或RAG配置的严格对照。共出现14次“Unknown configured check”和1次重复失败工具输入；这些错误没有阻止最后的独立验收通过，后续应收紧run_check可选名称。

single-case-diagnostic-v11 保留第一次 Docker pipe 权限失败，usage为0；提升权限后只读 docker ps 确认 Linux daemon 在线，v14-v16均在隔离容器中完成。任务用本地Qwen Embedding的single-no-rag没有调用Embedding。当时47/47自动化测试、类型检查和生产构建通过；当前已新增恢复凭证回归测试，累计48/48。`test:fixtures`通过并检出10/10个预置缺陷。逐题记录和价格说明见[本地评测说明](../LOCAL-EVALUATION.md)。

## 六题开发集 RAG / no-RAG 配对与工具 schema 修正

v17-v28 使用同一六题开发集、SiliconFlow DeepSeek-V4-Flash、256K 客户端窗口和固定 Harness，比较 single-rag 与 single-no-rag，各题各跑一次。两臂独立功能验收及 Gate 均为 6/6。RAG 的 Dense 调用 6/6 成功；按固定变异实现路径作目标，初始前三候选命中 5/6。

|指标|single-rag|single-no-rag|
|---|---:|---:|
|验收 / Gate|6/6 / 6/6|6/6 / 6/6|
|中位耗时|96.7 秒|56.7 秒|
|中位 Agent 工具尝试|11|11.5|
|中位总 usage|40,117 tokens|39,313 tokens|
|中位费用估算|¥0.069|¥0.057|

此小样本中 RAG 没有提高通过数，中位任务耗时约多40秒；RAG 索引更新时间平均38秒，查询耗时0.8–1.3秒。Token 中位数与费用中位数略高。初步路由建议是简单单文件缺陷用 no-RAG；代码位置不明确或跨文件任务再启用 RAG。目标命中标签来自受控变异路径，不是人工标注的通用检索金标准。六题每臂只运行一次，不外推总体结果。

这六题中，模型共有66次 run_check 尝试了未配置的检查名，另有3次重复失败工具输入。PiAgent 现在把合法检查名列入工具描述，并把参数 schema 限定为当前 profile 的检查名。单独重跑 mitt-unknown-handler：RAG 臂 Unknown configured check 从13次降至0、工具尝试从19降到10；no-RAG 臂从6次降至0、工具尝试从14降到6；两次修改前后均通过验收。这个一题一配置的复测支持工具 schema 修正有效，但仍需在更大样本验证。该阶段47/47自动化测试通过；后续加上 worker 重启回归测试后累计48/48。`test:fixtures`通过、10/10预置缺陷被检出。

此前开发诊断中的17次 SiliconFlow 生成调用按常规时段价格估算约¥1.12；实际账单未与控制台核对。此后完成了修复 Harness 后的六题保留集三臂对照，完整逐项数据见下节。

## 修复 Harness 后的六题保留集对照

2026-10-05 对 6 个固定 holdout 任务各运行 single-no-rag、single-rag、adaptive-rag 一次，共18次。no-RAG 功能验收/Gate 为6/6；RAG为6/6和5/6；adaptive-RAG为5/6和2/6。三臂中位耗时66.6/133.1/154.6秒，中位费用估算¥0.0759/¥0.0879/¥0.1316。两个RAG臂初始Top-3目标文件命中12/12，但没有转化成更好的Gate。Dense 12/12成功，索引更新中位24.3秒。

评测发现旧恢复路径会在 checkpoint 后漏传宿主凭证环境覆盖。修复 Worker 启动逻辑并加入假密钥回归后，真实模型三次 checkpoint 运行都完成了 Worker 重启；两次 Gate 通过，adaptive-RAG 一次在后续阶段因共享工具预算耗尽失败。最新 `npm run verify` 48/48，类型检查和生产构建通过；`npm run test:fixtures` 10/10。完整72次矩阵和 Review 人工判定仍未完成；受控任务不是自然历史 Issue。完整数据、失败原因和费用口径见[六题保留集三臂报告](HOLDOUT-STRATEGY-RESULTS.md)。

## 开发失败轨迹复核与本轮修正

两名只读子代理分别复核了 `calibration-v4` 的三条开发任务轨迹和30条检索候选标注。三条轨迹共同问题是模型反复提交无效路径/替换参数、产生不必要的修复调用，或把示例和测试片段写进生产代码；`mitt-wildcard` 两个策略没有留下源码 Diff，`stringify-nonfinite` 与 `dlv-falsy-values` 则出现错误实现或语法破坏。旧任务要求 Agent 新增回归测试，但评测 profile 又将整个 `test/`、`tests/` 设为只读，构成提示与权限冲突。

本轮已增加仓库根相对路径及替换参数示例，拒绝 before/after 完全相同的无效替换；同一 Pi Agent 调用中，某个完全相同的工具输入首次失败后再次出现会终止该调用，并保留明确错误类型；SDK 校验失败日志移除回显参数，避免把原始参数写入事件。评测任务改为使用固定独立验收，不再要求编辑受保护测试。还增加失败类别、工具调用指纹和重复失败的本地协议测试。

现已加入 Reflexion 闭环：程序检查/Review 是 Evaluator；仅失败且还有修复轮次时，Reflector 根据宿主整理的最多4条证据（验收摘要、工具错误、变更路径及限长 diff hunk）生成结构化经验，再带入下一次开发提示。经验必须引用当前试次有效证据 ID，最多保留3条；Reflector 没有任何工具，重复或无效反思不会进入记忆；反思重复后跳过后续 Reflector 调用，直接复用已有经验和最新验收反馈。`profile.reflexion` 默认关闭，任务 profile 可显式开启；本机1.7B的配对诊断显示开启后 Token/工具调用和耗时更高、3题功能通过仍为0，因此不默认承担这部分开销。不增加100工具调用、3轮修复或30分钟期限，反思产生的 Usage 与耗时仍计入同一 Run。模型空最终回复现在作为失败尝试进入程序验收，再按验收结果反思/修复；连续三次相同 `read_file` 输入得到相同内容会触发循环护栏。Reflector 输出字段限长，数值型空 `doNotRepeat` 会规范化为空列表，避免长字段或标量格式使整条记忆被拒绝；提示移除容易被小模型照抄的占位词。协议测试覆盖失败后反思、重复去重、经验持久化、空回复恢复、只读 Reflector 和相同结果读取护栏。本机 Qwen3 1.7B 的单次合成提示 smoke 在1.26秒内返回了合法结构并引用输入证据，记录在 E 盘 `data/repository-eval-v2/reflexion-smoke.json`；这只验证输出协议，不证明代码任务修复率提升。

检索候选最初由子代理建议：接受13题现有目标、收窄或改写17题；之后为 CommonJS `module` 粗粒度 chunk 增加可接受符号集合。AI复核表和原始候选均保留；`humanReviewed=false` 未更改。Recall/MRR 比较路径与兼容符号，不是人工金标准，也不代表精确行级定位。

## 仍存在的范围缺口

长期任务容器/Git worktree、完整主 Agent 预算、父子调用图、快照配额回收、真实模型功能任务通过、完整演示、检索人工标注与 Review 人工判定仍缺失。正式对照尚未执行，不得写成完整成绩。当前限制详见 SANDBOX.md 和 RETRIEVAL-MCP.md，不应在简历中写为已完成。

## 可用 STAR 初稿（仅使用已验证内容）

问题：原工具能协作开发、检查和 Review，但任务执行仍拥有宿主能力，旧评测无法证明新流程收益。

目标：保留 TypeScript/Pi/Fastify/SQLite 与原生终端，建立可验证的执行边界和可追溯仓库证据。

行动：关闭默认交付会话的宿主工具，统一受控文件与检查层；使用 Linux Docker 快照隔离、只读 Review、禁网与累计预算；绑定源码/验证配置/镜像指纹；增加 AST/FTS/Qdrant 检索接口和本地 MCP。

结果：真实 Docker 与 Qdrant 协议检查通过，固定跨文件流程经历真实检查失败和返修并阻止旧配置证据发布。30题 provisional 检索对照中 Hybrid Recall@5 为25/30，但标签待人工确认；真实代码任务仍未通过验收，不能声称 RAG 或多 Agent 提高修复成功率。

取舍：短生命周期快照牺牲部分吞吐以简化凭证隔离；Linux 依赖单独准备，Windows fixture 明确作为 trusted-host；低余额下使用本地小模型与 CPU Embedding，保留工具参数错误、预算耗尽和截断的真实失败。真实服务、协议通过与模型功能通过分别报告。
