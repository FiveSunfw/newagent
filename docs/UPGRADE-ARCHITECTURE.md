# 已实现的执行与证据路径

```mermaid
flowchart TD
  User[自然语言需求] --> Main[Pi 原生终端：交付编排]
  Main --> Run[SQLite Run / 累计预算 / 取消与恢复]
  Run --> Route{是否需要检索专家}
  Route -->|按需| Expert[只读检索专家]
  Route --> Dev[开发 Agent]
  Expert --> Dev
  Dev --> Boundary[TaskExecution：路径、保护策略与快照]
  Expert --> Boundary
  Boundary --> Snapshot[无凭证执行快照]
  Snapshot --> Container[非 root / 禁网 / 资源限制 / 取消清理]
  Container --> Write[校验后导回单文件修改]
  Write --> Gate[确定性检查]
  Gate -->|失败| Dev
  Gate --> Strategy{solver 策略}
  Strategy -->|adaptive-rag| Review[独立只读 Review]
  Strategy -->|single| Evidence
  Review -->|阻塞| Dev
  Review --> Evidence[源码 + 检查配置 + 镜像指纹]
  Evidence --> Confirm[人工确认推送与草稿 PR]
  Boundary --> Index[AST / Markdown / 重叠行 Chunk]
  Index --> FTS[SQLite FTS5]
  Index --> Dense[宿主 Embedding：本地服务或授权远程服务]
  Dense --> Qdrant[Qdrant 内部网络服务]
  Qdrant --> RRF[应用层 RRF / 当前源码核验]
  FTS --> RRF
  RRF --> Expert
  RRF --> Dev
  MCP[官方 SDK 本地 stdio：绑定任务] --> Boundary
  MCP --> Gate
```

模型凭证、Git 与 GitHub 发布由宿主编排层管理，不进入任务容器。Qdrant 使用独立内部网络与 E 盘 Docker Linux 数据卷；受限代理不挂载宿主目录。图中的专家与 Dense 路径都是有条件路径；缺少 Embedding 授权/配置时只有显式关键词降级。代码变更任务的检索上下文优先展示实现文件；索引更新已核验快照后复用其命中，避免重复读取候选文件。

single-no-rag 跳过检索与独立 Review，single-rag 加入检索，adaptive-rag 加入独立 Review 与按需专家。三者使用相同执行边界和外部功能验收，功能通过与交付 Gate 分开报告。专家收益由真实对照结果决定，不能从调用数量推断。见 [本地评测](LOCAL-EVALUATION.md)。
