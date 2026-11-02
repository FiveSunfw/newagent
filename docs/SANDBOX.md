# 执行边界与当前验收

当前分支基于 main/e4658db。以下是已实现的执行与预算基础，不代表整个求职补齐计划已完成。

## 配置与入口

`data`、`cache` 相对于 app 的父目录。项目配置不包含本机绝对路径。

```json
{"mode":"docker","image":"sha256:<64位镜像ID>","cpus":2,"memoryMb":2048,"pids":128}
```

保存到 `../data/sandbox.json`。镜像需预先下载；任务使用 `--pull=never`。Docker 配置目录固定为运行根目录下的 `cache/docker`。镜像所在磁盘由 Docker Desktop 的虚拟磁盘位置决定，不能仅凭 DOCKER_CONFIG 判断。

每个 profile 默认 Docker；仅 Windows 专用的可信仓库可以显式设置 `execution: {"mode":"trusted-host","acknowledged":true}`。原有 Windows fixture 由 setup 生成时明确标记此模式，不会静默转换。

带 package-lock 的仓库需要先单独准备 Linux 依赖：

```powershell
npm run sandbox:dependencies -- <profileId> --allow-network
```

此命令独立联网、禁用 npm 生命周期脚本，将依赖安装到 Docker 卷；保存 lock hash 与镜像 ID。任务期间只读挂载，禁网。当前仅验收普通 npm 单包仓库；monorepo/workspace、本地 file 依赖、需安装脚本的 native addon 尚未验收，失败必须明确处理，不能退回宿主。准备命令的网络授权标志不会给任务授权联网。

```powershell
$env:NEWAGENT_SANDBOX_IMAGE = 'sha256:<64位镜像ID>'
npm run test:sandbox:real
npm run test:sandbox:workflow
```

第一项是真实 Docker 权限/网络/文件/超时/取消检查；第二项是真实 Docker 工作流加固定开发与 Review 协议 fixture，**不调用真实模型，不是模型成功率**。

## 权限

- 主 TUI 只开放 delivery_agent；工具调用拦截同时拒绝宿主工具和未允许的工具。默认启动关闭扩展、技能与仓库上下文自动发现。`--plain-pi` 是独立原生 Pi 入口，不属于交付沙箱验收。
- 开发与 Review 只注册受控工具，禁用原生工具和自动扩展。Review 文件视图只读；开发可以读、搜索、写非保护源码及运行管理员配置的检查。不存在任意宿主 shell 工具。
- Docker 运行使用 uid/gid 1000，去掉 capabilities，禁止提权，根文件系统只读，CPU/内存/PID 限制，默认 network=none。不挂载凭证、Git metadata 或 Docker Socket。
- 每次操作创建任务专属快照和短生命周期容器。源码 checkout 保留 Git metadata，执行快照不含它。快照排除 .env、包管理凭证、SSH/AWS/Docker 配置、常见密钥文件与宿主 node_modules；遇到符号链接拒绝。支持范围不等于能自动识别源码里所有硬编码秘密。
- 写工具只导回已校验的单个文件；检查的源码改动使证据失败，不导回。主仓库不被任务改写。容器退出、超时、取消均执行 daemon 侧强制清理；清理失败会报错。
- 现在使用已有独立 Git clone checkout，尚未转换为 Git worktree；每任务长期驻留容器也未实现。短生命周期快照会保留在 cache 中，便于审计，后续需要增加配额和生命周期清理。

## Harness 与证据

开发、Review、格式修复共享持久化调用计数；程序检查也计入预算。默认 100 工具调用、3 轮返修、30 分钟；恢复沿用计数和起始时间，不重置预算。暂停后墙钟时间仍计入截止时间。主会话在创建任务之前的需求沟通尚未计入任务预算。

SQLite 保存阶段、调用结果、耗时与模型 Usage；大工具输出保存到 data/artifacts。事件与制品对已配置环境密钥及敏感字段脱敏。检查完整 stdout/stderr 写入日志。父子专家调用图、统一错误分类、面向最终用户的完整证据展示尚未补齐。

发布证据绑定未提交源码指纹、检查配置、保护策略、执行镜像与边界版本；检查期间或 Review 期间变化会拒绝，发布前再次校验。重启将未结束任务置为 paused，重跑检查。原有 GitHub 创建逻辑先查询同分支已有 PR；推送/PR 仍需 UI 明确确认。

## 实际结果（2026-10-02）

- Docker Desktop Linux daemon 已验证，虚拟磁盘在 E 盘；Node 22 镜像 ID 为 `sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c`。
- 真实 Docker smoke 的 7 项检查通过：非 root/无凭证与 Socket、禁网、只读 Review、任务副本可写、权限与资源限制、超时清理、取消清理。
- TaskExecution 真实验证：受控读写、路径越界拒绝、规范化路径保护、只读角色、检查改源码拒绝，原源码保持不变。
- 跨文件固定协议工作流实际经历 1 次检查失败、1 次返修、1 次只读 Review，最终 ready_for_pr；配置变化后发布被拒绝。未创建 PR，未调用真实模型。
- 独立 Linux 依赖准备在无外部依赖的 npm fixture 上通过；普通第三方依赖和 native addon 尚未验收。
- 2026-10-03 已部署 E 盘本地生成模型和 CPU Embedding，完成 9 次真实校准；0/9 功能通过、0 超时，不能声称模型收益。收费调用保持禁用。正式结果按父目录 data/repository-eval 中的运行报告确认。

Qdrant/MCP、按需检索专家和固定评测集已加入，见其他架构与评测文档；本页隔离与协议测试仍不能代替真实模型成绩。长期任务容器、真正 Git worktree 等边界缺口仍需补齐。
