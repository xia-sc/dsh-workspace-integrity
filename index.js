import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync,
  writeFileSync, writeSync,
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
const LOG_FILE = join(HOME, 'workspace-integrity.log')
const BACKUP_ROOT = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'dsh-workspace-integrity')
const COOLDOWN_MS = 60_000
const lastRun = new Map()
/** Cleanup cooldowns survive a remount, so a hot reload cannot re-clean at once. */
const STATE_FILE = join(HOME, 'workspace-integrity.state.json')
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
    mkdirSync(HOME, { recursive: true })
    const now = Date.now()
    const roots = {}
    for (const [root, at] of lastRun) {
      if (now - at < COOLDOWN_MS) roots[root] = at
    }
    writeFileSync(STATE_FILE, JSON.stringify({ roots }, null, 2))
  } catch { /* persistence must never break cleanup */ }
}

restoreCooldowns()

function log(message) {
  try {
    mkdirSync(HOME, { recursive: true })
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

function wantsFlag(value, fallback) {
  if (value === true) return true
  if (value === false) return false
  return fallback === true
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
        config: {
          autoClean: config.autoClean !== false,
          removeAces: config.removeAces === true,
          scanAllFiles: config.scanAllFiles === true,
        },
      }
    },

    async scan(input = {}) {
      const root = normalizeRoot(input.path)
      const args = ['-Action', 'scan', '-Path', root, '-Json']
      if (wantsFlag(input.allFiles, config.scanAllFiles)) args.push('-AllFiles')
      return run(args)
    },

    async fix(input = {}) {
      const root = normalizeRoot(input.path)
      // Host-side gate: the panel already asks twice, but a direct route call or
      // an agent tool call must not silently take a confined Session's write
      // access away. `force` is the explicit, informed override.
      const mode = sessionMode(ctx, resolveSession(ctx, input.sessionId))
      if (mode === 'workspace-write' && input.force !== true) {
        throw userError('This session is workspace-write: repairing would take away its workspace write access and DSH does not restore it. Switch to full access, or pass force to repair anyway.')
      }
      const removeAces = wantsFlag(input.removeAces, config.removeAces)
      const args = ['-Action', 'fix', '-Path', root, '-Json']
      args.push('-Trigger', TRIGGERS.includes(input.trigger) ? input.trigger : 'manual')
      if (removeAces) args.push('-RemoveAces')
      if (wantsFlag(input.allFiles, config.scanAllFiles)) args.push('-AllFiles')
      if (input.fast === true) args.push('-Fast')
      // The automatic path passes config.removeAces through, but `-Fast` skips
      // the pre-scan, so it cannot find ACEs to delete. Report that instead of
      // letting the setting fail silently.
      const fastWithoutScan = input.fast === true && removeAces
      if (fastWithoutScan) {
        log(`fast repair on ${root}: removeAces was requested but -Fast skips the pre-scan, so no leftover ACE was removed`)
      }
      const result = await withRootLock(root, () => run(args))
      return fastWithoutScan
        ? { ...result, warning: 'fast repair: the pre-scan was skipped, so no leftover ACE was removed; run a full repair to remove them' }
        : result
    },

    async verify(input = {}) {
      const root = normalizeRoot(input.path)
      const args = ['-Action', 'verify', '-Path', root, '-Json']
      if (wantsFlag(input.allFiles, config.scanAllFiles)) args.push('-AllFiles')
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
      return withRootLock(root || `record:${backupDir}`, () => run(['-Action', 'rollback', '-BackupDir', backupDir, '-Json']))
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
  if (typeof payload.restored === 'number') lines.push(`objects restored: ${payload.restored}`)
  if (Array.isArray(payload.failed) && payload.failed.length > 0) {
    lines.push(`failures: ${payload.failed.length}`)
    for (const item of payload.failed.slice(0, 8)) lines.push(`- ${item.path}: ${item.message}`)
  }
  if (payload.note) lines.push(payload.note)
  if (payload.warning) lines.push(payload.warning)
  return lines.join('\n')
}

export function apply(ctx, rawConfig = {}) {
  const config = {
    autoClean: true,
    removeAces: false,
    scanAllFiles: false,
    ...(rawConfig || {}),
  }
  if (IS_WIN) log(`plugin mounted (autoClean=${config.autoClean})`)

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
        description: 'Also delete non-inherited S-1-4 sandbox ACEs and the Everyone FILE_DELETE_CHILD deny. Defaults to the plugin config (false). Mutates DACLs and weakens a live sandbox; leave off unless you need a clean hand-back.',
      },
      allFiles: {
        type: 'boolean',
        description: 'Scan every file, not only common executable extensions. Slower on large trees.',
      },
      fast: {
        type: 'boolean',
        description: 'Skip the pre-scan and only recursively reset the root label. Used by automatic cleanup.',
      },
      force: {
        type: 'boolean',
        description: 'Repair even when the calling session is still workspace-write. That takes the session\'s workspace write access away and DSH does not restore it, so pass it only when the session no longer needs to write.',
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

  // The Plugins-page panel talks to the same operations over the app's own
  // HTTP carrier. Both services are optional: a Host without them keeps the
  // agent tool and simply never serves the panel.
  ctx.inject(['webServer'], (webCtx) => {
    // Registered on the carrier's own context: if it reloads, these routes are
    // withdrawn with it and the next mount registers them again instead of
    // colliding with the previous registration.
    webCtx.inject(['connection'], (connCtx) => {
      try {
        const disposeRoutes = registerRoutes(webCtx.webServer, connCtx.connection, {
          state: ({ url } = {}) => operations.state({
            sessionId: url ? url.searchParams.get('sessionId') || '' : '',
          }),
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
  })

  if (!IS_WIN || config.autoClean === false) return
  // Keyed by the Session object, not its id: no strings accumulate over a long
  // run, and the entry goes away with the Session it describes.
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
    void autoClean(ctx, operations, session)
  }
  ctx.on('session/event', (session, event) => {
    if (event?.type === 'sandbox/mode') {
      if (event?.data?.mode === 'danger-full-access') maybeClean(session, 'sandbox/mode')
      return
    }
    // A hot mount can meet a session that is already on full access; check once.
    if (!session || session.id === undefined) return
    if (seen.has(session)) return
    seen.add(session)
    maybeClean(session, 'session first seen')
  })
}

/** Clean a workspace after its session switched to full access. */
async function autoClean(ctx, operations, session) {
  // Same directory the panel shows and the tool defaults to: a Session that
  // changed directory with `working_directory` must not have its launch
  // directory cleaned instead.
  const root = sessionWorkspace(ctx, session)
  if (typeof root !== 'string' || !root) {
    log('full-access event without a workspace path; skipped')
    return
  }
  const now = Date.now()
  if (now - (lastRun.get(root) || 0) < COOLDOWN_MS) return
  // Record the attempt before running: a failed cleanup still counts as the
  // cooldown, exactly like the panel's own retry behaviour.
  lastRun.set(root, now)
  persistCooldowns()
  log(`full access detected: cleaning ${root}`)
  try {
    // One implementation for every caller: the automatic path goes through the
    // same operation as the panel and the tool, so `config.removeAces` and
    // `config.scanAllFiles` mean the same thing everywhere.
    const result = await operations.fix({
      path: root,
      fast: true,
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
    // A 400 is the shared lock or the mode gate, not a failure of this run.
    if (error?.status === 400) log(`clean skipped for ${root}: ${message}`)
    else log(`clean failed for ${root}: ${message}`)
  }
}
