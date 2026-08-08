import { describe, expect, it } from 'vitest'
import { heuristicTitle } from './heuristic-title.js'

/**
 * The no-model title.
 *
 * The floor under every strip: what shows when no credential is configured, and what
 * LANDED shows permanently. Measured at the time it was written, it produced a usable
 * title for 105 of 108 real sessions — these cases are the rules that got it there,
 * pinned so a later tweak to one regex cannot quietly cost the other 104.
 */

describe('signals that beat the prose', () => {
  it('uses a slash command, which is the clearest signal available', () => {
    expect(heuristicTitle('/new-day-task and then some rambling about it')).toBe('New day task')
  })

  it('prefers a markdown heading, which is already a hand-written title', () => {
    expect(heuristicTitle('# Ship the widget rewrite\n\nHere is a lot of context...')).toBe(
      'Ship the widget rewrite',
    )
  })
})

describe('what survives, and what does not', () => {
  it('keeps a file basename, dropping its path and extension', () => {
    // The basename is usually the subject of the request.
    expect(heuristicTitle('review @docs/beacon-customer-setup-guide.md carefully')).toContain(
      'beacon-customer-setup-guide',
    )
  })

  it('reduces a GitHub PR link to its number', () => {
    const out = heuristicTitle('address the feedback on https://github.com/acme/web-app/pull/2501')
    expect(out).toContain('#2501')
    expect(out).not.toContain('github.com')
  })

  it('keeps a customer hostname but drops its path', () => {
    // "phase 1 for acme.com" — the host is the subject, the path is noise.
    const out = heuristicTitle('run phase 1 for https://acme.com/products/all?page=2')
    expect(out).toContain('acme.com')
    expect(out).not.toContain('products')
  })

  it('drops a code-forge host entirely, since it says nothing about the task', () => {
    const out = heuristicTitle('look at https://github.com/acme/web-app for the config layout')
    expect(out).not.toContain('github')
  })

  it('flattens fenced code rather than titling a session with it', () => {
    const out = heuristicTitle('fix this handler\n```ts\nconst x = 1\n```\nthanks')
    expect(out).not.toContain('const x')
  })
})

describe('trimming to one line', () => {
  it('strips a filler opener', () => {
    expect(heuristicTitle('ok so can you rewrite the parser')).toBe('Rewrite the parser')
  })

  it('stops at the first sentence', () => {
    expect(heuristicTitle('Rewrite the parser. It should also handle nested quotes.')).toBe(
      'Rewrite the parser',
    )
  })

  it('does not split on a version number or a hostname', () => {
    // The sentence rule requires a space after the period, precisely for this.
    expect(heuristicTitle('upgrade to electron 43.3.0 before anything else')).toContain('43.3.0')
  })

  it('truncates on a word boundary, not mid-word', () => {
    const out = heuristicTitle('investigate ' + 'supercalifragilistic '.repeat(8))
    expect(out!.length).toBeLessThanOrEqual(64)
    expect(out).not.toMatch(/supercalifragilisti$/)
  })

  it('capitalises the result', () => {
    expect(heuristicTitle('rewrite the parser')).toBe('Rewrite the parser')
  })
})

describe('nothing usable', () => {
  it('returns null for no message', () => {
    expect(heuristicTitle(null)).toBeNull()
  })

  it('returns null when only filler remains', () => {
    expect(heuristicTitle('ok')).toBeNull()
    expect(heuristicTitle('hey')).toBeNull()
  })
})
