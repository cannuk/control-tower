/**
 * Types shared across the main and renderer processes.
 *
 * The renderer never touches the filesystem, `gh`, or the cmux socket — it
 * receives snapshots of these shapes over IPC and renders them. Keeping the
 * types here (rather than in either process) is what stops the boundary
 * blurring later.
 *
 * Naming note: the domain vocabulary is air traffic control (PLAN.md §3), but
 * only where a real equivalence exists. States and actions get aviation names
 * because they genuinely map — an approved-but-discussed PR really is an
 * aircraft cleared to land that still has advisories against it. Identifiers do
 * not: a PR number, a repo, and a branch are proper nouns and stay literal.
 * Dressing those up would hide information rather than compress it.
 */

export const THEMES = ['night-scope', 'day-cab', 'amber-sector'] as const
export type ThemeName = (typeof THEMES)[number]

export const THEME_LABELS: Record<ThemeName, string> = {
  'night-scope': 'Night Scope',
  'day-cab': 'Day Cab',
  'amber-sector': 'Amber Sector',
}

export const THEME_HINTS: Record<ThemeName, string> = {
  'night-scope': 'Dark radar scope — the default',
  'day-cab': 'Daylight in the tower cabin',
  'amber-sector': 'Amber phosphor CRT, near-monochrome',
}

/**
 * Transponder state, from the registry heartbeat (PLAN.md §2.1).
 * `airborne` = working now, `holding` = alive and idle, `no-contact` = process
 * gone or never reported (the uncorrelated target).
 */
export type Transponder = 'airborne' | 'holding' | 'no-contact'

/**
 * The single status a PR shows, resolved by the first-match precedence in
 * PLAN.md §6. Advisories are carried separately in `PrRef` — they qualify the
 * status rather than replacing it, which is the entire point: `CLEARED` and
 * `CLEARED · 17 ADVISORIES` must not look the same.
 */
export type PrStatus =
  | 'landed' /* merged */
  | 'diverted' /* closed unmerged */
  | 'at-gate' /* draft */
  | 'go-around' /* CI failing — aborted approach, must retry */
  | 'on-final' /* CI running */
  | 'hold-short' /* changes requested */
  | 'cleared' /* approved */
  | 'inbound' /* awaiting review */
  | 'no-contact' /* fetch failed */

export interface PrRef {
  number: number
  url: string
  repository: string
  status: PrStatus
  /** Review threads not marked resolved — the advisories against this flight. */
  advisories: number
  /** Advisories that are also outdated: usually stale nits. Tooltip only. */
  outdatedAdvisories: number
}

/** Where a session lives, and how to bring it to the front (PLAN.md §5). */
export interface SessionLocation {
  providerId: string
  /** Provider-native focus target: a cmux surface id, a tmux pane, a tty. */
  handle: string
  /** True when the provider claimed this session directly rather than via tty. */
  exact: boolean
}

export interface Session {
  sessionId: string
  pid: number | null
  cwd: string
  /** Repo-leaf of cwd. The flight's origin field. */
  project: string
  gitBranch: string | null
  gitDirty: boolean
  /** The semantic summary (PLAN.md §8), or null when only a fallback exists. */
  summary: string | null
  /** Registry-derived name (`chat-sdk-1f`) — the last-resort label. */
  fallbackName: string
  transponder: Transponder
  /** Epoch ms of last contact. Transcript mtime today; see §11 open question 2. */
  lastContact: number
  startedAt: number | null
  transcriptPath: string | null
  prs: PrRef[]
  location: SessionLocation | null
  /** Provider reports output the user hasn't seen — the cocked strip. */
  unread: boolean
}

/** What the main process pushes to the renderer on every radar sweep. */
export interface SessionSnapshot {
  sessions: Session[]
  /** Epoch ms the sweep completed — drives the "SWEEP 12s" readout. */
  sweptAt: number
  /** Non-fatal collector problems, surfaced rather than swallowed. */
  warnings: string[]
}

/**
 * Short handle for a session, taken from the first four hex digits of its uuid.
 *
 * Real transponder squawks are four octal digits; these are hex, so the analogy
 * is loose — but the utility is real. "7f93" is sayable, greppable, and fits a
 * fixed-width column where a full uuid cannot. Not unique in principle;
 * collisions across ~100 sessions are unlikely and cosmetic if they happen.
 */
export function squawk(sessionId: string): string {
  return sessionId.slice(0, 4).toUpperCase()
}

/**
 * Outcome of trying to bring a session's terminal to the front.
 *
 * A discriminated result rather than a thrown error or a silent boolean: the
 * failure cases here are ordinary and worth showing the user verbatim — the tab
 * was closed, cmux is not installed, the socket did not answer. Each of those
 * needs a different response from them, so each needs its own sentence.
 */
export type TuneResult = { ok: true; ref: string } | { ok: false; reason: string }
