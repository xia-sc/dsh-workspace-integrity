# @xia-sc/dsh-workspace-integrity

Windows 专用的 DSH 插件包：修复 DSH `workspace-write` 沙箱遗留在工作区上的 **Low 完整性标签**，并提供一个中文的「完整性」面板、`workspace_integrity` agent 工具、回滚记录与自动清理。

- npm 包名：`@xia-sc/dsh-workspace-integrity`
- 插件注册名：`@xia-sc/dsh-workspace-integrity`
- 界面语言：默认中文
- 平台：仅 Windows

## 它解决什么问题

在 Windows 上，DSH 的 `workspace-write` 沙箱会把工作区根目录（以及整棵树）的强制完整性标签设为 **Low**。会话结束后标签仍留在文件系统上，从该目录启动的程序会以 Low 完整性运行，常见表现为：

- 配置目录写不进去、托盘图标不显示；
- SmartScreen 弹窗、Electron 应用启动崩溃；
- 沙箱结束后仍有 `S-1-4-*` 沙箱权限项与 Everyone 删除拒绝项残留，导致删除工作区文件被拒。

插件把同一套修复操作放在三个入口：自动清理、界面面板、agent 工具，三者共用一份宿主实现，行为一致。

## 功能一览

| 能力 | 说明 |
|---|---|
| 自动清理 | 会话切到 `danger-full-access` 时，对会话**当前**工作区执行一次标签恢复；根已是 Medium 时幂等跳过 |
| 完整性面板 | 会话头部 View 标签行里的「完整性」，直接扫描 / 修复 / 校验 / 回滚，默认中文 |
| agent 工具 | `workspace_integrity`，支持 `scan` / `fix` / `verify` / `rollback` / `records` |
| 回滚记录 | 修复前保存根目录 DACL 与命中对象，可整条回滚；记录标注来源（自动 / 手动 / 工具）与是否预扫 |
| 安全门禁 | 调用方会话仍是 `workspace-write` 时拒绝修复，除非显式 `force` |
| 并发保护 | 同一工作区在进程内与跨进程都只允许一个修复（独占锁文件） |
| 状态可查 | 面板显示该工作区「上次清理」时间与来源，自动清理后不再显示「未扫描」 |
| 冷却持久化 | 60 秒清理冷却写入 `%DSH_HOME%\workspace-integrity.state.json`，插件重载后不重复触发 |

## 安装

### 从 npm 安装（推荐）

DSH 已连接 npm 时，直接以包名安装：

```js
plugin_manager({ action: 'install_bundle', target: '@xia-sc/dsh-workspace-integrity' })
```

也可以在 **Plugins → 添加插件** 中填入同样的包名。

### 从本地目录安装（开发）

```js
plugin_manager({ action: 'install_bundle', target: 'E:\\path\\to\\dsh-workspace-integrity' })
```

本地目录安装会链接整个目录，修改后需要重启 `dsh`（或让插件管理器重载）才能加载新的宿主模块与浏览器端 bundle。

### 启用与语言

安装后插件默认启用。面板与插件详情使用包内 `locale/zh.json`、`locale/en.json` 的元数据；**面板正文固定使用中文**，不随宿主或浏览器语言切换。

## 使用

### 完整性面板

1. 打开任意会话，在头部标签行（对话 / 轨迹 / …）选择 **完整性**。
2. 面板默认打开**当前会话的工作区**（跟随 `working_directory` 的切换）。
3. 点击 **扫描**（只读）查看 Low 对象、`S-1-4` 沙箱权限项与 Everyone 删除拒绝项。
4. 点击 **修复** 需要二次确认（4 秒内再次点击）；修复前若会话仍是 `workspace-write`，按钮会变成「仍要修复（会中断本会话写入）」，需要第三次确认。
5. **回滚记录** 列出 `%LOCALAPPDATA%\dsh-workspace-integrity\backup-*`，按记录恢复根 DACL 与 Low 标签。

面板会显示该工作区最近一次清理：`上次清理 · <时间> · 自动清理 / 手动修复 / 工具修复`。自动清理过的记录在列表中显示「自动清理（未预扫）」，其 Low 数量是未知（`null`）而不是 0。

### agent 工具

```text
workspace_integrity action=scan    path=E:\my-workspace
workspace_integrity action=fix     path=E:\my-workspace
workspace_integrity action=verify  path=E:\my-workspace
workspace_integrity action=records
workspace_integrity action=rollback backupDir=C:\Users\me\AppData\Local\dsh-workspace-integrity\backup-...
```

参数说明：

| 参数 | 说明 |
|---|---|
| `path` | 绝对工作区路径；省略时取调用会话的当前工作区 |
| `removeAces` | 同时删除非继承的 `S-1-4-*` ACE 与 Everyone 删除拒绝项；默认取插件配置 |
| `allFiles` | 扫描所有文件，而不只是常见可执行扩展名 |
| `fast` | 跳过预扫，只递归重置根标签；自动清理使用 |
| `force` | 会话仍是 `workspace-write` 时强制修复；会让该会话失去工作区写权限且 DSH 不会恢复 |

### 回滚记录与状态文件

- 回滚记录：`%LOCALAPPDATA%\dsh-workspace-integrity\backup-*`
- 跨进程锁：`%LOCALAPPDATA%\dsh-workspace-integrity\locks\*.lock`（陈旧锁 10 分钟后可被抢占）
- 冷却状态：`%DSH_HOME%\workspace-integrity.state.json`
- 日志：`%DSH_HOME%\workspace-integrity.log`

## 配置项

在 `cordis.patch.yml` 的插件条目里配置：

```yaml
- insert:
    - id: workspace-integrity
      name: '@xia-sc/dsh-workspace-integrity'
      config:
        autoClean: true
        removeAces: false
        scanAllFiles: false
```

| 配置项 | 默认 | 说明 |
|---|---|---|
| `autoClean` | `true` | 会话切到 `danger-full-access` 时自动清理当前工作区 |
| `removeAces` | `false` | 修复时同时删除非继承的 `S-1-4-*` ACE 与 Everyone 删除拒绝项；会削弱仍在使用的沙箱 |
| `scanAllFiles` | `false` | 扫描所有文件，而不是只扫描常见可执行扩展名 |

面板会以这些值作为初始勾选状态，单次操作可以覆盖，但不会写回配置。

## 行为与设计

- **自动清理**：监听 `sandbox/mode` 事件；根标签已是 Medium 时幂等跳过，不扫描、不写记录、不遍历整棵树。
- **目录一致**：自动清理、面板、工具都通过同一个 `sessionWorkspace()` 取目录（`working_directory` 优先，回退会话启动目录）。
- **幂等**：手动修复在「不删 ACE 且根非 Low」时直接返回「未改动」；`fast` 与删 ACE 无法同时满足，fast + `removeAces` 也会跳过并在结果里提示。
- **模式门禁**：`fix` 在调用方会话为 `workspace-write` 且未传 `force` 时被宿主拒绝，面板的「仍要修复」正是知情覆盖。
- **锁**：`fix`、`rollback`、自动清理共用按工作区的锁（进程内 Map + 跨进程锁文件），后到者得到「已有修复在运行」。
- **记录诚实**：回滚记录写入 `fast`（是否预扫）与 `trigger`（`auto` / `manual` / `tool`）；未预扫记录的 Low 数量是 `null`，回滚时说明 `restored` 只统计根 DACL 与标签恢复。

## 已知限制

- **仅 Windows**：修改强制标签需要 `WRITE_OWNER` 或 `SeRelabelPrivilege`；属主是 Administrators 的盘根目录会返回 Access denied，需要管理员 shell。
- **不要在 `workspace-write` 会话仍在写工作区时修复**：沙箱内的 Low 令牌需要 Low 标签才能写，提前改成 Medium 会让该会话失去写权限；自动清理只在切到 `danger-full-access` 后触发。
- **DSH 不会重新打标**：工作区授权按 provider 生命周期缓存，修复后继续用 `workspace-write` 的会话会一直写失败，直到重启 DSH 或换工作区。
- **幂等跳过只看根标签**：如果上一次清理中途失败、根已是 Medium 但子对象仍是 Low，`fix` 会跳过；先用「校验」确认残留，再用一次非 fast 的 `removeAces: true` 修复，或用管理员 shell 对子树执行 `icacls <path> /setintegritylevel (OI)(CI)M /T /C`。
- **`removeAces` 会改 DACL**：只删除非继承项，可能让受限进程恢复删除工作区外文件的能力；只在确实要交还目录时使用。
- **回滚记录不是逐对象快照**：只保存根 DACL 与命中对象的标签，子对象上的其他显式标签不会被精确还原。
- **自动清理不会删 ACE**：`-Fast` 不预扫，`removeAces` 在自动路径上不会生效，结果里会明确提示。
- **权限**：插件自身不提权，也不会关闭沙箱。

## 开发

### 目录结构

```text
.
├── index.js                 # 宿主插件：工具、共享操作、自动清理、路由挂载
├── routes.js                # 面板使用的同源 JSON 路由
├── client.js                # 浏览器端：完整性面板（默认中文）
├── cordis.patch.yml         # bundle 的 Loader patch
├── scripts/Repair.ps1       # ACL 引擎（扫描 / 修复 / 校验 / 回滚 / 记录）
├── locale/{zh,en}.json      # 插件显示名与描述
├── docs/DETAIL.md           # 行为细节文档
├── icon.svg
├── RISKS.md                 # 风险清单与修复记录
└── .github/workflows/publish.yml  # npm OIDC 发布
```

### 本地校验

```powershell
node --check index.js
node --check client.js
node --check routes.js
npm pack --dry-run
```

`npm pack --dry-run` 会列出实际发布内容，确认 `scripts`、`locale`、`docs`、`icon.svg`、`LICENSE` 与宿主文件都在 `files` 里。

### 发布（GitHub Actions + npm OIDC）

发布流水线：`.github/workflows/publish.yml`，触发条件为 **GitHub Release published** 或手动 `workflow_dispatch`。整个流程不使用 `NPM_TOKEN` 或任何 npm 凭据，只通过 npm Trusted Publishing（OIDC）换取短期发布权限。

workflow 的关键设置：

```yaml
permissions:
  contents: read
  id-token: write
```

npm 端（需要你本人配置）填写：

| 字段 | 值 |
|---|---|
| Package name | `@xia-sc/dsh-workspace-integrity` |
| Repository | `xia-sc/dsh-workspace-integrity` |
| Workflow filename | `publish.yml` |
| Environment | 留空（workflow 未指定 environment） |

配置位置：npm 包页面 → **Settings → Publishing access → Trusted publishers → Add a publisher → GitHub Actions**。

首次发布提示：如果 npm 上还没有这个包，Trusted Publisher 设置页可能不存在，需要先用 `npm publish --access public` 手动发布一次（本地 `npm login`），或先创建一个同名占位包，再切换到 OIDC。

发布前在本地确认：

1. `package.json` 的 `name` 是 `@xia-sc/dsh-workspace-integrity`；
2. `package.json` 的 `version` 已递增；
3. `node --check` 与 `npm pack --dry-run` 通过；
4. 在 GitHub 上创建 Release（tag 与版本一致）。

## 许可证

MIT，见 [LICENSE](LICENSE)。
