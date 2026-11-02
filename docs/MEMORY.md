# Mem0 长期记忆

使用官方 `mem0ai/oss` 3.3.1，独立 worker 包在 `services/mem0`。主项目 SQLite 13 与 SDK 的 SQLite 12 peer 要求冲突，因此隔离依赖，不降级主项目。worker 使用本地 Qdrant 持久化，SDK 原生 SQLite 历史关闭；写入、召回和异常事件记录在 NewAgent 事件表中。不是 Mem0 云端服务，不需要 `MEM0_API_KEY`。

## 安装和配置

在 `services/mem0` 目录中执行 `npm ci --ignore-scripts`，再回到 app 执行 `npm run build`。启动现有 Docker/Qdrant 和本地 Embedding 服务。

把 `templates/memory.example.json` 复制到运行根目录 `data/memory.json`，设置稳定的 userId，并将 enabled 改为 true。例如：

```json
{
  "enabled": true,
  "userId": "local-user",
  "collection": "newagent_memory_v1",
  "model": "deepseek-flash",
  "baseUrl": "https://api.deepseek.com",
  "timeoutMs": 120000
}
```

`DEEPSEEK_API_KEY` 仅通过环境变量提供。显式保存/查询使用本地 Embedding；自动提取调用配置的 DeepSeek。Embedding 配置复用 `data/retrieval.json`。记忆存入独立 collection，不受源码 TS-only 范围限制。元数据和 SDK 配置位于运行根目录 `data/memory`，不会写入默认用户目录。SDK 遥测关闭。

## 使用

终端主会话新增 `memory_agent`：`remember/search/list/update/forget`。用户可以直接说“记住，这个项目以后注释用中文”“查看这个项目的偏好”“把缩进偏好改成四个空格”“忘记这条偏好”。

支持 `preference` 和 `experience`，来源状态包括 `declared/inferred/observed/hypothesis`。用户偏好及未验证经验均可保存，没有强制的检查证据字段。`key` 标识同一偏好，例如 `style.indent`，再次保存同一 key 会更新，不制造多条冲突记录。

默认 `scope: project`，必须指定已配置 `profileId`；`scope: user` 表示该用户的全局偏好。用户身份只从服务端配置读取，工具不能指定其他用户。项目以 profile 隔离，更新和删除也验证所属范围。此应用仍是本机单用户工具，不宣称具备多租户登录鉴权。

Web API：`POST /api/memory`，请求字段与 memory_agent 相同，例如：

```json
{"action":"remember","scope":"project","profileId":"your-profile","kind":"preference","status":"declared","key":"style.comments","text":"新增代码注释使用中文"}
```

任务开始时，明确含“记住/以后/我偏好”等长期表述的用户需求才进入 Mem0 自动提取，结果标为 inferred；不从模型代码和助手回答推断用户偏好。普通一次性需求跳过提取。自动提取只更新 inferred 记录，不覆盖明确保存的偏好。

每次任务加载项目和用户偏好，以及语义相关的经验。偏好采用独立列表召回，避免与任务问题语义不同而被遗漏；同 key 优先明确声明，项目偏好优先于同级全局偏好。最多注入十条、约 6000 字符，记忆作为建议性上下文，不能覆盖当前需求、仓库规范、权限或验收。

任务到达 ready_for_pr 或 blocked 后，自动保存带状态、任务 ID 和源码版本的观察记录；ready_for_pr 不表示发布成功。记忆服务失败会记录 memory_error，任务仍按实际检查和 Review 判断。缺失配置时默认关闭，旧任务仍可运行。

## 验证范围

协议测试覆盖用户/项目隔离、偏好跨任务召回、未经验证经验、凭据拒绝、自动提取门槛、默认关闭。真实服务验证另行报告；Mem0 评分、任务成功率和“记忆提升修复率”不能由这些接通测试推断。
