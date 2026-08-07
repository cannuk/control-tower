import { closeSync, openSync, readSync, statSync } from 'node:fs'

/**
 * Pull a small, bounded excerpt out of a transcript.
 *
 * Transcripts run to 20MB+, so nothing here reads a whole file. The head read
 * finds the opening user message; the tail read finds what the session is doing
 * now. A titling call needs both — the first message says what was asked, the
 * last few turns say where it ended up — and together they are a few KB.
 */

const HEAD_BYTES = 256 * 1024

/**
 * Tail windows, tried smallest first until enough user turns are found.
 *
 * A fixed window does not work here, and the failure is silent. One assistant
 * turn — a large file read, a long tool result — routinely exceeds 64KB on its
 * own, so a 64KB tail of a multi-megabyte transcript can contain no complete user
 * message at all. Measured: 5 of the 6 largest active sessions returned *nothing*
 * from a 64KB tail, which meant the titler was reading only the opening request
 * on precisely the long-running sessions whose topic had drifted furthest from it.
 *
 * Growing windows keep the common case cheap while making the answer reliable.
 */
const TAIL_WINDOWS = [64 * 1024, 512 * 1024, 4 * 1024 * 1024]

/**
 * Cap for the escalated whole-file scan (see `firstUserMessage`).
 *
 * Only reached when the head window contained no genuine user message, which in
 * practice means a short transcript full of IDE notices. A file larger than this
 * that still has no real message in its first 256KB is pathological, and reading
 * 20MB to maybe find one is not worth it.
 */
const ESCALATE_MAX_BYTES = 4 * 1024 * 1024

interface TranscriptLine {
  type?: string
  message?: { role?: string; content?: unknown }
}

function readRange(path: string, start: number, length: number): string {
  if (length <= 0) return ''
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const buffer = Buffer.allocUnsafe(length)
    const read = readSync(fd, buffer, 0, length, start)
    return buffer.toString('utf8', 0, read)
  } catch {
    return ''
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/** Plain text out of a message's content, which may be a string or a block array. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: string; text: string } => {
      const block = b as { type?: string; text?: unknown }
      return block.type === 'text' && typeof block.text === 'string'
    })
    .map((b) => b.text)
    .join('\n')
}

/**
 * Machine-authored user turns that are not the user speaking.
 *
 * Claude Code injects these into the user role — IDE notices, slash-command
 * plumbing, tool output, page-view notices. Treating one as "what the user asked"
 * produces titles like "The user opened the file Untitled-3 in the IDE", which is
 * worse than no title because it looks like a real summary.
 */
const SYNTHETIC = [
  '<ide_opened_file>',
  '<ide_selection>',
  '<command-name>',
  '<command-message>',
  '<local-command-stdout>',
  '<local-command-stderr>',
  // Tool output routed back through the user role. Measured leaking into a
  // titling input as `<bash-stdout> 612 /tmp/lovesac.jwt</bash-stdout>`, which
  // would have been summarised as though it were a request.
  '<bash-input>',
  '<bash-stdout>',
  '<bash-stderr>',
  '<function_results>',
  '<tool_use_error>',
  '<system-reminder>',
  '<user-prompt-submit-hook>',
  '<post-tool-use-hook>',
  'Caveat: The messages below were generated',
  'This session is being continued from a previous conversation',
  '[Request interrupted by user',
]

function isSynthetic(text: string): boolean {
  const head = text.trimStart().slice(0, 200)
  return SYNTHETIC.some((marker) => head.includes(marker))
}

function scanForUserMessage(text: string): string | null {
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue
    let parsed: TranscriptLine
    try {
      parsed = JSON.parse(line) as TranscriptLine
    } catch {
      continue // truncated final line of the window
    }
    if (parsed.type !== 'user') continue
    const candidate = textOf(parsed.message?.content).trim()
    if (!candidate || isSynthetic(candidate)) continue
    return candidate
  }
  return null
}

/**
 * The first thing the human actually said, or null if they never said anything.
 *
 * A null answer is load-bearing — the board uses it to decide a transcript is not
 * a conversation at all — so it has to be right, not just cheap. The 256KB head
 * window covers essentially every session, but a transcript can open with a long
 * run of IDE notices and only reach a real prompt later: measured on this machine,
 * one 484KB transcript had its first genuine message past the window and would
 * have been wrongly classified as empty and dropped from the board.
 *
 * So: fast path first, and escalate to a full scan only when the fast path finds
 * nothing. That keeps the common case at 256KB while making the null answer
 * trustworthy.
 */
export function firstUserMessage(path: string): string | null {
  const fromHead = scanForUserMessage(readRange(path, 0, HEAD_BYTES))
  if (fromHead) return fromHead

  const size = (() => {
    try {
      return statSync(path).size
    } catch {
      return 0
    }
  })()
  if (size <= HEAD_BYTES || size > ESCALATE_MAX_BYTES) return null

  return scanForUserMessage(readRange(path, 0, size))
}

/**
 * The last few human turns, oldest first — what a session is working on *now*.
 *
 * This is the half of the titling input that the opening request cannot supply. A
 * long session drifts: the terminal's own title for this very session read
 * "Check new day skill status" while the work had moved on entirely. Recent turns
 * are how a summary stays true to that.
 */
export function recentUserMessages(path: string, limit = 3): string[] {
  const size = (() => {
    try {
      return statSync(path).size
    } catch {
      return 0
    }
  })()
  if (size === 0) return []

  let best: string[] = []
  for (const window of TAIL_WINDOWS) {
    const start = Math.max(0, size - window)
    const found = scanBackwards(readRange(path, start, size - start), limit)
    if (found.length > best.length) best = found
    // Stop as soon as the window yields enough, or once it covered the whole file.
    if (found.length >= limit || start === 0) break
  }
  return best.reverse()
}

/** Newest-first user turns from a chunk of transcript, up to `limit`. */
function scanBackwards(text: string, limit: number): string[] {
  const found: string[] = []
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0 && found.length < limit; i -= 1) {
    const line = lines[i]
    if (!line?.startsWith('{')) continue
    let parsed: TranscriptLine
    try {
      parsed = JSON.parse(line) as TranscriptLine
    } catch {
      continue // a line straddling the window boundary
    }
    if (parsed.type !== 'user') continue
    const candidate = textOf(parsed.message?.content).trim()
    if (!candidate || isSynthetic(candidate)) continue
    found.push(candidate.slice(0, 2000))
  }
  return found
}
