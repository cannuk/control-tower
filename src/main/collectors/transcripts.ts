import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import * as cache from '../store/cache.js'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

/**
 * Transcript indexer (PLAN.md §2.2).
 *
 * Each session is one append-only `{sessionId}.jsonl` under a project directory.
 * Two things are read from it: the file mtime, which is last-contact, and
 * `pr-link` records, which are how a session knows about its PRs.
 *
 * Transcripts reach 20MB+ and there are ~100 of them, so they are never fully
 * re-read. Each file's scan position is cached and only the appended tail is
 * parsed. Two details make that safe:
 *
 *   - The offset always lands on a newline. A transcript is being written while
 *     we read it, so the tail is routinely half a JSON object; resuming from a
 *     mid-line offset would corrupt every subsequent parse.
 *   - A file that shrank, or whose mtime moved backwards, is re-scanned from
 *     zero. That means it was truncated or replaced, and the old offset now
 *     points into unrelated content.
 */

export interface TranscriptInfo {
  sessionId: string
  path: string
  mtimeMs: number
  size: number
  /** cwd as recorded inside the transcript — see resolveCwd below. */
  recordedCwd: string | null
}

interface PrLinkRecord {
  type: string
  sessionId?: string
  prNumber?: number
  prUrl?: string
  prRepository?: string
  timestamp?: string
}

/** Every top-level transcript, keyed by session id. */
export function listTranscripts(): { transcripts: Map<string, TranscriptInfo>; warnings: string[] } {
  const transcripts = new Map<string, TranscriptInfo>()
  const warnings: string[] = []

  let projectDirs: string[]
  try {
    projectDirs = readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(PROJECTS_DIR, e.name))
  } catch {
    return { transcripts, warnings: ['no ~/.claude/projects directory'] }
  }

  for (const dir of projectDirs) {
    let files: string[]
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    } catch {
      warnings.push(`unreadable project dir ${basename(dir)}`)
      continue
    }

    for (const file of files) {
      const path = join(dir, file)
      try {
        const stat = statSync(path)
        // Only top-level .jsonl files are sessions; anything deeper is a
        // subagent or sidechain transcript and would inflate the board.
        transcripts.set(basename(file, '.jsonl'), {
          sessionId: basename(file, '.jsonl'),
          path,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          recordedCwd: null,
        })
      } catch {
        /* vanished between readdir and stat; ignore */
      }
    }
  }

  return { transcripts, warnings }
}

/**
 * Read the appended tail of a transcript and return any new PR links.
 *
 * Returns the byte offset consumed so the caller can persist it. The offset is
 * the position just past the last newline seen, never the end of the buffer.
 */
function scanTail(info: TranscriptInfo, from: number): { links: cache.StoredPrLink[]; offset: number } {
  const links: cache.StoredPrLink[] = []
  const toRead = info.size - from
  if (toRead <= 0) return { links, offset: from }

  let fd: number | null = null
  let buffer: Buffer
  try {
    fd = openSync(info.path, 'r')
    buffer = Buffer.allocUnsafe(toRead)
    readSync(fd, buffer, 0, toRead, from)
  } catch {
    return { links, offset: from }
  } finally {
    if (fd !== null) closeSync(fd)
  }

  const text = buffer.toString('utf8')
  const lastNewline = text.lastIndexOf('\n')
  if (lastNewline === -1) return { links, offset: from } // no complete line yet

  // Byte length, not string length — a multi-byte character before the newline
  // would otherwise leave the offset mid-character and desynchronize the file.
  const consumed = Buffer.byteLength(text.slice(0, lastNewline + 1), 'utf8')

  for (const line of text.slice(0, lastNewline).split('\n')) {
    // Cheap reject before JSON.parse: most lines are large assistant messages
    // and parsing all of them would defeat the point of the tail scan.
    if (!line.includes('"pr-link"')) continue
    try {
      const record = JSON.parse(line) as PrLinkRecord
      if (
        record.type === 'pr-link' &&
        typeof record.prNumber === 'number' &&
        typeof record.prUrl === 'string' &&
        typeof record.prRepository === 'string'
      ) {
        links.push({
          sessionId: record.sessionId ?? info.sessionId,
          number: record.prNumber,
          url: record.prUrl,
          repository: record.prRepository,
          firstSeen: record.timestamp ?? new Date().toISOString(),
        })
      }
    } catch {
      /* malformed line; skip it rather than abandoning the scan */
    }
  }

  return { links, offset: from + consumed }
}

/** Bring the PR-link cache up to date for every transcript that changed. */
export function indexPrLinks(transcripts: Map<string, TranscriptInfo>): void {
  const pending: cache.StoredPrLink[] = []

  for (const info of transcripts.values()) {
    const previous = cache.getScan(info.path)

    // Truncated or replaced: the stored offset now points into different content.
    const rewound =
      previous !== null && (info.size < previous.size || info.mtimeMs < previous.mtimeMs)
    const from = previous && !rewound ? previous.offset : 0

    if (previous && !rewound && info.size === previous.size) continue // nothing appended

    const { links, offset } = scanTail(info, from)
    pending.push(...links)
    cache.setScan(info.path, { mtimeMs: info.mtimeMs, size: info.size, offset })
  }

  cache.putPrLinks(pending)
}

/**
 * Recover the real working directory for a project directory name.
 *
 * Claude mangles the cwd into the directory name by replacing both `/` and `_`
 * with `-`, which is not reversible: `my_app` and `my/app` produce the same name.
 * So prefer a decode that actually exists on disk, and treat the registry's cwd
 * as authoritative when it is available.
 */
export function resolveCwd(projectDirName: string, registryCwd: string | null): string {
  if (registryCwd) return registryCwd
  const decoded = '/' + projectDirName.replace(/^-/, '').replace(/-/g, '/')
  return existsSync(decoded) ? decoded : projectDirName
}
