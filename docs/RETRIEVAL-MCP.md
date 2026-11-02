# 仓库检索与本地 MCP

## 启动与存储

```powershell
docker compose up -d qdrant
npm run build
newagent --mcp <taskId>
```

Qdrant 镜像固定 digest，当前实测版本 1.19.1。服务使用 internal 网络 `newagent-retrieval`，不发布宿主端口。宿主通过 `docker-internal` 传输访问；每次请求启动非 root、无宿主挂载、禁止提权的短生命周期代理容器，仅能访问固定 Qdrant 服务的 collection/health 端点。任务执行容器仍为 network=none。

向量存储使用 Linux Docker volume `newagent-qdrant-data`，其物理位置由 Docker Desktop 虚拟磁盘决定。本机已确认在 E 盘。SQLite 索引与清单位于运行根目录 `data/retrieval`。Windows NTFS bind 在本机启动时被 Qdrant 提示无法保证存储安全，所以没有将其当作正式向量存储。

## Embedding 配置

`data/retrieval.json`：

```json
{
  "transport": "docker-internal",
  "qdrant": "http://127.0.0.1:6333",
  "embedding": {
    "endpoint": "https://your-provider.example/v1",
    "model": "your-embedding-model",
    "dimensions": 1536,
    "version": "model-version-1",
    "queryInstruction": "Given a software repository query, retrieve relevant source code or documentation that best answers it."
  }
}
```

`qdrant` 是逻辑本机地址；internal 传输将其映射到固定服务，不对宿主开放此端口。已有受控本机 HTTP 服务可选 `transport: "http"`。

本地 Qwen3-Embedding-0.6B 配置了查询侧 instruction，文档侧仍编码原文；这一格式遵循 [Qwen3-Embedding 官方模型卡](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) 的 instruction-aware retrieval 用法。

密钥只通过 `NEWAGENT_EMBEDDING_API_KEY` 提供；还必须设置 `NEWAGENT_ALLOW_EMBEDDING=1` 明确授权模型联网。未授权、缺少配置或凭证时返回 keyword fallback 原因，**不发送 Embedding 请求**。文档向量用源码原文；若配置 `queryInstruction`，查询使用 `Instruct: ...\nQuery: ...` 编码。维度、模型、版本或指令决定 collection 与索引版本，变更后重建相关文件索引。模型价格未知时不能启动收费评测。

## 索引与证据

`data/retrieval.json` 可用 `typescriptOnlyRepositories: ["profile-id"]` 为指定仓库启用 TS 代码索引（`.ts`、`.tsx`、`.mts`、`.cts`）。离线准备、运行时增量更新与结果过滤使用同一范围；更新时清理该仓库原有非 TS 的 SQLite/FTS 和 Qdrant 记录，不删除源码。其他仓库保持原有语言范围。这个限制作用于 RAG，不禁止 Agent 直接读取工作区中的旧文件。

- TS/JS 使用 TypeScript 5.9 AST API（固定 alias `typescript-ast`）。`chunks-v5-parent-child` 保留类、方法、函数和声明节点，方法使用 `Class.method` 限定名称；超过 100 行或 4000 字符的节点优先按语句组、if/else、switch/case、try/catch/finally 和循环体拆分，无法再按结构拆分的单条语句使用重叠行窗口。CommonJS 与具名嵌套函数仍受支持。Markdown 按标题，其他语言仍按行窗口，不宣称 Rust/Python 等语言的类级 AST 切分。
- `parentId` 关联父子块。父块保存在 SQLite，只有末级小块写入 Qdrant；Qdrant payload 包含符号、类型、行号和父块 ID。返回命中时附带最多两级方法/函数/类上下文，各自最多 160 行、约 12000 字符，超长上下文显式标记 `complete:false`。源码、版本或哈希不一致的父块不会返回。
- Chunk 包含仓库 ID、相对路径、符号、行号、源码哈希与索引版本。索引通过 TaskExecution 的受控读工具取得源码，不直接开放任意宿主路径。
- 按文件哈希增量更新和删除；SQLite 事务更新 Chunk 与 FTS。Qdrant 删除失败进入持久化待删除队列。远端孤儿 ID 不会成为证据。
- Dense + SQLite FTS5/BM25 在应用层使用 RRF（k=60）；不把 FTS 成功写成向量检索成功。首次进入工作区、恢复任务或切换索引配置时，通过执行边界批量计算源码哈希，对齐索引；未变化的文件不再逐个跨容器读取。后续查询复用工作区索引状态，开发工具写入的文件通过变更记录增量更新。BM25/Dense/RRF 排名后，只批量读取本次命中文件，验证实际源码与引用，父块随文件哈希一同验证。工作区外部的修改在命中时进行实时校验；新增的外部文件需恢复任务以重新对齐目录。没有受控工作区状态接口的管理 reader 仍按显式更新逻辑处理。开发工具修改前仍须读取实际源码。
- 代码变更任务的初始上下文和 `search_repository` 结果会优先排列实现文件；测试、示例和文档作为候选后备保留。路径/符号权重只决定上下文顺序，不伪造或改写检索证据。
- 支持的文本扩展名与 2000 文件上限见实现。文件内容上限 300000 字符。二进制与凭证文件不索引。

管理员可在模型任务开始前，对明确指定的可信本机 Git 仓库做只读索引准备（不会给 Agent 开放宿主任意路径）：

```powershell
node node_modules/tsx/dist/cli.mjs scripts/index-repository.ts E:/your-repository profile-id --plan
node node_modules/tsx/dist/cli.mjs scripts/index-repository.ts E:/your-repository profile-id --allow-local-embedding
```

仓库 ID 使用任务的 profile ID，保持与运行时检索一致。命令只允许本机 Embedding 地址；manifest、进度和实测报告在运行根目录 `data/retrieval/<profile-id>`。只有所有文件 Dense 写入成功且真实查询成功才生成完成报告；仅关键词 fallback 不算向量化成功。开发时仍按工作区哈希刷新，预索引不是免除源码一致性检查。
- `strategy` 可选 single-no-rag、single-rag、adaptive-rag。默认 adaptive-rag；跨文件/跨模块关键词或至少四项验收条件会调用只读检索专家，结构化结果校验位置后传给开发者。该路由是初始启发式，尚无真实收益证据。当前实现中只有 adaptive-rag 经过独立 Reviewer，两个 single 配置在确定性检查通过后直接进入 ready_for_pr；不能把三个配置称为完全相同的 Review/Gate 流程。

Qdrant 的 [Hybrid Query/RRF 官方参考](https://qdrant.tech/documentation/search/hybrid-queries/) 与 [MCP 官方 TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) 是实现依据。

## MCP 权限

stdio 服务使用官方 SDK 1.31.0，仅绑定启动时的一个 taskId；不允许模型选择任意仓库、玩家或外部 MCP。工具：repository_search、file_read、verification_run、verification_evidence。复用 TaskExecution、任务预算和检查证据；没有发布、合并或任意 shell 工具。

服务与 TUI 使用同一进程锁，不能同时操作同一运行根目录。错误参数不会执行工具；调用、取消与超时通过同一运行计数和执行信号。当前协议测试使用官方 SDK 的 InMemoryTransport，真实 stdio 握手与文件读取已通过本地协议测试。
