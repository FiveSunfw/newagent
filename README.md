# NewAgent

面向可信代码仓库的研发交付 Agent。通过原生终端完成开发，再由确定性检查和独立 Reviewer 验证代码；验证结果绑定当前版本，失败后返修，提交 PR 由人确认。

## 快速开始

需要 Node.js 22.23.3 或更高的 22.x 版本、npm 和 Git。当前主要验证环境为 Windows + Git Bash。

推荐把仓库克隆到一个独立运行目录的 app 子目录，例如 E:/newagent/app。app 的父目录存放运行数据，不能与其他项目共用。

~~~powershell
git clone https://github.com/FiveSunfw/newagent.git E:/newagent/app
cd E:/newagent/app
npm ci
npm run setup
npm run build
~~~

setup 创建演示仓库及配置模板。将 ../data/model.example.json 复制为 ../data/model.json，将 ../data/pi/models.example.json 复制为 ../data/pi/models.json；填写相同的 provider/model ID 和接口地址，密钥通过 NEWAGENT_API_KEY 环境变量提供。模型费率必须自行配置，模板的零费率不表示免费。

~~~powershell
npm start
~~~

进入终端后直接描述开发需求，或输入 /delivery help。已有本机 newagent 命令仍可使用。启动会保留当前工作目录。

## 研发流程

inspect → create → prepare → 原生 Agent 修改隔离工作区 → validate → 检查与独立 Review → 最多三轮返修 → 人工确认 PR → sync CI/合并版本。

默认终端的 Pi 会话负责需求与编排，通过受控开发会话执行修改；主会话的宿主文件、搜索与 shell 工具已禁用。Web 与终端共享任务库，不能同时运行。可选 Web 入口：./start-web.ps1，仅监听 127.0.0.1:4780。

新 profile 默认 `execution: {"mode":"docker"}`。需要 Linux Docker daemon 与 `../data/sandbox.json` 中固定的 sha256 镜像 ID；未配置或 Docker 不可用时停止，不回退宿主。沙箱配置格式与当前验收范围见 [执行边界](docs/SANDBOX.md)。旧 Windows fixture 通过显式 `execution: {"mode":"trusted-host","acknowledged":true}` 运行，不计入容器隔离成绩。

## 目录

~~~text
app/                      Git 仓库
  bin/newagent.mjs         CLI 启动器
  src/core/               交付编排
  src/protocol/           任务与证据 Schema
  src/model-provider/     Pi 模型会话与 Review
  src/exec/               文件边界、Git 与检查执行
  src/state/              SQLite 与进程锁
  src/tui/                终端交付扩展
  src/app-server/         本机 Web API
  src/integrations/       GitHub PR/CI
  src/eval/               演示准备和固定评测
  tests/                  行为与协议测试
  web/                    React 界面
  templates/              演示业务与外置验收脚本
  scripts/                指标工具及历史成对评测
  docs/                   架构、运行记录和报告
  dist/, web-dist/        本机生成，不提交
../data/                  配置、凭据、SQLite、会话与日志，不提交
../cache/                 缓存、临时文件及测试产物
../fixtures/              setup 生成的演示仓库
../workspaces/            每项任务的执行副本
../archive/experiments/   本机一次性实验脚本，不属于产品入口
../tools/, ../upstream/   本机工具和参考源码
~~~

## 验证

~~~powershell
npm run verify
npm run test:fixtures
~~~

verify 执行类型检查、行为测试和生产构建，不调用真实模型。test:fixtures 验证预置缺陷和参考实现，不能作为模型成绩。

## 边界与证据

- 当前为本机、单用户工具。Docker 任务的读写、文本搜索、配置检查经过脱敏任务快照；Review 挂载只读，任务禁网。源码 checkout 与执行快照分开，Git 和 GitHub 操作由宿主编排层负责。宿主管理员与 Docker daemon 属于信任边界。
- 推送和创建 PR 需要界面确认；合并由人执行，不自动生产发布。
- 旧版三任务对照样本不足以推断总体效果。当前本地 Qwen3 1.7B 校准为 0/9 功能通过；正式对照因Docker后端中断尚未完成，不能声称多Agent或RAG带来提升。见[评测记录](docs/reports/UPGRADE-VALIDATION.md)、[部分对照报告](/E:/newagent/data/repository-eval/formal-v2/report.md)和[Docker中断记录](/E:/newagent/data/repository-eval/formal-v3/report.md)。
- 仓库 RAG 与本地 MCP 已实现并通过协议测试；本地 Qwen 生成模型和真实 Embedding 已部署，固定 12 任务对照与 30 问检索专项使用独立命令运行。结果以运行报告为准，人工检索标注和 Review 误报判定尚待确认；Issue 分诊和专用 CI 排障未实现。见 [本地评测](docs/LOCAL-EVALUATION.md)、[检索与 MCP](docs/RETRIEVAL-MCP.md) 和 [升级验证记录](docs/reports/UPGRADE-VALIDATION.md)。
- 固定依赖的历史 audit 风险与实验细节保留在开发记录中，未宣称安全审计通过。

文档：[当前架构](docs/UPGRADE-ARCHITECTURE.md) · [Mem0 长期记忆](docs/MEMORY.md) · [历史架构与配置](docs/ARCHITECTURE.md) · [评测说明](scripts/eval/README.md) · [真实对照报告](docs/reports/REAL-EVAL-REPORT.md) · [新版单任务](docs/reports/NATIVE-QUALITY-RUN.md) · [交接记录](docs/HANDOFF.md) · [历史开发记录](docs/archive/development-notes.md)
