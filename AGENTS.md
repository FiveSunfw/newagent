# NewAgent 工作约定

- 产品代码与 npm 依赖在 app；新增下载在 tools/upstream；所有缓存与运行数据在 E:\newagent 下。
- 使用本机 Node 22.23.3 和 npm，依赖版本由 package-lock.json 固定。
- 开发/Review 调用 Pi SDK；任务状态与检查证据由编排程序管理，不能根据模型文字伪造成功。
- 默认入口为 完整 Pi 原生 TUI（newagent 命令，直接用自然语言；/delivery 是可选入口）；可选 Web API 只监听本机；仓库配置和命令属于本机可信管理员配置。当前未提供容器级执行隔离。
- 检查、Review、PR 与发布评估关联实际代码版本。代码变更后重新验证。
- 推送与创建 PR 需要终端或 Web 界面明确确认；合并和正式发布由人操作。
- 原 E:\valorant-analytics 只作为参考，实际任务操作独立副本，保留原有改动及 Riot 业务约束。
- 标准检查：本机 Node 环境下 npm run typecheck、npm test、npm run build；固定样本验证 npm run test:fixtures。
- 真实模型评测必须单独报告；协议 fixture、参考实现和预置缺陷检测不能作为真实模型成绩。
- data 下不提交密钥；配置缺失时明确停止。Pi 上游 shrinkwrap 锁定依赖的 audit 问题见 README，尚未修复。

- 目录按 core、protocol、model-provider、exec、state、tui、app-server、integrations、eval 分工；测试在 tests，报告在 docs/reports，产品入口仅 bin/newagent.mjs。
- npm run verify 执行类型检查、行为测试与构建；运行数据和历史实验不提交。
