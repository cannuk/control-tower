import { describe, expect, it } from 'vitest'
import { splitByBoard, type BoardLimits } from './boards.js'
import { search, snippetAround } from './search.js'
import type { Departure, PrRef, Session, SessionSnapshot } from './types.js'

/**
 * Global search.
 *
 * The behaviour worth pinning is not "does substring matching work" but the two rules
 * that make it more than a filter: it spans every board and reports which one each hit
 * came from, and it sees rows the boards are hiding behind a limit.
 */

const NOW = 1_800_000_000_000
const UNBOUNDED: BoardLimits = { enRoute: null, holding: null, approach: null, landed: null }

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
    sessionId: 'aaaaaaaa',
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

const departure = (over: Partial<Departure> = {}): Departure => ({
  id: 1,
  title: 'A filed plan',
  notes: null,
  cwd: null,
  createdAt: NOW,
  position: 0,
  ...over,
})

/** Classify with no limits, the way the app does when searching. */
const boardsOf = (sessions: Session[]) =>
  splitByBoard({ sessions, sweptAt: NOW, warnings: [] } satisfies SessionSnapshot, UNBOUNDED)

const find = (sessions: Session[], query: string, plans: Departure[] = []) =>
  search(boardsOf(sessions), plans, query)

describe('what it matches', () => {
  it('finds a row by its title', () => {
    const hits = find([session({ summary: 'Rework the retry backoff' })], 'backoff')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.field).toBe('title')
  })

  it('is case-insensitive', () => {
    expect(find([session({ summary: 'Rework the RETRY backoff' })], 'retry')).toHaveLength(1)
  })

  it('finds a row by a name you gave it, since that is what you would search for', () => {
    const hits = find(
      [session({ summary: 'Rework the retry backoff', userName: 'flaky one' })],
      'flaky',
    )
    expect(hits[0]?.field).toBe('title')
    expect(hits[0]?.snippet).toBe('flaky one')
  })

  it('finds a row by its summary, which the strip truncates', () => {
    const hits = find([session({ sessionState: 'Waiting on a decision about the cache' })], 'cache')
    expect(hits[0]?.field).toBe('summary')
  })

  it('finds a session by its own name on a PR-led board', () => {
    // On APPROACH the PR titles the row, so the session name is the subtitle — and it is
    // often the thing you remember, because it is what you were doing.
    const hits = find(
      [session({ summary: 'Rework the retry backoff', prs: [pr({ title: 'Bump the client' })] })],
      'backoff',
    )
    expect(hits[0]?.board).toBe('approach')
    expect(hits[0]?.field).toBe('name')
  })

  it('finds a filed plan by its notes', () => {
    const hits = find([], 'migration', [departure({ notes: 'start with the migration' })])
    expect(hits[0]?.kind).toBe('departure')
    expect(hits[0]?.field).toBe('notes')
  })

  it('requires every term, in any field and any order', () => {
    const rows = [session({ summary: 'Rework the retry backoff', sessionState: 'flaky in CI' })]
    expect(find(rows, 'backoff flaky')).toHaveLength(1)
    expect(find(rows, 'flaky backoff')).toHaveLength(1)
    // A phrase match would find this; a terms match must not invent the second word.
    expect(find(rows, 'backoff kubernetes')).toHaveLength(0)
  })

  it('returns nothing for an empty or blank query', () => {
    const rows = [session()]
    expect(find(rows, '')).toEqual([])
    expect(find(rows, '   ')).toEqual([])
  })
})

describe('where the hit is', () => {
  it('reports the board each result came from', () => {
    const hits = find(
      [
        session({ sessionId: 'a', summary: 'widget parked', held: true }),
        session({ sessionId: 'b', summary: 'widget running' }),
        session({ sessionId: 'c', summary: 'widget reviewed', prs: [pr({ number: 9 })] }),
        session({
          sessionId: 'd',
          summary: 'widget shipped',
          prs: [pr({ number: 8, mergedAt: '2026-08-01T00:00:00Z' })],
        }),
      ],
      'widget',
    )
    expect(hits.map((h) => h.board)).toEqual(['holding', 'en-route', 'approach', 'landed'])
  })

  it('lists results in tab order, not in match order', () => {
    const hits = find([session({ summary: 'widget running' })], 'widget', [
      departure({ title: 'widget plan' }),
    ])
    // DEPARTURES is the leftmost tab, so its hit leads however the sessions sort.
    expect(hits.map((h) => h.kind)).toEqual(['departure', 'session'])
  })
})

describe('rows the boards are hiding', () => {
  it('finds a row trimmed off its board by a limit', () => {
    // The case search exists for. With LANDED set to 1, the older merge is not on screen
    // anywhere — and it is still the row you are looking for.
    const rows = [
      session({
        sessionId: 'recent',
        lastContact: NOW - 1000,
        prs: [pr({ number: 2, mergedAt: '2026-08-09T00:00:00Z', title: 'widget one' })],
      }),
      session({
        sessionId: 'older',
        lastContact: NOW - 5000,
        prs: [pr({ number: 1, mergedAt: '2026-08-01T00:00:00Z', title: 'widget two' })],
      }),
    ]
    const snapshot = { sessions: rows, sweptAt: NOW, warnings: [] } satisfies SessionSnapshot

    // What the board shows, versus what search sees.
    expect(splitByBoard(snapshot, { ...UNBOUNDED, landed: 1 }).landed).toHaveLength(1)
    expect(search(splitByBoard(snapshot, UNBOUNDED), [], 'widget')).toHaveLength(2)
  })
})

describe('the snippet', () => {
  it('returns short text whole', () => {
    expect(snippetAround('Rework the retry backoff', 'retry')).toBe('Rework the retry backoff')
  })

  it('windows around the match rather than the start', () => {
    const long =
      'Approved by reviewer-a. 19 unresolved threads — 9 from reviewer-b and 10 from reviewer-c. ' +
      'All of them sit on outdated code about the cache invalidation problem'
    const snippet = snippetAround(long, 'invalidation')
    expect(snippet).toContain('invalidation')
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.length).toBeLessThan(long.length)
  })

  it('marks only the ends it actually cut', () => {
    const text = 'retry backoff ' + 'x'.repeat(200)
    const snippet = snippetAround(text, 'retry')
    expect(snippet.startsWith('…')).toBe(false)
    expect(snippet.endsWith('…')).toBe(true)
  })
})
