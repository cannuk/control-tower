import { describe, expect, it } from 'vitest'
import { parseGenerated } from './parse.js'

/**
 * Parsing the headless backend's reply.
 *
 * The model is asked for two labelled lines and frequently supplies something else:
 * a preamble, a refusal, a follow-up question, or the answer followed by an offer to
 * help. Each case here is output that was actually observed, and the guards exist
 * because a bad parse does not look like a failure on the board — it looks like a
 * summary, which is worse.
 */

describe('the agreed shape', () => {
  it('reads a title and state', () => {
    expect(
      parseGenerated('TITLE: Fix the upload retry\nSTATE: Retry logic is written and tested.'),
    ).toEqual({ title: 'Fix the upload retry', state: 'Retry logic is written and tested.' })
  })

  it('joins a state that wraps onto two lines', () => {
    // Legitimate: the prompt asks for one or two sentences, and models wrap them.
    const out = parseGenerated('TITLE: A thing\nSTATE: First sentence here.\nSecond one follows.')
    expect(out?.state).toBe('First sentence here. Second one follows.')
  })

  it('is case-insensitive about the labels', () => {
    expect(parseGenerated('title: A thing\nstate: Somewhere in the middle of it.')?.title).toBe(
      'A thing',
    )
  })
})

describe('output that keeps going after the answer', () => {
  it('stops the state at the first blank line', () => {
    // The bug: STATE matched to end of input, so a horizontal rule and a follow-up
    // question were collapsed into the state and shown on a strip.
    const raw = [
      'TITLE: Review PR for security fix',
      'STATE: Checking whether it addresses the issue.',
      '',
      '---',
      '',
      "To proceed, I'll need the PR number. Which PR should I review?",
    ].join('\n')
    const out = parseGenerated(raw)
    expect(out?.state).toBe('Checking whether it addresses the issue.')
    expect(out?.state).not.toContain('---')
    expect(out?.state).not.toContain('Which PR')
  })

  it('caps a runaway state', () => {
    const out = parseGenerated(`TITLE: A thing\nSTATE: ${'x'.repeat(900)}`)
    expect(out?.state?.length).toBe(400)
  })
})

describe('output that is not a summary at all', () => {
  it('rejects a refusal, so the heuristic title stays', () => {
    // Observed verbatim when the excerpt was too thin to summarise.
    const raw =
      "I don't have enough context to write an accurate summary. The opening request is clear, but the most recent turns are too brief."
    expect(parseGenerated(raw)).toBeNull()
  })

  it('rejects a title of more than ten words', () => {
    expect(
      parseGenerated('TITLE: one two three four five six seven eight nine ten eleven'),
    ).toBeNull()
  })

  it('rejects a title over seventy characters', () => {
    expect(parseGenerated(`TITLE: ${'a'.repeat(80)}`)).toBeNull()
  })

  it('rejects empty output', () => {
    expect(parseGenerated('')).toBeNull()
    expect(parseGenerated('   \n  ')).toBeNull()
  })
})

describe('output that ignored the format', () => {
  it('takes a bare first line as the title', () => {
    // A model that drops the labels almost always still leads with the title.
    expect(parseGenerated('Fix the upload retry')).toEqual({
      title: 'Fix the upload retry',
      state: null,
    })
  })

  it('strips surrounding quotes and trailing punctuation', () => {
    expect(parseGenerated('TITLE: "Fix the upload retry."')?.title).toBe('Fix the upload retry')
  })

  it('drops a state too short to be a sentence', () => {
    // Guards against "STATE: ok" and similar becoming a paragraph on a strip.
    expect(parseGenerated('TITLE: A thing\nSTATE: ok')?.state).toBeNull()
  })
})
