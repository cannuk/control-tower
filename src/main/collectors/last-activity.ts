import { closeSync, openSync, readSync } from 'node:fs'

/**
 * When a session last actually said something.
 *
 * The board took this from the transcript file's mtime, which turns out to be a
 * different question. Claude Code appends an `away_summary` recap to every session you
 * were away from when you come back, and that write lands *now* while the record it
 * writes is about a conversation from days ago. Measured across this machine: 88 of
 * 158 transcripts had an mtime newer than their newest real message, one of them by
 * 622 hours. So a morning's batch of recaps made every session look like it had just
 * spoken — lighting the unread dot on rows nobody had touched, and feeding a bogus
 * "last seen" into EN ROUTE's window.
 *
 * The content knows better than the filesystem, so the timestamp comes from the newest
 * real entry instead.
 */

/**
 * Entry types that count as the session speaking.
 *
 * A positive list, not a list of things to skip. The meta records are open-ended —
 * `away_summary` is merely the one that caused this, alongside `last-prompt`,
 * `permission-mode` and whatever ships next — and excluding them one by one means the
 * next addition silently becomes activity again. Conversation is only ever `user` or
 * `assistant`, so anything else is not it.
 */
const REAL_TYPES = ['"type":"user"', '"type":"assistant"']

/**
 * Newest real-entry timestamp in a chunk of JSONL, or null if it holds none.
 *
 * The maximum, not the last line. Entries are appended in order almost always, and
 * "almost" is doing real work there — a resumed session and an interleaved sidechain
 * both put an older timestamp after a newer one, and stopping at the first hit from
 * the end would report the older. Scanning the whole chunk costs nothing worth saving:
 * the read is capped at a few hundred kilobytes and the timestamp comes out by regex
 * rather than `JSON.parse`, which is the expense actually worth avoiding on entries
 * that carry whole tool results.
 *
 * `partial` marks a chunk taken from the middle of a file, whose first line is a
 * fragment. Dropping it matters, and matters more under maximum semantics: a truncated
 * line can carry an intact `"timestamp":"…"` belonging to an entry whose type marker
 * was cut off, and that stray value would win.
 */
export function newestRealTimestamp(chunk: string, partial: boolean): number | null {
  const lines = chunk.split('\n')
  let newest: number | null = null

  for (let i = partial ? 1 : 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue

    // isMeta marks a machine-authored entry wearing a conversation type: command
    // output, a system reminder, a hook's notice. Not the session speaking.
    if (line.includes('"isMeta":true')) continue
    if (!REAL_TYPES.some((t) => line.includes(t))) continue

    const match = /"timestamp":"([^"]+)"/.exec(line)
    if (!match?.[1]) continue

    const at = Date.parse(match[1])
    if (!Number.isNaN(at) && (newest === null || at > newest)) newest = at
  }

  return newest
}

/** First window read from the tail. Comfortably more than one exchange. */
const WINDOW = 128 * 1024

/**
 * How far back to keep looking before giving up.
 *
 * A transcript whose last 2MB contains no conversation at all is not a session that
 * has gone quiet — it is one being written by something other than a conversation,
 * and no amount of further reading produces an answer worth the I/O.
 */
const MAX_WINDOW = 2 * 1024 * 1024

/**
 * Read backwards from the end of a transcript for its newest real timestamp.
 *
 * Null when the file cannot be read or holds no conversation in range, which the
 * caller answers by falling back to mtime — a wrong clock being better than no row.
 */
export function lastActivityAt(path: string, size: number): number | null {
  let window = WINDOW

  while (true) {
    const from = Math.max(0, size - window)
    const length = size - from
    if (length <= 0) return null

    let fd: number | null = null
    let buffer: Buffer
    try {
      fd = openSync(path, 'r')
      buffer = Buffer.allocUnsafe(length)
      readSync(fd, buffer, 0, length, from)
    } catch {
      return null
    } finally {
      if (fd !== null) closeSync(fd)
    }

    const at = newestRealTimestamp(buffer.toString('utf8'), from > 0)
    if (at !== null) return at

    // Nothing found: widen, unless the whole file has already been read or the cap
    // has been reached.
    if (from === 0 || window >= MAX_WINDOW) return null
    window = Math.min(window * 8, MAX_WINDOW)
  }
}

/**
 * Cached per file identity, because a sweep runs every few seconds over 150-odd
 * transcripts and the answer only changes when the file does. Keyed on size and
 * mtime together: either moving means new bytes worth reading.
 */
const memo = new Map<string, { size: number; mtimeMs: number; at: number | null }>()

export function cachedLastActivityAt(path: string, size: number, mtimeMs: number): number | null {
  const hit = memo.get(path)
  if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.at

  const at = lastActivityAt(path, size)
  memo.set(path, { size, mtimeMs, at })
  return at
}
