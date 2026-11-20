# 工作区完整性修复

包名与插件注册名：`@xia-sc/dsh-workspace-integrity`。本文件描述插件的行为细节；安装、配置与发布见仓库根目录的 [README](../README.md)。

Windows 上使用 DSH 的 `workspace-write` 沙箱后，工作区根目录会被写入一条可继承的 Low 完整性标签。会话结束后标签仍留在文件系统上，从该目录启动的 exe 会以 Low 完整性运行，表现为配置目录写不进去、托盘图标不显示、SmartScreen 提示、Electron 启动崩溃等。

本插件把同一套操作放在三个入口：

- **自动**：会话切到 `danger-full-access` 时，监听 `sandbox/mode` 事件，对该会话**当前**的工作区（`working_directory` 优先，回退会话启动目录）执行一次标签恢复（等同 `icacls <root> /setintegritylevel (OI)(CI)M /T /C`）；根已经是 Medium 时直接跳过，不写记录。自动路径调用与面板、工具相同的 `operations.fix`，所以 `removeAces` / `scanAllFiles` 配置在三个入口含义一致；`fast` 不预扫，因此自动清理不会删除 ACE，日志与结果里会写明这一点。
- **手动（界面）**：在会话头部的 View 标签行里多一个「完整性」，点开就是面板，直接对着**当前会话的工作区**扫描、修复、校验和回滚，不需要先选目录，也不需要让模型代劳。
- **手动（工具）**：提供 `workspace_integrity` 工具，支持扫描、修复、校验、回滚和查看记录。

## 界面

会话头部的标签行（对话 / 轨迹 / ……）里新增「完整性」，来自 `conversation.view` 插槽；它只在 Windows 上可用，读的是同一份宿主实现：

- 顶部是状态徽标（未扫描 / 上次自动清理 / 上次清理 / 未发现 Low / 发现 N 个 Low 对象 / 已恢复为 Medium / 未改动 / 已回滚：标签恢复为 Low / 修复未完成）；刚打开面板时若该工作区已有清理记录，徽标显示「上次自动清理」或「上次清理」，而不是「未扫描」；
- 面板会读当前会话的沙箱模式：`danger-full-access` 时只显示一行「已是完全权限」；`workspace-write` 时说明「修复会让它失去写权限且不会自动恢复，切到完全权限时插件会自动清理，一般不用手动修复」——不引导用户为了手动修复去切模式，因为切模式本身就会触发自动清理；读不到模式时提示确认；
- 「当前会话工作区」默认取这个会话当前所在的目录（`working_directory` 优先，回退 `session.header.cwd`），打开即可直接扫描；自动清理和工具不带 `path` 时也取同一个目录，所以面板显示的就是会被自动清理的那棵树；确实要扫别的目录时点「换个目录」，那里才出现工作区下拉与路径输入；
- 「当前会话工作区」下方显示该工作区最近一次清理：`上次清理 · <时间> · 自动清理/手动修复/工具修复`，数据来自回滚记录，没有记录时不显示；
- 「扫描」「修复」「校验」调用与工具相同的操作，「回滚记录」列出 `%LOCALAPPDATA%\dsh-workspace-integrity\backup-*` 并按记录回滚；
- 「修复」和「回滚」需要点两次（4 秒内第二次才执行），避免误点改写 ACL；「修复」的第二次点击会先重新读一次会话模式，若此时仍是 `workspace-write`，按钮变成「仍要修复（会中断本会话写入）」，要第三次点击才执行；
- 宿主侧同样有门禁：`fix` 请求不带 `force` 且调用方会话是 `workspace-write` 时直接拒绝，面板的「仍要修复」正是带 `force` 的知情覆盖；工具调用同理；
- 两个复选框：`扫描所有文件` 对应 `allFiles`，`同时移除沙箱残留权限项` 对应 `removeAces`（默认关闭，勾选后就地给出削弱沙箱的说明）；
- 结果区显示 Low 对象数、`S-1-4` 权限项数、无法读取的对象、是否截断和耗时；扫描和校验都会列出命中的对象，超过 60 条时标注 `已显示/总数`；修复在 fast + `removeAces` 时还会多一行提示「fast 未预扫，ACE 未删除」。

面板通过同源 JSON 路由（`/workspace-integrity/api/*`）调用宿主，路由由 `connection` 服务做登录与来源校验，因此面板和工具产生完全相同的状态变化。改标签是特权操作，面板不会弹 UAC，属主是 Administrators 的目录仍然返回 Access denied。

## 扫描

`scan` 读取对象 SACL 中的 mandatory label，列出 Low 对象，同时标出残留的 `S-1-4-*` 沙箱 ACE 和 Everyone 的 `FILE_DELETE_CHILD` 拒绝项。默认扫描目录和常见可执行文件（exe/dll/bat/cmd/msi/ps1 等）；`allFiles: true` 扫描所有文件。

如果当前令牌读不到 SACL，结果会给出 `unreadable` 数量，而不是把“读不到”误报成“没有 Low”。

## 修复

`fix` 的执行顺序（幂等：根标签已经是 Medium 且没有勾选「同时移除沙箱残留权限项」时，直接返回「未改动」，不预扫、不写回滚记录、不遍历全树。跳过只看根标签，不检查子对象；要删 ACE 时必须照常扫描才能找到它们）：

1. 保存回滚记录：根目录的 owner+DACL SDDL、根标签状态、命中的对象列表、本次是否预扫（`fast`）以及来源（`trigger`：`auto` / `manual` / `tool`），写入 `%LOCALAPPDATA%\dsh-workspace-integrity\backup-*`；
2. 对根目录执行递归标签恢复，把整棵树（包括 `bin`、`dist`、`node_modules` 等）设为 Medium；
3. 如果当前账户对该目录没有 `WRITE_OWNER`，通过 `WRITE_DAC` 临时授予自己完全控制，改完标签后按保存的 SDDL 还原 DACL；
4. 可选 `removeAces: true`：删除**非继承**的 `S-1-4-*` ACE 和 Everyone 的删除拒绝项（默认关闭；从父目录继承来的 ACE 不会被删除）；自动清理走 fast、不预扫，所以不会执行这一步，并会在结果里提示；
5. 复扫并报告剩余 Low、无法读取的对象和失败项。

`verify` 只复扫，不修改。`rollback` 按记录恢复根 DACL，并把记录中原本为 Low 的对象重新设为 Low。`records` 列出可用记录，并标出来源与是否预扫：自动清理的记录在面板上显示「自动清理（未预扫）」，它的 `Low` 数是未知（`null`）而不是 0；回滚这类记录时也会说明 `restored` 只统计根 DACL 与标签恢复。

## 限制

- 只在 Windows 生效；修改强制标签需要 `WRITE_OWNER`。插件会在必要时临时授予完全控制来取得 `WRITE_OWNER`，改完立即还原 DACL；也支持管理员会话直接运行。属主是 Administrators 的盘根目录会返回 Access denied。
- 不要在 `workspace-write` 会话仍在写工作区时执行 `fix`：沙箱内的 Low 令牌需要 Low 标签才能写，提前改成 Medium 会让该会话失去写权限。自动清理只在切到 `danger-full-access` 后触发；手动路径在宿主侧会被拒绝，除非显式传 `force`。
- 清理之后继续使用 `workspace-write` **不会**自动恢复：DSH 的工作区授权按 provider 生命周期缓存（`dsh-sandbox-local` 的 `workspaceGrants`，每个工作区只 materialize 一次），标签被改回 Medium 后不会重新打标。所以修复后这个会话的受限写操作会失败，直到重启 DSH 或换一个工作区。
- 自动清理和面板修复共用一把按工作区的锁：同一工作区同时只跑一个修复，后到的那个会得到「已有修复在运行」而不是并发改写 ACL；自动路径通过同一个 `operations.fix` 调用，所以这条规则对三者一致。
- 自动清理与手动修复共用同一套幂等判断：根非 Low 且不要求删 ACE 时都直接跳过，所以重复点击不会产生空转和记录堆积；fast 与删 ACE 无法同时满足，fast + `removeAces` 也会跳过并提示。
- 清理冷却（60 秒）持久化在 `%DSH_HOME%\workspace-integrity.state.json`：插件重装或 HMR 重挂载后，已经清理过的会话不会立刻再触发一轮检查。
- 幂等跳过只看根标签：如果上一次清理中途失败、根已经是 Medium 但子对象仍是 Low，`fix` 会跳过。先用「校验」确认残留，再用一次**非 fast** 的 `removeAces: true` 修复（没有 ACE 可删时不会误删），或用管理员 shell 对子树执行 `icacls <path> /setintegritylevel (OI)(CI)M /T /C`。
- `removeAces` 会改 DACL，并可能让受限进程恢复删除工作区外文件的能力；只在确实需要交还目录时使用。
- 回滚记录保存的是根 DACL 和命中对象的标签，不是每个对象的完整 SACL；子对象上的其他显式标签不会被精确还原。
