import {
  headlinePr,
  isOpen,
  onApproach,
  type Board,
  type Session,
  type SessionSnapshot,
} from './types.js'

/**
 * Board classification, shared by both processes.
 *
 * This lived in the renderer store until the titler needed it: summaries are only
 * generated for EN ROUTE sessions, and the main process cannot decide that from a
 * session in isolation — which board a session lands on depends on every other
 * session, since the boards are ordered and bounded as a whole. Two copies of the rule
 * would be two things to keep in step, and the failure would be quiet: the titler
 * summarising sessions the board does not consider active.
 */

/**
 * Whether a session is in the air, rather than merely recent.
 *
 * Recency alone was the original rule for the active board, chosen back when that
 * board meant "what have you touched lately". EN ROUTE means something narrower now
 * — work actually in flight — and a session whose process has exited is not that.
 * It is the same row that was unwanted on LANDED: interrupted, left behind in case
 * it gets resumed, and nothing you can act on from here.
 *
 * Deliberately not applied to APPROACH or LANDED. Those are about a pull request,
 * and a PR with feedback waiting needs you whether or not its terminal is still
 * open — gating them on liveness would hide the most actionable rows on the board.
 */
function inFlight(session: Session): boolean {
  return session.transponder !== 'no-contact'
}

/**
 * How many rows each board holds. `null` means every one of them.
 *
 * EN ROUTE used an eight-hour recency window, which asked "was this touched recently"
 * — a question whose answer rode on a clock that turned out to be wrong, and which was
 * never the real question. Once last contact came from the conversation rather than the
 * file's mtime, 21 of 22 running sessions fell outside the window and the board showed
 * a single row. A count has no such failure mode: a quiet week shows as many rows as a
 * busy hour, just older ones.
 *
 * The two bounded boards are bounded because they are lists of *recent* things, where
 * an old row is genuinely less interesting than a new one. The two unbounded ones are
 * not lists at all — they are queues of things that need you:
 *
 *   - APPROACH is people waiting on you. A cap there hides someone's review, and the
 *     hidden one would be the oldest, which is the one that has waited longest.
 *   - HOLDING is what you deliberately parked. A cap there discards a decision you
 *     made explicitly, which is the same mistake as the hold that used to expire after
 *     eight hours.
 *
 * Both stay configurable anyway, because "probably no limit" is a default rather than a
 * law, and a hundred parked rows is its own kind of unreadable.
 */
export interface BoardLimits {
  enRoute: number | null
  holding: number | null
  approach: number | null
  landed: number | null
}

export const DEFAULT_BOARD_LIMITS: BoardLimits = {
  enRoute: 12,
  holding: null,
  approach: null,
  landed: 10,
}

/**
 * Take the first `limit` rows, and say how many were left behind.
 *
 * The count is the point. A board that shrinks without admitting it reads as complete
 * when it is not — the same reason folded rows are reported rather than dropped.
 */
function capped<T>(rows: T[], limit: number | null): { kept: T[]; trimmed: number } {
  if (limit === null) return { kept: rows, trimmed: 0 }
  const kept = rows.slice(0, Math.max(0, limit))
  return { kept, trimmed: rows.length - kept.length }
}

const prKey = (repository: string, number: number): string => repository + '#' + number

export interface Boards {
  enRoute: Session[]
  /** Parked by you — see the HOLDING branch in splitByBoard. */
  holding: Session[]
  approach: Session[]
  landed: Session[]
  /**
   * Sessions on no board at all: no pull request of any kind, and not running.
   *
   * Distinct from `trimmed`. A trimmed row qualified for its board and did not fit; one
   * counted here qualified for nothing.
   */
  olderCount: number
  /**
   * Sessions folded into another row because they share its pull request.
   *
   * Reported rather than quietly discarded. A board that drops rows without saying
   * so reads as complete when it is not, and the count is also the signal that
   * several sessions have worked one PR.
   */
  collapsed: { approach: number; landed: number }
  /**
   * Rows a board's limit left off, per board.
   *
   * Separate from `collapsed` because they are different losses: a folded row is
   * still represented by another row, while a trimmed one is simply not shown.
   */
  trimmed: { enRoute: number; holding: number; approach: number; landed: number }
}

/**
 * Sort every session onto its board.
 *
 * Precedence is deliberate, because a session can hold several PRs at once.
 * APPROACH wins over everything: a PR a human is waiting on is the most
 * actionable thing on the board and must not be buried by a sibling that merged.
 */
export function splitByBoard(
  snapshot: SessionSnapshot | null,
  limits: BoardLimits = DEFAULT_BOARD_LIMITS,
): Boards {
  if (!snapshot) {
    return {
      enRoute: [],
      holding: [],
      approach: [],
      landed: [],
      olderCount: 0,
      collapsed: { approach: 0, landed: 0 },
      trimmed: { enRoute: 0, holding: 0, approach: 0, landed: 0 },
    }
  }

  const sessions = [...snapshot.sessions].sort((a, b) => b.lastContact - a.lastContact)

  const approach: Session[] = []
  const landed: Session[] = []
  const holding: Session[] = []
  const enRoute: Session[] = []
  let olderCount = 0

  for (const session of sessions) {
    if (
      /**
       * LANDED means finished, so nothing still in flight may appear — not even
       * alongside a merge. One merged sibling must not file a whole session under
       * "shipped" while an open PR sits inside it. That guard is also why LANDED can be
       * tested first without burying a PR someone is waiting on: a session with an open
       * reviewed PR can never satisfy it.
       *
       * Membership is "has a merge", with recency left entirely to the sort and the
       * limit below. It used to be "has one of the N most recently merged PRs", which
       * spent the limit twice over: a session with three merges consumed three of the N
       * slots and still rendered one row, and a slot spent on a session that also had an
       * open PR bought no row at all. Configured to 20, the board showed 11 — 20 PR
       * slots resolving to 16 sessions, two of which shared a PR and collapsed.
       */
      !session.prs.some(isOpen) &&
      session.prs.some((pr) => pr.mergedAt !== null)
    ) {
      landed.push(session)
    } else if (session.held) {
      /**
       * Parked. A decision, so it outranks every inference below it.
       *
       * It used to sit below APPROACH, on the reasoning that a PR somebody is
       * waiting on outranks your having parked it. That was wrong about what parking
       * an APPROACH row means: "approved, but I am not merging this yet" is a
       * decision about *your* next move, not a way to hide someone else's review.
       * Refusing to park those left the one case with a real reason to wait — a
       * release window, a dependency, a deliberate pause — as the only row that could
       * not be moved off the board.
       *
       * Still below LANDED, because a merged PR has nothing left to wait for and a
       * hold on it would be a hold on nothing.
       *
       * Deliberately exempt from both EN ROUTE bounds: no recency window and no
       * liveness check, since a hold that expired after eight hours or the moment you
       * quit the terminal would lose exactly what you asked it to keep.
       */
      holding.push(session)
    } else if (session.prs.some(onApproach)) {
      approach.push(session)
    } else if (inFlight(session)) {
      enRoute.push(session)
    } else {
      olderCount += 1
    }
  }

  // LANDED reads as a shipping log, so order it by merge time rather than by when
  // the session was last touched. Deduped first, while the list is still in
  // last-contact order — that ordering is what picks the representative.
  const shipped = oneRowPerPr(landed, 'landed')
  const mergeTime = (session: Session): number =>
    Math.max(...session.prs.map((pr) => (pr.mergedAt ? Date.parse(pr.mergedAt) : 0)), 0)
  shipped.kept.sort((a, b) => mergeTime(b) - mergeTime(a))

  const waiting = oneRowPerPr(approach, 'approach')

  // Every board is already in its display order by this point, so a cap keeps the
  // rows that matter most on each: the most recent on EN ROUTE, the newest merges on
  // LANDED. `sessions` was sorted by last contact at the top.
  const air = capped(enRoute, limits.enRoute)
  const parked = capped(holding, limits.holding)
  const inbound = capped(waiting.kept, limits.approach)
  const down = capped(shipped.kept, limits.landed)

  return {
    enRoute: air.kept,
    holding: parked.kept,
    approach: inbound.kept,
    landed: down.kept,
    olderCount,
    collapsed: { approach: waiting.collapsed, landed: shipped.collapsed },
    trimmed: {
      enRoute: air.trimmed,
      holding: parked.trimmed,
      approach: inbound.trimmed,
      landed: down.trimmed,
    },
  }
}

/**
 * Collapse a PR-defined board to one row per pull request.
 *
 * APPROACH and LANDED are named after a PR, but the row unit is a session — and a
 * PR accumulates sessions. #2501 was built in one session on 28 July and its
 * feedback addressed in another today, so the board showed the same PR title twice
 * with the same review paragraph under it, indistinguishable. Measured across the
 * board: five PRs were linked from two or three sessions each.
 *
 * EN ROUTE is deliberately left alone. There the row *is* the session — that is the
 * thing in flight, and two sessions working toward one PR are genuinely two things
 * happening.
 *
 * The representative is the most recently active session, which relies on the input
 * still being in last-contact order: for #2501 that keeps today's "Address PR #2501
 * feedback" over the ten-day-old build session, which is the one you would want to
 * tune to. Sessions with no headline PR are passed through untouched rather than
 * collapsed together, since they have no key to collapse on.
 */
function oneRowPerPr(sessions: Session[], board: Board): { kept: Session[]; collapsed: number } {
  const seen = new Set<string>()
  const kept: Session[] = []
  let collapsed = 0
  for (const session of sessions) {
    const lead = headlinePr(session, board)
    if (!lead) {
      kept.push(session)
      continue
    }
    const key = prKey(lead.repository, lead.number)
    if (seen.has(key)) {
      collapsed += 1
      continue
    }
    seen.add(key)
    kept.push(session)
  }
  return { kept, collapsed }
}

export function sessionsOn(boards: Boards, board: Board): Session[] {
  switch (board) {
    case 'approach':
      return boards.approach
    case 'en-route':
      return boards.enRoute
    case 'holding':
      return boards.holding
    case 'landed':
      return boards.landed
    case 'departures':
      return []
  }
}
