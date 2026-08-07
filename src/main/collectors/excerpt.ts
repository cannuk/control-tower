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
const TAIL_BYTES = 64 * 1024

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
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<system-reminder>',
  '<user-prompt-submit-hook>',
  'Caveat: The messages below were generated',
  "This session is being continued from a previous conversation",
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

/** The last few human turns, oldest first — context for a titling call. */
export function recentUserMessages(path: string, limit = 3): string[] {
  const size = (() => {
    try {
      return statSync(path).size
    } catch {
      return 0
    }
  })()
  if (size === 0) return []

  const start = Math.max(0, size - TAIL_BYTES)
  const tail = readRange(path, start, size - start)
  const found: string[] = []

  // Walk backwards: the newest turns are the ones worth keeping when the window
  // holds more than `limit`.
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0 && found.length < limit; i -= 1) {
    const line = lines[i]
    if (!line?.startsWith('{')) continue
    let parsed: TranscriptLine
    try {
      parsed = JSON.parse(line) as TranscriptLine
    } catch {
      continue
    }
    if (parsed.type !== 'user') continue
    const text = textOf(parsed.message?.content).trim()
    if (!text || isSynthetic(text)) continue
    found.push(text.slice(0, 2000))
  }

  return found.reverse()
}
