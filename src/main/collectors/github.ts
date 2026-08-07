import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import type { PrStatus } from '../../shared/types.js'
import * as cache from '../store/cache.js'

const run = promisify(execFile)

/**
 * PR state from GitHub (PLAN.md §2.4, §6).
 *
 * Shells out to `gh api graphql`, which means no token is stored here — the CLI
 * already holds the credential.
 *
 * Everything is fetched in **one** query with aliased repositories and pull
 * requests. Measured on a real board: 50 PRs across 7 repos costs **1 point**
 * against a 5,000/hour limit. The plan hedged about rate limits and ETag caching;
 * neither is warranted. (ETags would not have worked anyway — GraphQL is a POST,
 * so there is nothing to condition a request on.) A 60s poll costs ~60 points an
 * hour, about 1% of budget.
 *
 * What *is* worth avoiding is refetching settled PRs: 37 of those 50 were already
 * merged or closed, and those states cannot change. They are cached permanently
 * and dropped from later queries, so the working set shrinks to the PRs that can
 * actually move.
 */

const GH_CANDIDATES = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']

const FRAGMENT = `
fragment F on PullRequest {
  number state isDraft reviewDecision
  reviewThreads(first: 50) { nodes { isResolved isOutdated } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`

interface GraphQlPr {
  number: number
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft: boolean
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  reviewThreads: { nodes: { isResolved: boolean; isOutdated: boolean }[] }
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] }
}

function findGh(): string | null {
  return GH_CANDIDATES.find((p) => existsSync(p)) ?? null
}

/**
 * Resolve one PR to a single status, first match wins (PLAN.md §6).
 *
 * Order is not cosmetic. CI outcome is checked before review decision because a
 * PR that is approved with failing CI is not ready — reporting `APPROVED` there
 * would be the same class of lie the advisory count exists to prevent.
 */
function toStatus(pr: GraphQlPr): PrStatus {
  if (pr.state === 'MERGED') return 'landed'
  if (pr.state === 'CLOSED') return 'diverted'
  if (pr.isDraft) return 'at-gate'

  const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup?.state
  if (rollup === 'FAILURE' || rollup === 'ERROR') return 'go-around'
  if (rollup === 'PENDING' || rollup === 'EXPECTED') return 'on-final'

  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'hold-short'
  if (pr.reviewDecision === 'APPROVED') return 'cleared'
  // A null reviewDecision means no review has been requested or given yet, which
  // is the same actionable state as REVIEW_REQUIRED: nobody has looked.
  return 'inbound'
}

function buildQuery(byRepo: Map<string, number[]>): string {
  let query = 'query {\n'
  let index = 0
  for (const [repository, numbers] of byRepo) {
    const [owner, name] = repository.split('/')
    if (!owner || !name) continue
    query += `  r${index}: repository(owner: "${owner}", name: "${name}") {\n`
    for (const number of numbers) {
      query += `    p${number}: pullRequest(number: ${number}) { ...F }\n`
    }
    query += '  }\n'
    index += 1
  }
  return query + '}\n' + FRAGMENT
}

/**
 * Refresh every PR that can still change. Returns warnings, never throws — a
 * GitHub outage or a logged-out `gh` should leave the board showing last-known
 * state rather than taking the app down.
 */
export async function refresh(): Promise<string[]> {
  const gh = findGh()
  if (!gh) return ['gh CLI not found — PR status unavailable']

  const wanted = cache.prsNeedingRefresh()
  if (wanted.size === 0) return []

  let payload: { data?: Record<string, Record<string, GraphQlPr | null> | null> }
  try {
    const { stdout } = await run(gh, ['api', 'graphql', '-f', `query=${buildQuery(wanted)}`], {
      timeout: 20_000,
      maxBuffer: 32 * 1024 * 1024,
    })
    payload = JSON.parse(stdout) as typeof payload
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    // gh exits non-zero on partial GraphQL errors (e.g. one repo you cannot see)
    // even though the rest of the data is present, so this is a warning, not a
    // failure — the next poll retries.
    return [`could not read PR status: ${detail.split('\n')[0] ?? detail}`]
  }

  const repositories = [...wanted.keys()]
  const updates: cache.StoredPrStatus[] = []
  const now = Date.now()

  for (const [alias, repoData] of Object.entries(payload.data ?? {})) {
    if (!repoData) continue
    const repository = repositories[Number(alias.slice(1))]
    if (!repository) continue

    for (const pr of Object.values(repoData)) {
      if (!pr) continue // deleted, or not visible to this account
      const threads = pr.reviewThreads.nodes
      const unresolved = threads.filter((t) => !t.isResolved)
      const status = toStatus(pr)
      updates.push({
        repository,
        number: pr.number,
        status,
        advisories: unresolved.length,
        outdatedAdvisories: unresolved.filter((t) => t.isOutdated).length,
        terminal: pr.state !== 'OPEN',
        fetchedAt: now,
      })
    }
  }

  cache.putPrStatus(updates)
  return []
}
