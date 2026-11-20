/* @xia-sc/dsh-workspace-integrity — browser half of the plugin.
 *
 * Registers the "完整性" Conversation View (`conversation.view`), so the panel
 * is one tab away in the session header instead of a page buried in Plugins.
 * It opens on the Session's own workspace: a scan is one click and no
 * directory has to be chosen. Every action calls the Host half over its
 * same-origin JSON routes, which run the same operations the agent's
 * `workspace_integrity` tool calls.
 *
 * Classic script bundle: the DSH web loader evaluates this file through
 * window.__ModuleLoader__.load({ id, factory }). Only `react` is required.
 */
window.__ModuleLoader__.load({
  id: '@xia-sc/dsh-workspace-integrity',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useRef = React.useRef

    const NS = 'workspaceIntegrity'
    const API = '/workspace-integrity/api'
    const SLOT = 'conversation.view'

    let titleSeed = 0

    const DICT = {
      zh: {
        nav: '完整性',
        title: '工作区完整性',
        subtitle: '修复 Windows 沙箱在 workspace-write 会话后遗留在工作区上的 Low 完整性标签；扫描和校验只读，不修改文件。',
        modeFullAccess: '当前会话已是完全权限，可以安全修复。',
        modeWorkspaceWrite: '当前会话是 workspace-write：修复会让它失去工作区写权限，DSH 不会自动恢复。切到「完全权限」时插件会自动清理，一般不用在这里手动修复；扫描和校验随时可用。',
        modeUnknown: '无法确认当前会话的沙箱模式；修复前请确认它不在 workspace-write。',
        sessionWorkspace: '当前会话工作区',
        lastClean: '上次清理',
        triggerAuto: '自动清理',
        triggerManual: '手动修复',
        triggerTool: '工具修复',
        changeDir: '换个目录',
        useSessionDir: '用回当前会话目录',
        noSessionPath: '读不到这个会话的工作区路径，请填写要扫描的目录。',
        workspace: '工作区',
        chooseWorkspace: '选择工作区…',
        workspacePath: '工作区路径',
        pathPlaceholder: 'E:\\path\\to\\workspace',
        scan: '扫描',
        fix: '修复',
        verify: '校验',
        records: '回滚记录',
        rollback: '回滚',
        close: '收起',
        removeAces: '同时移除沙箱残留权限项',
        allFiles: '扫描所有文件',
        loading: '读取中…',
        scanning: '扫描中…',
        fixing: '修复中…',
        verifying: '校验中…',
        rollingBack: '回滚中…',
        reading: '读取记录…',
        statusIdle: '未扫描',
        statusLastClean: '上次清理',
        statusAutoCleaned: '上次自动清理',
        statusClean: '未发现 Low',
        statusLow: '发现 {count} 个 Low 对象',
        statusFixed: '已恢复为 Medium',
        statusWhatIf: '预演（未修改）',
        statusSkipped: '未改动',
        statusRolledBack: '已回滚：标签恢复为 Low',
        statusFailed: '修复未完成',
        lowObjects: 'Low 对象',
        sidObjects: '沙箱权限项',
        unreadable: '无法读取',
        daclUnreadable: 'DACL 不可读',
        removedAces: '已删权限项',
        acesSkipped: '未删权限项',
        rootOnly: '仅验证根',
        objectsRestored: '对象 DACL 已恢复',
        remainingLow: '剩余 Low',
        truncated: '结果已截断',
        elapsed: '耗时',
        hits: '命中的对象',
        plan: '计划',
        noHits: '没有发现 Low 标签或残留的沙箱权限项。',
        backup: '回滚目录',
        failed: '失败项',
        created: '创建时间',
        root: '工作区',
        noRecords: '暂无回滚记录。',
        backupRoot: '回滚记录目录',
        recordAuto: '自动清理（未预扫）',
        autoClean: '当前会话切到完全权限时自动清理',
        on: '开',
        off: '关',
        confirmFix: '再次点击确认修复',
        confirmFixUnsafe: '仍要修复（会中断本会话写入）',
        confirmRollback: '再次点击确认回滚',
        removeAcesWarning: '会删除非继承的沙箱权限项和 Everyone 删除拒绝项，削弱仍在使用的沙箱；只在确实要把目录交还时才勾选。',
        authRequired: '登录状态已失效，请重新登录后再试。',
        forbidden: '请求来源不可信：请在应用自己的页面里操作。',
        requestFailed: '请求失败，请刷新页面后重试。',
        needsPath: '请先填写工作区路径。',
        notWindows: '此面板只在 Windows 可用。',
        onlyLow: 'Low',
        onlySid: '沙箱',
        onlyDeny: 'Everyone 删除拒绝',
        fixHint: '已写入回滚记录，可用「回滚记录」恢复。',
      },
      en: {
        nav: 'Integrity',
        title: 'Workspace integrity',
        subtitle: "Repairs the Low integrity label that the Windows sandbox leaves on a workspace after a workspace-write session. Scan and verify are read-only.",
        modeFullAccess: 'This session is on full access; repairing is safe.',
        modeWorkspaceWrite: 'This session is workspace-write: repairing would take away its workspace write access, and DSH does not restore it automatically. Switching to full access cleans the workspace automatically, so a manual repair is usually unnecessary; scan and verify work at any time.',
        modeUnknown: "This session's sandbox mode is unknown; make sure it is not workspace-write before repairing.",
        sessionWorkspace: "This session's workspace",
        lastClean: 'Last cleanup',
        triggerAuto: 'automatic',
        triggerManual: 'manual',
        triggerTool: 'tool',
        changeDir: 'Use another directory',
        useSessionDir: "Back to this session's directory",
        noSessionPath: "This session's workspace path is unavailable; enter the directory to scan.",
        workspace: 'Workspace',
        chooseWorkspace: 'Choose a workspace…',
        workspacePath: 'Workspace path',
        pathPlaceholder: 'E:\\path\\to\\workspace',
        scan: 'Scan',
        fix: 'Repair',
        verify: 'Verify',
        records: 'Rollback records',
        rollback: 'Roll back',
        close: 'Close',
        removeAces: 'Also remove leftover sandbox entries',
        allFiles: 'Scan every file',
        loading: 'Loading…',
        scanning: 'Scanning…',
        fixing: 'Repairing…',
        verifying: 'Verifying…',
        rollingBack: 'Rolling back…',
        reading: 'Reading records…',
        statusIdle: 'Not scanned',
        statusLastClean: 'Last cleanup',
        statusAutoCleaned: 'Last automatic cleanup',
        statusClean: 'No Low objects',
        statusLow: '{count} Low objects',
        statusFixed: 'Restored to Medium',
        statusWhatIf: 'What-if (no changes)',
        statusSkipped: 'No change',
        statusRolledBack: 'Rolled back: labels are Low again',
        statusFailed: 'Repair incomplete',
        lowObjects: 'Low objects',
        sidObjects: 'Sandbox entries',
        unreadable: 'Unreadable',
        daclUnreadable: 'Unreadable DACLs',
        removedAces: 'ACEs removed',
        acesSkipped: 'ACEs skipped',
        rootOnly: 'Root only',
        objectsRestored: 'Object DACLs restored',
        remainingLow: 'Remaining Low',
        truncated: 'Results truncated',
        elapsed: 'Elapsed',
        hits: 'Matching objects',
        plan: 'Plan',
        noHits: 'No Low labels or leftover sandbox entries were found.',
        backup: 'Rollback directory',
        failed: 'Failures',
        created: 'Created',
        root: 'Workspace',
        noRecords: 'No rollback records yet.',
        backupRoot: 'Rollback records',
        recordAuto: 'Auto-cleaned (not pre-scanned)',
        autoClean: 'Clean automatically when the session switches to full access',
        on: 'on',
        off: 'off',
        confirmFix: 'Click again to confirm the repair',
        confirmFixUnsafe: "Repair anyway (breaks this session's writes)",
        confirmRollback: 'Click again to confirm the rollback',
        removeAcesWarning: 'Deletes non-inherited sandbox entries and the Everyone delete deny, weakening a live sandbox; use it only when handing the directory back.',
        authRequired: 'Your sign-in expired. Sign in again and retry.',
        forbidden: "The request origin is not trusted. Use this app's own page.",
        requestFailed: 'The request failed. Refresh the page and retry.',
        needsPath: 'Enter a workspace path first.',
        notWindows: 'This panel only works on Windows.',
        onlyLow: 'Low',
        onlySid: 'Sandbox',
        onlyDeny: 'Everyone delete deny',
        fixHint: 'A rollback record was written; use Rollback records to undo it.',
      },
    }

    // Matches the page's own detail sections: .detailSection (column, 12px gap),
    // .sectionHead (baseline row), .sectionTitle (14px/500), .sectionCount (12px
    // secondary). Only the 14 listed --dsw-alias-* tokens are referenced.
    const CSS_TEXT = `
.dshwi-view { width: 100%; box-sizing: border-box; padding: 20px clamp(16px, 3vw, 40px) calc(var(--dsh-composer-height, 152px) + 24px); }
.dshwi-inner { display: flex; flex-direction: column; gap: 12px; width: 100%; max-width: 920px; margin: 0 auto; min-width: 0; }
.dshwi-workspace { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.dshwi-link { padding: 0; border: 0; background: none; font: inherit; font-size: 12px; line-height: 18px; color: var(--dsw-alias-brand-primary); cursor: pointer; }
.dshwi-link:hover { text-decoration: underline; }
.dshwi-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.dshwi-title { margin: 0; font-size: 14px; line-height: 20px; font-weight: 500; }
.dshwi-sub { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dshwi-caution { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-warn-primary); }
.dshwi-pill { padding: 0 8px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); font-size: 11.5px; line-height: 18px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.dshwi-pill.ok { color: var(--dsw-alias-state-success-primary); }
.dshwi-pill.warn { color: var(--dsw-alias-state-warn-primary); }
.dshwi-pill.bad { color: var(--dsw-alias-state-error-primary); }
.dshwi-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dshwi-row.options { gap: 16px; }
.dshwi-grow { flex: 1 1 220px; min-width: 0; }
.dshwi-input, .dshwi-select { font: inherit; font-size: 13px; line-height: 20px; padding: 4px 9px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
.dshwi-select { flex: 0 1 220px; min-width: 0; }
.dshwi-input:focus-visible, .dshwi-select:focus-visible, .dshwi-btn:focus-visible, .dshwi-check:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dshwi-btn { font: inherit; font-size: 13px; line-height: 20px; padding: 4px 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); cursor: pointer; }
.dshwi-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.dshwi-btn:disabled { opacity: .55; cursor: default; }
.dshwi-btn.primary { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); font-weight: 500; }
.dshwi-btn.small { padding: 1px 9px; font-size: 12px; line-height: 18px; }
.dshwi-btn.danger { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.dshwi-btn.danger.armed { background: var(--dsw-alias-bg-layer-2); font-weight: 500; }
.dshwi-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.dshwi-check input { margin: 0; accent-color: var(--dsw-alias-brand-primary); }
.dshwi-error { margin: 0; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-state-error-primary); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; }
.dshwi-result { display: flex; flex-direction: column; gap: 10px; padding: 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); }
.dshwi-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.dshwi-chip { display: inline-flex; align-items: baseline; gap: 6px; padding: 1px 9px; border-radius: 999px; background: var(--dsw-alias-bg-base); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dshwi-chip b { font-weight: 600; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.dshwi-chip.ok b { color: var(--dsw-alias-state-success-primary); }
.dshwi-chip.warn b { color: var(--dsw-alias-state-warn-primary); }
.dshwi-chip.bad b { color: var(--dsw-alias-state-error-primary); }
.dshwi-label { font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.dshwi-list { display: flex; flex-direction: column; gap: 4px; max-height: 220px; overflow: auto; margin: 0; padding: 0; list-style: none; }
.dshwi-item { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 4px 8px; border-radius: 6px; background: var(--dsw-alias-bg-base); }
.dshwi-mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11.5px; line-height: 16px; color: var(--dsw-alias-label-secondary); word-break: break-all; }
.dshwi-tags { display: inline-flex; gap: 6px; flex: none; }
.dshwi-tag { padding: 0 6px; border-radius: 5px; font-size: 11px; line-height: 17px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); }
.dshwi-tag.bad { color: var(--dsw-alias-state-error-primary); }
.dshwi-tag.warn { color: var(--dsw-alias-state-warn-primary); }
.dshwi-note { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dshwi-empty { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dshwi-records { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
`

    function interpolate(text, params) {
      if (!params) return text
      return String(text).replace(/\{(\w+)\}/g, function (match, key) {
        const value = params[key]
        return value === undefined || value === null ? match : String(value)
      })
    }

    function makeTranslator(bound) {
      return function translate(key, params) {
        let value
        if (typeof bound === 'function') {
          try {
            value = bound(key)
          } catch {
            value = undefined
          }
        }
        if (typeof value !== 'string' || value === key || value === '') {
          value = baseDict[key] === undefined ? key : baseDict[key]
        }
        return interpolate(value, params)
      }
    }

    // The panel defaults to Chinese regardless of the Host or browser language:
    // `DICT.zh` is the translator's base dictionary, and the locale service is
    // only used for registration and the Plugins-page metadata, never to switch
    // the panel copy. `DICT.en` stays for that metadata and future switching.
    const baseDict = DICT.zh

    function requestJson(path, init) {
      const options = { credentials: 'same-origin', cache: 'no-store' }
      if (init) {
        for (const key in init) {
          if (Object.prototype.hasOwnProperty.call(init, key)) options[key] = init[key]
        }
      }
      if (options.body !== undefined) {
        options.headers = { 'content-type': 'application/json' }
      }
      return fetch(API + path, options).then(function (response) {
        return response.text().then(function (text) {
          let payload = null
          if (text) {
            try {
              payload = JSON.parse(text)
            } catch {
              payload = null
            }
          }
          // Status codes win over the Host's English body so the panel keeps
          // one language; only operation failures pass the Host text through.
          if (response.status === 401) return { ok: false, error: 'AUTH', status: 401 }
          if (response.status === 403) return { ok: false, error: 'FORBIDDEN', status: 403 }
          if (payload && payload.ok === true) return { ok: true, data: payload.data, status: response.status }
          const message = payload && typeof payload.error === 'string' && payload.error
            ? payload.error
            : 'REQUEST'
          return { ok: false, error: message, status: response.status }
        }, function () {
          return { ok: false, error: 'REQUEST', status: response.status }
        })
      }, function () {
        return { ok: false, error: 'REQUEST', status: 0 }
      })
    }

    function errorText(t, code) {
      if (code === 'AUTH') return t('authRequired')
      if (code === 'FORBIDDEN') return t('forbidden')
      if (!code || code === 'REQUEST') return t('requestFailed')
      return code
    }

    function pickInitialPath(state) {
      if (!state) return ''
      if (typeof state.sessionPath === 'string' && state.sessionPath) return state.sessionPath
      const workspaces = Array.isArray(state.workspaces) ? state.workspaces : []
      if (workspaces.length > 0 && workspaces[0].path) return workspaces[0].path
      return typeof state.defaultDirectory === 'string' ? state.defaultDirectory : ''
    }

    function triggerLabelKey(trigger) {
      if (trigger === 'auto') return 'triggerAuto'
      if (trigger === 'tool') return 'triggerTool'
      return 'triggerManual'
    }

    function statusOf(result, t, lastClean) {
      if (!result) {
        // Nothing done in this mount: report the last recorded cleanup instead
        // of "not scanned", which reads as "nothing ever ran here".
        if (lastClean) {
          return {
            text: lastClean.trigger === 'auto' ? t('statusAutoCleaned') : t('statusLastClean'),
            tone: '',
          }
        }
        return { text: t('statusIdle'), tone: '' }
      }
      const data = result.data || {}
      const failures = Array.isArray(data.failed) ? data.failed.length : 0

      if (result.kind === 'fix') {
        if (data.whatIf === true) return { text: t('statusWhatIf'), tone: '' }
        // `ok: false` or a `note` means the engine changed nothing; never show
        // that as a green success.
        if (data.ok === false || failures > 0) return { text: t('statusFailed'), tone: 'bad' }
        if (data.note) return { text: t('statusSkipped'), tone: '' }
        return { text: t('statusFixed'), tone: 'ok' }
      }
      if (result.kind === 'rollback') {
        // A rollback turns the labels back into Low: that is a warn state, not a
        // clean one.
        if (failures > 0) return { text: t('statusFailed'), tone: 'bad' }
        return { text: t('statusRolledBack'), tone: 'warn' }
      }
      const low = typeof data.low === 'number' ? data.low : 0
      return low > 0
        ? { text: t('statusLow', { count: low }), tone: 'warn' }
        : { text: t('statusClean'), tone: 'ok' }
    }

    function chip(tone, label, value) {
      return h('span', { className: 'dshwi-chip' + (tone ? ' ' + tone : '') },
        label ? h('span', null, label) : null,
        h('b', null, value))
    }

    function tag(tone, text) {
      return h('span', { className: 'dshwi-tag' + (tone ? ' ' + tone : '') }, text)
    }

    function formatTime(value) {
      if (typeof value !== 'string' || !value) return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return value
      try {
        return date.toLocaleString()
      } catch {
        return value
      }
    }

    function Hits(props) {
      const { hits, t } = props
      const all = Array.isArray(hits) ? hits : []
      const shown = all.slice(0, 60)
      if (shown.length === 0) return h('p', { className: 'dshwi-empty' }, t('noHits'))
      const count = all.length > shown.length ? shown.length + '/' + all.length : String(all.length)
      return h('div', { className: 'dshwi-records' },
        h('span', { className: 'dshwi-label' }, t('hits') + ' · ' + count),
        h('ul', { className: 'dshwi-list' }, shown.map(function (hit, index) {
          const entry = hit || {}
          return h('li', { className: 'dshwi-item', key: (entry.path || '') + index },
            h('span', { className: 'dshwi-mono' }, String(entry.path || '')),
            h('span', { className: 'dshwi-tags' },
              entry.low ? tag('warn', t('onlyLow')) : null,
              entry.sandboxSid ? tag(null, t('onlySid')) : null,
              entry.everyoneDeny ? tag('bad', t('onlyDeny')) : null))
        })),
        all.length > shown.length
          ? h('p', { className: 'dshwi-note' }, t('truncated'))
          : null)
    }

    function ResultPanel(props) {
      const { result, t } = props
      const data = result.data || {}
      const chips = []
      if (typeof data.low === 'number') chips.push(chip(data.low > 0 ? 'warn' : 'ok', t('lowObjects'), data.low))
      if (typeof data.sandboxSid === 'number') chips.push(chip(data.sandboxSid > 0 ? 'warn' : '', t('sidObjects'), data.sandboxSid))
      if (typeof data.unreadable === 'number') chips.push(chip(data.unreadable > 0 ? 'bad' : '', t('unreadable'), data.unreadable))
      if (typeof data.daclUnreadable === 'number' && data.daclUnreadable > 0) {
        chips.push(chip('bad', t('daclUnreadable'), data.daclUnreadable))
      }
      if (typeof data.removedAces === 'number') chips.push(chip('', t('removedAces'), data.removedAces))
      if (data.acesSkipped === true) chips.push(chip('warn', '', t('acesSkipped')))
      if (data.rootOnly === true) chips.push(chip('', '', t('rootOnly')))
      if (typeof data.objectsRestored === 'number') {
        chips.push(chip('', t('objectsRestored'), data.objectsRestored))
      }
      if (typeof data.remainingLow === 'number') {
        chips.push(chip(data.remainingLow > 0 ? 'warn' : 'ok', t('remainingLow'), data.remainingLow))
      }
      if (data.truncated === true) chips.push(chip('warn', '', t('truncated')))
      if (typeof data.elapsedMs === 'number') chips.push(chip('', t('elapsed'), Math.round(data.elapsedMs) + ' ms'))

      const failed = Array.isArray(data.failed) ? data.failed : []
      const failedShown = failed.slice(0, 20)
      const scanLike = result.kind === 'scan' || result.kind === 'verify'
      return h('div', { className: 'dshwi-result', role: 'status' },
        chips.length > 0 ? h('div', { className: 'dshwi-chips' }, chips) : null,
        data.path ? h('span', { className: 'dshwi-mono' }, String(data.path)) : null,
        data.backupDir
          ? h('span', { className: 'dshwi-note' },
            t('backup') + ' · ',
            h('span', { className: 'dshwi-mono' }, String(data.backupDir)),
            result.kind === 'fix' ? ' · ' + t('fixHint') : '')
          : null,
        data.warning ? h('p', { className: 'dshwi-caution' }, String(data.warning)) : null,
        data.note ? h('p', { className: 'dshwi-note' }, String(data.note)) : null,
        Array.isArray(data.plan) && data.plan.length > 0
          ? h('div', { className: 'dshwi-records' },
            h('span', { className: 'dshwi-label' }, t('plan')),
            h('ul', { className: 'dshwi-list' }, data.plan.map(function (line, index) {
              return h('li', { className: 'dshwi-item', key: index },
                h('span', { className: 'dshwi-mono' }, String(line)))
            })))
          : null,
        failed.length > 0
          ? h('div', { className: 'dshwi-records' },
            h('span', { className: 'dshwi-label' }, t('failed') + ' · ' + failed.length),
            h('ul', { className: 'dshwi-list' }, failedShown.map(function (item, index) {
              return h('li', { className: 'dshwi-item', key: index },
                h('span', { className: 'dshwi-mono' }, String(item && item.path || '')),
                h('span', { className: 'dshwi-mono' }, String(item && item.message || '')))
            })),
            failed.length > failedShown.length
              ? h('p', { className: 'dshwi-note' }, t('truncated'))
              : null)
          : null,
        scanLike && Array.isArray(data.hits) ? h(Hits, { hits: data.hits, t }) : null)
    }

    function createView(t, locale) {
      return function WorkspaceIntegrityView(props) {
        return h(Panel, { t, locale, sessionId: props ? props.sessionId : undefined })
      }
    }

    function Panel(props) {
      const { t, locale, sessionId } = props
      const [state, setState] = useState(null)
      const [path, setPath] = useState('')
      const [editingPath, setEditingPath] = useState(false)
      const [sandboxMode, setSandboxMode] = useState('')
      const [lastClean, setLastClean] = useState(null)
      const [phase, setPhase] = useState('loading')
      const [result, setResult] = useState(null)
      const [error, setError] = useState(null)
      const [records, setRecords] = useState(null)
      const [removeAces, setRemoveAces] = useState(false)
      const [allFiles, setAllFiles] = useState(false)
      const [pending, setPending] = useState('')
      const [, setLocaleTick] = useState(0)

      const ticketRef = useRef(0)
      const mountedRef = useRef(true)
      const busyRef = useRef(false)
      const pendingTimerRef = useRef(null)
      const titleRef = useRef('')
      if (!titleRef.current) titleRef.current = 'dshwi-title-' + (++titleSeed)

      useEffect(function () {
        mountedRef.current = true
        return function () {
          mountedRef.current = false
          if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current)
        }
      }, [])

      // Re-render on a locale change while the section stays mounted.
      useEffect(function () {
        if (!locale || typeof locale.subscribe !== 'function') return undefined
        return locale.subscribe(function () {
          if (mountedRef.current) setLocaleTick(function (value) { return value + 1 })
        })
      }, [locale])

      useEffect(function () {
        let cancelled = false
        setPhase('loading')
        setError(null)
        const query = sessionId ? '?sessionId=' + encodeURIComponent(String(sessionId)) : ''
        requestJson('/state' + query).then(function (response) {
          if (cancelled || !mountedRef.current) return
          if (!response.ok) {
            setPhase(null)
            setError(errorText(t, response.error))
            return
          }
          const data = response.data || {}
          setState(data)
          setPath(pickInitialPath(data))
          // The session's own workspace is the default: the panel opens on it,
          // so a scan is one click and no directory has to be chosen.
          setEditingPath(!(typeof data.sessionPath === 'string' && data.sessionPath))
          setSandboxMode(typeof data.sandboxMode === 'string' ? data.sandboxMode : '')
          setLastClean(data.lastClean && typeof data.lastClean === 'object' ? data.lastClean : null)
          setRemoveAces(!!(data.config && data.config.removeAces))
          setAllFiles(!!(data.config && data.config.scanAllFiles))
          setPhase(null)
        }, function () {
          if (cancelled || !mountedRef.current) return
          setPhase(null)
          setError(t('requestFailed'))
        })
        return function () {
          cancelled = true
        }
        // Re-read when the shell switches this View to another Session.
      }, [sessionId])

      const windows = !state || state.windows !== false
      const busy = phase !== null && phase !== 'loading'

      // A destructive action needs a second click within four seconds: the first
      // click only arms it, so a stray click cannot rewrite ACLs.
      function arm(key) {
        setPending(key)
        if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current)
        pendingTimerRef.current = setTimeout(function () {
          if (mountedRef.current) setPending('')
        }, 4000)
      }

      function disarm() {
        if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current)
        pendingTimerRef.current = null
        setPending('')
      }

      async function submit(kind, endpoint, payload) {
        if (busyRef.current) return
        if (endpoint !== '/rollback' && !path.trim()) {
          setError(t('needsPath'))
          return
        }
        busyRef.current = true
        disarm()
        const ticket = ++ticketRef.current
        setPhase(kind)
        setError(null)
        try {
          const response = await requestJson(endpoint, {
            method: 'POST',
            body: JSON.stringify(payload),
          })
          if (!mountedRef.current || ticket !== ticketRef.current) return
          if (!response.ok) {
            setError(errorText(t, response.error))
            return
          }
          setResult({ kind, data: response.data || {} })
          if (kind === 'rollback') setRecords(null)
          // A repair writes a new record: refresh the "last cleanup" line and the
          // badge baseline from the Host instead of trusting stale state.
          if (kind === 'fix') void refreshMode()
        } catch {
          if (mountedRef.current && ticket === ticketRef.current) setError(t('requestFailed'))
        } finally {
          busyRef.current = false
          if (mountedRef.current && ticket === ticketRef.current) setPhase(null)
        }
      }

      async function loadRecords() {
        if (busyRef.current) return
        busyRef.current = true
        disarm()
        const ticket = ++ticketRef.current
        setPhase('records')
        setError(null)
        try {
          const response = await requestJson('/records')
          if (!mountedRef.current || ticket !== ticketRef.current) return
          if (!response.ok) {
            setError(errorText(t, response.error))
            return
          }
          const data = response.data || {}
          setRecords(Array.isArray(data.records) ? data.records : [])
        } catch {
          if (mountedRef.current && ticket === ticketRef.current) setError(t('requestFailed'))
        } finally {
          busyRef.current = false
          if (mountedRef.current && ticket === ticketRef.current) setPhase(null)
        }
      }

      // Re-read the Session's sandbox mode right before a repair: the panel may
      // have stayed open while the mode changed, and repairing under
      // workspace-write takes this Session's write access away.
      async function refreshMode() {
        const query = sessionId ? '?sessionId=' + encodeURIComponent(String(sessionId)) : ''
        const response = await requestJson('/state' + query)
        if (!mountedRef.current || !response.ok) return sandboxMode
        const data = response.data || {}
        setState(data)
        setLastClean(data.lastClean && typeof data.lastClean === 'object' ? data.lastClean : null)
        const mode = typeof data.sandboxMode === 'string' ? data.sandboxMode : ''
        setSandboxMode(mode)
        return mode
      }

      async function confirmFix() {
        if (busyRef.current) return
        const mode = await refreshMode()
        if (!mountedRef.current) return
        if (mode === 'workspace-write') {
          // Still confined: ask once more, with the consequence spelled out.
          arm('fix-unsafe')
          return
        }
        void submit('fix', '/fix', { path: path.trim(), removeAces, allFiles, sessionId })
      }

      const status = statusOf(result, t, lastClean)
      const workspaces = state && Array.isArray(state.workspaces) ? state.workspaces : []
      const trimmed = path.trim().toLowerCase()
      const matched = workspaces.filter(function (workspace) {
        return String(workspace.path || '').toLowerCase() === trimmed
      })[0]
      const busyLabel = phase === 'scan' ? t('scanning')
        : phase === 'fix' ? t('fixing')
          : phase === 'verify' ? t('verifying')
            : phase === 'rollback' ? t('rollingBack')
              : phase === 'records' ? t('reading')
                : phase === 'loading' ? t('loading') : ''

      const sessionPath = state && typeof state.sessionPath === 'string' ? state.sessionPath : ''
      const pathControl = editingPath
        ? sessionPath
          ? h('button', {
            type: 'button',
            className: 'dshwi-link',
            onClick: function () { setPath(sessionPath); setEditingPath(false) },
          }, t('useSessionDir'))
          : null
        : h('button', {
          type: 'button',
          className: 'dshwi-link',
          disabled: busy,
          onClick: function () { setEditingPath(true) },
        }, t('changeDir'))

      return h('section', { className: 'dshwi-view', 'aria-labelledby': titleRef.current },
        h('style', null, CSS_TEXT),
        h('div', { className: 'dshwi-inner' },
          h('div', { className: 'dshwi-head' },
            h('h2', { className: 'dshwi-title', id: titleRef.current }, t('title')),
            h('span', { className: 'dshwi-pill' + (status.tone ? ' ' + status.tone : '') }, status.text)),

          h('p', { className: 'dshwi-sub' }, t('subtitle')),

          windows ? null : h('p', { className: 'dshwi-caution' }, t('notWindows')),
          phase === 'loading'
            ? null
            : sandboxMode === 'workspace-write'
              ? h('p', { className: 'dshwi-caution' }, t('modeWorkspaceWrite'))
              : sandboxMode === 'danger-full-access'
                ? h('p', { className: 'dshwi-note' }, t('modeFullAccess'))
                : h('p', { className: 'dshwi-caution' }, t('modeUnknown')),

          h('div', { className: 'dshwi-workspace' },
            h('div', { className: 'dshwi-row' },
              h('span', { className: 'dshwi-label' }, t('sessionWorkspace')),
              editingPath || !path
                ? null
                : h('span', { className: 'dshwi-mono' }, path),
              pathControl),
            editingPath
              ? h('div', { className: 'dshwi-row' },
                workspaces.length > 0
                  ? h('select', {
                    className: 'dshwi-select',
                    'aria-label': t('workspace'),
                    value: matched ? matched.id : '',
                    disabled: busy,
                    onChange: function (event) {
                      const picked = workspaces.filter(function (workspace) {
                        return workspace.id === event.target.value
                      })[0]
                      if (picked) setPath(picked.path)
                    },
                  },
                  h('option', { value: '', disabled: true }, t('chooseWorkspace')),
                  workspaces.map(function (workspace) {
                    return h('option', { key: workspace.id || workspace.path, value: workspace.id },
                      workspace.title && workspace.title !== workspace.path
                        ? workspace.title + ' — ' + workspace.path
                        : workspace.path)
                  }))
                  : null,
                h('input', {
                  className: 'dshwi-input dshwi-grow',
                  type: 'text',
                  value: path,
                  spellCheck: false,
                  disabled: busy,
                  placeholder: t('pathPlaceholder'),
                  'aria-label': t('workspacePath'),
                  onChange: function (event) { setPath(event.target.value) },
                }))
              : null,
            lastClean && !editingPath
              ? h('p', { className: 'dshwi-note' },
                t('lastClean') + ' · ' + formatTime(lastClean.createdAt) + ' · ' + t(triggerLabelKey(lastClean.trigger)))
              : null,
            !editingPath || sessionPath || phase === 'loading'
              ? null
              : h('p', { className: 'dshwi-note' }, t('noSessionPath'))),

        h('div', { className: 'dshwi-row' },
          h('button', {
            type: 'button',
            className: 'dshwi-btn primary',
            disabled: busy || !windows || phase === 'loading' || !path.trim(),
            onClick: function () { submit('scan', '/scan', { path: path.trim(), allFiles }) },
          }, phase === 'scan' ? t('scanning') : t('scan')),
          h('button', {
            type: 'button',
            className: 'dshwi-btn' + (pending === 'fix' || pending === 'fix-unsafe' ? ' danger' : ''),
            disabled: busy || !windows || phase === 'loading' || !path.trim(),
            onClick: function () {
              if (pending === 'fix-unsafe') submit('fix', '/fix', { path: path.trim(), removeAces, allFiles, sessionId, force: true })
              else if (pending === 'fix') void confirmFix()
              else arm('fix')
            },
          }, phase === 'fix'
            ? t('fixing')
            : pending === 'fix-unsafe'
              ? t('confirmFixUnsafe')
              : pending === 'fix'
                ? t('confirmFix')
                : t('fix')),
          h('button', {
            type: 'button',
            className: 'dshwi-btn',
            disabled: busy || !windows || phase === 'loading' || !path.trim(),
            onClick: function () { submit('verify', '/verify', { path: path.trim(), allFiles }) },
          }, phase === 'verify' ? t('verifying') : t('verify')),
          h('button', {
            type: 'button',
            className: 'dshwi-btn',
            disabled: busy || !windows || phase === 'loading',
            onClick: loadRecords,
          }, phase === 'records' ? t('reading') : t('records')),
          busyLabel && phase !== 'scan' && phase !== 'fix' && phase !== 'verify' && phase !== 'records'
            ? h('span', { className: 'dshwi-note' }, busyLabel)
            : null),

        h('div', { className: 'dshwi-row options' },
          h('label', { className: 'dshwi-check' },
            h('input', {
              type: 'checkbox',
              checked: allFiles,
              onChange: function (event) { setAllFiles(event.target.checked) },
            }),
            t('allFiles')),
          h('label', { className: 'dshwi-check' },
            h('input', {
              type: 'checkbox',
              checked: removeAces,
              onChange: function (event) { setRemoveAces(event.target.checked) },
            }),
            t('removeAces'))),

        removeAces ? h('p', { className: 'dshwi-caution' }, t('removeAcesWarning')) : null,

        state && state.backupRoot
          ? h('p', { className: 'dshwi-note' },
            t('backupRoot') + ' · ' + String(state.backupRoot),
            ' · ',
            t('autoClean') + ' · ' + (state.config && state.config.autoClean ? t('on') : t('off')))
          : null,

        error ? h('p', { className: 'dshwi-error', role: 'alert' }, error) : null,
        result ? h(ResultPanel, { result, t }) : null,
        records ? h('div', { className: 'dshwi-records' },
          h('span', { className: 'dshwi-label' }, t('records')),
          records.length === 0
            ? h('p', { className: 'dshwi-empty' }, t('noRecords'))
            : h('ul', { className: 'dshwi-list' }, records.map(function (record, index) {
              const dir = String(record.dir || '')
              const key = dir + index
              const armed = pending === 'rollback:' + dir
              // Automatic records carry no pre-scan, so they report `low: null`
              // instead of a misleading 0 and say so in words.
              const unscanned = record.fast === true && (record.low === null || record.low === undefined)
              return h('li', { className: 'dshwi-item', key },
                h('span', { className: 'dshwi-mono' },
                  formatTime(record.createdAt) + ' · ' + String(record.root || ''),
                  unscanned
                    ? ' · ' + t('recordAuto')
                    : typeof record.low === 'number' && record.low > 0
                      ? ' · Low=' + record.low
                      : '',
                  typeof record.removedAces === 'number' && record.removedAces > 0
                    ? ' · ACEs=' + record.removedAces
                    : ''),
                h('button', {
                  type: 'button',
                  className: 'dshwi-btn small danger' + (armed ? ' armed' : ''),
                  disabled: busy,
                  onClick: function () {
                    if (armed) submit('rollback', '/rollback', { backupDir: dir })
                    else arm('rollback:' + dir)
                  },
                }, armed ? t('confirmRollback') : t('rollback')))
            })))
          : null))
    }

    function apply(ctx) {
      // Chinese is the panel's default and only copy source: no locale.bind here,
      // so a Host or browser set to English cannot turn the panel English. The
      // dictionaries are still registered for the Plugins-page metadata.
      const translate = makeTranslator(null)
      let locale = null
      try {
        locale = ctx.locale || (typeof ctx.get === 'function' ? ctx.get('locale') : null)
      } catch {
        locale = null
      }
      if (locale && typeof locale.register === 'function') {
        const register = function () {
          return locale.register(NS, { zh: DICT.zh, en: DICT.en })
        }
        try {
          if (typeof ctx.effect === 'function') ctx.effect(register, 'workspace-integrity: dictionaries')
          else register()
        } catch (error) {
          console.warn('[@xia-sc/dsh-workspace-integrity] locale registration skipped', error)
        }
      }

      const View = createView(translate, locale)
      const slots = ctx.slots
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return
      slots.inject(SLOT, function () {
        return slots.register({
          name: SLOT,
          id: 'workspace-integrity',
          order: 40,
          label: function () { return translate('nav') },
        }, View)
      })
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
