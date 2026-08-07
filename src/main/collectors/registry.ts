import { execFile } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const SESSIONS_DIR = join(homedir(), '.claude', 'sessions')

/**
 * Live session registry (PLAN.md §2.1).
 *
 * Claude Code writes one file per running CLI to `~/.claude/sessions/{pid}.json`,
 * carrying a `status` heartbeat — far better than inferring activity from file
 * mtimes.
 *
 * Two traps, both of which silently produce wrong answers rather than errors:
 *
 *   1. Entries are not reliably cleaned up, and PIDs get recycled. A stale file
 *      can name a PID that now belongs to something else entirely, so liveness
 *      is confirmed by checking that the PID currently belongs to a `claude`
 *      process — one `ps` for the whole sweep, not one per entry.
 *   2. `procStart` in the file is rendered in **UTC** while `ps -o lstart=` is
 *      **local**. Comparing them as strings reports every session dead (measured:
 *      a 7-hour offset). Nothing here compares them; `startedAt` is epoch ms and
 *      is the only start time used.
 */

export interface RegistryEntry {
  pid: number
  sessionId: string
  cwd: string
  startedAt: number
  version: string
  entrypoint: string
  name: string
  /** Absent on `claude-vscode` entries — those never write a heartbeat. */
  status: 'busy' | 'idle' | null
  updatedAt: number | null
}

/** PIDs that currently belong to a claude process. */
async function livePids(): Promise<Set<number>> {
  const live = new Set<number>()
  try {
    const { stdout } = await run('/bin/ps', ['-Ao', 'pid=,command='], {
      timeout: 5000,
      maxBuffer: 16 * 1024 * 1024,
    })
    for (const line of stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line)
      if (!match?.[1] || !match[2]) continue
      // Match the executable, not the whole line: a session's own argv embeds
      // hook commands that mention `claude`, so a loose test matches unrelated
      // shells and helper processes too.
      if (/\/claude(\s|$)|native-binary\/claude/.test(match[2])) {
        live.add(Number(match[1]))
      }
    }
  } catch {
    /* no ps: fall through and treat nothing as verified */
  }
  return live
}

export async function readRegistry(): Promise<{
  entries: RegistryEntry[]
  warnings: string[]
}> {
  const warnings: string[] = []
  const live = await livePids()

  let files: string[]
  try {
    files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'))
  } catch {
    return { entries: [], warnings: ['no ~/.claude/sessions directory'] }
  }

  const entries: RegistryEntry[] = []
  for (const file of files) {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(join(SESSIONS_DIR, file), 'utf8'))
    } catch {
      warnings.push(`unreadable registry entry ${file}`)
      continue
    }

    const d = raw as Partial<RegistryEntry> & { statusUpdatedAt?: number }
    if (typeof d.pid !== 'number' || typeof d.sessionId !== 'string') continue
    if (!live.has(d.pid)) continue // stale file, or a recycled PID

    entries.push({
      pid: d.pid,
      sessionId: d.sessionId,
      cwd: typeof d.cwd === 'string' ? d.cwd : '',
      startedAt: typeof d.startedAt === 'number' ? d.startedAt : 0,
      version: typeof d.version === 'string' ? d.version : '',
      entrypoint: typeof d.entrypoint === 'string' ? d.entrypoint : '',
      name: typeof d.name === 'string' ? d.name : '',
      status: d.status === 'busy' || d.status === 'idle' ? d.status : null,
      updatedAt: typeof d.updatedAt === 'number' ? d.updatedAt : null,
    })
  }

  return { entries, warnings }
}
