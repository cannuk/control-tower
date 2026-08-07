import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Branch and dirty state per working directory.
 *
 * Split deliberately by cost. The branch comes from reading `.git/HEAD`, which is
 * a few bytes and needs no subprocess, so it runs every sweep. Dirty state needs
 * `git status`, which walks the tree — with ~14 distinct working directories and
 * a sweep on every file change, running that every time would spawn constant
 * subprocesses for a field that decorates one character of UI. So it is cached
 * with a short TTL and refreshed opportunistically.
 *
 * A worktree's `.git` is a file pointing elsewhere, not a directory — several of
 * these sessions run in worktrees, so that case is handled rather than treated as
 * "not a repo".
 */

const DIRTY_TTL_MS = 30_000

const dirtyCache = new Map<string, { dirty: boolean; checkedAt: number }>()

export function branchOf(cwd: string): string | null {
  try {
    let gitPath = join(cwd, '.git')
    if (!existsSync(gitPath)) return null

    // Worktrees and submodules: `.git` is a file containing `gitdir: <path>`.
    // Reading a directory throws, which is how we tell the two apart.
    try {
      const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitPath, 'utf8'))
      if (match?.[1]) gitPath = match[1].trim()
    } catch {
      /* .git is a directory — use it as-is */
    }

    const head = readFileSync(join(gitPath, 'HEAD'), 'utf8').trim()
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    if (ref?.[1]) return ref[1]
    // Detached HEAD: show the short sha rather than nothing.
    return head.slice(0, 7)
  } catch {
    return null
  }
}

export function cachedDirty(cwd: string): boolean {
  return dirtyCache.get(cwd)?.dirty ?? false
}

/** Refresh dirty state for directories whose cached value has expired. */
export async function refreshDirty(cwds: Iterable<string>): Promise<void> {
  const now = Date.now()
  const stale = [...new Set(cwds)].filter((cwd) => {
    const entry = dirtyCache.get(cwd)
    return !entry || now - entry.checkedAt > DIRTY_TTL_MS
  })

  await Promise.all(
    stale.map(async (cwd) => {
      try {
        const { stdout } = await run(
          '/usr/bin/git',
          ['status', '--porcelain', '--untracked-files=no'],
          { cwd, timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
        )
        dirtyCache.set(cwd, { dirty: stdout.trim().length > 0, checkedAt: Date.now() })
      } catch {
        // Not a repo, or git unavailable. Record the attempt so a broken path is
        // not retried on every sweep.
        dirtyCache.set(cwd, { dirty: false, checkedAt: Date.now() })
      }
    }),
  )
}
