import { describe, expect, it } from 'vitest'
import { describeApproach, describePr } from './describe.js'
import { headlinePr } from './types.js'
import type { PrRef, Session } from './types.js'

/**
 * The composed APPROACH sentence.
 *
 * This is the one piece of prose in the app that is assembled rather than generated,
 * which is exactly why it needs tests: a model that says something slightly wrong is
 * a bad summary, but a composer that says something wrong is a bug that will repeat
 * identically forever. Two of these encode mistakes that shipped — a login getting
 * capitalised into a different person's name, and the outdated count reading as one
 * more author in the list.
 */

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
    humanReviewed: true,
    mergedAt: null,
    ...over,
  }
}

describe('review stance', () => {
  it('names who approved', () => {
    expect(describePr(pr({ reviewers: [{ login: 'ada', stance: 'approved' }] }))).toBe(
      'Approved by ada. Nothing left to resolve.',
    )
  })

  it('lets changes-requested outrank an approval', () => {
    // One person blocking is the state of the PR regardless of who else signed off.
    const text = describePr(
      pr({
        reviewers: [
          { login: 'ada', stance: 'approved' },
          { login: 'grace', stance: 'changes-requested' },
        ],
      }),
    )
    expect(text).toContain('Changes requested by grace')
    expect(text).not.toContain('Approved')
  })

  it('never capitalises a login', () => {
    // The bug: sentence-casing the first clause turned `cannuk` into `Cannuk`, which
    // is a different account. Every clause is written to start with a capital word
    // instead, so nothing is transformed.
    const text = describePr(pr({ reviewers: [{ login: 'ada', stance: 'commented' }] }))
    expect(text).toContain('ada')
    expect(text).not.toContain('Ada')
  })

  it('says nothing about a stance when nobody has posted a review', () => {
    // A PR reaches APPROACH on thread activity alone.
    const text = describePr(
      pr({ advisories: 2, advisors: [{ login: 'ada', threads: 2, outdated: 0 }] }),
    )
    expect(text).toBe('2 unresolved threads from ada.')
  })
})

describe('checks', () => {
  it('are mentioned only when they contradict the stance', () => {
    const approved = { reviewers: [{ login: 'ada', stance: 'approved' as const }] }
    expect(describePr(pr({ ...approved, status: 'cleared' }))).not.toContain('Checks')
    expect(describePr(pr({ ...approved, status: 'go-around' }))).toContain('Checks failing')
    expect(describePr(pr({ ...approved, status: 'on-final' }))).toContain('Checks still running')
  })

  it('names what is failing, because most red PRs are not broken builds', () => {
    // The reported problem, measured: three of the four red PRs on this account were
    // failing only `labels` and `ticket` — merge requirements with nothing built or
    // broken — and "CI failing" sent you to a CI log to find an unfilled field.
    expect(describePr(pr({ status: 'go-around', failingChecks: ['labels', 'ticket'] }))).toContain(
      'Failing labels and ticket',
    )
  })

  it('reads the same way for a real build failure, which is the point', () => {
    // No category is asserted either way. The name is what tells you which it is.
    expect(
      describePr(pr({ status: 'go-around', failingChecks: ['typecheck', 'build'] })),
    ).toContain('Failing typecheck and build')
  })

  it('summarises past three rather than listing everything', () => {
    const text = describePr(pr({ status: 'go-around', failingChecks: ['a', 'b', 'c', 'd', 'e'] }))
    expect(text).toContain('Failing a, b, c and 2 others')
  })

  it('falls back to the generic sentence when the names are unknown', () => {
    // A row cached before the names were collected, or a rollup that is red without
    // any single context admitting it. Still true, so it is not dropped.
    expect(describePr(pr({ status: 'go-around', failingChecks: [] }))).toContain('Checks failing')
  })
})

describe('threads', () => {
  it('names a single advisor inline', () => {
    expect(
      describePr(pr({ advisories: 4, advisors: [{ login: 'ada', threads: 4, outdated: 0 }] })),
    ).toBe('4 unresolved threads from ada.')
  })

  it('breaks several advisors down, busiest first', () => {
    expect(
      describePr(
        pr({
          advisories: 9,
          advisors: [
            { login: 'ada', threads: 5, outdated: 0 },
            { login: 'grace', threads: 4, outdated: 0 },
          ],
        }),
      ),
    ).toBe('9 unresolved threads — 5 from ada and 4 from grace.')
  })

  it('summarises past three advisors rather than listing everyone', () => {
    const text = describePr(
      pr({
        advisories: 10,
        advisors: [
          { login: 'a', threads: 4, outdated: 0 },
          { login: 'b', threads: 3, outdated: 0 },
          { login: 'c', threads: 2, outdated: 0 },
          { login: 'd', threads: 1, outdated: 0 },
        ],
      }),
    )
    expect(text).toContain('1 from 1 other')
    expect(text).not.toContain('from d')
  })

  it('puts outdated in its own clause, not trailing the author list', () => {
    // Appended to the breakdown, "10 on outdated code" parsed as a fourth author.
    const text = describePr(
      pr({
        advisories: 9,
        advisors: [
          { login: 'ada', threads: 5, outdated: 3 },
          { login: 'grace', threads: 4, outdated: 2 },
        ],
      }),
    )
    expect(text).toContain('. 5 of those sit on outdated code.')
  })

  it('says all of them when every thread is outdated', () => {
    expect(
      describePr(pr({ advisories: 2, advisors: [{ login: 'ada', threads: 2, outdated: 2 }] })),
    ).toContain('All of them sit on outdated code')
  })

  it('says nobody has looked rather than claiming nothing was resolved', () => {
    // "Nothing left to resolve" implies there had been something. These rows reach
    // APPROACH with no review and no threads, and silence there is indistinguishable
    // from having failed to load anything.
    expect(describePr(pr({ status: 'inbound' }))).toBe('Nobody has looked at this yet.')
  })

  it('still reports the failing checks on a PR nobody has looked at', () => {
    expect(describePr(pr({ status: 'go-around', failingChecks: ['ticket'] }))).toBe(
      'Nobody has looked at this yet. Failing ticket.',
    )
  })
})

describe('a session with several open PRs', () => {
  function session(prs: PrRef[]): Session {
    return {
      sessionId: 's',
      origin: 'session' as const,
      pid: null,
      cwd: '/tmp',
      project: 'repo',
      gitBranch: null,
      gitDirty: false,
      summary: 's',
      summarySource: 'generated',
      sessionState: null,
      fallbackName: 'repo',
      transponder: 'idle',
      lastContact: 0,
      startedAt: null,
      transcriptPath: null,
      prs,
      location: null,
      unread: false,
      held: false,
    }
  }

  it('names the siblings, so the row does not look further along than it is', () => {
    // The newest unmerged PR leads, so #9 is described and #7 is the sibling.
    const text = describeApproach(
      session([
        pr({ number: 7, humanReviewed: true, reviewers: [{ login: 'ada', stance: 'approved' }] }),
        pr({ number: 9, humanReviewed: false }),
      ]),
    )
    expect(text).toContain('Also open: #7')
  })

  it('describes the highest-numbered reviewed PR, which is the current work', () => {
    const text = describeApproach(
      session([
        pr({ number: 3, humanReviewed: true, reviewers: [{ login: 'old', stance: 'approved' }] }),
        pr({ number: 8, humanReviewed: true, reviewers: [{ login: 'new', stance: 'approved' }] }),
      ]),
    )
    expect(text).toContain('Approved by new')
  })

  it('is null when every PR has merged', () => {
    // Nothing is on approach once it has landed, so there is no sentence to compose.
    expect(describeApproach(session([pr({ mergedAt: '2026-08-01T00:00:00Z' })]))).toBeNull()
  })
})

describe('a parked PR row', () => {
  it('keeps its PR headline on HOLDING rather than falling back to the session', () => {
    // HOLDING is the one mixed board — rows arrive from EN ROUTE with no PR and from
    // APPROACH with one. Parking a PR row must not cost it the identity you parked
    // it for.
    const s = {
      sessionId: 's',
      origin: 'session' as const,
      pid: null,
      cwd: '/tmp',
      project: 'repo',
      gitBranch: null,
      gitDirty: false,
      summary: 'the session name',
      summarySource: 'generated' as const,
      sessionState: null,
      fallbackName: 'repo',
      transponder: 'idle' as const,
      lastContact: 0,
      startedAt: null,
      transcriptPath: null,
      prs: [pr({ number: 12, humanReviewed: true, title: 'The pull request name' })],
      location: null,
      unread: false,
      held: true,
    }
    expect(headlinePr(s, 'holding')?.title).toBe('The pull request name')
    expect(headlinePr(s, 'holding')?.number).toBe(12)
  })

  it('has no headline on HOLDING when it came from EN ROUTE', () => {
    const s = {
      sessionId: 's',
      origin: 'session' as const,
      pid: null,
      cwd: '/tmp',
      project: 'repo',
      gitBranch: null,
      gitDirty: false,
      summary: 'the session name',
      summarySource: 'generated' as const,
      sessionState: 'doing a thing',
      fallbackName: 'repo',
      transponder: 'idle' as const,
      lastContact: 0,
      startedAt: null,
      transcriptPath: null,
      prs: [],
      location: null,
      unread: false,
      held: true,
    }
    expect(headlinePr(s, 'holding')).toBeNull()
  })
})

describe('a closed pull request', () => {
  it('says how it ended and how to undo it', () => {
    // Every closed PR that reaches the renderer was closed by a bot — the ones you
    // closed yourself are filtered upstream — so all of them are revivable.
    expect(describePr(pr({ status: 'diverted' }))).toBe(
      'Closed without merging. Reopen it on GitHub to bring it back.',
    )
  })

  it('says it even when the closed PR had review activity', () => {
    expect(
      describePr(
        pr({
          status: 'diverted',
          advisories: 3,
          reviewers: [{ login: 'ada', stance: 'commented' }],
        }),
      ),
    ).toContain('Closed without merging')
  })

  it('does not claim a merged PR was closed', () => {
    expect(describePr(pr({ status: 'landed', mergedAt: '2026-08-01T00:00:00Z' }))).not.toContain(
      'Closed',
    )
  })
})

describe('the four awaiting-review states', () => {
  it('distinguishes no reviewer from nobody having looked', () => {
    // The reported confusion: both used to read NEEDS REVIEW, so a PR you had never
    // asked anyone about looked identical to one you were waiting on.
    expect(describePr(pr({ status: 'unassigned' }))).toBe('No reviewer has been requested yet.')
    expect(describePr(pr({ status: 'inbound' }))).toBe('Nobody has looked at this yet.')
  })

  it('names who was asked, so waiting on them differs from having to pick them', () => {
    // The second half of the same confusion, reported on a PR with three requested
    // reviewers: the chip said NEEDS REVIEW and the sentence said nobody had looked,
    // which reads exactly like nobody having been asked.
    expect(
      describePr(
        pr({ status: 'inbound', requestedFrom: ['reviewer-a', 'reviewer-b', 'reviewer-c'] }),
      ),
    ).toBe('Requested from reviewer-a, reviewer-b and reviewer-c, nobody has looked yet.')
  })

  it('does not claim nobody was asked just because we do not know who', () => {
    // A row cached before the names were collected still knows a request exists. The
    // status is authoritative; falling back to "no reviewer" would contradict the chip.
    expect(describePr(pr({ status: 'inbound', requestedFrom: [] }))).toBe(
      'Nobody has looked at this yet.',
    )
  })

  it('names a requested team the same way it names a person', () => {
    expect(describePr(pr({ status: 'inbound', requestedFrom: ['web-platform'] }))).toBe(
      'Requested from web-platform, nobody has looked yet.',
    )
  })

  it('says the ball is back with them once everything is resolved', () => {
    expect(
      describePr(
        pr({
          status: 're-review',
          advisories: 0,
          reviewers: [{ login: 'ada', stance: 'commented' }],
        }),
      ),
    ).toBe('Everything is resolved. Waiting on another look from ada.')
  })

  it('names several reviewers on a re-review', () => {
    expect(
      describePr(
        pr({
          status: 're-review',
          reviewers: [
            { login: 'ada', stance: 'commented' },
            { login: 'grace', stance: 'commented' },
          ],
        }),
      ),
    ).toContain('another look from ada and grace')
  })

  it('keeps the thread breakdown while threads are still open', () => {
    // in-review is your move, so the count and whose it is stay the point.
    const text = describePr(
      pr({
        status: 'in-review',
        advisories: 4,
        advisors: [{ login: 'ada', threads: 4, outdated: 0 }],
        reviewers: [{ login: 'ada', stance: 'commented' }],
      }),
    )
    expect(text).toContain('Comments from ada')
    expect(text).toContain('4 unresolved threads from ada')
  })

  it('still reports failing checks on a PR with no reviewer', () => {
    expect(describePr(pr({ status: 'unassigned' }))).not.toContain('Failing')
    expect(describePr(pr({ status: 'go-around', failingChecks: ['labels'] }))).toContain(
      'Failing labels',
    )
  })
})
