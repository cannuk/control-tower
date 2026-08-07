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
 * PLAN.md §6.
 *
 * "Approved" is two states, not one, and that distinction is the reason this enum
 * exists rather than a bare `reviewDecision`. Approved with every thread resolved
 * means merge it; approved with threads still open means read them first. Those
 * lead to different actions, so they are different states.
 *
 * Unresolved threads used to be a second chip beside this one. Two chips implied two
 * independent facts and made the board harder to scan than the single question it
 * is actually answering — what is this PR waiting on. The count is now an attribute
 * of the status it qualifies.
 */
export type PrStatus =
  | 'landed' /* merged */
  | 'diverted' /* closed unmerged */
  | 'at-gate' /* draft */
  | 'go-around' /* CI failing — aborted approach, must retry */
  | 'on-final' /* CI running */
  | 'hold-short' /* changes requested */
  | 'cleared' /* approved, every thread resolved — mergeable */
  | 'cleared-advisory' /* approved, threads still open — read before merging */
  | 'inbound' /* awaiting review */
  | 'no-contact' /* fetch failed */

/** One person's share of a PR's unresolved review threads. */
export interface Advisor {
  login: string
  /** Unresolved threads this person opened. */
  threads: number
  /** How many of those sit on outdated code — usually nits already dealt with. */
  outdated: number
}

/**
 * A human's current position on a PR.
 *
 * Current, not historical: someone who requested changes and later approved
 * appears once, as approved. GitHub returns every review ever posted, so the last
 * decisive one per person is the only one that describes where the PR stands.
 */
export interface Reviewer {
  login: string
  stance: 'approved' | 'changes-requested' | 'commented'
}

export interface PrRef {
  number: number
  url: string
  repository: string
  /** The PR's own title. On boards defined by PR state, this is the headline. */
  title: string | null
  status: PrStatus
  /**
   * Unresolved review threads started by **somebody else**.
   *
   * Two exclusions, same reasoning both times: this number exists to say what other
   * people are waiting on you for, so anything that is not that would inflate it.
   * Bots go first — CodeRabbit opens threads on most PRs, and counting them made "3
   * unresolved" appear on a PR no person had read. The PR's own author goes too: a
   * thread you opened on your own work is a note to yourself.
   */
  advisories: number
  /** Advisories that are also outdated: usually stale nits. Tooltip only. */
  outdatedAdvisories: number
  /**
   * Who the unresolved threads belong to, most threads first.
   *
   * The counts here sum to `advisories`. Kept as a breakdown rather than a total
   * because on APPROACH the useful question is not "how many" but "whose" — six
   * threads from one reviewer is one conversation to work through, and three each
   * from two people is two.
   */
  advisors: Advisor[]
  /** Humans who have posted a review, and where they landed. Bots excluded. */
  reviewers: Reviewer[]
  /**
   * Somebody other than you has reviewed or commented on this PR.
   *
   * The board's central distinction, and what admits a session to APPROACH.
   * `reviewDecision` alone cannot answer it: #2453 sat at REVIEW_REQUIRED with 25
   * open threads from three people, while #2545 had a full review posted by
   * CodeRabbit and no human involvement at all. Any review or thread counts, from
   * anyone who is neither a bot nor the author — #2471 was on APPROACH purely
   * because its author had commented on their own work.
   */
  humanReviewed: boolean
  /** ISO timestamp, or null while unmerged. Orders the LANDED board. */
  mergedAt: string | null
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
  /** The semantic summary (PLAN.md §8). Never null — §8 layer 3 guarantees one. */
  summary: string | null
  /**
   * Which tier of §8 produced `summary`.
   *
   * Load-bearing, not diagnostic: it is how the titler knows which sessions still
   * need a real title, and it stops us paying to re-title a session that already
   * has a perfectly good one from the terminal.
   */
  summarySource: 'provider' | 'generated' | 'heuristic' | null
  /**
   * One or two sentences on where the session currently stands.
   *
   * Only shown on EN ROUTE, where the question is "what is happening here" rather
   * than "which PR is this". A title has to fit a fixed column and so can only
   * name the topic; this is the room to say the topic has moved on, what is
   * blocked, or what is half-finished. Null unless generated — the heuristic
   * cannot produce one, since it only ever sees the opening request.
   */
  sessionState: string | null
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
 * The four boards, in the order work moves through them.
 *
 * This is a pipeline, not a set of filters on recency — which was the flaw in the
 * previous PATTERN/LANDED split. "Not touched in 8 hours" is a fact about a
 * process; it says nothing about whether you owe anybody anything. Position in
 * the review pipeline does.
 */
export type Board = 'departures' | 'en-route' | 'approach' | 'landed'

export const BOARDS: Board[] = ['departures', 'en-route', 'approach', 'landed']

/**
 * This PR is on approach: still flying, and a human has been in the loop.
 *
 * Covers both shapes that block a merge — changes you need to address, and an
 * approval carrying non-blocking comments you still want to read before merging.
 * Both mean the PR is close to the ground and needs a decision from you.
 */
export function onApproach(pr: PrRef): boolean {
  return pr.mergedAt === null && pr.humanReviewed
}

/**
 * The PR a strip should be named after, or null when the session is the subject.
 *
 * On APPROACH and LANDED the row exists *because of* a pull request, so naming it
 * after the session buries the thing you came to read — two sessions called
 * "Run phase 1 of the setup guide" are indistinguishable, while their PR titles
 * are not. EN ROUTE is the opposite: the work is in flight, often with no PR at
 * all, so the session is the subject there.
 *
 * With several candidates, the newest wins. PR numbers are monotonic per repo, so
 * the highest number is the most recent piece of work — the one you are most
 * likely to have in mind.
 */
export function headlinePr(session: Session, board: Board): PrRef | null {
  if (board === 'approach') {
    const candidates = session.prs.filter(onApproach)
    return candidates.sort((a, b) => b.number - a.number)[0] ?? null
  }
  if (board === 'landed') {
    const merged = session.prs.filter((pr) => pr.mergedAt !== null)
    return (
      merged.sort((a, b) => Date.parse(b.mergedAt ?? '') - Date.parse(a.mergedAt ?? ''))[0] ?? null
    )
  }
  return null
}

/**
 * Still in flight — neither merged nor abandoned.
 *
 * A PR whose state we could not read counts as open. That is the conservative
 * direction: the cost of wrongly calling something open is one extra row on a
 * working board, while wrongly calling it settled files unfinished work under
 * "shipped", where you would never look for it again.
 */
export function isOpen(pr: PrRef): boolean {
  return pr.mergedAt === null && pr.status !== 'diverted'
}

/**
 * Outcome of trying to bring a session's terminal to the front.
 *
 * A discriminated result rather than a thrown error or a silent boolean: the
 * failure cases here are ordinary and worth showing the user verbatim — the tab
 * was closed, cmux is not installed, the socket did not answer. Each of those
 * needs a different response from them, so each needs its own sentence.
 */
export type TuneResult =
  { ok: true; ref: string; resumed?: boolean } | { ok: false; reason: string }

/**
 * A filed flight plan: work you intend to start, before any session exists.
 *
 * The one thing on the board that Control Tower *owns* rather than observes.
 * Everything else here is derived from a transcript, a process or GitHub and can be
 * rebuilt by rescanning; these rows exist only because you typed them, which is why
 * they live in their own store with no schema-version rebuild (see store/staging.ts).
 */
export interface Departure {
  id: number
  /** One line. Becomes the strip headline, and the first line of the prompt. */
  title: string
  /** Optional detail, sent to the session as the rest of the prompt. */
  notes: string | null
  /**
   * Where to start it. Optional when filing so an idea can be captured without
   * deciding, but required to launch — there is no sensible default directory for
   * "go and do this", and guessing one would start the session in the wrong repo.
   */
  cwd: string | null
  createdAt: number
}

/** What a launch attempt reports back. */
export type LaunchResult = { ok: true } | { ok: false; reason: string }
