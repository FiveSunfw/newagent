# NewAgent Ragas 分层评测 v1

日期：2026-10-05（Asia/Shanghai）

完整逐样本报告与原始产物位于 `E:\newagent\data\ragas\ragas-v1\`。批次使用 Ragas 0.4.3、SiliconFlow `deepseek-ai/DeepSeek-V4-Flash`；本地 CPU Qwen3-Embedding-0.6B（1024 维）生成检索向量。客户端上下文上限为 262,144，provider 实际窗口未核实。回答生成与评判使用同一模型，存在自评偏差。

## 范围与结果

- 导出 111 个样本：30 个问题 × 关键词/Dense/Hybrid（90 条）、历史 Agent 轨迹 18 条、真实窄工具任务 3 条。
- 新鲜检索 90/90 完成并保留实际 Top-5 原文。文件/符号 Recall@5：关键词 22/30、Dense 19/30、Hybrid 25/30；MRR@10：0.454、0.395、0.477。目标标签由 AI 核源但未真人审核。
- Ragas 有效检索评分：

|模式|ContextPrecision|ContextRecall|Faithfulness|
|---|---:|---:|---:|
|关键词|0.770（n=10）|0.900（n=10）|0.601（n=10）|
|Dense|0.905（n=11）|0.909（n=11）|0.702（n=11）|
|Hybrid|0.779（n=11）|1.000（n=11）|0.616（n=11）|

- 18 条历史 Agent 轨迹中，12 条完整可评分，6 条因缺少工具结果标为不完整。AgentGoalAccuracyWithReference 均值 0.75；与独立功能验收相比有 1 个假阳性、3 个假阴性。程序功能验收为 17/18，交付 Gate 为 13/18。
- 三条窄工具任务 ToolCallAccuracy 为 3/3；隔离仓库状态独立检查为 3/3 通过。

## 预算与边界

账本共有 323 条请求记录：322 次发送后获得 Usage，1 次预算拒绝在发送前拦截。输入 563,615 tokens、输出 142,703 tokens、缓存输入 21,760 tokens。按普通公开单价、不抵扣缓存优惠估算 ¥2.975172/¥3.00；被拒绝请求的最坏预留为 ¥0.027102。实际账单未核对。

本轮完成 53 个样本并有 1 个额外部分评分样本；另有 58 个样本未运行。Q8 的历史文件/符号标签指向 `mitt/README.md`，而 README 没有回答省略 handler 时的 `off` 行为；参考答案仅指出文档缺失，仍待人工复核。30 题是迭代集，不是独立保留集；参考答案均标记为 AI 核源、未经真人审核。Ragas 分数不能替代功能验收或交付 Gate，也不构成成功率提升证据。

逐题分数、预算/失败状态、请求 ID 和 Usage 在 `scores.jsonl` 与 `scores.csv`；原始模型评判输出在 `raw-llm-calls.jsonl` 并按请求 ID 链接进 `review_queue.jsonl`。

预算拒绝时 Instructor 将本地拒绝包装成 `Connection error`。评测后根据账本把唯一该结果行和 `run-state.json` 更正为 `budget_refused`，保留包装错误文本作为附加字段；分数与已发送请求未改变。`manifest.json` 保留实际执行期 runtime hash，并单列评测后的分类修正及当前代码 SHA-256；如需复跑，应新建导出批次，避免把事后代码修正冒充为原评测代码。
