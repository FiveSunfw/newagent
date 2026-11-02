# DeepSeek Flash 六题保留集三臂对照

更新时间：2026-10-05

## 评测协议

对 repository-eval-v2 中 6 个未参与开发集调参的 holdout 任务，各运行一次 `single-no-rag`、`single-rag` 与 `adaptive-rag`，共 18 次。任务覆盖 `developit/mitt`、`epoberezkin/fast-json-stable-stringify` 和 `developit/dlv`，含受控植入缺陷与跨文件集成要求；这些不是自然历史 Issue。

三臂使用相同的 Docker Linux 执行边界、任务源码快照、独立功能验收和运行预算。每次最多 24 次工具预算、3 轮修复、10 分钟；SiliconFlow DeepSeek-V4-Flash，输出上限 2,048 tokens，temperature 0.7、top_p 1、presence penalty 1.5。Pi SDK 客户端上下文 cap 为 262,144 tokens；SiliconFlow 的模型列表未返回可核验的服务端上下文长度，不能据此宣称模型支持或实际使用了 256K。

RAG 与 adaptive-RAG 使用本机 E 盘的 Qwen3-Embedding-0.6B（CPU，1024 维）和 Qdrant；Embedding 没有产生付费 API 调用。18 个结果共享数据集 SHA-256 `9bc3860e3704ff084a28db50c7edf315cc088b8194734e3f499523cf90356f75` 和修复后的 Harness SHA-256 `d9ee93a0011302bc9843a08ee477bd618c963ef5366107a2d76ed41c636c34c9`。每臂每题只有一个重复样本。

费用按 SiliconFlow 常规时段的输入 ¥3/M、缓存读取 ¥0.3/M、输出 ¥9/M，使用每条结果的 token usage 估算；实际账单未在账户控制台核对。参见[官方价格公告](https://docs.siliconflow.cn/docs/release-notes/overview)。

## 汇总结果

|配置|功能验收|交付 Gate|中位耗时|中位 Agent 工具调用|中位预算工具量|中位总 usage|中位费用估算|六题费用估算|
|---|---:|---:|---:|---:|---:|---:|---:|---:|
|single-no-rag|6/6|6/6|66.6 秒|10.5|12.5|39,093 tokens|¥0.0759|¥0.4783|
|single-rag|6/6|5/6|133.1 秒|11|14.5|38,118 tokens|¥0.0879|¥0.5975|
|adaptive-rag|5/6|2/6|154.6 秒|19|23|61,444 tokens|¥0.1316|¥0.8057|

18 次合计 1,026,690 tokens，费用估算约 ¥1.88；人工代码介入 0 次，修复轮次合计 3。Agent 工具调用来自 `agent_tool` 事件；“预算工具量”是共享 Harness 消耗量，两者口径不同。

相对 no-RAG，RAG 的中位耗时约增加 100%，中位费用约增加 16%，功能通过数相同而 Gate 少 1 题。adaptive-RAG 的中位耗时约增加 132%、中位 usage 增加 57%、中位费用增加 73%；功能验收少 1 题，Gate 少 4 题。因此这组数据不支持“默认启用 RAG/多 Agent 能提升任务通过率”，也不支持把多 Agent 作为默认路由。

RAG 的检索本身能定位样本目标：single-rag 与 adaptive-rag 共 12 次初始检索，Dense 12/12 成功，12/12 在 Top-3 返回至少一个由植入变异指定的目标文件；索引更新中位数 24.3 秒，混合查询中位数 0.80 秒。这证明固定任务上能检索到目标路径，但没有带来更好的端到端 Gate 结果。

## 失败原因与修复证据

- `mitt-once-integration` 的 single-rag 首轮 contract smoke 与独立验收失败，进入一次修复后独立功能验收通过；但共享预算耗尽，最终 Gate 未通过。该运行消耗 24 个预算工具单位。
- `mitt-once-integration` 的 adaptive-rag 在只读检索专家阶段返回普通文字而非 JSON，结构化解析失败，开发 Agent 没有完成公共导出，功能验收和 Gate 均失败。
- adaptive-rag 在 `stringify-key-comparator`、`stringify-cycle-recovery` 和 `dlv-options-integration` 上均通过独立功能验收，但 Review 阶段耗尽 24 个预算工具单位，Gate 未通过。`dlv-options-integration` 的 Review 输出还出现非法 JSON，格式重试后预算不足。
- 共 3 次运行经历“首轮检查失败 → 一轮修复 → 最终独立验收通过”：两次完整到达 Gate，一次 single-rag 因预算耗尽停在 Gate 之前。没有无反馈对照臂，因此这是轨迹事实，不是“反馈机制因果提升”的估计。

保留集包含 `stringify-cycle-recovery` 进程重启任务。旧批次 v10–v12 在 checkpoint 后因恢复 Worker 漏传宿主凭证环境覆盖而失败；密钥在容器中始终未开放。已抽取 `executeWorkerWithRecovery`，让重启 Worker 复用相同的宿主环境覆盖，并添加只用假密钥的回归测试。修复后的 no-RAG、RAG、adaptive-RAG 三次运行都触发并完成 Worker 重启；前两次 Gate 通过，adaptive-RAG 后续因共享工具预算耗尽而 Gate 失败。旧批次保留为 Harness 故障证据，不并入以上对照。

修复后 `npm run verify` 为 48/48 测试通过，类型检查和生产构建通过；`npm run test:fixtures` 为 10/10。真实恢复结果、原始逐题 JSON 和事件保存在 `E:\newagent\data\repository-eval-v2\single-case-holdout-diagnostic-v19` 至 `v36`。

## 可写简历的边界

可以写“搭建三仓库、六题保留集的三策略对照评测，并分别报告功能验收、交付 Gate、工具预算、耗时和模型 usage”；也可以写“发现并修复 checkpoint 重启时凭证环境遗漏，假凭证回归测试通过，真实模型恢复运行 3/3 完成 Worker 重启”。

不应写 RAG 或 adaptive-RAG 提高了成功率；不应把受控植入缺陷描述成自然 Issue 修复；不应把这 18 次说成完整的 12 题 × 3 配置 × 2 次正式矩阵。Review 质量专项和真人标注的检索评测仍未完成。
