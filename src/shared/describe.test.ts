import { describe, expect, it } from 'vitest'
import { describeApproach, describePr } from './describe.js'
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

describe('CI', () => {
  it('is mentioned only when it contradicts the stance', () => {
    const approved = { reviewers: [{ login: 'ada', stance: 'approved' as const }] }
    expect(describePr(pr({ ...approved, status: 'cleared' }))).not.toContain('CI')
    expect(describePr(pr({ ...approved, status: 'go-around' }))).toContain('CI failing')
    expect(describePr(pr({ ...approved, status: 'on-final' }))).toContain('CI still running')
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

  it('claims nothing was resolved when nothing was ever reviewed', () => {
    // "Nothing left to resolve" implies there had been something.
    expect(describePr(pr({ status: 'inbound' }))).toBeNull()
  })
})

describe('a session with several open PRs', () => {
  function session(prs: PrRef[]): Session {
    return {
      sessionId: 's',
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
    const text = describeApproach(
      session([
        pr({ number: 7, humanReviewed: true, reviewers: [{ login: 'ada', stance: 'approved' }] }),
        pr({ number: 9, humanReviewed: false }),
      ]),
    )
    expect(text).toContain('Also open: #9')
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

  it('is null when no PR is on approach at all', () => {
    expect(describeApproach(session([pr({ humanReviewed: false })]))).toBeNull()
  })
})
