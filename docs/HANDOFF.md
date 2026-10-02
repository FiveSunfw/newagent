验证：本机 Node 22.23.3 / npm 10.9.9；newagent 与 pi 均返回 0.99.2；类型检查、17 个测试、生产构建通过。新增本地测试覆盖模型工具创建/查询任务及发布确认。

新增入口：本机 D:\Nodejs 已通过官方 MSI 升级为 22.23.3；E:\newagent\bin 已加入用户 PATH。新开终端输入 newagent，完整 Pi 加载交付工具，可用自然语言创建/运行/查看任务；pi 命令不加载交付扩展。原生工具、技能、扩展均恢复。模型自主选择交付工具，内部开发/检查/独立审查循环仍受程序约束。自然语言真实调用已在用户明确授权的 VALORANT 实验中验证；早期无具体仓库授权的尝试被自动审批拒绝。

# 当前交付状态

默认入口：新终端输入 newagent，Pi 原生 TUI，通过自然语言调用交付工具；/delivery 为可选菜单。可选 Web 入口 app/start-web.ps1。Web 服务已停止，终端与 Web 互斥。

已实现 Pi 0.99.2 SDK、受控文件工具、独立开发/审查、检查/返修、SQLite 记录、暂停恢复、任务界面、GitHub PR/CI API、合并版本验证与发布评估。

验证：17 个自动化测试通过；服务端和前端类型检查、构建通过；真实 Pi SDK + 本地 SSE/工具协议通过；参考实现的独立验收、真实 HTTP + SQLite 集成通过；10 个预置缺陷均被检测；真实 GitHub CI API 的只读请求通过（该提交没有 check runs）。

已配置：deepseek-flash，通过 DEEPSEEK_API_KEY 环境变量读取密钥；用户已确认，两个启动脚本已保存 NODE_USE_SYSTEM_CA=1，使用 Windows 系统可信证书并保持 TLS 校验开启。

待补：真实 PR 操作的 GITHUB_TOKEN；VALORANT 仓库对应任务的独立验收和集成命令；真实模型评测结果。

真实任务：79c23a02-ae91-44ce-98d0-9d995c1b7ded 已进入 ready_for_pr；最终类型检查、单元测试、独立验收、独立审查、HTTP + SQLite 集成通过。历史检查保留最初配置错误和后续失败/返修证据。结果位于 data/first-real-run.json。

早期订单任务未推送、创建 PR 或合并；后续 VALORANT PR #8 已按用户授权合并。生产发布未执行。原 VALORANT 目录未修改。app 是独立本地 Git 仓库，尚未提交和推送。

限制：可信仓库、本机单用户单任务；无容器级恶意代码隔离；固定评测为单模块。Pi shrinkwrap 仍包含 brace-expansion 5.0.9 的 high audit 项，npm audit fix 未解决，未宣称安全审计通过。

VALORANT 真实仓库实验已跑通自然语言入口、独立开发/审查、全仓检查、独立验收与本机 HTTP 集成；详情见 VALORANT-EXPERIMENT.md。实验期间修复两项框架问题后恢复；后续远端交付结果见下方 PR #8 记录。

PR #8 已获用户批准并合并 main，SHA ce59e57e6918e7690f2d9f510f61435071da99b5。合并提交 CI / Vercel 状态成功，NewAgent 已对合并 SHA 完成 API build、HTTP 集成和独立验收，评估 conditions_met。原 VALORANT 工作目录保留原有改动，未执行 pull。


## 2026-10-01 真实三任务对照

已完成 Riot Retry-After、JSON3 字幕容错、首杀时间基准三个真实任务，每个由原生 Pi 和 NewAgent 各运行一次，统一复核六份模型代码，均通过原版测试和独立功能验收。NewAgent 自身交付流程完成 2/3，字幕任务因 reviewer verdict 枚举无效阻塞。直接 Pi 两次正常追加原测试被原始严格规则拒绝，此结果不是功能失败。

NewAgent 未缓存输入 397930、输出 97068 Token；直接 Pi 为 33792、20202。小样本未证明能力或效率优势，费用费率未配置。完整报告 REAL-EVAL-REPORT.md，原始数据 data/real-eval/2026-10-01T12-07-32-565Z。保留失败记录；无人工改模型生产代码、无推送，原 VALORANT 工作目录未修改。

评测 npm scripts：eval:real:setup / eval:real:run / eval:real:audit / eval:real:report；audit/report 需追加 results.json 路径。运行时本地 Pi settings.json 已指定实际 Git Bash，避免误选 WSL。

后续优先：审查 JSON 格式失败的有限重试；缩小开发/审查上下文，减少重复读取；再扩大任务样本和重复次数。当前标准检查：类型检查、17 个测试、生产构建通过；评测脚本语法检查通过。

## 新分支修改

分支 codex/pi-quality-review。终端改为 prepare/validate：原生 Pi 开发，独立 Reviewer 验证；失败回到当前 Pi。staticChecks 可选，缺失时 AI 审查静态风险与规范，返回证据来源并记录 fallback。质量审查加强重复逻辑、模块职责、架构及最小修复建议；格式错误有限重试一次。Web/旧评测暂保留 legacy 开发接口。完整 DevFlow 的 RAG、Issue 与专用 CI Agent 尚未实现。
