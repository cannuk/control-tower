import { describe, expect, it } from 'vitest'
import { DEFAULT_BOARD_LIMITS, splitByBoard, type BoardLimits } from './boards.js'
import type { PrRef, Session, SessionSnapshot } from './types.js'

/**
 * Board classification.
 *
 * Every case here is a bug that reached the running app. The rules read as obvious
 * once written down and were not obvious while being written — a session with two
 * merged PRs and one open one sat on LANDED, one pull request appeared twice under
 * two different sessions, and parking something quietly expired after eight hours.
 * The point of these is that the next change to `splitByBoard` cannot silently undo
 * any of that.
 */

const HOUR = 3600_000
const NOW = 1_800_000_000_000

function pr(over: Partial<PrRef> = {}): PrRef {
  return {
    number: 1,
    url: 'https://github.com/example-org/web-app/pull/1',
    repository: 'example-org/web-app',
    title: 'A pull request',
    status: 'inbound',
    advisories: 0,
    outdatedAdvisories: 0,
    advisors: [],
    reviewers: [],
    requestedFrom: [],
    failingChecks: [],
    humanReviewed: false,
    mergedAt: null,
    ...over,
  }
}

function session(over: Partial<Session> = {}): Session {
  return {
    sessionId: 'aaaaaaaa-0000-0000-0000-000000000000',
    origin: 'session' as const,
    pid: 1,
    cwd: '/tmp/repo',
    project: 'repo',
    gitBranch: null,
    gitDirty: false,
    summary: 'A session',
    summarySource: 'generated',
    userName: null,
    sessionState: null,
    fallbackName: 'repo-aa',
    transponder: 'idle',
    lastContact: NOW - 60_000,
    startedAt: null,
    transcriptPath: '/tmp/t.jsonl',
    prs: [],
    location: null,
    unread: false,
    held: false,
    ...over,
  }
}

const snap = (sessions: Session[]): SessionSnapshot => ({ sessions, sweptAt: NOW, warnings: [] })
const split = (sessions: Session[]) => splitByBoard(snap(sessions))
/** One board capped, the rest left at their defaults. */
const withLimit = (over: Partial<BoardLimits>): BoardLimits => ({
  ...DEFAULT_BOARD_LIMITS,
  ...over,
})

describe('EN ROUTE', () => {
  it('takes a live session', () => {
    const { enRoute } = split([session()])
    expect(enRoute).toHaveLength(1)
  })

  it('drops a session whose process is gone, however recent', () => {
    // The reported bug: rows for sessions interrupted an hour ago and left behind.
    const { enRoute, olderCount } = split([
      session({ transponder: 'no-contact', lastContact: NOW - 60_000 }),
    ])
    expect(enRoute).toHaveLength(0)
    expect(olderCount).toBe(1)
  })

  it('keeps a live session however long ago it last spoke', () => {
    // The replaced rule. An eight-hour window meant a night off emptied the board:
    // 21 of 22 running sessions fell outside it, and the answer to "what am I working
    // on" became one row. Age orders the list now; it does not remove anything.
    const { enRoute } = split([session({ lastContact: NOW - 400 * HOUR })])
    expect(enRoute).toHaveLength(1)
  })

  it('holds only the limit, keeping the most recent', () => {
    const rows = [
      session({ sessionId: 'oldest', lastContact: NOW - 3 * HOUR }),
      session({ sessionId: 'newest', lastContact: NOW - 1 * HOUR }),
      session({ sessionId: 'middle', lastContact: NOW - 2 * HOUR }),
    ]
    const { enRoute } = splitByBoard(snap(rows), withLimit({ enRoute: 2 }))
    expect(enRoute.map((s) => s.sessionId)).toEqual(['newest', 'middle'])
  })

  it('orders by last contact, newest first', () => {
    const rows = [
      session({ sessionId: 'b', lastContact: NOW - 2 * HOUR }),
      session({ sessionId: 'c', lastContact: NOW - 3 * HOUR }),
      session({ sessionId: 'a', lastContact: NOW - 1 * HOUR }),
    ]
    expect(
      splitByBoard(snap(rows), withLimit({ enRoute: 10 })).enRoute.map((s) => s.sessionId),
    ).toEqual(['a', 'b', 'c'])
  })

  it('counts what the limit trimmed rather than dropping it silently', () => {
    // A board that shrinks without saying so reads as complete when it is not.
    const rows = Array.from({ length: 5 }, (_, i) =>
      session({ sessionId: `s${i}`, lastContact: NOW - i * HOUR }),
    )
    const { enRoute, trimmed, olderCount } = splitByBoard(snap(rows), withLimit({ enRoute: 2 }))
    expect(enRoute).toHaveLength(2)
    expect(trimmed.enRoute).toBe(3)
    // Reported per board rather than folded into olderCount, which means something
    // else: a session on no board at all. A trimmed row is on this board and hidden,
    // and the footer has to be able to say which of the two happened.
    expect(olderCount).toBe(0)
  })

  it('survives a nonsensical limit rather than rendering a negative slice', () => {
    // The main process clamps this, but the board must not depend on that holding.
    expect(splitByBoard(snap([session()]), withLimit({ enRoute: 0 })).enRoute).toHaveLength(0)
    expect(splitByBoard(snap([session()]), withLimit({ enRoute: -5 })).enRoute).toHaveLength(0)
  })
})

describe('APPROACH', () => {
  it('claims a session with an unmerged, human-reviewed PR', () => {
    const { approach, enRoute } = split([session({ prs: [pr({ humanReviewed: true })] })])
    expect(approach).toHaveLength(1)
    expect(enRoute).toHaveLength(0)
  })

  it('takes a PR nobody has reviewed yet', () => {
    // The hole this closed. Requiring a review left an unreviewed PR on no board at
    // all — APPROACH refused it, EN ROUTE dropped it once its session went quiet.
    // Four real PRs were invisible that way, two of them for nine days.
    const { approach, enRoute } = split([session({ prs: [pr({ humanReviewed: false })] })])
    expect(approach).toHaveLength(1)
    expect(enRoute).toHaveLength(0)
  })

  it('keeps an unreviewed PR even after its session dies and ages out', () => {
    // The exact shape of the lost rows: work finished days ago, terminal closed,
    // nobody has looked. The PR is the live thing, not the session.
    const { approach } = split([
      session({
        transponder: 'no-contact',
        lastContact: NOW - 200 * HOUR,
        prs: [pr({ humanReviewed: false })],
      }),
    ])
    expect(approach).toHaveLength(1)
  })

  it('outranks a merged sibling', () => {
    const { approach, landed } = split([
      session({
        prs: [
          pr({ number: 1, mergedAt: '2026-08-01T00:00:00Z' }),
          pr({ number: 2, humanReviewed: true }),
        ],
      }),
    ])
    expect(approach).toHaveLength(1)
    expect(landed).toHaveLength(0)
  })

  it('keeps a closed PR that had review activity', () => {
    // Not an oversight. A PR closed for staleness is often one you mean to revive,
    // and the row is the thread back to the session that built it. Removing them
    // wholesale was tried and reverted; dismissing them one at a time is the answer.
    const { approach } = split([
      session({ prs: [pr({ status: 'diverted', humanReviewed: true })] }),
    ])
    expect(approach).toHaveLength(1)
  })

  it('yields to a hold, because parking one is a decision about your next move', () => {
    // Reversed deliberately. "Approved, but I am not merging this yet" is a real
    // state with a real reason to wait, and refusing to park it left the one row
    // with the best reason to be set aside as the only one that could not be.
    const { approach, holding } = split([
      session({ held: true, prs: [pr({ humanReviewed: true })] }),
    ])
    expect(holding).toHaveLength(1)
    expect(approach).toHaveLength(0)
  })
})

describe('LANDED', () => {
  it('takes a session whose PR merged', () => {
    const { landed } = split([session({ prs: [pr({ mergedAt: '2026-08-01T00:00:00Z' })] })])
    expect(landed).toHaveLength(1)
  })

  it('never takes a session that still has an open PR', () => {
    // Found on the live board: two merged PRs and one open-but-unreviewed filed the
    // whole session under "shipped".
    const { landed, enRoute, approach } = split([
      session({
        prs: [
          pr({ number: 1, mergedAt: '2026-08-01T00:00:00Z' }),
          pr({ number: 2, mergedAt: '2026-08-02T00:00:00Z' }),
          pr({ number: 3, status: 'inbound' }),
        ],
      }),
    ])
    expect(landed).toHaveLength(0)
    // Lands on APPROACH now rather than EN ROUTE: the open sibling is unmerged, and
    // that alone is what APPROACH means.
    expect(enRoute).toHaveLength(0)
    expect(approach).toHaveLength(1)
  })

  it('does not count a closed PR as still open', () => {
    const { landed } = split([
      session({
        prs: [
          pr({ number: 1, mergedAt: '2026-08-01T00:00:00Z' }),
          pr({ number: 2, status: 'diverted' }),
        ],
      }),
    ])
    expect(landed).toHaveLength(1)
  })

  it('orders by merge time, not by last contact', () => {
    const older = session({
      sessionId: 'old',
      origin: 'session' as const,
      lastContact: NOW - 1000,
      prs: [pr({ number: 1, mergedAt: '2026-08-05T00:00:00Z' })],
    })
    const newer = session({
      sessionId: 'new',
      origin: 'session' as const,
      lastContact: NOW - 10 * HOUR,
      prs: [pr({ number: 2, mergedAt: '2026-08-09T00:00:00Z' })],
    })
    expect(split([older, newer]).landed.map((s) => s.sessionId)).toEqual(['new', 'old'])
  })
})

describe('one row per pull request', () => {
  it('collapses two sessions that share a PR, keeping the most recent', () => {
    // Two sessions worked #1: the build, then the feedback. The board showed the
    // same title twice with the same review paragraph under it.
    const build = session({
      sessionId: 'build',
      origin: 'session' as const,
      lastContact: NOW - 10 * HOUR,
      prs: [pr({ humanReviewed: true })],
    })
    const feedback = session({
      sessionId: 'feedback',
      origin: 'session' as const,
      lastContact: NOW - 1000,
      prs: [pr({ humanReviewed: true })],
    })
    const { approach, collapsed } = split([build, feedback])
    expect(approach.map((s) => s.sessionId)).toEqual(['feedback'])
    expect(collapsed.approach).toBe(1)
  })

  it('reports what it folded rather than shrinking silently', () => {
    const merged = { mergedAt: '2026-08-01T00:00:00Z' }
    const { landed, collapsed } = split([
      session({ sessionId: 'a', lastContact: NOW - 1000, prs: [pr(merged)] }),
      session({ sessionId: 'b', lastContact: NOW - 2000, prs: [pr(merged)] }),
      session({ sessionId: 'c', lastContact: NOW - 3000, prs: [pr(merged)] }),
    ])
    expect(landed).toHaveLength(1)
    expect(collapsed.landed).toBe(2)
  })

  it('leaves EN ROUTE alone', () => {
    // EN ROUTE now only ever holds sessions with no unmerged PR, so there is no
    // shared key left to collapse on — two sessions there are always two rows.
    // Kept as a guard against oneRowPerPr ever being pointed at this board.
    const { enRoute } = split([session({ sessionId: 'a' }), session({ sessionId: 'b' })])
    expect(enRoute).toHaveLength(2)
  })
})

describe('HOLDING', () => {
  it('takes a parked session out of EN ROUTE', () => {
    const { holding, enRoute } = split([session({ held: true })])
    expect(holding).toHaveLength(1)
    expect(enRoute).toHaveLength(0)
  })

  it('keeps it past the EN ROUTE window — a hold that expires loses what you parked', () => {
    const { holding } = split([session({ held: true, lastContact: NOW - 1000 * HOUR })])
    expect(holding).toHaveLength(1)
  })

  it('takes a parked PR row out of APPROACH', () => {
    // The feature: an approved PR you are not ready to merge.
    const { holding, approach } = split([
      session({ held: true, prs: [pr({ humanReviewed: true, status: 'cleared' })] }),
    ])
    expect(holding).toHaveLength(1)
    expect(approach).toHaveLength(0)
  })

  it('lets a merged PR out of a hold, since there is nothing left to wait for', () => {
    // LANDED is the one thing a hold does not outrank.
    const { landed, holding } = split([
      session({ held: true, prs: [pr({ mergedAt: '2026-08-01T00:00:00Z' })] }),
    ])
    expect(landed).toHaveLength(1)
    expect(holding).toHaveLength(0)
  })

  it('returns a released row to the board it belongs on', () => {
    const reviewed = [pr({ humanReviewed: true })]
    expect(split([session({ held: true, prs: reviewed })]).approach).toHaveLength(0)
    expect(split([session({ held: false, prs: reviewed })]).approach).toHaveLength(1)
  })

  it('keeps it after the process exits, for the same reason', () => {
    const { holding } = split([session({ held: true, transponder: 'no-contact' })])
    expect(holding).toHaveLength(1)
  })
})

describe('the empty snapshot', () => {
  it('returns every board rather than undefined', () => {
    // The renderer destructures all of these on first paint, before any sweep.
    const b = splitByBoard(null)
    expect(b).toEqual({
      enRoute: [],
      holding: [],
      approach: [],
      landed: [],
      olderCount: 0,
      collapsed: { approach: 0, landed: 0 },
      trimmed: { enRoute: 0, holding: 0, approach: 0, landed: 0 },
    })
  })
})

/**
 * Per-board limits.
 *
 * The two queues are unbounded by default and that is the whole point: APPROACH is
 * people waiting on you, where the row a cap would hide is the one that has waited
 * longest, and HOLDING is what you deliberately parked, where a cap discards a decision
 * you made on purpose — the same mistake as the hold that used to expire after eight
 * hours.
 */
describe('limits per board', () => {
  const merged = (n: number) => pr({ number: n, mergedAt: `2026-08-0${n}T00:00:00Z` })

  it('leaves HOLDING and APPROACH uncapped by default', () => {
    const parked = Array.from({ length: 30 }, (_, i) =>
      session({ sessionId: `h${i}`, held: true, lastContact: NOW - i * HOUR }),
    )
    const waiting = Array.from({ length: 30 }, (_, i) =>
      session({ sessionId: `a${i}`, lastContact: NOW - i * HOUR, prs: [pr({ number: 100 + i })] }),
    )
    const { holding, approach, trimmed } = split([...parked, ...waiting])
    expect(holding).toHaveLength(30)
    expect(approach).toHaveLength(30)
    expect(trimmed.holding).toBe(0)
    expect(trimmed.approach).toBe(0)
  })

  it('caps HOLDING when you ask it to, and says how many it hid', () => {
    const parked = Array.from({ length: 5 }, (_, i) =>
      session({ sessionId: `h${i}`, held: true, lastContact: NOW - i * HOUR }),
    )
    const { holding, trimmed } = splitByBoard(snap(parked), withLimit({ holding: 2 }))
    expect(holding.map((s) => s.sessionId)).toEqual(['h0', 'h1'])
    expect(trimmed.holding).toBe(3)
  })

  it('caps APPROACH independently of EN ROUTE', () => {
    const rows = [
      session({ sessionId: 'a', lastContact: NOW - 1 * HOUR, prs: [pr({ number: 1 })] }),
      session({ sessionId: 'b', lastContact: NOW - 2 * HOUR, prs: [pr({ number: 2 })] }),
      session({ sessionId: 'c', lastContact: NOW - 3 * HOUR }),
      session({ sessionId: 'd', lastContact: NOW - 4 * HOUR }),
    ]
    const { approach, enRoute, trimmed } = splitByBoard(
      snap(rows),
      withLimit({ approach: 1, enRoute: 1 }),
    )
    expect(approach.map((s) => s.sessionId)).toEqual(['a'])
    expect(enRoute.map((s) => s.sessionId)).toEqual(['c'])
    expect(trimmed).toMatchObject({ approach: 1, enRoute: 1 })
  })

  it('still bounds LANDED, and by merge time rather than arrival', () => {
    const rows = [1, 2, 3].map((n) =>
      session({ sessionId: `s${n}`, lastContact: NOW - n * HOUR, prs: [merged(n)] }),
    )
    const { landed } = splitByBoard(snap(rows), withLimit({ landed: 2 }))
    // 3 merged latest, so it leads and 1 is the one dropped.
    expect(landed.map((s) => s.sessionId)).toEqual(['s3', 's2'])
  })

  it('shows every merge when LANDED is uncapped', () => {
    const rows = [1, 2, 3].map((n) =>
      session({ sessionId: `s${n}`, lastContact: NOW - n * HOUR, prs: [merged(n)] }),
    )
    const { landed, trimmed } = splitByBoard(snap(rows), withLimit({ landed: null }))
    expect(landed).toHaveLength(3)
    expect(trimmed.landed).toBe(0)
  })
})
