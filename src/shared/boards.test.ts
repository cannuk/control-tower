import { describe, expect, it } from 'vitest'
import { EN_ROUTE_WINDOW_HOURS, splitByBoard } from './boards.js'
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
    humanReviewed: false,
    mergedAt: null,
    ...over,
  }
}

function session(over: Partial<Session> = {}): Session {
  return {
    sessionId: 'aaaaaaaa-0000-0000-0000-000000000000',
    pid: 1,
    cwd: '/tmp/repo',
    project: 'repo',
    gitBranch: null,
    gitDirty: false,
    summary: 'A session',
    summarySource: 'generated',
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
const split = (sessions: Session[]) => splitByBoard(snap(sessions), NOW)

describe('EN ROUTE', () => {
  it('takes a live session touched inside the window', () => {
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

  it('drops a live session past the window', () => {
    const { enRoute } = split([session({ lastContact: NOW - (EN_ROUTE_WINDOW_HOURS + 1) * HOUR })])
    expect(enRoute).toHaveLength(0)
  })
})

describe('APPROACH', () => {
  it('claims a session with an unmerged, human-reviewed PR', () => {
    const { approach, enRoute } = split([session({ prs: [pr({ humanReviewed: true })] })])
    expect(approach).toHaveLength(1)
    expect(enRoute).toHaveLength(0)
  })

  it('ignores a PR only a bot has touched', () => {
    // humanReviewed is computed upstream with bots and the author excluded; the board
    // must not second-guess it by treating any PR as review activity.
    const { approach, enRoute } = split([session({ prs: [pr({ humanReviewed: false })] })])
    expect(approach).toHaveLength(0)
    expect(enRoute).toHaveLength(1)
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

  it('outranks a hold, because a review is somebody else waiting', () => {
    const { approach, holding } = split([
      session({ held: true, prs: [pr({ humanReviewed: true })] }),
    ])
    expect(approach).toHaveLength(1)
    expect(holding).toHaveLength(0)
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
    const { landed, enRoute } = split([
      session({
        prs: [
          pr({ number: 1, mergedAt: '2026-08-01T00:00:00Z' }),
          pr({ number: 2, mergedAt: '2026-08-02T00:00:00Z' }),
          pr({ number: 3, status: 'inbound' }),
        ],
      }),
    ])
    expect(landed).toHaveLength(0)
    expect(enRoute).toHaveLength(1)
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
      lastContact: NOW - 1000,
      prs: [pr({ number: 1, mergedAt: '2026-08-05T00:00:00Z' })],
    })
    const newer = session({
      sessionId: 'new',
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
      lastContact: NOW - 10 * HOUR,
      prs: [pr({ humanReviewed: true })],
    })
    const feedback = session({
      sessionId: 'feedback',
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

  it('leaves EN ROUTE alone — two sessions toward one PR are two things happening', () => {
    const un = { humanReviewed: false }
    const { enRoute } = split([
      session({ sessionId: 'a', prs: [pr(un)] }),
      session({ sessionId: 'b', prs: [pr(un)] }),
    ])
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
    })
  })
})
