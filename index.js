import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync,
  unlinkSync, writeFileSync, writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerRoutes } from './routes.js'

export const name = '@xia-sc/dsh-workspace-integrity'

/** The tool surface is the only service this plugin needs; routes are optional. */
export const inject = ['tools']

const IS_WIN = process.platform === 'win32'
const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'scripts', 'Repair.ps1')
const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
/** 插件自己的数据目录：日志、冷却状态与配置都收在这里，不再散落在 DSH 主目录根部。 */
const DATA_DIR = join(HOME, 'dsh-workspace-integrity')
const LOG_FILE = join(DATA_DIR, 'workspace-integrity.log')
const BACKUP_ROOT = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'dsh-workspace-integrity')
const COOLDOWN_MS = 60_000
const lastRun = new Map()
/** Cleanup cooldowns survive a remount, so a hot reload cannot re-clean at once. */
const STATE_FILE = join(DATA_DIR, 'workspace-integrity.state.json')
/** 用户可直接编辑的插件配置；缺失时自动生成一份默认值。 */
const CONFIG_FILE = join(DATA_DIR, 'config.json')
const DEFAULT_CONFIG = {
  autoClean: true,
  removeAces: false,
  scanAllFiles: false,
  excludeDirs: ['.git', '.hg', '.svn'],
}
/** Who asked for a repair; recorded in the rollback record so it stays honest. */
const TRIGGERS = ['auto', 'manual', 'tool']

function restoreCooldowns() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    const roots = parsed?.roots
    if (!roots || typeof roots !== 'object') return
    const now = Date.now()
    for (const [root, at] of Object.entries(roots)) {
      if (typeof root === 'string' && typeof at === 'number' && now - at < COOLDOWN_MS) lastRun.set(root, at)
    }
  } catch { /* first mount: no state file yet */ }
}

function persistCooldowns() {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    const now = Date.now()
    const roots = {}
    for (const [root, at] of lastRun) {
      if (now - at < COOLDOWN_MS) roots[root] = at
    }
    writeFileSync(STATE_FILE, JSON.stringify({ roots }, null, 2))
  } catch { /* persistence must never break cleanup */ }
}

/**
 * 读取数据目录里的 config.json。文件缺失或损坏时退回空对象，
 * 由 apply() 用内置默认值与 profile 配置兜底；损坏原因只记日志，不阻断挂载。
 * @returns {Record<string, unknown>} 文件中的配置，或空对象。
 */
function readFileConfig() {
  let text
  try {
    text = readFileSync(CONFIG_FILE, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') log(`config.json unreadable (${error?.message || error}); using defaults`)
    return {}
  }
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    log('config.json is not valid JSON; using defaults')
    return {}
  }
}

/** 首次运行时写出一份 config.json，让用户知道配置放在哪里；种子可带入已有的 profile 配置。 */
function ensureConfigFile(seed = DEFAULT_CONFIG) {
  if (existsSync(CONFIG_FILE)) return
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(CONFIG_FILE, `${JSON.stringify(seed, null, 2)}\n`)
  } catch { /* 只读的 DSH_HOME 也不能拦住挂载 */ }
}

restoreCooldowns()

function log(message) {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`)
  } catch {
    /* logging must never break the host */
  }
}

function powershellPath() {
  const root = process.env.SystemRoot || process.env.windir
  if (root) {
    const candidate = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (existsSync(candidate)) return candidate
  }
  return 'powershell.exe'
}

/**
 * Run the ACL engine and resolve its parsed JSON. The script writes progress
 * to stderr and only the JSON document to stdout.
 * @param {string[]} args - script arguments, already validated by the caller.
 * @returns {Promise<{ ok: boolean, result?: unknown, error?: string, stderr?: string }>}
 */
function runScript(args) {
  return new Promise((resolvePromise) => {
    execFile(
      powershellPath(),
      ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args],
      { windowsHide: true, timeout: 300_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          resolvePromise({
            ok: false,
            error: error.killed ? 'The repair timed out after 300 seconds.' : error.message,
            stderr: (stderr || '').slice(-4000),
          })
          return
        }
        const text = (stdout || '').trim()
        if (!text) {
          resolvePromise({ ok: false, error: 'The ACL engine produced no output.', stderr: (stderr || '').slice(-4000) })
          return
        }
        try {
          resolvePromise({ ok: true, result: JSON.parse(text), stderr: (stderr || '').slice(-4000) })
        } catch {
          resolvePromise({ ok: false, error: `Could not parse the ACL engine output: ${text.slice(0, 800)}` })
        }
      },
    )
  })
}

/** A caller mistake; the panel reports it as an input error, not a Host failure. */
function userError(message) {
  const error = new Error(message)
  error.status = 400
  return error
}

/**
 * One repair per workspace at a time, in this process and across processes.
 * The automatic path and the panel rewrite the same tree, and `Set-LabelTree`
 * temporarily grants FullControl before restoring the saved DACL — two
 * interleaved runs can leave that temporary grant behind, and each writes its
 * own rollback record.
 */
const inFlight = new Map()
const LOCK_DIR = join(BACKUP_ROOT, 'locks')
/** Longer than the engine's own 300 s timeout, so a live run is never stolen. */
const LOCK_STALE_MS = 10 * 60_000

function lockFileFor(root) {
  const digest = createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 16)
  return join(LOCK_DIR, `${digest}.lock`)
}

/**
 * Cross-process guard: the in-process Map cannot see another DSH process
 * repairing the same workspace. An exclusive-create lock file is the portable
 * primitive here; a lock older than the engine timeout is treated as stale so
 * a crashed run cannot block repairs forever.
 * @param root - the workspace the lock is keyed by.
 * @returns a release function, or null when another process holds the lock.
 */
function acquireFileLock(root) {
  try {
    mkdirSync(LOCK_DIR, { recursive: true })
  } catch {
    return null
  }
  const file = lockFileFor(root)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(file, 'wx')
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, time: Date.now(), root }))
      } finally {
        closeSync(fd)
      }
      return () => {
        try { unlinkSync(file) } catch { /* already released */ }
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') return null
      try {
        if (Date.now() - statSync(file).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(file)
          continue
        }
      } catch {
        continue
      }
      return null
    }
  }
  return null
}

/**
 * Run one repair under the workspace lock.
 * @param root - the workspace to lock.
 * @param operation - the repair to run while holding it.
 * @param options.soft - called instead of throwing when the workspace is busy;
 *   optional; the automatic path now treats `operations.fix`'s 400 as skipped.
 */
async function withRootLock(root, operation, options = {}) {
  const busy = () => {
    if (typeof options.soft === 'function') return options.soft()
    throw userError(`A repair is already running for ${root}; wait for it to finish.`)
  }
  if (inFlight.has(root)) return busy()
  inFlight.set(root, true)
  let release = null
  try {
    release = acquireFileLock(root)
    if (release === null) return busy()
    return await operation()
  } finally {
    if (release !== null) release()
    inFlight.delete(root)
  }
}

function normalizeRoot(input) {
  if (typeof input !== 'string' || !input.trim()) throw userError('A workspace path is required.')
  const candidate = input.trim()
  if (!isAbsolute(candidate)) throw userError(`Only absolute paths are accepted: ${candidate}`)
  const root = resolve(candidate)
  if (!existsSync(root)) throw userError(`Path does not exist: ${root}`)
  if (!statSync(root).isDirectory()) throw userError(`Expected a directory: ${root}`)
  return root
}

/**
 * Refuse roots whose recursive repair would rewrite the machine: a drive root,
 * a protected system directory, or the profile root. The engine repeats this
 * check, so a direct script run cannot bypass it either.
 * @param root - the normalized workspace path a repair is about to touch.
 */
function assertSafeRoot(root) {
  const full = resolve(root)
  if (/^[a-zA-Z]:\\?$/.test(full)) throw userError(`Refusing a drive root: ${root}`)
  const protectedDirs = []
  for (const key of ['SystemRoot', 'ProgramFiles', 'ProgramData']) {
    const value = process.env[key]
    if (value) protectedDirs.push(value)
  }
  const x86 = process.env['ProgramFiles(x86)']
  if (x86) protectedDirs.push(x86)
  const lower = full.toLowerCase()
  for (const dir of protectedDirs) {
    const key = resolve(dir).toLowerCase()
    if (lower === key || lower.startsWith(key + '\\')) {
      throw userError(`Refusing a protected system directory: ${root}`)
    }
  }
  const profile = process.env.USERPROFILE
  if (profile && lower === resolve(profile).toLowerCase()) throw userError(`Refusing the user profile root: ${root}`)
  const drive = process.env.SystemDrive
  if (drive) {
    const usersRoot = resolve(join(drive + '\\', 'Users')).toLowerCase()
    if (lower === usersRoot) throw userError(`Refusing the Users root: ${root}`)
  }
}

/** A reparse-point root would repair whatever it targets, not the path shown. */
function assertNotReparse(root) {
  try {
    if (lstatSync(root).isSymbolicLink()) throw userError(`Refusing a reparse-point root: ${root}`)
  } catch (error) {
    if (error?.status === 400) throw error
  }
}

function wantsFlag(value, fallback) {
  if (value === true) return true
  if (value === false) return false
  return fallback === true
}

// 规范化目录排除清单：接受字符串或字符串数组，按逗号/分号拆分，去掉引号、
// 空白与结尾分隔符，转小写并去重；空值回退到调用方给出的默认清单。
function normalizeExcludes(value, fallback) {
  const source = value === undefined || value === null ? fallback : value
  const list = []
  const add = (item) => {
    if (typeof item !== 'string') return
    for (const part of item.split(/[,;]/)) {
      const trimmed = part.trim().replace(/^["']|["']$/g, '').replace(/[\\/]+$/, '')
      if (trimmed && !list.includes(trimmed)) list.push(trimmed)
    }
  }
  if (Array.isArray(source)) source.forEach(add)
  else add(String(source))
  return list
}

/** 把生效配置投影成写回 config.json 的四个字段。 */
function snapshotConfig(source) {
  return {
    autoClean: source.autoClean !== false,
    removeAces: source.removeAces === true,
    scanAllFiles: source.scanAllFiles === true,
    excludeDirs: Array.isArray(source.excludeDirs) ? source.excludeDirs : [],
  }
}

// 把排除清单追加为引擎参数；空清单不追加，保持不排除时的旧行为。
// 以逗号拼接成单个参数，避免 -File 传参把多个值解析成位置参数。
function appendExcludes(args, excludes) {
  if (!Array.isArray(excludes) || excludes.length === 0) return args
  args.push('-ExcludeDirs', excludes.join(','))
  return args
}

/** Resolve one Session by id through whichever Host service owns it. */
function resolveSession(ctx, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return undefined
  try {
    const live = ctx.get?.('agents')?.get?.(sessionId)?.session
    if (live) return live
    return ctx.get?.('sessions')?.get?.(sessionId)
  } catch {
    return undefined
  }
}

/** The effective sandbox mode of one Session, or '' when it cannot be read. */
function sessionMode(ctx, session) {
  if (!session) return ''
  try {
    return ctx.get?.('sandboxPolicy')?.resolve?.({ session })?.mode || ''
  } catch {
    return ''
  }
}

/**
 * The directory a Session currently works in. A `working_directory` change wins
 * over the launch directory, and the automatic path, the panel and the agent
 * tool must all agree on it: cleaning the launch directory while the Session
 * works somewhere else repairs the wrong tree.
 * @param ctx - the plugin context, used to reach the workingDirectory service.
 * @param session - the Session to resolve, or undefined.
 * @returns the workspace path, or '' when neither source has one.
 */
function sessionWorkspace(ctx, session) {
  if (!session) return ''
  try {
    const current = ctx.get?.('workingDirectory')?.get?.(session)
    if (typeof current === 'string' && current) return current
  } catch { /* optional service */ }
  const cwd = session.header?.cwd
  return typeof cwd === 'string' ? cwd : ''
}

/**
 * The newest rollback record for one workspace. The automatic path leaves no
 * other trace, so this is how the panel knows a cleanup already happened
 * instead of reporting "not scanned" after every full-access switch.
 * @param root - the workspace to look up.
 * @returns { createdAt, trigger, fast, low, backupDir } or null when unrecorded.
 */
function latestRecord(root) {
  if (typeof root !== 'string' || !root) return null
  const wanted = root.toLowerCase()
  let newest = null
  try {
    for (const entry of readdirSync(BACKUP_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('backup-')) continue
      const dir = join(BACKUP_ROOT, entry.name)
      try {
        const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
        if (typeof manifest?.root !== 'string' || manifest.root.toLowerCase() !== wanted) continue
        const at = Date.parse(manifest.createdAt) || 0
        if (newest === null || at > newest.at) newest = { at, manifest, dir }
      } catch { /* a record without a readable manifest is not evidence */ }
    }
  } catch {
    return null
  }
  if (newest === null) return null
  const fast = newest.manifest.fast === true
  const hits = Array.isArray(newest.manifest.hits) ? newest.manifest.hits : []
  return {
    createdAt: newest.manifest.createdAt,
    trigger: typeof newest.manifest.trigger === 'string' && newest.manifest.trigger
      ? newest.manifest.trigger
      : 'manual',
    fast,
    // A fast record never pre-scanned: report null rather than a fake zero.
    low: fast ? null : hits.filter((hit) => hit && hit.low).length,
    backupDir: newest.dir,
  }
}

/**
 * Every operation below is shared by the agent tool and the Plugins-page panel:
 * one implementation, two callers, so a repair behaves the same either way.
 * @param ctx - the plugin context, used to resolve Sessions and their mode.
 * @param {Record<string, unknown>} config - the resolved row configuration.
 */
function createOperations(ctx, config) {
  async function run(args) {
    const result = await runScript(args)
    if (!result.ok) throw new Error(result.error)
    return result.result ?? {}
  }

  return {
    state(input = {}) {
      const sessionId = typeof input.sessionId === 'string' ? input.sessionId : ''
      let workspaces = []
      try {
        const registry = ctx.get?.('workspaceRegistry')
        const listed = typeof registry?.list === 'function' ? registry.list() : []
        workspaces = (Array.isArray(listed) ? listed : [])
          .map((workspace) => ({
            id: String(workspace?.id ?? ''),
            title: typeof workspace?.title === 'string' && workspace.title
              ? workspace.title
              : String(workspace?.path ?? ''),
            path: String(workspace?.path ?? ''),
          }))
          .filter((workspace) => workspace.path)
      } catch {
        workspaces = []
      }
      let defaultDirectory = ''
      try {
        defaultDirectory = ctx.get?.('workingDirectory')?.defaultDirectory || ''
      } catch { /* optional service */ }

      // The panel opens on the Session's own directory: same value the agent
      // tool falls back to, including a `working_directory` change.
      let sessionPath = ''
      // The effective sandbox mode of this Session, so the panel can say whether
      // repairing now would take the Session's write access away instead of
      // showing one warning forever.
      let sandboxMode = ''
      const session = resolveSession(ctx, sessionId)
      if (session) {
        sessionPath = sessionWorkspace(ctx, session)
        sandboxMode = sessionMode(ctx, session)
      }

      return {
        platform: process.platform,
        windows: IS_WIN,
        workspaces,
        sessionPath,
        sandboxMode,
        defaultDirectory,
        backupRoot: BACKUP_ROOT,
        // What the automatic path last did to this workspace, if anything.
        lastClean: latestRecord(sessionPath),
        config: snapshotConfig(config),
        // 面板直接告诉用户去哪儿改排除目录等配置。
        configFile: CONFIG_FILE,
        dataDir: DATA_DIR,
      }
    },

    /** 设置页读取：当前生效配置、存放位置与数据目录。 */
    config() {
      return { config: snapshotConfig(config), configFile: CONFIG_FILE, dataDir: DATA_DIR }
    },

    /**
     * 设置页保存：只接受四个已知字段，写回 config.json 后立即作用于当前进程，
     * 不需要重启或重载插件。写入先落临时文件再 rename，避免半截 JSON。
     */
    updateConfig(input = {}) {
      const next = {}
      for (const key of ['autoClean', 'removeAces', 'scanAllFiles']) {
        if (input[key] === undefined) continue
        if (typeof input[key] !== 'boolean') throw userError(`${key} must be a boolean.`)
        next[key] = input[key]
      }
      if (input.excludeDirs !== undefined) {
        if (typeof input.excludeDirs !== 'string' && !Array.isArray(input.excludeDirs)) {
          throw userError('excludeDirs must be a string or an array of strings.')
        }
        next.excludeDirs = normalizeExcludes(input.excludeDirs, [])
      }
      if (Object.keys(next).length === 0) throw userError('No configuration value to save.')
      const merged = { ...config, ...next }
      const tmp = `${CONFIG_FILE}.tmp`
      try {
        mkdirSync(DATA_DIR, { recursive: true })
        writeFileSync(tmp, `${JSON.stringify(snapshotConfig(merged), null, 2)}\n`)
        renameSync(tmp, CONFIG_FILE)
      } catch (error) {
        try { unlinkSync(tmp) } catch { /* 清理失败不影响保存结果 */ }
        throw new Error(`Could not save config.json: ${error?.message || error}`)
      }
      Object.assign(config, next)
      log(`config saved (autoClean=${config.autoClean}, removeAces=${config.removeAces}, scanAllFiles=${config.scanAllFiles}, excludeDirs=${config.excludeDirs.join(',')})`)
      return { config: snapshotConfig(config), configFile: CONFIG_FILE, dataDir: DATA_DIR }
    },

    async scan(input = {}) {
      const root = normalizeRoot(input.path)
      const args = ['-Action', 'scan', '-Path', root, '-Json']
      if (wantsFlag(input.allFiles, config.scanAllFiles)) args.push('-AllFiles')
      appendExcludes(args, normalizeExcludes(input.excludeDirs, config.excludeDirs))
      return run(args)
    },

    async fix(input = {}) {
      const root = normalizeRoot(input.path)
      assertSafeRoot(root)
      assertNotReparse(root)
      // Host-side gate: the panel already asks twice, but a direct route call or
      // an agent tool call must not silently take a confined Session's write
      // access away. `force` is the explicit, informed override.
      const mode = sessionMode(ctx, resolveSession(ctx, input.sessionId))
      if (mode === 'workspace-write' && input.force !== true) {
        throw userError('This session is workspace-write: repairing would take away its workspace write access and DSH does not restore it. Switch to full access, or pass force to repair anyway.')
      }
      let removeAces = wantsFlag(input.removeAces, config.removeAces)
      // `-Fast` never pre-scans, so it cannot find ACEs to delete; the engine
      // rejects the combination. Degrade explicitly instead of failing the
      // automatic path when config.removeAces is on.
      const fastWithoutScan = input.fast === true && removeAces
      if (fastWithoutScan) {
        removeAces = false
        log(`fast repair on ${root}: removeAces was requested but -Fast skips the pre-scan, so no ACE was removed`)
      }
      const args = ['-Action', 'fix', '-Path', root, '-Json']
      args.push('-Trigger', TRIGGERS.includes(input.trigger) ? input.trigger : 'manual')
      if (removeAces) args.push('-RemoveAces')
      if (wantsFlag(input.allFiles, config.scanAllFiles)) args.push('-AllFiles')
      if (input.fast === true) args.push('-Fast')
      if (input.whatIf === true) args.push('-WhatIf')
      appendExcludes(args, normalizeExcludes(input.excludeDirs, config.excludeDirs))
      const result = await withRootLock(root, () => run(args))
      if (!fastWithoutScan) return result
      const warning = 'fast repair: the pre-scan was skipped, so no ACE was removed; run a full repair to remove them'
      return { ...result, warning: result.warning ? `${result.warning} ${warning}` : warning }
    },

    async verify(input = {}) {
      const root = normalizeRoot(input.path)
      const args = ['-Action', 'verify', '-Path', root, '-Json']
      if (wantsFlag(input.allFiles, config.scanAllFiles)) args.push('-AllFiles')
      appendExcludes(args, normalizeExcludes(input.excludeDirs, config.excludeDirs))
      return run(args)
    },

    async records() {
      const result = await run(['-Action', 'records', '-Json'])
      return { records: Array.isArray(result.records) ? result.records : [] }
    },

    async rollback(input = {}) {
      const backupDir = typeof input.backupDir === 'string' && input.backupDir.trim()
        ? input.backupDir.trim()
        : ''
      if (!backupDir) throw userError('rollback needs backupDir (use action=records to list them).')
      // A rollback rewrites the same tree a repair does (it re-applies the Low
      // label through the same DACL fallback), so it takes the same lock. The
      // record names its workspace; fall back to the record directory as the key.
      let root = ''
      try {
        const manifest = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8'))
        if (typeof manifest?.root === 'string') root = manifest.root
      } catch { /* unreadable record: the engine reports it */ }
      return withRootLock(root || `record:${backupDir}`, () => {
        const args = ['-Action', 'rollback', '-BackupDir', backupDir, '-Json']
        appendExcludes(args, config.excludeDirs)
        return run(args)
      })
    },
  }
}

function summary(action, payload) {
  const lines = [`action: ${action}`]
  if (payload.path) lines.push(`path: ${payload.path}`)
  if (payload.backupDir) lines.push(`backup: ${payload.backupDir}`)
  if (typeof payload.low === 'number') lines.push(`Low objects: ${payload.low}`)
  if (typeof payload.sandboxSid === 'number') lines.push(`S-1-4 ACE objects: ${payload.sandboxSid}`)
  if (typeof payload.unreadable === 'number') lines.push(`unreadable objects: ${payload.unreadable}`)
  if (typeof payload.labelsFixed === 'number') lines.push(`labels changed: ${payload.labelsFixed}`)
  if (typeof payload.removedAces === 'number') lines.push(`ACEs removed: ${payload.removedAces}`)
  if (typeof payload.excluded === 'number') lines.push(`excluded directories: ${payload.excluded}`)
  if (payload.acesSkipped === true) lines.push('ACE removal skipped')
  if (typeof payload.restored === 'number') lines.push(`objects restored: ${payload.restored}`)
  if (typeof payload.objectsRestored === 'number') lines.push(`object DACLs restored: ${payload.objectsRestored}`)
  if (payload.remainingLow != null) lines.push(`remaining Low after rollback: ${payload.remainingLow}`)
  if (payload.truncated === true) lines.push('truncated: yes')
  if (payload.whatIf === true) lines.push('what-if: no changes were written')
  if (Array.isArray(payload.failed) && payload.failed.length > 0) {
    lines.push(`failures: ${payload.failed.length}`)
    for (const item of payload.failed.slice(0, 8)) lines.push(`- ${item.path}: ${item.message}`)
  }
  if (payload.note) lines.push(payload.note)
  if (payload.warning) lines.push(payload.warning)
  return lines.join('\n')
}

export function apply(ctx, rawConfig = {}) {
  // 配置来源按优先级从低到高：内置默认值 < profile 里的插件配置 < 数据目录 config.json。
  // 面板与文档都指向 config.json，用户不必再去改 profile 补丁。
  const fileConfig = readFileConfig()
  const config = {
    ...DEFAULT_CONFIG,
    ...(rawConfig || {}),
    ...fileConfig,
  }
  // 配置可能写成字符串或数组；统一规范化，后续扫描/修复/回滚共用同一份清单。
  config.excludeDirs = normalizeExcludes(config.excludeDirs, DEFAULT_CONFIG.excludeDirs)
  // 首次挂载把已生效的配置落盘：profile 里的旧配置会迁进 config.json，之后以文件为准。
  ensureConfigFile(snapshotConfig(config))
  if (IS_WIN) log(`plugin mounted (autoClean=${config.autoClean}, excludeDirs=${config.excludeDirs.join(',')}, dataDir=${DATA_DIR})`)

  const operations = createOperations(ctx, config)

  ctx.effect(() => ctx.tools.register({
    name: 'workspace_integrity',
    description: 'Inspect or repair the Windows Low integrity label that DSH\'s workspace-write sandbox leaves on a workspace. '
      + 'scan lists objects whose mandatory label is still Low and the leftover S-1-4 sandbox ACEs. '
      + 'fix restores the label to Medium (recursively) and writes a rollback record first. '
      + 'verify re-scans. rollback restores a recorded root DACL and Low labels. records lists rollback records. '
      + 'fix refuses to run while the calling session is still workspace-write unless force is set: '
      + 'a running workspace-write sandbox needs the Low label to keep writing, and DSH does not re-apply it. '
      + 'This tool never elevates; protected roots owned by Administrators fail with Access denied.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['scan', 'fix', 'verify', 'rollback', 'records'],
        description: 'scan: read-only inspection. fix: restore labels. verify: re-scan. rollback: restore a record. records: list records.',
      },
      path: {
        type: 'string',
        description: 'Absolute workspace path. Defaults to the calling session\'s working directory. rollback may omit it when backupDir is given.',
      },
      backupDir: {
        type: 'string',
        description: 'Rollback record directory, for rollback only. Get one from a previous fix result or records.',
      },
      removeAces: {
        type: 'boolean',
        description: 'Also delete explicit DSH sandbox grants (S-1-4-x-y / S-1-4-x-y-1 with the sandbox grant mask) and the Everyone FILE_DELETE_CHILD deny. Defaults to the plugin config (false). Mutates DACLs and weakens a live sandbox; each removed object DACL is recorded for rollback.',
      },
      allFiles: {
        type: 'boolean',
        description: 'Scan every file, not only common executable extensions. Slower on large trees.',
      },
      fast: {
        type: 'boolean',
        description: 'Skip the pre-scan and only recursively reset the root label. Used by automatic cleanup; it never removes ACEs.',
      },
      force: {
        type: 'boolean',
        description: 'Repair even when the calling session is still workspace-write. That takes the session\'s workspace write access away and DSH does not restore it, so pass it only when the session no longer needs to write.',
      },
      whatIf: {
        type: 'boolean',
        description: 'Return the planned fix without writing a rollback record or touching any ACL.',
      },
      excludeDirs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Directory names (any depth) or relative-path prefixes to skip while scanning, fixing and verifying. Defaults to the plugin config (.git, .hg, .svn); the root itself is always checked.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
        },
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const action = args.action
      if (!['scan', 'fix', 'verify', 'rollback', 'records'].includes(action)) {
        throw new Error(`unknown action: ${String(action)}`)
      }
      if (!IS_WIN) throw new Error('workspace_integrity only runs on Windows.')

      if (action === 'records') {
        const { records } = await operations.records()
        if (records.length === 0) return { text: 'No rollback records.' }
        return { text: records.map((record) => `${record.createdAt}  ${record.root}\n  ${record.dir}`).join('\n') }
      }

      if (action === 'rollback') {
        return { text: summary('rollback', await operations.rollback({ backupDir: args.backupDir })) }
      }

      const fallback = sessionWorkspace(ctx, exec?.agent?.session)
      const root = normalizeRoot(args.path || fallback)
      const input = {
        path: root,
        removeAces: args.removeAces,
        allFiles: args.allFiles,
        fast: args.fast,
        force: args.force,
        whatIf: args.whatIf,
        excludeDirs: args.excludeDirs,
        trigger: 'tool',
        sessionId: exec?.agent?.session?.id,
      }
      const result = action === 'scan'
        ? await operations.scan(input)
        : action === 'verify'
          ? await operations.verify(input)
          : await operations.fix(input)

      let text = summary(action, result)
      if (action === 'fix') {
        let mode
        try {
          mode = ctx.get?.('sandboxPolicy')?.resolve?.({ session: exec?.agent?.session })?.mode
        } catch { /* optional service */ }
        if (mode === 'workspace-write') {
          text += '\nwarning: this session is still workspace-write; a running sandbox needs the Low label to keep writing.'
        }
      }
      return { text }
    },
  }))

  // 插件面板与 agent 工具共用同一套 operations，经应用自带的 HTTP 载体暴露。
  // webServer 是可选服务：宿主没有它时保留 agent 工具，只是不提供面板。
  ctx.inject(['webServer'], (webCtx) => {
    // 注册在载体自己的 context 上：它重载时这些路由随之撤销，下次挂载重新注册，
    // 不会与上一轮注册冲突。准入交给 webServer 的 auth 策略，详见 routes.js。
    try {
      const disposeRoutes = registerRoutes(webCtx.webServer, {
        state: ({ url } = {}) => operations.state({
          sessionId: url ? url.searchParams.get('sessionId') || '' : '',
        }),
        config: () => operations.config(),
        updateConfig: (body) => operations.updateConfig(body),
        scan: (body) => operations.scan(body),
        fix: (body) => operations.fix(body),
        verify: (body) => operations.verify(body),
        records: () => operations.records(),
        rollback: (body) => operations.rollback(body),
      })
      webCtx.effect(() => disposeRoutes, 'workspace-integrity: panel routes')
      log('panel routes registered')
    } catch (error) {
      log(`panel routes unavailable: ${String(error && error.message || error)}`)
    }
  })

  if (!IS_WIN || config.autoClean === false) return
  // 以 Session 对象为键，而不是 id：长期运行不会累积字符串，条目随会话回收。
  const seen = new WeakSet()
  const modeOf = (session) => {
    try {
      return ctx.get?.('sandboxPolicy')?.resolve?.({ session })?.mode
    } catch {
      return undefined
    }
  }
  const maybeClean = (session, why) => {
    const root = sessionWorkspace(ctx, session)
    if (!root) return
    if (modeOf(session) !== 'danger-full-access') return
    log(`${why}: full access on ${root}`)
    // config 只存在于 apply 作用域，必须在这里读取并传入 autoClean；
    // 同时兜底拒绝，避免自动清理的异常逃逸成宿主的未处理拒绝。
    void autoClean(ctx, operations, session, { removeAces: config.removeAces }).catch((error) => {
      log(`clean failed for ${root}: ${String(error && error.message || error)}`)
    })
  }
  ctx.on('session/event', (session, event) => {
    if (event?.type === 'sandbox/mode') {
      if (event?.data?.mode === 'danger-full-access') maybeClean(session, 'sandbox/mode')
      return
    }
    // 热挂载可能遇到已经处于完全权限的会话：每个会话只检查一次。
    if (!session || session.id === undefined) return
    if (seen.has(session)) return
    seen.add(session)
    maybeClean(session, 'session first seen')
  })
}

/** 会话切到完全权限后清理其工作区。 */
async function autoClean(ctx, operations, session, options = {}) {
  // 与面板、工具使用同一个目录：用 working_directory 改过目录的会话，
  // 不能去清理它启动时的目录。
  const root = sessionWorkspace(ctx, session)
  if (typeof root !== 'string' || !root) {
    log('full-access event without a workspace path; skipped')
    return
  }
  const now = Date.now()
  if (now - (lastRun.get(root) || 0) < COOLDOWN_MS) return
  // 先记录本次尝试：失败的清理同样计入冷却，与面板的重试行为一致。
  lastRun.set(root, now)
  persistCooldowns()
  log(`full access detected: cleaning ${root}`)
  if (options.removeAces) {
    log('automatic cleanup uses fast mode and does not remove ACEs; run a full repair to remove them')
  }
  try {
    // 三个入口共用同一份实现：自动路径也走 operations.fix。这里固定
    // removeAces: false——fast 不预扫，只有显式全量修复才会删除 ACE。
    const result = await operations.fix({
      path: root,
      fast: true,
      removeAces: false,
      trigger: 'auto',
      sessionId: session?.id,
    })
    const label = result?.labelReadable === false
      ? 'labels were not readable; forced the whole tree to Medium'
      : `Low=${result?.low ?? '?'}`
    log(`clean finished for ${root}: ${label}`)
    if (result?.warning) log(`clean warning for ${root}: ${result.warning}`)
  } catch (error) {
    const message = String(error?.message || error)
    // 400 表示共享锁或模式门禁，不是本次清理失败。
    if (error?.status === 400) log(`clean skipped for ${root}: ${message}`)
    else log(`clean failed for ${root}: ${message}`)
  }
}
