import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import type { Advisor, PrStatus, Reviewer } from '../../shared/types.js'
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

/**
 * `author { __typename }` is the whole reason this query grew.
 *
 * GitHub types a review author as `User` or `Bot`, which is the only reliable way
 * to tell a person's review from CodeRabbit's — matching on login would need a
 * hardcoded list of every bot you might install.
 *
 * `login` and review `state` are here so the APPROACH board can say who is waiting
 * on what without a model in the loop. Both come free with authors we were already
 * selecting: the query is one field wider, not one request longer.
 *
 * `reviews` is 100 rather than 30 because a stance has to be the *latest* review
 * per person — someone who requested changes and later approved must not still read
 * as blocking — and a long-running PR accumulates COMMENTED reviews that would
 * otherwise push the decisive ones out of the window.
 */
const FRAGMENT = `
fragment F on PullRequest {
  number title state isDraft reviewDecision mergedAt
  author { login }
  reviews(first: 100) { nodes { state author { __typename login } } }
  reviewThreads(first: 100) {
    nodes {
      isResolved isOutdated
      comments(first: 1) { nodes { author { __typename login } } }
    }
  }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`

interface Author {
  __typename: string
  login?: string
}

interface GraphQlPr {
  number: number
  title: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft: boolean
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  mergedAt: string | null
  author: { login: string } | null
  reviews: { nodes: { state: string; author: Author | null }[] }
  reviewThreads: {
    nodes: {
      isResolved: boolean
      isOutdated: boolean
      comments: { nodes: { author: Author | null }[] }
    }[]
  }
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] }
}

/** A null author is a deleted account — treat as human, not as a bot. */
function isBot(author: Author | null | undefined): boolean {
  return author?.__typename === 'Bot'
}

/** A deleted account still owns its threads, so it needs a name to be counted. */
const loginOf = (author: Author | null | undefined): string => author?.login ?? 'someone'

/**
 * Each human's *current* position, from every review they have posted.
 *
 * Three rules, all load-bearing. Reviews arrive oldest-first, so later ones
 * overwrite earlier ones — otherwise a reviewer who requested changes and then
 * approved would still read as blocking. COMMENTED never overwrites a verdict:
 * GitHub records a plain comment as a review, so a follow-up remark after an
 * approval would otherwise downgrade that approval to "commented". And the author
 * is skipped: GitHub does not let you review your own PR, so every "review" of
 * yours is a comment, and counting it made #2471 read as "cannuk commented, no
 * verdict yet" when in truth nobody had looked at it.
 */
function reviewersOf(pr: GraphQlPr): Reviewer[] {
  const stances = new Map<string, Reviewer['stance']>()
  for (const review of pr.reviews.nodes) {
    if (isBot(review.author)) continue
    const login = loginOf(review.author)
    if (login === pr.author?.login) continue
    if (review.state === 'APPROVED') stances.set(login, 'approved')
    else if (review.state === 'CHANGES_REQUESTED') stances.set(login, 'changes-requested')
    else if (review.state === 'COMMENTED' && !stances.has(login)) stances.set(login, 'commented')
    // DISMISSED and PENDING are deliberately ignored: a dismissed review no longer
    // describes anyone's position, and a pending one has not been posted.
  }
  return [...stances].map(([login, stance]) => ({ login, stance }))
}

/** Unresolved threads grouped by whoever opened them, busiest first. */
function advisorsOf(threads: { isOutdated: boolean; login: string }[]): Advisor[] {
  const byLogin = new Map<string, Advisor>()
  for (const thread of threads) {
    const existing = byLogin.get(thread.login) ?? { login: thread.login, threads: 0, outdated: 0 }
    existing.threads += 1
    if (thread.isOutdated) existing.outdated += 1
    byLogin.set(thread.login, existing)
  }
  return [...byLogin.values()].sort(
    (a, b) => b.threads - a.threads || a.login.localeCompare(b.login),
  )
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

      /**
       * Threads that represent somebody else's feedback.
       *
       * Bots are excluded for the reason on `PrRef.advisories`, and the author for
       * the same reason again one step further: a thread you opened on your own PR
       * is a note to yourself, not something waiting on you. Counting them put PRs
       * nobody had read onto APPROACH and inflated "N unresolved" with your own
       * remarks.
       */
      const threads = pr.reviewThreads.nodes
      const others = threads.filter((t) => {
        const author = t.comments.nodes[0]?.author
        return !isBot(author) && loginOf(author) !== pr.author?.login
      })
      const unresolved = others
        .filter((t) => !t.isResolved)
        .map((t) => ({ isOutdated: t.isOutdated, login: loginOf(t.comments.nodes[0]?.author) }))
      const reviewers = reviewersOf(pr)

      updates.push({
        repository,
        number: pr.number,
        title: pr.title,
        status: toStatus(pr),
        // Human threads only — see the note on PrRef.advisories.
        advisories: unresolved.length,
        outdatedAdvisories: unresolved.filter((t) => t.isOutdated).length,
        advisors: advisorsOf(unresolved),
        reviewers,
        terminal: pr.state !== 'OPEN',
        // Either signal counts: a posted review, or a thread someone opened.
        // #2453 had 25 open human threads while still reading REVIEW_REQUIRED.
        humanReviewed: reviewers.length > 0 || others.length > 0,
        mergedAt: pr.mergedAt,
        fetchedAt: now,
      })
    }
  }

  cache.putPrStatus(updates)
  return []
}
