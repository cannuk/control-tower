import { basename } from 'node:path'
import type { PrRef, Session } from '../../shared/types.js'
import type { AuthoredPr } from '../store/cache.js'

/**
 * Pull requests that no session accounts for.
 *
 * The board learned about PRs only from `pr-link` records, which Claude Code writes
 * when it creates the PR itself. Open one any other way and it was invisible — #2493
 * sat open for over two weeks, mentioned in thirty transcripts and recorded in none.
 * Asking GitHub directly closes that, and this module decides what to do with each
 * answer: attach it to a session that is plainly working on it, or give it a row of
 * its own.
 */

/** A session the PR clearly belongs to, matched on the branch it is checked out on. */
export function sessionOnBranch(sessions: Session[], headRef: string | null): Session | null {
  if (!headRef) return null
  // Most recent wins: a branch can be checked out in several worktrees, and the one
  // you touched last is the one you mean.
  const matches = sessions
    .filter((s) => s.gitBranch === headRef)
    .sort((a, b) => b.lastContact - a.lastContact)
  return matches[0] ?? null
}

/**
 * Where to start a session for a PR that has none.
 *
 * Tried in order of how much each answer actually knows, because the failure mode of
 * a wrong guess is a session opened in the wrong repository:
 *
 *   1. A session already on that branch. Not a guess at all.
 *   2. A directory whose name matches the repository. Cheap and usually right.
 *   3. Where sessions that opened PRs in this repo were running. Right for repos you
 *      work in constantly and wrong for the rest — measured, `looker` and `supernova`
 *      both resolved to the chat-sdk checkout, because that is where you were sitting
 *      when you opened those PRs.
 *
 * Null when none of them apply, which is a question for the user rather than a
 * fourth guess.
 */
export function inferCwd(
  sessions: Session[],
  repository: string,
  headRef: string | null,
): string | null {
  const onBranch = sessionOnBranch(sessions, headRef)
  if (onBranch) return onBranch.cwd

  const repoName = repository.split('/')[1]
  if (repoName) {
    const byName = sessions
      .filter((s) => basename(s.cwd) === repoName)
      .sort((a, b) => b.lastContact - a.lastContact)[0]
    if (byName) return byName.cwd
  }

  const counts = new Map<string, number>()
  for (const s of sessions) {
    if (!s.prs.some((pr) => pr.repository === repository)) continue
    counts.set(s.cwd, (counts.get(s.cwd) ?? 0) + 1)
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  return best?.[0] ?? null
}

/** The synthetic session id a PR row carries. Parsed back by the tune handler. */
export const prSessionId = (repository: string, number: number): string =>
  `pr:${repository}#${number}`

export function parsePrSessionId(id: string): { repository: string; number: number } | null {
  const match = /^pr:(.+)#(\d+)$/.exec(id)
  if (!match?.[1] || !match[2]) return null
  return { repository: match[1], number: Number(match[2]) }
}

/**
 * Build a row for a PR with no session behind it.
 *
 * A `Session` rather than a new shape, so it flows through board classification,
 * headline resolution, the review paragraph and the strip untouched. The board is
 * already PR-first on APPROACH — it names rows after the pull request and describes
 * them from review data — so a row with no session is barely a special case there.
 *
 * `transponder: 'no-contact'` is literally true: no process, and the session field
 * dims itself accordingly. `origin` is what the tune handler branches on, rather than
 * inferring from a null transcript, because that would couple two unrelated facts.
 */
export function prSession(pr: AuthoredPr, ref: PrRef, cwd: string | null): Session {
  return {
    sessionId: prSessionId(pr.repository, pr.number),
    origin: 'pull-request',
    pid: null,
    cwd: cwd ?? '',
    project: pr.repository.split('/')[1] ?? pr.repository,
    gitBranch: pr.headRef,
    gitDirty: false,
    summary: ref.title ?? `#${pr.number}`,
    summarySource: null,
    // Filled in by the snapshot, which owns the name table.
    userName: null,
    sessionState: null,
    fallbackName: `#${pr.number}`,
    transponder: 'no-contact',
    // The PR's own last activity, so it sorts among real rows by when it last moved.
    lastContact: pr.updatedAt,
    startedAt: null,
    transcriptPath: null,
    prs: [ref],
    location: null,
    unread: false,
    held: false,
  }
}
