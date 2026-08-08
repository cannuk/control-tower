import { describe, expect, it } from 'vitest'
import { lastHumanReviewAt, type ReviewEvent } from './review-activity.js'

/**
 * When somebody else last reviewed a pull request.
 *
 * This value releases a hold, so a wrong answer is not cosmetic in either direction:
 * too eager and a hold empties itself seconds after you place it, too reluctant and a
 * PR you are waiting on never comes back.
 */

const at = (iso: string) => Date.parse(iso)
const event = (over: Partial<ReviewEvent> = {}): ReviewEvent => ({
  at: '2026-08-07T12:00:00Z',
  login: 'reviewer',
  isBot: false,
  ...over,
})

describe('who counts', () => {
  it('takes a review from someone else', () => {
    expect(lastHumanReviewAt([event()], 'author')).toBe(at('2026-08-07T12:00:00Z'))
  })

  it('ignores the author', () => {
    // The trap, measured on a real PR: a reviewer approved at 17:51 and the author
    // replied at 22:13. Counting the author releases every hold on your own replies,
    // which is exactly what you do just before parking something.
    const events = [
      event({ login: 'reviewer', at: '2026-08-07T17:51:58Z' }),
      event({ login: 'author', at: '2026-08-07T22:13:30Z' }),
    ]
    expect(lastHumanReviewAt(events, 'author')).toBe(at('2026-08-07T17:51:58Z'))
  })

  it('ignores bots', () => {
    const events = [event({ login: 'coderabbit', isBot: true, at: '2026-08-08T00:00:00Z' })]
    expect(lastHumanReviewAt(events, 'author')).toBeNull()
  })

  it('returns null when only the author and bots have touched it', () => {
    const events = [event({ login: 'author' }), event({ login: 'bot', isBot: true })]
    expect(lastHumanReviewAt(events, 'author')).toBeNull()
  })
})

describe('which moment', () => {
  it('takes the newest, not the last in the list', () => {
    const events = [
      event({ at: '2026-08-07T09:00:00Z' }),
      event({ at: '2026-08-07T18:00:00Z' }),
      event({ at: '2026-08-07T11:00:00Z' }),
    ]
    expect(lastHumanReviewAt(events, 'author')).toBe(at('2026-08-07T18:00:00Z'))
  })

  it('takes the newest across reviews and thread comments alike', () => {
    // Resolving a thread is a response too, so both feed the same list.
    const events = [
      event({ login: 'a', at: '2026-08-07T09:00:00Z' }),
      event({ login: 'b', at: '2026-08-07T21:00:00Z' }),
    ]
    expect(lastHumanReviewAt(events, 'author')).toBe(at('2026-08-07T21:00:00Z'))
  })
})

describe('bad input cannot release a hold', () => {
  it('skips a missing timestamp rather than treating it as now', () => {
    expect(lastHumanReviewAt([event({ at: null }), event({ at: undefined })], 'author')).toBeNull()
  })

  it('skips an unparseable timestamp', () => {
    expect(lastHumanReviewAt([event({ at: 'not a date' })], 'author')).toBeNull()
  })

  it('ignores an event with no login when the author is unknown', () => {
    // A deleted account is still somebody else, but with no author to compare
    // against there is no way to be sure, and guessing would release the hold.
    expect(lastHumanReviewAt([event({ login: null })], null)).toBeNull()
  })

  it('counts a deleted account when the author is known', () => {
    expect(lastHumanReviewAt([event({ login: undefined })], 'author')).toBeNull()
  })

  it('returns null for no events at all', () => {
    expect(lastHumanReviewAt([], 'author')).toBeNull()
  })
})
