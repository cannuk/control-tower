import chokidar, { type FSWatcher } from 'chokidar'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { SessionSnapshot } from '../shared/types.js'
import { collect } from './collectors/snapshot.js'
import { refresh as refreshGitHub } from './collectors/github.js'
import Store from 'electron-store'
import { backend as titlerBackend, run as runTitler } from './titler/index.js'

/**
 * Push a fresh sweep whenever the underlying files change (PLAN.md §9, M2).
 *
 * Watched paths:
 *   ~/.claude/sessions/          — heartbeats; changes on every status flip
 *   ~/.claude/projects/          — transcripts; changes on every message
 *   cmux's session store         — titles, and which workspace holds what
 *
 * Two properties matter more than immediacy:
 *
 *   - Debounced. A single Claude turn writes the transcript many times and flips
 *     the heartbeat twice. Sweeping per event would mean dozens of redundant
 *     passes per turn, each spawning a `ps`.
 *   - Serialized. A sweep is async (ps, git), so a burst of events could overlap
 *     two collections and deliver them out of order, making the board flicker
 *     between old and new state. One runs at a time; an event arriving mid-sweep
 *     sets a flag to run once more afterwards, rather than queueing a pass per
 *     event.
 */

const DEBOUNCE_MS = 500

/**
 * GitHub poll interval. One batched query costs 1 rate-limit point regardless of
 * PR count, so 60s spends about 1% of the hourly budget — this interval is set by
 * how fresh you want CI state, not by any limit.
 */
const GITHUB_POLL_MS = 60_000

const CLAUDE_DIR = join(homedir(), '.claude')
const WATCH_PATHS = [
  join(CLAUDE_DIR, 'sessions'),
  join(CLAUDE_DIR, 'projects'),
  join(homedir(), 'Library/Application Support/cmux/session-com.cmuxterm.app.json'),
]

let watcher: FSWatcher | null = null
let timer: NodeJS.Timeout | null = null
let sweeping = false
let sweepAgain = false
let githubTimer: NodeJS.Timeout | null = null

export type SnapshotListener = (snapshot: SessionSnapshot) => void

async function sweep(notify: SnapshotListener): Promise<void> {
  if (sweeping) {
    sweepAgain = true
    return
  }
  sweeping = true
  try {
    const snapshot = await collect()
    notify(snapshot)

    // Title a few sessions that still lack a real summary, then push again so the
    // new titles land. Runs after the notify so the board is never waiting on a
    // network call it does not need.
    const titlingOn = new Store<{ titling: boolean }>().get('titling') !== false
    if (titlingOn && titlerBackend() !== null) {
      // Only sessions still on the heuristic floor. A provider title is already
      // an LLM summary and a generated one is ours — paying to redo either would
      // be spend for no change on screen.
      const candidates = snapshot.sessions
        .filter((s) => s.transcriptPath !== null && s.summarySource !== 'provider')
        .filter((s) => s.summarySource !== 'generated')
        .map((s) => ({ sessionId: s.sessionId, transcriptPath: s.transcriptPath as string }))
      if (candidates.length > 0 && (await runTitler(candidates)) > 0) {
        notify(await collect())
      }
    }
  } catch (cause) {
    notify({
      sessions: [],
      sweptAt: Date.now(),
      warnings: [`sweep failed: ${cause instanceof Error ? cause.message : String(cause)}`],
    })
  } finally {
    sweeping = false
    if (sweepAgain) {
      sweepAgain = false
      void sweep(notify)
    }
  }
}

function schedule(notify: SnapshotListener): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void sweep(notify), DEBOUNCE_MS)
}

/**
 * Fetch PR state, then sweep so the new state reaches the board.
 *
 * Ordered this way deliberately: refreshing without a following sweep writes
 * fresh status into the cache that nothing reads until the next unrelated file
 * change, leaving the board on stale chips for no visible reason.
 */
async function pollGitHub(notify: SnapshotListener): Promise<void> {
  const warnings = await refreshGitHub()
  if (warnings.length > 0) console.warn(warnings.join('; '))
  await sweep(notify)
}

export function start(notify: SnapshotListener): void {
  void sweep(notify) // paint something before the first file event
  void pollGitHub(notify)
  githubTimer = setInterval(() => void pollGitHub(notify), GITHUB_POLL_MS)

  watcher = chokidar.watch(WATCH_PATHS, {
    ignoreInitial: true,
    // Transcripts live one level down (`projects/<project>/<id>.jsonl`); deeper
    // paths are subagent transcripts that do not belong on the board.
    depth: 2,
    // Only metadata is read, so polling would be pure overhead on ~100 files.
    usePolling: false,
    awaitWriteFinish: false,
  })

  for (const event of ['add', 'change', 'unlink'] as const) {
    watcher.on(event, () => schedule(notify))
  }
}

export function stop(): void {
  if (timer) clearTimeout(timer)
  timer = null
  if (githubTimer) clearInterval(githubTimer)
  githubTimer = null
  void watcher?.close()
  watcher = null
}

/** Send a snapshot to a window, guarding against a destroyed renderer. */
export function pushTo(win: BrowserWindow | null, snapshot: SessionSnapshot): void {
  if (!win || win.isDestroyed()) return
  win.webContents.send('sessions:pushed', snapshot)
}
