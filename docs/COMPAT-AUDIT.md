# DSH 兼容审计记录

本文件按 DSH 版本记录插件的实测结论与遗留契约漂移，供下次升级直接取用精确起始版本。

## 0.2.2-rc.5 → 0.2.3-alpha.2（2026-11-23）

- 目标版本：`0.2.3-alpha.2`（`Runtime.getVersion`，安装时间 2026-11-23 11:02）
- 起始版本：`0.2.2-rc.5`
- 所读版本段：`v0.2.2-rc.5`（14 条）、`v0.2.3-alpha.1`（1 条），共 15 条
- 结论：**兼容**。指南条目 0 命中，且全套功能在当前实例上实跑通过。

### 实测证据（均在 0.2.3-alpha.2 进程内）

| 项 | 结果 | 依据 |
|---|---|---|
| Host 挂载 | 通过 | `workspace-integrity.log` 05:23Z、05:49Z（本地 13:23、13:49）两轮 `plugin mounted` + `panel routes registered` |
| 自动清理链路 | 通过 | 05:25Z（本地 13:25）`sandbox/mode: full access on E:\dsh\dsh` → `clean finished … Low=0` |
| 面板 HTTP 路由 | 通过 | `GET /workspace-integrity/api/state` 返回 401（路由已注册，被准入层拦截） |
| Client 槽位 | 通过 | `conversation.view` occupant `workspace-integrity`，`order: 40`，`active: true` |
| Agent 工具 | 通过 | `Tool.listTools` 含 `workspace_integrity`，`parameters` 与 `output.schema` 原样投影 |
| 服务契约 | 通过 | `tools`、`webServer`、`connection`、`sandboxPolicy`、`workingDirectory`、`workspaceRegistry`、`agents`、`sessions`、`locale` 全部在位，签名未变 |
| 会话事件 | 通过 | `session/event` 签名 `(session, event)` 未变；`sandbox/mode` 的 data 仍为 `{ mode, source? }` |
| 模式值域 | 通过 | `SandboxMode = 'read-only' \| 'workspace-write' \| 'danger-full-access'` 未变 |

### 指南条目对照

15 条中与插件表面相关的疑似项全部排除：

- `list_agents` 结构改为 `{ running, limit, agents }` —— 插件不消费该工具结果，只用 `ctx.get('agents').get()`。
- 移除 `ctx.sessionQuery.inspectSession` —— 插件未使用 `sessionQuery`。
- 压缩摘要预览移除视图 `summary` 字段 —— 插件自渲染面板，不读聊天视图数据。
- 其余条目（归档 worktree、CUA、office 单技能、个性化推荐、图片字节上限、PTC 默认 scoped REPL、SDK 时区、系统消息章节）均不涉及插件表面。

### 遗留契约漂移及处理（2026-11-23）

1. **`ctx.connection.requestRejection` 已移除**（移除发生在 `v0.2.2-rc.2` 段）。原先 `routes.js` 的 `gate()` 对它做了存在性判断，因此静默变成空操作，面板只剩 `webServer` 的默认准入兜底。
   - **已处理**：删除 `gate()`，六条路由改为声明 `auth: 'required'`，由 `webServer` 在 HTTP 准入层执行登录与 Host/Origin 校验；`registerRoutes(webServer, service)` 不再接收 `connection`，`index.js` 同步去掉 `connection` 注入。
   - 没有采用指南建议的 `connection.admit`：载体已经准入过一次，handler 内再 `admit` 会重复校验，并产生需要 `dispose` 的 Peer；`auth` 策略是同一道闸的声明式写法。
2. **`engines.node: ">=20"` 过时**（DSH 自 `0.2.3-alpha.1` 起要求 `^24.22.3 || >=26.13.1`）。
   - **已处理**：`package.json` 的 `engines.node` 改为 `^24.22.3 || >=26.13.1`。插件仍不声明 `engines.dsh`，DSH 因此不做范围校验。
3. **`0.2.3-alpha.2` 无独立升级指南段**（索引停在 `v0.2.3-alpha.1`）。alpha.1 → alpha.2 之间的变更不在文档覆盖范围，如需彻底确认须比对两版产物（成本高，未做）。

### 本次改动的验证

- `node --check`：`index.js`、`client.js`、`routes.js` 全部通过；`package.json` 可解析。
- 用假 `webServer` 驱动 `registerRoutes`：6 条 `exact` 路由、`auth` 均为 `required`、`handler` 均为函数；`GET /state` 与 `POST /scan|/rollback` 返回 200，`DELETE /fix` 返回 405，空 body 按 `{}` 处理；`dispose()` 撤销 6 条。
- `grep` 确认仓库内已无 `requestRejection` 与 `connection` 引用（文档已同步）。
- 尚未在重启后的宿主进程里复测：宿主插件代码改动需要重启 DSH 才能生效，重启后应出现新的 `plugin mounted` + `panel routes registered`，且未登录请求仍为 401。
