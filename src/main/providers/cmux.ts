import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { TuneResult } from '../../shared/types.js'

const run = promisify(execFile)

/**
 * cmux terminal provider — the layer-1 adapter from PLAN.md §5.
 *
 * cmux exposes a control API over an owner-only Unix socket. M0 established that
 * it authorizes on filesystem permissions alone: a scrubbed environment with no
 * `CMUX_SOCKET_CAPABILITY` token can still call `surface.list`, `surface.focus`,
 * and `workspace.select`. That is why this works from a separate Electron app
 * with no credential to store.
 *
 * The non-obvious part is that the socket does not know about every session.
 * cmux materializes surfaces lazily, so `surface.list` returns only the *open*
 * workspace's tabs — measured on a real machine: 4 surfaces against 20 claude
 * panels the app had persisted, and 22 claude processes actually running. Passing
 * `all_workspaces: true` changes nothing; the surfaces genuinely do not exist yet.
 *
 * So resolution is two-tier:
 *
 *   1. Ask the socket. If the session's tab is already materialized, focus it.
 *      Exact, fast, no side effects.
 *   2. Otherwise read cmux's persisted store to find which workspace holds the
 *      session, select that workspace — which materializes its surfaces — and
 *      then focus. Costs a workspace switch, which is what the user asked for
 *      anyway by clicking "take me to this session".
 *
 * Every call uses `execFile` with an argument array, never a shell string. The
 * session id originates in our own collectors, but interpolating a value like
 * that into a shell command creates the injection risk regardless of provenance,
 * and there is no upside to accepting it.
 */

const CANDIDATE_BINARIES = [
  process.env.CMUX_BUNDLED_CLI_PATH,
  '/Applications/cmux.app/Contents/Resources/bin/cmux',
]

const BUNDLE_ID = 'com.cmuxterm.app'

const STORE_PATH = join(homedir(), 'Library/Application Support/cmux/session-com.cmuxterm.app.json')

interface Surface {
  id: string
  ref: string
  title?: string
  resume_binding?: {
    kind?: string
    /** The Claude session id — the reason layer 1 is exact rather than heuristic. */
    checkpoint_id?: string
  }
}

function findBinary(): string | null {
  for (const candidate of CANDIDATE_BINARIES) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return null
}

export function detect(): boolean {
  return findBinary() !== null
}

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const bin = findBinary()
  if (!bin) throw new Error('cmux CLI not found')
  const { stdout } = await run(bin, ['rpc', method, JSON.stringify(params)], {
    timeout: 5000,
    maxBuffer: 8 * 1024 * 1024,
  })
  return JSON.parse(stdout) as T
}

/** Materialized claude surfaces, keyed by Claude session id. */
async function liveSurfaces(): Promise<Map<string, Surface>> {
  const { surfaces } = await rpc<{ surfaces: Surface[] }>('surface.list', {
    all_workspaces: true,
  })
  const bySession = new Map<string, Surface>()
  for (const surface of surfaces) {
    const binding = surface.resume_binding
    if (binding?.kind === 'claude' && binding.checkpoint_id) {
      bySession.set(binding.checkpoint_id, surface)
    }
  }
  return bySession
}

/**
 * Session id -> workspace id, from cmux's persisted layout.
 *
 * This covers sessions whose workspace has not been opened yet, which the socket
 * cannot see. Read defensively: it is another application's private file, so a
 * shape change should degrade tier 2 rather than break tuning altogether.
 */
function persistedWorkspaces(): Map<string, string> {
  const bySession = new Map<string, string>()
  try {
    const store = JSON.parse(readFileSync(STORE_PATH, 'utf8')) as {
      windows?: {
        tabManager?: {
          workspaces?: {
            workspaceId?: string
            panels?: { terminal?: { agent?: { sessionId?: string } } }[]
          }[]
        }
      }[]
    }
    for (const window of store.windows ?? []) {
      for (const workspace of window.tabManager?.workspaces ?? []) {
        if (!workspace.workspaceId) continue
        for (const panel of workspace.panels ?? []) {
          const sessionId = panel.terminal?.agent?.sessionId
          if (sessionId) bySession.set(sessionId, workspace.workspaceId)
        }
      }
    }
  } catch {
    /* tier 2 unavailable; tier 1 still works */
  }
  return bySession
}

/**
 * Session id -> panel title, from cmux's persisted layout.
 *
 * These titles are cmux's own `hooks claude auto-name` output — an LLM-generated
 * summary of what the session is doing. Reading them is the layer-1 fast path for
 * §8: free, already computed, and available for every panel cmux has persisted
 * (20 on a real machine) rather than only the materialized ones (4).
 *
 * The leading glyph is a live status/spinner frame cmux prepends, not part of the
 * title, so it is stripped.
 */
export function titles(): Map<string, string> {
  const bySession = new Map<string, string>()
  try {
    const store = JSON.parse(readFileSync(STORE_PATH, 'utf8')) as {
      windows?: {
        tabManager?: {
          workspaces?: {
            panels?: { title?: string; terminal?: { agent?: { sessionId?: string } } }[]
          }[]
        }
      }[]
    }
    for (const window of store.windows ?? []) {
      for (const workspace of window.tabManager?.workspaces ?? []) {
        for (const panel of workspace.panels ?? []) {
          const sessionId = panel.terminal?.agent?.sessionId
          const title = panel.title?.replace(/^[^\p{L}\p{N}]+/u, '').trim()
          if (sessionId && title) bySession.set(sessionId, title)
        }
      }
    }
  } catch {
    /* no titles available; callers fall back */
  }
  return bySession
}

/** Select the tab, then raise cmux above other apps. Both are needed. */
async function focusSurface(surface: Surface): Promise<TuneResult> {
  try {
    await rpc('surface.focus', { surface_id: surface.id })
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    return { ok: false, reason: `cmux refused to focus the tab: ${detail}` }
  }

  // `surface.focus` selects the tab within cmux but does not bring cmux forward;
  // `open -b` activates the app but cannot choose a tab. Non-fatal: if this
  // fails the tab is already selected and the user just switches apps manually.
  try {
    await run('/usr/bin/open', ['-b', BUNDLE_ID], { timeout: 5000 })
  } catch {
    /* ignored on purpose — see above */
  }

  return { ok: true, ref: surface.ref }
}

export async function focus(sessionId: string): Promise<TuneResult> {
  if (!detect()) {
    return { ok: false, reason: 'cmux is not installed on this machine' }
  }

  // Tier 1 — already materialized.
  let live: Map<string, Surface>
  try {
    live = await liveSurfaces()
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    return { ok: false, reason: `could not reach cmux: ${detail}` }
  }

  const open = live.get(sessionId)
  if (open) return focusSurface(open)

  // Tier 2 — the session's workspace has not been opened this run.
  const workspaceId = persistedWorkspaces().get(sessionId)
  if (!workspaceId) {
    return {
      ok: false,
      reason: 'cmux has no tab for this session — it may have been closed',
    }
  }

  try {
    await rpc('workspace.select', { workspace_id: workspaceId })
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    return { ok: false, reason: `could not open the session's workspace: ${detail}` }
  }

  // Selecting the workspace materializes its surfaces, so re-resolve.
  try {
    const hydrated = (await liveSurfaces()).get(sessionId)
    if (hydrated) return focusSurface(hydrated)
  } catch {
    /* fall through to the message below */
  }

  return {
    ok: false,
    reason: 'opened the workspace, but cmux did not report a tab for this session',
  }
}

/**
 * Start a new cmux workspace resuming a session that has no live tab.
 *
 * The common case this exists for: you ctrl+C out of a session but leave it
 * around in case you want to pick it back up. Before this, clicking such a strip
 * reported "no cmux tab" and stopped — technically true and completely useless,
 * because the session is resumable and the resume command is right there in
 * cmux's own persisted store.
 *
 * The command is preferred from `resume_binding.command` when cmux recorded one,
 * since that carries the flags the session was started with (permission mode in
 * particular). Only when it is absent do we synthesise a plain `claude --resume`.
 */
export async function resume(sessionId: string, cwd: string): Promise<TuneResult> {
  if (!detect()) return { ok: false, reason: 'cmux is not installed on this machine' }

  const recorded = persistedResumeCommands().get(sessionId)
  const command = recorded ?? `claude --resume '${sessionId}'`

  try {
    await rpc('workspace.create', { cwd, command, focus: true })
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    return { ok: false, reason: `could not start a workspace: ${detail}` }
  }

  try {
    await run('/usr/bin/open', ['-b', BUNDLE_ID], { timeout: 5000 })
  } catch {
    /* tab is created either way */
  }

  return { ok: true, ref: 'resumed', resumed: true }
}

/** Session id -> the exact command cmux used to launch it, when recorded. */
function persistedResumeCommands(): Map<string, string> {
  const bySession = new Map<string, string>()
  try {
    const store = JSON.parse(readFileSync(STORE_PATH, 'utf8')) as {
      windows?: {
        tabManager?: {
          workspaces?: {
            panels?: {
              terminal?: { agent?: { sessionId?: string }; resumeBinding?: { command?: string } }
            }[]
          }[]
        }
      }[]
    }
    for (const window of store.windows ?? []) {
      for (const workspace of window.tabManager?.workspaces ?? []) {
        for (const panel of workspace.panels ?? []) {
          const sessionId = panel.terminal?.agent?.sessionId
          const command = panel.terminal?.resumeBinding?.command
          if (sessionId && command) bySession.set(sessionId, command)
        }
      }
    }
  } catch {
    /* fall back to a synthesised command */
  }
  return bySession
}

/**
 * Start a brand-new session for a filed departure.
 *
 * The same `workspace.create` call `resume` uses, with a fresh `claude` invocation
 * instead of a recorded resume command. Claude Code takes an initial prompt as a
 * positional argument, so the whole flight plan travels with the launch and the
 * session opens already knowing the task.
 *
 * The prompt is single-quoted for the shell with `'` rewritten as `'\''` — close the
 * quote, emit an escaped quote, reopen. That is the only POSIX-safe way to pass
 * arbitrary text through a shell string, and it matters here more than anywhere else
 * in this app: this is the one place user-authored prose becomes part of a command
 * line. Newlines need no special handling inside single quotes.
 */
export async function launch(cwd: string, prompt: string): Promise<TuneResult> {
  if (!detect()) return { ok: false, reason: 'cmux is not installed on this machine' }

  const quoted = `'${prompt.replace(/'/g, `'\\''`)}'`

  try {
    await rpc('workspace.create', { cwd, command: `claude ${quoted}`, focus: true })
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    return { ok: false, reason: `could not start a workspace: ${detail}` }
  }

  try {
    await run('/usr/bin/open', ['-b', BUNDLE_ID], { timeout: 5000 })
  } catch {
    /* the tab exists either way; only focus is best-effort */
  }

  return { ok: true, ref: 'launched', resumed: false }
}
