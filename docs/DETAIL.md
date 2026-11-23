# 工作区完整性修复

包名与插件注册名：`@xia-sc/dsh-workspace-integrity`。本文件描述插件的行为细节；安装、配置与发布见仓库根目录的 [README](../README.md)。

Windows 上使用 DSH 的 `workspace-write` 沙箱后，工作区根目录会被写入一条可继承的 Low 完整性标签。会话结束后标签仍留在文件系统上，从该目录启动的 exe 会以 Low 完整性运行，表现为配置目录写不进去、托盘图标不显示、SmartScreen 提示、Electron 启动崩溃等。

本插件把同一套操作放在三个入口：

- **自动**：会话切到 `danger-full-access` 时，监听 `sandbox/mode` 事件，对该会话**当前**的工作区（`working_directory` 优先，回退会话启动目录）执行一次标签恢复（等同 `icacls <root> /setintegritylevel (OI)(CI)M /T /C`）；根已经是 Medium 时直接跳过，不写记录。自动路径调用与面板、工具相同的 `operations.fix`，但固定 `fast: true, removeAces: false`，所以自动清理不会删除 ACE。
- **手动（界面）**：在会话头部的 View 标签行里多一个「完整性」，点开就是面板，直接对着**当前会话的工作区**扫描、修复、校验和回滚，不需要先选目录，也不需要让模型代劳。
- **手动（工具）**：提供 `workspace_integrity` 工具，支持扫描、修复、校验、回滚和查看记录。

## 界面

会话头部的标签行（对话 / 轨迹 / ……）里新增「完整性」，来自 `conversation.view` 插槽；它只在 Windows 上可用，读的是同一份宿主实现：

- 插件详情页（**Plugins** → 工作区完整性）在描述与插件行之间渲染「插件设置」表单：自动清理、扫描所有文件、删除沙箱权限项与排除目录；保存写入数据目录的 `config.json`，宿主内存中的配置同步更新并立即作用于自动清理、面板和工具，表单底部显示配置文件路径。
- 顶部是状态徽标（未扫描 / 上次自动清理 / 上次清理 / 预演 / 未发现 Low / 发现 N 个 Low 对象 / 已恢复为 Medium / 未改动 / 已回滚：标签恢复为 Low / 修复未完成）；
- 面板会读当前会话的沙箱模式：`danger-full-access` 时只显示一行「已是完全权限」；`workspace-write` 时说明「修复会让它失去写权限且不会自动恢复，切到完全权限时插件会自动清理，一般不用手动修复」；
- 「当前会话工作区」默认取这个会话当前所在的目录（`working_directory` 优先，回退 `session.header.cwd`），打开即可直接扫描；自动清理和工具不带 `path` 时也取同一个目录；
- 「当前会话工作区」下方显示该工作区最近一次清理：`上次清理 · <时间> · 自动清理/手动修复/工具修复`，数据来自回滚记录；
- 「扫描」「修复」「校验」调用与工具相同的操作，「回滚记录」列出 `%LOCALAPPDATA%\dsh-workspace-integrity\backup-*` 并按记录回滚；
- 「修复」和「回滚」需要点两次（4 秒内第二次才执行）；「修复」的第二次点击会先重新读一次会话模式，若此时仍是 `workspace-write`，按钮变成「仍要修复（会中断本会话写入）」，要第三次点击才执行；
- 宿主侧同样有门禁：`fix` 请求不带 `force` 且调用方会话是 `workspace-write` 时直接拒绝；工具调用同理；
- 两个复选框：`扫描所有文件` 对应 `allFiles`，`同时移除沙箱残留权限项` 对应 `removeAces`（默认关闭，勾选后就地给出削弱沙箱的说明）；
- 结果区显示 Low 对象数、`S-1-4` 权限项数、Everyone 删除拒绝项、无法读取的对象、DACL 不可读的对象、已删权限项、是否截断与耗时；修复结果还会显示 `warning`/`note` 与预演计划；底部显示当前生效的配置文件路径（`%DSH_HOME%\dsh-workspace-integrity\config.json`）。

面板通过同源 JSON 路由（`/workspace-integrity/api/*`）调用宿主。每条路由都声明 `auth: 'required'`，登录与 Host/Origin 校验由 `webServer` 在 HTTP 准入层执行，插件不再自行复制一套；因此面板和工具产生完全相同的状态变化。改标签是特权操作，面板不会弹 UAC，属主是 Administrators 的目录仍然返回 Access denied。

## 扫描

`scan` 读取对象 SACL 中的 mandatory label，列出 Low 对象；同时按 DSH 沙箱的真实 ACE 形状识别残留：

- workspace 能力 SID：`S-1-4-x-y`（两个 30 位 subauthority，均 ≥ 1）；
- temp 能力 SID：`S-1-4-x-y-1`（第三个 subauthority 为 1）；
- allow ACE 的 `GRANT_MASK = 0x110156`、继承 `OI|CI`；
- Everyone 的 `FILE_DELETE_CHILD` deny、继承 `CI`。

扫描把「显式项」与「继承项」分开计数（`sandboxSid` / `sandboxInherited` / `everyoneDeny` / `everyoneInherited`），继承项不会被删除。默认扫描目录和常见可执行文件；`allFiles: true` 扫描所有文件。

目录排除由 `-ExcludeDirs`（数据目录 `config.json` 的 `excludeDirs`，默认 `.git`、`.hg`、`.svn`）控制：不含反斜杠的条目按目录名匹配任意层级，含反斜杠的条目按相对根的路径前缀匹配。排除在进入子树前生效，被排除目录不计数、不入命中、也不会被删除；结果用 `excluded` 数量与 `excludedSamples`（前 20 条）体现。根目录自身始终检查。

结果里的 `hits` 是前 500 条命中，`hitsTotal` 是全部命中数；面板最多渲染 500 条，超出时提示「仅显示前 N 条」，这与引擎因 `MaxObjects` 截断产生的 `truncated` 是两件事。

读不到 SACL 的对象计入 `unreadable`，读不到 DACL 的对象计入 `daclUnreadable`；两者都不会被误报成「没有残留」。目录遍历失败会出现在 `errors` 里。

## 修复

`fix` 的执行顺序（幂等：根标签已经是 Medium 且没有勾选「同时移除沙箱残留权限项」时，直接返回「未改动」，不预扫、不写回滚记录、不遍历全树）：

1. 保存回滚记录：根目录的 owner+DACL SDDL、根标签状态、命中的对象列表、是否预扫（`fast`）、来源（`trigger`）、是否截断（`truncated`）、排除清单与数量（`excludeDirs` / `excluded` / `excludedSamples`）；`sddlSaved` 记录根 DACL 是否保存成功；
2. 对根目录执行递归标签恢复，把整棵树（包括 `bin`、`dist`、`node_modules` 等）设为 Medium；
3. 如果当前账户对该目录没有 `WRITE_OWNER`，通过 `WRITE_DAC` 临时授予自己完全控制，改完标签后按保存的 SDDL 还原 DACL（还原放在 `finally` 中，异常时也会执行）；
4. 只有标签恢复成功且根已不是 Low 时，才执行第 5 步；否则标记 `acesSkipped` 并跳过删除；
5. 可选 `removeAces: true`：删除**显式**的 DSH 沙箱 allow ACE 与 Everyone 删除拒绝项；继承项留给父级。删除每个对象前先保存其 DACL 到 `backup-*/objects/`，保存失败则跳过该对象；
6. 复扫并报告剩余 Low、沙箱 ACE、Everyone deny、DACL 不可读、失败项与是否截断；只有这些残留都为 0 且无失败才 `ok=true`。

`-Fast` 与 `-RemoveAces` 不能组合：fast 不预扫，无法找到 ACE，脚本直接拒绝；宿主会把 fast 路径的 `removeAces` 降级为 false 并给出 `warning`。自动清理固定使用 `removeAces: false`。

`-WhatIf`（工具 `whatIf: true`）只返回计划（`plan`），不写记录、不改 ACL。

`verify` 只复扫，不修改。`rollback` 按记录恢复根 DACL、逐个恢复 `objects/` 中保存的对象 DACL，并把记录中原本为 Low 的对象重新设为 Low；结果给出 `restored`（实际恢复动作数）、`daclRestored`、`objectsRestored`、`remainingLow`、`excluded`。`records` 列出来源、是否预扫、`removedAces`、`acesSkipped`、`truncated` 与 `ok`。

## 限制

- 只在 Windows 生效；修改强制标签需要 `WRITE_OWNER`。插件会在必要时临时授予完全控制来取得 `WRITE_OWNER`，改完立即还原 DACL；也支持管理员会话直接运行。属主是 Administrators 的盘根目录会返回 Access denied。
- 不要在 `workspace-write` 会话仍在写工作区时执行 `fix`：沙箱内的 Low 令牌需要 Low 标签才能写，提前改成 Medium 会让该会话失去写权限。自动清理只在切到 `danger-full-access` 后触发；手动路径在宿主侧会被拒绝，除非显式传 `force`。
- 清理之后继续使用 `workspace-write` **不会**自动恢复：DSH 的工作区授权按 provider 生命周期缓存（`dsh-sandbox-local` 的 `workspaceGrants`，每个工作区只 materialize 一次），标签被改回 Medium 后不会重新打标。删除 workspace 能力 SID 的 ACE 也会让该缓存与实际 DACL 不一致，后续会话可能要求重新授权。所以修复后这个会话的受限写操作会失败，直到重启 DSH 或换一个工作区。
- 危险路径默认拒绝：盘根、`%SystemRoot%`、`%ProgramFiles%`、`%ProgramData%`、`%USERPROFILE%` 根、`%SystemDrive%\Users` 根；脚本只有显式 `-AllowDangerousRoot` 才能越过，插件不会自动放行。文件路径与重解析点根也会被拒绝。
- 自动清理和面板修复共用一把按工作区的锁：同一工作区同时只跑一个修复，后到的那个会得到「已有修复在运行」而不是并发改写 ACL；直接运行脚本时另有一把 `%TEMP%\dsh-workspace-integrity-locks` 下的互斥锁。
- 自动清理与手动修复共用同一套幂等判断：根非 Low 且不要求删 ACE 时都直接跳过，所以重复点击不会产生空转和记录堆积；fast 与删 ACE 无法同时满足，组合会被拒绝。
- 清理冷却（60 秒）持久化在 `%DSH_HOME%\dsh-workspace-integrity\workspace-integrity.state.json`：插件重装或 HMR 重挂载后，已经清理过的会话不会立刻再触发一轮检查。日志在数据目录同级的 `workspace-integrity.log`。
- 手动修复会先扫描子树：根是 Medium 但子对象仍有 Low 时（例如上一次 `/T` 部分失败），会继续执行标签恢复，直到整树都无 Low 才跳过。`fast` 自动清理不预扫，只按根判断；子对象残留需要手动修复。`Set-LabelTree` 对文件使用不带继承标志的一遍设置，再补回 `(OI)(CI)` 让目录继续继承。
- 扫描/复扫按 `MaxObjects` 截断：截断会标记 `truncated`，`verify` 与 `fix` 判为未完成（`ok=false`），只修复已扫描对象，不会假装完成；面板命中列表只渲染前 500 条时另有「仅显示前 N 条」提示，不代表引擎截断。
- 排除目录不会被清理：`excludeDirs` 中的目录既不扫描也不删除，结果与记录用 `excluded` 标记；不要把它当成「已修复」。排除只影响子树，根目录的标签与 DACL 仍会检查。
- `removeAces` 会改 DACL，并可能让受限进程恢复删除工作区外文件的能力；只在确实需要交还目录时使用。删除前会保存对象 DACL，回滚可恢复；0.4.0 之前的旧记录没有对象 DACL，那些删除不可回滚。
- 回滚记录保存根 DACL 与受影响对象的 DACL，不保存每个对象的完整 SACL；子对象上的其他显式标签不会被精确还原。
- 文件编码为 UTF-8 with BOM；脚本不再用本地化的错误文本判断失败，只依据退出码与复扫结果。
