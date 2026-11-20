# @xia-sc/dsh-workspace-integrity 风险清单

针对 `@xia-sc/dsh-workspace-integrity` **0.3.2** 的复核结果，供后续逐条修复；当前已核到 0.3.5。0.3.5 之后只做包名迁移（旧 `@local` 作用域 → `@xia-sc`）、中文文档与发布流水线，行为未变。

- 复核对象：自动清理注册处、`index.js`、`scripts/Repair.ps1`、`routes.js`、`client.js`。
- 复核基准：0.3.3 已修复风险 1、2（跨进程锁 + 宿主模式门禁）；0.3.4 已修复风险 3、4、5（修复幂等、记录标注 `fast`/`trigger`、自动路径跟随 `working_directory`）；0.3.5 已修复风险 6、7、8（面板显示上次清理、自动路径共用 `operations.fix`、冷却持久化 + `WeakSet`）。
- 行号以 0.3.5 为准，改动后需重新核对。

## 判据

- **高**：影响数据或权限安全，或让会话直接不可用；用户可感知；修复成本低到中。
- **中**：影响数据可信度，或造成用户可感知的无效操作；不破坏权限。
- **低**：体验、配置语义或噪音问题；不影响安全。

## 总览

| # | 风险 | 等级 | 状态 | 一句话修复方向 |
|---|---|---|---|---|
| 1 | DACL 竞态：临时 FullControl 被永久留下 | 高 | 已修复 | `rollback` 纳入 `withRootLock`；跨进程用独占锁文件 |
| 2 | 手动入口无模式门禁 | 高 | 已修复 | `operations.fix` 按 `sessionId` 解析模式并拒绝，`force` 显式覆盖 |
| 3 | 手动路径不幂等 | 中 | 已修复 | `Invoke-Fix` 在「不删 ACE 且根非 Low」时直接跳过，不扫描也不写记录 |
| 4 | 自动记录 `hits: []` 导致回滚记录不可信 | 中 | 已修复 | manifest 记 `fast`/`trigger`，`Get-Records` 对 fast 记录返回 `low = null`，面板显示「自动清理（未预扫）」 |
| 5 | 自动与手动执行范围不一致 | 中 | 已修复 | `sessionWorkspace()` 统一取 `workingDirectory.get(session)`，自动路径、面板、工具共用 |
| 6 | 状态徽标误导：自动清理后仍显示「未扫描」 | 低 | 已修复 | `state()` 返回该工作区最新记录（`lastClean`），面板显示「上次清理」并据此初始化徽标 |
| 7 | `config.removeAces` 被自动路径忽略 | 低 | 已修复 | `autoClean` 改走 `operations.fix`；fast 下显式提示「未预扫，ACE 未删除」 |
| 8 | 重挂载重触发 | 低 | 已修复 | `lastRun` 持久化到 `%DSH_HOME%/workspace-integrity.state.json`；`seen` 换成 `WeakSet` |

---

## 1. DACL 竞态：临时 FullControl 被永久留下

**结论**：0.3.3 已把 `rollback` 纳入同一把锁，并加了跨进程独占锁文件；同一工作区在任何进程里同时只跑一个修复。

### 触发条件 / 复现路径

1. 工作区根目录属主缺 `WRITE_OWNER`（本插件目标场景的常态），`icacls /setintegritylevel` 被拒，`Set-LabelTree` 进入 fallback：`SaveSddl` → `icacls /grant <user>:(OI)(CI)(F)` → 重试 → `RestoreSddl`。
2. 两个修复进程交错：A 保存原始 SDDL 并授权；B 在 A 授权**之后**才 `SaveSddl`，于是 B 保存的是「已含临时授权」的版本；A 恢复原始，B 恢复「含授权」版本 → 临时 FullControl 永久留下。
3. 0.3.3 之后，`fix`、`rollback`、`autoClean` 共用一把按工作区的锁（进程内 Map + 跨进程锁文件），原先三条并发路径都已封住。仍存在的边界：
   - 锁文件被手工删除、或 `%LOCALAPPDATA%` 不可写时，退化为只有进程内保护；
   - 崩溃进程留下的锁文件会阻塞修复最多 10 分钟（陈旧阈值），之后自动抢占。

### 影响

工作区根目录上多出一条当前用户的完全控制 ACE，且不会被任何回滚记录还原（该记录本身就以「含授权」的 SDDL 为基线）。用户不可直接感知，但属于权限面的静默变更。

### 证据

- `scripts/Repair.ps1:46-78` — `Set-LabelTree` 的 `SaveSddl` / `icacls /grant` / `RestoreSddl` fallback。
- `scripts/Repair.ps1:599` — `Invoke-Fix` 调用 `Set-LabelTree`。
- `scripts/Repair.ps1:677-682` — `Invoke-Rollback` 在 `rootLabel === 'Low'` 时同样调用 `Set-LabelTree`。
- `index.js:124-127` — `inFlight`、`LOCK_DIR`、`LOCK_STALE_MS`。
- `index.js:142-181` — `acquireFileLock`：`openSync(..., 'wx')` 独占创建，陈旧锁按 mtime 抢占。
- `index.js:183-203` — `withRootLock`：进程内 Map + 文件锁；自动路径经 `operations.fix` 共用同一把锁。
- `index.js:395` — `operations.fix` 加锁。
- `index.js:426` — `operations.rollback` 从 manifest 取 root 后加锁。
- `index.js:640` — `autoClean` 改走 `operations.fix`，锁由它提供。

### 紧急程度：高

判据：直接改权限（安全面）；用户不可感知所以更危险；修复成本低到中（rollback 加锁 + 跨进程锁文件）。

### 最小修复建议

已实施（0.3.3）：

- `index.js`：`operations.rollback` 先读 `join(backupDir, 'manifest.json')` 取 `root`，再用 `withRootLock(root, ...)`；读不到 manifest 时退回以 `record:<backupDir>` 为 key。
- `index.js`：`withRootLock` 增加跨进程锁文件（`%LOCALAPPDATA%\dsh-workspace-integrity\locks\<sha1>.lock`），`openSync(..., 'wx')` 独占创建，10 分钟 mtime 视为陈旧并抢占；`autoClean` 用 `soft` 模式跳过而不是抛错（0.3.5 起自动路径改走 `operations.fix`，不再需要 `soft`）。

### 当前状态

**已修复**（进程内 + 跨进程）。残留边界见「触发条件」第 3 点。

---

## 2. 手动入口无模式门禁

**结论**：0.3.3 在宿主层加了门禁：`operations.fix` 按 `sessionId` 解析模式，`workspace-write` 且未传 `force` 时直接拒绝；面板的「仍要修复」正是传 `force` 的知情覆盖。

### 触发条件 / 复现路径

1. 会话处于 `workspace-write`。
2. 面板点「修复」两次：第二次会重新读模式，若仍是 `workspace-write` 则按钮变成「仍要修复（会中断本会话写入）」，第三次点击带 `force: true` 执行。
3. 直接 `POST /workspace-integrity/api/fix` 且不带 `force` → 400 拒绝。
4. 让 agent 调 `workspace_integrity action=fix` → 同样被拒，除非显式传 `force: true`。

### 影响

该会话的受限进程立刻失去工作区写权限，且 **DSH 不会重新打标**（见下），会话后续写操作持续失败，直到重启 DSH 或换工作区。0.3.3 之后只有显式 `force` 才会走到这一步，默认请求会被拒绝。

> 依据：`dsh-sandbox-local/src/index.ts:442-462` 的 `workspaceGrants` 是 provider 级缓存，只在首次 materialize 时调 `grant.add`；`dsh-sandbox-windows-acl/src/acl.ts:386-395` 的幂等跳过会比对 label，但只有被调用时才生效。

### 证据

- `index.js:378-380` — `operations.fix` 的模式门禁（`workspace-write` 且 `force !== true` 时抛 `userError`）。
- `index.js:218-240` — `resolveSession` / `sessionMode` 辅助。
- `index.js:536-540` — 工具把 `sessionId` 与 `force` 传进 `operations.fix`。
- `index.js:497-500` — 工具 schema 的 `force` 参数。
- `index.js:467-468` — 工具描述说明 fix 会拒绝。
- `routes.js:104` — `/fix` 透传 body（含 `sessionId` / `force`）。
- `client.js:618` — 普通修复带 `sessionId`。
- `client.js:729` — 「仍要修复」带 `sessionId` 与 `force: true`。
- `client.js:597-618` — `refreshMode` / `confirmFix` 的二次确认。
- `client.js:660-670` — 按模式显示文案。

### 紧急程度：高

判据：让会话不可用（可用性 + 权限）；用户可感知（写操作报错）；修复成本中（需要把 `sessionId` 传进 `operations.fix`）。

### 最小修复建议

已实施（0.3.3）：

- `index.js`：`createOperations(ctx, config)` 收进 ctx；`operations.fix` 用 `resolveSession` + `sessionMode` 解析调用方模式，`workspace-write` 且 `force !== true` 时抛 `userError`。
- `index.js`：工具把 `exec.agent.session.id` 作为 `sessionId` 传入，并新增 `force` 参数。
- `client.js`：普通修复带 `sessionId`；「仍要修复」带 `force: true`，与宿主门禁语义对齐。

### 当前状态

**已修复**（宿主层门禁 + UI 知情覆盖）。

---

## 3. 手动路径不幂等

**结论**：0.3.4 起，根标签已经是 Medium 且没有要求删 ACE 时，手动「修复」直接跳过：不预扫、不写新记录、不遍历全树。与自动路径的跳过条件对齐，`removeAces` 例外（需要扫描才能找到 ACE）。

### 触发条件 / 复现路径

1. 工作区已清理干净（根标签 Medium）。
2. 面板点「修复」两次（或工具 `action=fix`）。
3. `Invoke-Fix` 先探测根标签；`readable && !low && !removeAces` 时直接返回 `note: 'The root label is not Low; skipped.'`，不再 `Invoke-Scan` / `New-BackupRecord` / `Set-LabelTree`。

### 影响

0.3.4 之前是大树上的分钟级空转（`icacls /T` 全树遍历），每次点击都新增一条 `backup-*` 记录；现在重复点击是常量开销，记录也不再堆积。

### 证据

- `scripts/Repair.ps1:563-590` — `Invoke-Fix` 的幂等跳过分支（`$fast -or -not $removeAces` 时探测；fast 跑不预扫，`removeAces` 也跳过）。
- `scripts/Repair.ps1:596` — 只有走到这里才写回滚记录。
- `scripts/Repair.ps1:599` — 只有走到这里才 `Set-LabelTree`。
- `index.js:378-387` — 面板与工具都不传 `fast`，靠新条件获得幂等。

### 紧急程度：中

判据：不破坏权限，但造成可感知的无效操作与记录堆积；修复成本极低（一行条件）。

### 最小修复建议

已实施（0.3.4）：

- `scripts/Repair.ps1`：`Invoke-Fix` 的跳过条件从 `if ($fast)` 放宽到 `if ($fast -or -not $removeAces)`，跳过判断再加 `-not $removeAces`；`removeAces` 时保持不跳过，避免漏删 ACE。

### 当前状态

**已修复**。四种组合已验证：手动/fast × 是否删 ACE，只有「不删 ACE」时跳过；根是 Low 或标签不可读时不跳过。已知边界：跳过只探测根标签，若根已是 Medium 而子对象仍有 Low（上一次清理中途失败），需要 `removeAces: true` 让流程不跳过，或对子树单独 `icacls`，详见 `docs/DETAIL.md` 的「限制」。

---

## 4. 自动记录 `hits: []` 导致回滚记录不可信

**结论**：0.3.4 起，回滚记录会写明这次修复是 `fast`（未预扫）还是预扫过，以及由谁触发（`auto` / `manual` / `tool`）；`records` 对未预扫的记录返回 `low = null`，面板显示「自动清理（未预扫）」，不再谎报 0。

### 触发条件 / 复现路径

1. 会话切到 `danger-full-access`，自动路径以 `-Fast -Trigger auto` 运行。
2. 根标签是 Low（未跳过），`$scan` 被替换成 `{ hits = @(); low = 0; ... }`。
3. `New-BackupRecord` 写入 `hits: []`、`fast: true`、`trigger: 'auto'`。
4. 面板「回滚记录」列出该记录时 `low` 是 `null`，显示为「自动清理（未预扫）」。

### 影响

记录不再把「没扫描」说成「扫过、0 个命中」。标签回滚本身仍有效（靠 `rootLabel === 'Low'` 走整树 `Set-LabelTree L`）；`rollback` 结果写明 `preScanned: false` 并提示 `restored` 只统计根 DACL 与标签恢复，所以是**证据缺失的标注**而不是回滚失效。

### 证据

- `scripts/Repair.ps1:547-548` — manifest 新增 `fast`、`trigger`。
- `scripts/Repair.ps1:596` — `New-BackupRecord` 收 `fast`/`trigger`。
- `scripts/Repair.ps1:697-720` — `Get-Records`：fast 记录 `low = $null`，并输出 `fast`/`trigger`。
- `scripts/Repair.ps1:664`、`690-692` — `Invoke-Rollback` 的 `preScanned` 与说明。
- `scripts/Repair.ps1:672-682` — hits 只影响 `restored` 计数，标签恢复走 `rootLabel === 'Low'` 的整树分支。
- `index.js:28`、`384` — `TRIGGERS` 白名单与 `-Trigger` 传参。
- `index.js:640` — 自动路径固定 `trigger: 'auto'`。
- `client.js:793-799` — 记录行对 `fast && low === null` 显示「自动清理（未预扫）」。

### 紧急程度：中

判据：影响回滚证据的可信度，不破坏权限；用户可感知（记录显示 0）；修复成本低。

### 最小修复建议

已实施（0.3.4）：

- `scripts/Repair.ps1`：`Invoke-Fix` 增加 `-Trigger auto|manual|tool`（默认 manual），与 `fast` 一起写进 manifest；`Get-Records` 对 fast 记录返回 `low = $null`。
- `index.js`：工具路径传 `trigger: 'tool'`，自动路径传 `-Trigger auto`，面板默认 `manual`。
- `client.js`：记录行对 `low === null` 显示「自动清理（未预扫）」。

### 当前状态

**已修复**。已验证：fast 记录 manifest 为 `fast: true` / `trigger: auto`，`records` 输出 `low: null`；非 fast 记录仍给出数字 `low`；旧记录缺字段时按非 fast 处理。

---

## 5. 自动与手动执行范围不一致

**结论**：0.3.4 起，自动路径、面板、工具共用 `sessionWorkspace()`：优先 `workingDirectory.get(session)`，回退 `session.header.cwd`。改过目录的会话不会再清错树。

### 触发条件 / 复现路径

1. 会话内用 `working_directory` 切换过目录。
2. 切到 `danger-full-access` → 自动路径按 `workingDirectory.get(session)`（当前目录）清理。
3. 面板打开时显示并清理同一个目录；工具不带 `path` 时的回退也落在同一目录。

### 影响

自动清理不再清原始工作区而漏掉用户实际在用的目录；面板显示的「当前会话工作区」与实际被自动清理的目录始终一致。

### 证据

- `index.js:248-256` — `sessionWorkspace()`：`workingDirectory.get(session)` 优先，回退 `header.cwd`。
- `index.js:344` — `state()` 用它算 `sessionPath`。
- `index.js:530` — 工具不带 `path` 时的回退。
- `index.js:600` — `maybeClean` 的日志与空判断。
- `index.js:624` — `autoClean` 的实际清理目标。

### 紧急程度：中

判据：可能清错目录（数据面），用户可感知；修复成本极低（一行）。

### 最小修复建议

已实施（0.3.4）：

- `index.js`：新增 `sessionWorkspace(ctx, session)`；`autoClean` 改为 `autoClean(ctx, session)` 并用它取根；`maybeClean`、`state()`、工具回退统一走同一函数。

### 当前状态

**已修复**。已验证：工作区切到 `D:\dshwi-other-workspace`、`header.cwd` 为 `C:\dshwi-launch-dir` 时，`state().sessionPath`、工具回退与自动清理日志都指向前者，日志中没有出现后者。

---

## 6. 状态徽标误导：自动清理后仍显示「未扫描」

**结论**：0.3.5 起，`state()` 返回该工作区最新一条回滚记录的摘要（`lastClean`），面板据此显示「上次清理 · <时间> · 自动/手动/工具」，并在本次没有手动结果时把徽标初始化为「上次自动清理」或「上次清理」，不再显示「未扫描」。

### 触发条件 / 复现路径

1. 切到 `danger-full-access`，自动路径清理完成并写入 `backup-*` 记录。
2. 打开「完整性」标签页：`/state` 读该工作区最新的 `manifest.json`。
3. 徽标显示「上次自动清理」；「当前会话工作区」下方显示「上次清理 · <时间> · 自动清理」。手动修复后记录刷新，来源显示「手动修复」。

### 影响

自动路径的结果不再隐形：用户不会因为「未扫描」而怀疑自动清理没生效、也不会因此重复点击（即使点击，0.3.4 的幂等跳过也只是空操作）。

### 证据

- `index.js:265-296` — `latestRecord()`：按 root 找最新的 `manifest.json`，给出来源与是否预扫。
- `index.js:357` — `state()` 返回 `lastClean`。
- `client.js:322-354` — `statusOf` 在没有本次结果时使用 `lastClean`。
- `client.js:450`、`502`、`603` — 面板保存并在 `/state` 刷新时更新 `lastClean`。
- `client.js:709-712` — 「上次清理 · 时间 · 触发者」一行。
- `client.js:316-320` — `triggerLabelKey` 的文案映射。

### 紧急程度：低

判据：不影响安全，只是信息缺失；修复成本中（需要 `state()` 返回最新记录，依赖风险 4 的 `trigger` 字段）。

### 最小修复建议

已实施（0.3.5）：

- `index.js`：新增 `latestRecord(root)`；`state()` 返回 `lastClean`（含 `createdAt` / `trigger` / `fast` / `low` / `backupDir`）。
- `client.js`：工作区卡片显示「上次清理 · 时间 · 来源」；无手动结果时徽标用「上次自动清理 / 上次清理」；修复成功后再拉一次 `/state` 刷新。

### 当前状态

**已修复**。已验证：构造新旧两条记录时 `lastClean` 取到最新一条并保留 `trigger`/`fast`/`low` 语义（fast 记录 `low = null`）；面板渲染为代码审阅（浏览器侧未单独跑）。

---

## 7. `config.removeAces` 被自动路径忽略

**结论**：0.3.5 起，自动路径不再自己拼脚本参数，而是调用与面板/工具相同的 `operations.fix`：`config.removeAces` 和 `config.scanAllFiles` 在三个入口含义一致。`-Fast` 仍然不预扫，所以 fast 下要求删 ACE 也删不掉——这一点写进插件日志，并在结果里以 `warning` 返回，面板和工具都能看到。

### 触发条件 / 复现路径

1. 配置 `removeAces: true`。
2. 会话切到 `danger-full-access` → `autoClean` 调用 `operations.fix({ fast: true, trigger: 'auto' })`，参数里带 `-RemoveAces -Fast`。
3. `Repair.ps1` 的 `-Fast` 不预扫：根非 Low 时幂等跳过并注明「ACE 未处理」；根是 Low 时只做标签恢复，hits 为空，删不掉 ACE。
4. 日志出现 `fast repair ... no leftover ACE was removed`，结果带 `warning`，面板以 caution 行显示。

### 影响

配置不再被静默忽略：自动路径的 `removeAces` 语义与面板/工具一致，fast 与删 ACE 的固有矛盾被显式告知。要真正删 ACE 仍需一次非 fast 的修复（让 fast 也预扫成本高，按清单建议不做）。

### 证据

- `index.js:640-651` — `autoClean` 调用 `operations.fix`，`trigger: 'auto'`。
- `index.js:382-397` — `removeAces` 按 `wantsFlag(input.removeAces, config.removeAces)` 决定；`fastWithoutScan` 记日志并返回 `warning`。
- `index.js:446` — `summary` 把 `warning` 一并输出给工具调用方。
- `client.js:421` — 面板以 caution 样式显示 `warning`。
- `scripts/Repair.ps1:563-590` — fast + `-RemoveAces` 时的幂等跳过与提示文案。
- `scripts/Repair.ps1:611-620` — 删除循环遍历 `$record.manifest.hits`，fast 下为空。

### 紧急程度：低

判据：配置语义问题，不破坏权限；用户可感知但影响有限；修复成本低。

### 最小修复建议

已实施（0.3.5）：

- `index.js`：`autoClean` 改走 `operations.fix({ path, fast: true, trigger: 'auto', sessionId })`；`operations.fix` 在 `fast && removeAces` 时记日志并返回 `warning`。
- `scripts/Repair.ps1`：fast 记录/跳过时不再假装删过 ACE，note 写明「-Fast does not pre-scan」。

### 当前状态

**已修复**（配置语义统一 + 显式提示）。fast 仍不预扫，这是清单里明确保留的取舍。

---

## 8. 重挂载重触发

**结论**：0.3.5 起，`lastRun` 冷却持久化到 `%DSH_HOME%/workspace-integrity.state.json`，重挂载后仍然生效；`seen` 改成按 Session 对象的 `WeakSet`，不再累积 id 字符串，条目随会话回收。

### 触发条件 / 复现路径

1. 安装/升级插件（或 HMR 重挂载）。
2. 模块重新求值：`seen` 清空，但 `lastRun` 从状态文件恢复（只恢复仍在 60s 冷却内的 root）。
3. 每个已存在的 full-access 会话首次事件仍会 `maybeClean`，但 `autoClean` 在冷却内直接返回：不启动 PowerShell、不写记录、不写 `cleaning` 日志。

### 影响

重挂载后的风暴从「每个会话一次 PowerShell 启动」降为一次 Map 查询；`seen` 不再随会话数量增长。

### 证据

- `index.js:24-54` — `lastRun`、`STATE_FILE`、`restoreCooldowns()`、`persistCooldowns()`。
- `index.js:591` — `const seen = new WeakSet()`。
- `index.js:606-618` — `session/event`：`seen.has(session)` 去重后才检查。
- `index.js:632-634` — 冷却判断之后立即 `lastRun.set` + `persistCooldowns()`。
- `index.js:124` — `inFlight` 仍是模块级（随重挂载重置；跨进程由锁文件覆盖）。

### 紧急程度：低

判据：不影响安全，用户基本不可感知；修复成本低。

### 最小修复建议

已实施（0.3.5）：

- `index.js`：`seen` 由 `Set<string>` 改为 `WeakSet<Session>`。
- `index.js`：启动时 `restoreCooldowns()` 读取 `%DSH_HOME%/workspace-integrity.state.json`，每次记录冷却时 `persistCooldowns()` 写回（只保留未过期的 root）。

### 当前状态

**已修复**。已验证：同一进程内同一 Session 的两次事件只触发一次清理；新进程（模拟重挂载）使用同一 `DSH_HOME` 时没有第二次 `full access detected`，状态文件写入 root 时间戳。

---

## 附：各版本改动与风险的关系

行号为该版本发布时的位置，用于对照正文证据；正文按当前版本标注。

| 版本 | 改动 | 影响的风险 |
|---|---|---|
| 0.3.2 | `inFlight` 按工作区锁（`index.js:93`） | 1 的进程内并发已封住 |
| 0.3.2 | 面板按会话模式显示文案（`client.js:620-630`） | 2 的 UI 层知情确认 |
| 0.3.2 | 修复二次确认重新读模式、三次点击（`client.js:561-582`、`688`） | 2 的 UI 层；3 的误点概率下降但未消除 |
| 0.3.2 | `DETAIL.md` 修正「DSH 会重新打标」的错误说法 | 无（文档修正） |
| 0.3.3 | `rollback` 纳入锁 + 跨进程锁文件（`index.js:111-172`、`325`） | 1 已修复 |
| 0.3.3 | 宿主模式门禁 + `force`（`index.js:289-291`、`395-398`） | 2 已修复 |
| 0.3.4 | `Invoke-Fix` 幂等跳过（`Repair.ps1:556-568`） | 3 已修复 |
| 0.3.4 | manifest 记 `fast`/`trigger`，records 返回 `low = null`（`Repair.ps1:547-548`、`690-710`、`client.js:754-760`） | 4 已修复 |
| 0.3.4 | `sessionWorkspace()` 统一目录（`index.js:219-227`、`515`、`539`） | 5 已修复 |
| 0.3.5 | `state()` 返回 `lastClean`，面板显示「上次清理」（`index.js:265-296`、`357`、`client.js:709-712`） | 6 已修复 |
| 0.3.5 | `autoClean` 走 `operations.fix`；fast + `-RemoveAces` 记日志并返回 `warning`（`index.js:640-651`、`382-397`、`scripts/Repair.ps1:563-590`） | 7 已修复 |
| 0.3.5 | 冷却持久化 + `WeakSet`（`index.js:24-54`、`591`、`606-618`） | 8 已修复 |
