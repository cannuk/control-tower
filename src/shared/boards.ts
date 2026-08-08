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
 * session in isolation — LANDED membership depends on the ten most recently merged
 * PRs across the whole board. Two copies of the rule would be two things to keep
 * in step, and the failure would be quiet: the titler summarising sessions the
 * board does not consider active.
 */

/**
 * How recent a session must be to count as "in the air" on EN ROUTE.
 *
 * Only EN ROUTE needs a recency bound. APPROACH and LANDED are defined by PR
 * state, which stays meaningful however long ago you last typed — a PR with
 * feedback waiting does not stop mattering because you closed the terminal.
 * EN ROUTE has no such anchor, so without a window it would list every session
 * that never got reviewed: ~90 rows of history rather than today's work.
 */
export const EN_ROUTE_WINDOW_HOURS = 8

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
function inFlight(session: Session, cutoff: number): boolean {
  return session.lastContact >= cutoff && session.transponder !== 'no-contact'
}

/** How many recently merged PRs the LANDED board holds. */
export const LANDED_LIMIT = 10

const prKey = (repository: string, number: number): string => repository + '#' + number

export interface Boards {
  enRoute: Session[]
  /** Parked by you — see the HOLDING branch in splitByBoard. */
  holding: Session[]
  approach: Session[]
  landed: Session[]
  /** Sessions on no board: nothing in review, nothing shipped recently, not in flight. */
  olderCount: number
  /**
   * Sessions folded into another row because they share its pull request.
   *
   * Reported rather than quietly discarded. A board that drops rows without saying
   * so reads as complete when it is not, and the count is also the signal that
   * several sessions have worked one PR.
   */
  collapsed: { approach: number; landed: number }
}

/**
 * Sort every session onto its board.
 *
 * Precedence is deliberate, because a session can hold several PRs at once.
 * APPROACH wins over everything: a PR a human is waiting on is the most
 * actionable thing on the board and must not be buried by a sibling that merged.
 */
export function splitByBoard(snapshot: SessionSnapshot | null, now = Date.now()): Boards {
  if (!snapshot) {
    return {
      enRoute: [],
      holding: [],
      approach: [],
      landed: [],
      olderCount: 0,
      collapsed: { approach: 0, landed: 0 },
    }
  }

  const sessions = [...snapshot.sessions].sort((a, b) => b.lastContact - a.lastContact)

  // The N most recently merged PRs across the whole board. Deduped by key first:
  // one PR is often linked from several sessions, and it should occupy one slot.
  const mergedByKey = new Map<string, number>()
  for (const session of sessions) {
    for (const pr of session.prs) {
      if (!pr.mergedAt) continue
      mergedByKey.set(prKey(pr.repository, pr.number), Date.parse(pr.mergedAt))
    }
  }
  const recentlyMerged = new Set(
    [...mergedByKey.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, LANDED_LIMIT)
      .map(([key]) => key),
  )

  const cutoff = now - EN_ROUTE_WINDOW_HOURS * 3600_000
  const approach: Session[] = []
  const landed: Session[] = []
  const holding: Session[] = []
  const enRoute: Session[] = []
  let olderCount = 0

  for (const session of sessions) {
    if (
      // LANDED means finished, so nothing still in flight may appear — not even
      // alongside a merge. One merged sibling must not file a whole session under
      // "shipped" while an open PR sits inside it. That guard is also why LANDED can
      // be tested first without burying a PR someone is waiting on: a session with an
      // open reviewed PR can never satisfy it.
      !session.prs.some(isOpen) &&
      session.prs.some((pr) => recentlyMerged.has(prKey(pr.repository, pr.number)))
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
    } else if (inFlight(session, cutoff)) {
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

  return {
    enRoute,
    holding,
    approach: waiting.kept,
    landed: shipped.kept,
    olderCount,
    collapsed: { approach: waiting.collapsed, landed: shipped.collapsed },
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
