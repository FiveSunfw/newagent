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

默认终端使用当前原生 Pi 会话开发；Web 和旧评测保留 legacy 流程。二者共享任务库，不能同时运行。可选 Web 入口：./start-web.ps1，仅监听 127.0.0.1:4780。

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

- 当前为本机、单用户、可信仓库工具。Worktree/副本隔离不等于容器沙箱，原生终端拥有本机工具能力。
- 推送和创建 PR 需要界面确认；合并由人执行，不自动生产发布。
- 已有真实任务和三任务对照报告，样本不足以推断总体成功率或效率优势；旧版对照不代表当前终端版本。
- 研发资料 RAG、Issue 分诊和专用 CI 排障尚未实现。
- 固定依赖的历史 audit 风险与实验细节保留在开发记录中，未宣称安全审计通过。

文档：[架构与配置](docs/ARCHITECTURE.md) · [评测说明](scripts/eval/README.md) · [真实对照报告](docs/reports/REAL-EVAL-REPORT.md) · [新版单任务](docs/reports/NATIVE-QUALITY-RUN.md) · [交接记录](docs/HANDOFF.md) · [历史开发记录](docs/archive/development-notes.md)
