import { describe, expect, it } from 'vitest'
import { newestRealTimestamp } from './last-activity.js'

/**
 * Which transcript entries count as the session speaking.
 *
 * The bug this replaces: unread and EN ROUTE both ran on the transcript file's mtime,
 * and Claude Code appends an `away_summary` recap to every session you were away from
 * when you return. That write lands now and describes a conversation from days ago, so
 * a morning's batch of recaps lit the dot on every row at once. Measured on this
 * machine, 88 of 158 transcripts had an mtime newer than their newest real message —
 * one by 622 hours.
 */

const at = (iso: string) => Date.parse(iso)
const line = (o: Record<string, unknown>) => JSON.stringify(o)

const user = (ts: string, extra: Record<string, unknown> = {}) =>
  line({ type: 'user', message: { content: 'hello' }, timestamp: ts, ...extra })
const assistant = (ts: string) =>
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] }, timestamp: ts })
const away = (ts: string) =>
  line({ type: 'system', subtype: 'away_summary', content: 'Goal was …', timestamp: ts })

describe('what counts as the session speaking', () => {
  it('takes a real exchange', () => {
    const chunk = [user('2026-08-07T10:00:00Z'), assistant('2026-08-07T10:00:09Z')].join('\n')
    expect(newestRealTimestamp(chunk, false)).toBe(at('2026-08-07T10:00:09Z'))
  })

  it('ignores an away_summary appended long afterwards', () => {
    // The exact shape found on disk: the recap is the last line in the file and its
    // own timestamp is older than the write that put it there.
    const chunk = [assistant('2026-08-07T10:00:09Z'), away('2026-08-11T13:24:00Z')].join('\n')
    expect(newestRealTimestamp(chunk, false)).toBe(at('2026-08-07T10:00:09Z'))
  })

  it('ignores a transcript that is nothing but recaps', () => {
    // Answering null is what lets the caller fall back rather than invent a time.
    expect(newestRealTimestamp([away('2026-08-11T13:24:00Z')].join('\n'), false)).toBeNull()
  })

  it('ignores machine-authored entries wearing a conversation type', () => {
    // Command output and system reminders arrive as `user` with isMeta set. They are
    // not you, and they are written by tooling at times you were not present.
    const chunk = [
      assistant('2026-08-07T10:00:09Z'),
      user('2026-08-11T13:24:00Z', { isMeta: true }),
    ].join('\n')
    expect(newestRealTimestamp(chunk, false)).toBe(at('2026-08-07T10:00:09Z'))
  })

  it('ignores the other meta records without naming them', () => {
    // last-prompt and permission-mode are real types seen on disk, and the list will
    // grow. The positive filter means a new one needs no change here.
    const chunk = [
      assistant('2026-08-07T10:00:09Z'),
      line({ type: 'last-prompt', timestamp: '2026-08-11T01:42:00Z' }),
      line({ type: 'permission-mode', timestamp: '2026-08-11T13:24:00Z' }),
    ].join('\n')
    expect(newestRealTimestamp(chunk, false)).toBe(at('2026-08-07T10:00:09Z'))
  })
})

describe('which moment', () => {
  it('takes the newest, not the last line', () => {
    // Entries are usually in order, but nothing guarantees it and a resumed session
    // can interleave.
    const chunk = [
      assistant('2026-08-07T18:00:00Z'),
      assistant('2026-08-07T09:00:00Z'),
      away('2026-08-11T13:00:00Z'),
    ].join('\n')
    expect(newestRealTimestamp(chunk, false)).toBe(at('2026-08-07T18:00:00Z'))
  })

  it('scans past a long run of trailing meta records', () => {
    const recaps: string[] = Array.from({ length: 40 }, () => away('2026-08-11T13:00:00Z'))
    const chunk = [assistant('2026-08-07T10:00:00Z'), ...recaps].join('\n')
    expect(newestRealTimestamp(chunk, false)).toBe(at('2026-08-07T10:00:00Z'))
  })
})

describe('a chunk read from the middle of a file', () => {
  it('drops the leading partial line', () => {
    // A fragment can still carry a whole timestamp from an entry whose type marker
    // was cut off, which would be read as activity that never happened.
    const fragment = '","timestamp":"2026-08-11T13:24:00Z"}'
    const chunk = [fragment, assistant('2026-08-07T10:00:00Z')].join('\n')
    expect(newestRealTimestamp(chunk, true)).toBe(at('2026-08-07T10:00:00Z'))
  })

  it('keeps the first line when the chunk is the whole file', () => {
    expect(newestRealTimestamp(assistant('2026-08-07T10:00:00Z'), false)).toBe(
      at('2026-08-07T10:00:00Z'),
    )
  })

  it('would have been fooled by the fragment without the flag, proving the flag works', () => {
    const fragment = line({ type: 'assistant', timestamp: '2026-08-11T13:24:00Z' })
    const chunk = [fragment, assistant('2026-08-07T10:00:00Z')].join('\n')
    expect(newestRealTimestamp(chunk, false)).toBe(at('2026-08-11T13:24:00Z'))
    expect(newestRealTimestamp(chunk, true)).toBe(at('2026-08-07T10:00:00Z'))
  })
})

describe('bad input', () => {
  it('skips an unparseable timestamp', () => {
    const chunk = [line({ type: 'assistant', timestamp: 'not a date' })].join('\n')
    expect(newestRealTimestamp(chunk, false)).toBeNull()
  })

  it('skips an entry with no timestamp at all', () => {
    expect(newestRealTimestamp(line({ type: 'assistant' }), false)).toBeNull()
  })

  it('returns null for an empty chunk', () => {
    expect(newestRealTimestamp('', false)).toBeNull()
    expect(newestRealTimestamp('\n\n', false)).toBeNull()
  })
})
