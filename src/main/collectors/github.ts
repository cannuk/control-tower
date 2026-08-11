import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import type { Advisor, PrStatus, Reviewer } from '../../shared/types.js'
import { lastHumanReviewAt, type ReviewEvent } from './review-activity.js'
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
  number title state isDraft reviewDecision mergedAt headRefName
  author { login }
  reviewRequests(first: 1) { totalCount }
  reviews(first: 100) { nodes { state submittedAt author { __typename login } } }
  reviewThreads(first: 100) {
    nodes {
      isResolved isOutdated
      comments(first: 1) { nodes { author { __typename login } } }
      latest: comments(last: 1) { nodes { createdAt author { __typename login } } }
    }
  }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  closedBy: timelineItems(last: 1, itemTypes: [CLOSED_EVENT]) {
    nodes { ... on ClosedEvent { actor { __typename } } }
  }
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
  headRefName: string | null
  author: { login: string } | null
  reviewRequests: { totalCount: number }
  reviews: { nodes: { state: string; submittedAt: string | null; author: Author | null }[] }
  reviewThreads: {
    nodes: {
      isResolved: boolean
      isOutdated: boolean
      /** The thread's opener, which is who the thread belongs to. */
      comments: { nodes: { author: Author | null }[] }
      /** Its newest comment, which is when it last moved. */
      latest: { nodes: { createdAt: string | null; author: Author | null }[] }
    }[]
  }
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] }
  closedBy: { nodes: { actor?: Author | null }[] }
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
 * would be the same class of lie that splitting `cleared` from `cleared-advisory`
 * exists to prevent.
 *
 * `advisories` is passed in rather than recomputed from `pr`, because deciding which
 * threads count means excluding bots and the author, and that filtering belongs with
 * the caller that already does it.
 */
function toStatus(pr: GraphQlPr, advisories: number, reviewers: Reviewer[]): PrStatus {
  if (pr.state === 'MERGED') return 'landed'
  if (pr.state === 'CLOSED') return 'diverted'
  if (pr.isDraft) return 'at-gate'

  const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup?.state
  if (rollup === 'FAILURE' || rollup === 'ERROR') return 'go-around'
  if (rollup === 'PENDING' || rollup === 'EXPECTED') return 'on-final'

  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'hold-short'
  if (pr.reviewDecision === 'APPROVED') return advisories > 0 ? 'cleared-advisory' : 'cleared'

  /**
   * No verdict yet, which is four different situations and used to be one.
   *
   * `reviewers` has already dropped bots and the author, so "somebody looked" means a
   * person other than you posted a review or a comment — which is why a PR only
   * CodeRabbit has touched still counts as unlooked-at.
   */
  if (reviewers.length > 0) return advisories > 0 ? 'in-review' : 're-review'
  return pr.reviewRequests.totalCount > 0 ? 'inbound' : 'unassigned'
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
 * Ask GitHub which of your pull requests are open.
 *
 * The second source of PRs, and the only one that can see a PR no session created.
 * A separate call rather than part of the batched status query, because that query
 * is built *from* the set of PRs we already know — it can only refresh what has
 * already been discovered, never discover anything.
 *
 * Failure is a warning, not an error: losing discovery leaves the board on the
 * link-derived set, which is what it had before this existed.
 */
async function discoverAuthored(gh: string): Promise<string[]> {
  interface SearchResult {
    number: number
    url: string
    updatedAt: string
    headRefName?: string
    repository: { nameWithOwner: string }
  }

  let results: SearchResult[]
  try {
    const { stdout } = await run(
      gh,
      [
        'search',
        'prs',
        '--author=@me',
        '--state=open',
        '--limit=100',
        '--json',
        'number,repository,url,updatedAt',
      ],
      { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
    )
    results = JSON.parse(stdout) as SearchResult[]
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    return [`could not list your open PRs: ${detail.split('\n')[0] ?? detail}`]
  }

  cache.putAuthoredPrs(
    results.map((r) => ({
      repository: r.repository.nameWithOwner,
      number: r.number,
      url: r.url,
      // `gh search prs` does not return the branch, so it is filled in by the status
      // query below, which asks for headRefName on every PR it fetches.
      headRef: null,
      updatedAt: Date.parse(r.updatedAt) || Date.now(),
    })),
  )
  return []
}

/**
 * Refresh every PR that can still change. Returns warnings, never throws — a
 * GitHub outage or a logged-out `gh` should leave the board showing last-known
 * state rather than taking the app down.
 */
export async function refresh(options: { force?: boolean } = {}): Promise<string[]> {
  const gh = findGh()
  if (!gh) return ['gh CLI not found — PR status unavailable']

  // Discovery first, so a PR found this sweep gets its status in the same pass
  // rather than a minute later.
  const warnings = await discoverAuthored(gh)

  const wanted = cache.prsNeedingRefresh(Date.now(), options.force)
  if (wanted.size === 0) return warnings

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
    return [...warnings, `could not read PR status: ${detail.split('\n')[0] ?? detail}`]
  }

  const repositories = [...wanted.keys()]
  const updates: cache.StoredPrStatus[] = []
  const headRefs: { repository: string; number: number; headRef: string }[] = []
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
      /**
       * Who closed it, and only when we are certain it was a person.
       *
       * A PR closed by a stale bot is one you may well revive, and its row is the
       * thread back to the session that built it. A PR you closed yourself is
       * finished business. Measured on a real board: three closed by `pr-stalebot`
       * and three by people, which is exactly the split worth acting on.
       *
       * Only `User` counts as a human close. A null or unrecognised actor stays
       * visible, because the two failures are not symmetrical — an extra chip can be
       * dismissed with one click, while a wrongly hidden PR has no way back except
       * reopening it on GitHub.
       */
      const closedByHuman = pr.closedBy.nodes[0]?.actor?.__typename === 'User'
      if (pr.headRefName) {
        headRefs.push({ repository, number: pr.number, headRef: pr.headRefName })
      }

      const reviewers = reviewersOf(pr)

      /**
       * Every moment somebody could have reviewed this: a posted review, or a comment
       * on any thread — resolved or not, since resolving one is itself a response.
       */
      const events: ReviewEvent[] = [
        ...pr.reviews.nodes.map((r) => ({
          at: r.submittedAt,
          login: r.author?.login,
          isBot: isBot(r.author),
        })),
        ...threads.map((t) => {
          const newest = t.latest.nodes[0]
          return {
            at: newest?.createdAt,
            login: newest?.author?.login,
            isBot: isBot(newest?.author),
          }
        }),
      ]
      const reviewedAt = lastHumanReviewAt(events, pr.author?.login ?? null)

      updates.push({
        repository,
        number: pr.number,
        title: pr.title,
        status: toStatus(pr, unresolved.length, reviewers),
        // Human threads only — see the note on PrRef.advisories.
        advisories: unresolved.length,
        outdatedAdvisories: unresolved.filter((t) => t.isOutdated).length,
        advisors: advisorsOf(unresolved),
        reviewers,
        terminal: pr.state !== 'OPEN',
        // Either signal counts: a posted review, or a thread someone opened.
        // #2453 had 25 open human threads while still reading REVIEW_REQUIRED.
        humanReviewed: reviewers.length > 0 || others.length > 0,
        lastHumanReviewAt: reviewedAt,
        closedByHuman,
        mergedAt: pr.mergedAt,
        fetchedAt: now,
      })
    }
  }

  cache.putPrStatus(updates)
  cache.setAuthoredHeadRefs(headRefs)
  return warnings
}
