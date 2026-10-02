# NewAgent — 基于 Pi 的研发交付 Agent

代码在 app，依赖在 app/node_modules，参考源码在 upstream，缓存在 cache，配置、会话、任务库和日志在 data，执行副本在 workspaces。第一版默认使用 Pi 原生终端界面（TUI），通过 /delivery 管理研发流程。

## 启动

```powershell
newagent
```

新开 PowerShell，输入 `newagent`，直接描述需求，例如“在 orders-fixture 给订单查询增加日期区间过滤，保持本人权限并补充测试”。模型通过 `delivery_agent` 工具查看仓库、创建任务、启动开发与独立审查，再依据实际证据决定是否返修。仓库不明确时会询问。

`pi` 命令启动同一完整 Pi，不加载交付扩展。两者默认使用 DeepSeek，并保留 Pi 原生文件、编辑、终端、技能与扩展能力。`newagent` 保留当前工作目录。启动后也可输入 `/delivery` 打开菜单，`/delivery new` 创建任务，`/delivery run` 开始开发、检查、Review 和返修。`/delivery help` 查看所有命令。底部组件显示实时阶段，`status/review/checks/log/diff` 查看证据；`publish` 需要终端确认后才推送，`sync` 同步 CI 和合并后的验证。退出 Pi 会暂停任务并保存记录。

交付任务中的开发和审查使用独立受控 Pi 会话，强制执行检查和返修；主会话可自由选择交付工具。当前没有任意角色并行调度器，子会话角色仍由程序管理。推送需要界面确认。普通 Pi 工具拥有本机文件和终端能力，不具备容器隔离。

可选 Web 入口使用 `app/start-web.ps1`，地址 http://127.0.0.1:4780；与终端共享数据，不能同时启动。构建与行为验证使用 `app/verify.ps1`。新增下载与运行缓存放在项目目录；使用已安装 Git，不改变其全局配置。

## 模型配置

本地已配置 `deepseek-flash`，密钥通过 `DEEPSEEK_API_KEY` 环境变量读取。当前开发及审查关闭思考模式。真实调用已成功；两个启动脚本已设置 `NODE_USE_SYSTEM_CA=1`，使用 Windows 系统可信证书，保持 TLS 校验开启。

将 `data/model.example.json` 复制为 `data/model.json`，将 `data/pi/models.example.json` 复制为 `data/pi/models.json`，填写相同 provider/model ID、真实接口地址及模型容量。启动前设置 `NEWAGENT_API_KEY` 环境变量。示例中的 0 成本只是未配置费率，不能作为实际免费或费用统计依据。凭据不写入源码。官方模型也可在 data/pi/auth.json 配置；选择对应 provider/model。

本项目固定 Pi 0.99.2，使用本机 Node 22.23.3。本机 Node 已升级到 22.23.3。SDK 的实际协议连接已经使用本地 SSE fixture 测试；fixture 不代表真实模型能力或商业验证。

## 使用

创建任务，选择仓库配置并填写需求及每行一条验收条件；点击开始。流程准备分支与执行副本、开发、执行检查、独立只读 Review、最多三轮返修。失败或缺配置记录为 blocked，可补充意见后重新验证。

orders-fixture 推荐需求：给 queryOrders 增加第三个可选参数 `{from?:string,to?:string}`，用闭区间筛选 createdAt，非法时间和逆序区间报错，保持本人权限，补充单元测试。它的验收脚本位于 data，开发 Agent 无法写入。集成脚本启动真实 HTTP 服务并使用 SQLite 内存库；这些是演示数据。

准备好后可人工点击“提交草稿 PR”，程序才提交和推送。GITHUB_TOKEN 必须由用户配置，权限覆盖目标仓库 contents/pull requests 写和 checks/actions 读。合并由人操作；点击同步读取 CI、审查评论，合并后检出对应提交并运行集成与独立验收。未配置检查和缺少 CI 证据显示 insufficient_evidence。正式生产部署不自动执行。

PR 未合并时，可在追加意见填写实际 Review/CI 问题并再次运行，然后提交同一 PR 的新版本。推送后检查与评估应重新执行。审查评论自动读取，但是否接受由人工反馈或 Agent 返修判断。

## 仓库配置与执行边界

data/profiles.json 是本机管理员信任配置，不能由网页修改。命令使用 file/args 直接启动，不经过 shell；它们会执行仓库代码，因此当前版本只用于自己信任的仓库，不具备容器级恶意代码隔离。Pi 使用受控文件工具，没有任意终端工具，拒绝越界路径、符号链接、凭据文件和受保护配置。检查子进程移除密钥相关环境变量。

新增依赖、改变验收/CI 配置和权限规则需人修改配置，不由 Agent 自动放宽。现有基准测试路径可以加入 protectedPaths；所有新增/修改测试仍需要独立审查。大仓库当前限制 10000 个源码文件。

valorant-analytics 配置从远端已提交代码克隆，运行 npm ci --ignore-scripts 后执行 npm run check。原 E:\valorant-analytics 和未提交改动不会被修改。其 integration/acceptance 尚为空，实际健康检查、fixture/Eval 需按对应任务补充；不能据此宣称可生产发布。

## 已实现与验证缺口

实现：Pi SDK、独立会话、实际命令检查、证据与版本关联、返修、SQLite 状态恢复、任务界面、GitHub PR/CI API、合并后集成与发布评估。

真实 GitHub PR #8 已合并，合并提交 CI、HTTP 集成和独立验收通过。真实模型的三任务成对评测见 REAL-EVAL-REPORT.md；小样本不能作为总体完成率。真实预发布环境与模型账单尚未验证。

进程重启暂停未完成任务；恢复重新执行检查。重启后的 PR/CI 外部操作需人工同步以确认实际远端状态。默认单任务，命令超时 10 分钟、Agent 尝试 30 分钟、每会话最多 100 工具调用。

## 上游与许可证

依赖 Pi SDK（MIT）。upstream/pi-review 为同组织 Review 扩展参考，首版使用自己的结构化只读会话封装，并未直接加载交互式扩展。参考其定位要求与误报控制原则；第三方许可证见上游目录与 node_modules。完整生命周期编排由本项目实现。
## 实际验证记录

- 服务端与前端类型检查、生产构建通过。
- 17 个行为/协议测试通过，覆盖真实 Pi SDK 的 SSE 和工具调用、实际失败返修、取消、恢复、版本失效及 GitHub 数据边界。
- 独立业务验收与 HTTP + SQLite 集成脚本在参考实现上通过；10 个预置缺陷全部被验收捕获。这是测试集质量验证，不是模型修复成绩。
- 已只读请求 valorant-analytics 的真实提交 CI API。该提交未返回 check runs；不能据此认定 CI 验证完整。
- DeepSeek 已完成订单日期筛选真实任务，经过测试失败返修，最终类型检查、单元测试、独立验收、独立审查和 HTTP + SQLite 集成检查通过。任务 ID：79c23a02-ae91-44ce-98d0-9d995c1b7ded。这是演示仓库上的单次结果，不代表模型总体完成率。未创建真实 PR，也未合并或发布。
- npm audit 仍报告 Pi shrinkwrap 锁定的 brace-expansion 5.0.9 的 1 个 high 问题；npm audit fix 未能更新上游锁定项。未宣称审计通过。当前服务限本机可信仓库使用，后续应换用已修复的 Pi 发布版本或提供经过验证的上游补丁。

## 固定评测

`npm run setup` 可准备示例与 10 个缺陷仓库。真实模型配置后，先停止本地服务，再使用便携 Node 环境分别运行 `npm run eval:direct` 和 `npm run eval:workflow`。二者输出位于 data/eval，包含任务 ID、独立验收结果和耗时。服务与评测器互斥。`npm run test:fixtures` 验证参考实现与预置缺陷，完全不调用模型。

当前评测集集中在一个订单查询模块，用于验证闭环；不代表跨语言、复杂仓库或商业部署表现。使用其他仓库时，应增加其独立验收与集成条件。

VALORANT 真实仓库实验已跑通自然语言入口、独立开发/审查、全仓检查、独立验收与本机 HTTP 集成；详情见 VALORANT-EXPERIMENT.md。实验期间修复两项框架问题后恢复；随后经用户授权创建并合并 PR #8，合并 SHA 验证通过，未执行生产部署。


## 2026-10-01 真实三任务对照

已完成 Riot Retry-After、JSON3 字幕容错、首杀时间基准三个真实任务，每个由原生 Pi 和 NewAgent 各运行一次，统一复核六份模型代码，均通过原版测试和独立功能验收。NewAgent 自身交付流程完成 2/3，字幕任务因 reviewer verdict 枚举无效阻塞。直接 Pi 两次正常追加原测试被原始严格规则拒绝，此结果不是功能失败。

NewAgent 未缓存输入 397930、输出 97068 Token；直接 Pi 为 33792、20202。小样本未证明能力或效率优势，费用费率未配置。完整报告 REAL-EVAL-REPORT.md，原始数据 data/real-eval/2026-10-01T12-07-32-565Z。保留失败记录；无人工改模型生产代码、无推送，原 VALORANT 工作目录未修改。

评测 npm scripts：eval:real:setup / eval:real:run / eval:real:audit / eval:real:report；audit/report 需追加 results.json 路径。运行时本地 Pi settings.json 已指定实际 Git Bash，避免误选 WSL。

后续优先：审查 JSON 格式失败的有限重试；缩小开发/审查上下文，减少重复读取；再扩大任务样本和重复次数。当前标准检查：类型检查、17 个测试、生产构建通过；评测脚本语法检查通过。

## 原生 Pi 开发与质量审查（codex/pi-quality-review）

终端 `newagent` 保留完整 Pi 原生开发工具。交付工具的调用顺序为 create → prepare → 当前 Pi 在返回的 task.workspace 中开发 → validate。验证失败把检查日志或 Review 意见交回当前 Pi，由它修改后再次 validate。run 在终端是 validate 的兼容别名，不再启动受控开发会话；/delivery prepare、/delivery validate 为可选手动入口。

仓库配置新增可选 staticChecks（与 checks 使用相同命令结构），用于 lint、格式检查、类型检查等真实命令。有配置时执行并保存版本关联的日志；无配置时由只读 Reviewer 做 AI 静态风险和规范审查，并记录 static_review_fallback。工具返回 staticReviewMode，AI 判断不能写成编译器/lint 通过。现有 checks 仍执行功能测试和原有工程检查。

质量 Review 覆盖命名与可读性、重复业务逻辑、已有模块复用、职责内聚、依赖方向、模块边界、现有架构、当前需求所需扩展性、边界行为和测试质量。问题必须有代码位置、具体证据、维护影响及最小建议；不要求推测性抽象或无关重构。审查格式错误只重试一次，再失败保留阻塞。

兼容边界：Web 与旧评测脚本暂时保留 legacy 自动开发流程，用于旧实验复现；本次迁移的是默认终端产品入口。Issue 分诊、研发资料 RAG 与专用 CI 排障尚未完成，不能据此称已具备完整 DevFlow 能力。真实模型的新版端到端表现尚未重新评测。
