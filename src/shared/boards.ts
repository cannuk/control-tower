import { isOpen, onApproach, type Board, type Session, type SessionSnapshot } from './types.js'

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

/** How many recently merged PRs the LANDED board holds. */
export const LANDED_LIMIT = 10

const prKey = (repository: string, number: number): string => repository + '#' + number

export interface Boards {
  enRoute: Session[]
  approach: Session[]
  landed: Session[]
  /** Sessions on no board: nothing in review, nothing shipped recently, not recent. */
  olderCount: number
}

/**
 * Sort every session onto its board.
 *
 * Precedence is deliberate, because a session can hold several PRs at once.
 * APPROACH wins over everything: a PR a human is waiting on is the most
 * actionable thing on the board and must not be buried by a sibling that merged.
 */
export function splitByBoard(snapshot: SessionSnapshot | null, now = Date.now()): Boards {
  if (!snapshot) return { enRoute: [], approach: [], landed: [], olderCount: 0 }

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
  const enRoute: Session[] = []
  let olderCount = 0

  for (const session of sessions) {
    if (session.prs.some(onApproach)) {
      approach.push(session)
    } else if (
      // LANDED means finished, so nothing still in flight may appear — not even
      // alongside a merge. One merged sibling must not file a whole session under
      // "shipped" while an open PR sits inside it.
      !session.prs.some(isOpen) &&
      session.prs.some((pr) => recentlyMerged.has(prKey(pr.repository, pr.number)))
    ) {
      landed.push(session)
    } else if (session.lastContact >= cutoff) {
      enRoute.push(session)
    } else {
      olderCount += 1
    }
  }

  // LANDED reads as a shipping log, so order it by merge time rather than by when
  // the session was last touched.
  const mergeTime = (session: Session): number =>
    Math.max(...session.prs.map((pr) => (pr.mergedAt ? Date.parse(pr.mergedAt) : 0)), 0)
  landed.sort((a, b) => mergeTime(b) - mergeTime(a))

  return { enRoute, approach, landed, olderCount }
}

export function sessionsOn(boards: Boards, board: Board): Session[] {
  switch (board) {
    case 'approach':
      return boards.approach
    case 'en-route':
      return boards.enRoute
    case 'landed':
      return boards.landed
    case 'holding':
      return []
  }
}
