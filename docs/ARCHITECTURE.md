# 架构与运行目录

## 模块职责

- bin/newagent.mjs：加载本机模型配置，设置独立运行数据目录，启动 Pi TUI 与交付扩展。
- src/tui/terminal-extension.ts：自然语言 delivery_agent 工具及 /delivery 命令，界面确认和状态显示。
- src/core/workflow.ts：任务准备、版本检查、静态/功能验证、独立 Review、返修与交付状态。
- src/model-provider/pi.ts：独立模型会话、结构化 Review 解析及受控工具。
- src/exec/execution.ts：文件边界、源码指纹、Git 和检查命令。
- src/state/store.ts：SQLite 任务、事件和检查证据；src/state/process-lock.ts：运行互斥。
- src/integrations/github.ts：PR/CI 与远端版本；src/app-server/server.ts 和 web/：可选本机 Web 入口。
- src/eval/setup*.ts、src/eval/evaluate.ts、src/eval/validate-fixtures.ts：演示准备和验证入口，npm scripts 统一提供入口。

## 配置

运行根目录默认是 app 的父目录。data/profiles.json 是本机管理员维护的可信仓库和检查命令配置；setup 只在缺失时生成演示配置。不要上传真实 model.json、models.json、auth.json、任务库或会话。

默认终端由当前 Pi 开发，交付编排 prepare/validate 管理工作区与证据。Web/旧评测使用 legacy 开发流程。ready_for_pr 只代表当前版本的本地证据满足条件。

## 本次结构整理

产品入口保留在 bin；测试独立到 tests；报告集中到 docs/reports；可复用评测脚本归到 scripts/eval。一次性 VALORANT 续跑/同步脚本保存在运行根目录 archive/experiments，不自动执行。缓存和历史任务原样保留，避免破坏会话恢复与评测证据。

## Codex 结构参考

参考 https://github.com/openai/codex 的 CLI、core、protocol、model-provider、state、TUI 与 app-server 职责边界。NewAgent 使用一个 TypeScript 包组织对应模块，不复制 Rust crate 工作区或引入空模块。目录借鉴不代表实现了 Codex 的权限、沙箱或协议能力。
