import {
  headlinePr,
  isOpen,
  type Advisor,
  type PrRef,
  type Reviewer,
  type Session,
} from './types.js'

/**
 * Plain-English state for an APPROACH row, composed from data rather than guessed.
 *
 * EN ROUTE needs a model because "what is this session doing" only exists in the
 * transcript as prose. APPROACH does not: everything that decides whether the row
 * needs you is already structured — the review decision, who posted it, how many
 * threads are unresolved and whose they are. Asking an LLM to restate that would be
 * slower, cost usage, and be capable of being wrong about a number we already hold.
 *
 * So this is deterministic and exact. It says only what the GraphQL response
 * supports, and it is the same sentence every time for the same state.
 */

/** Join logins the way a person would: "a", "a and b", "a, b and c". */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * Where the humans landed, or null when nobody has posted a review.
 *
 * Null is a real state on this board, not a gap: a PR reaches APPROACH on thread
 * activity alone, so someone can have left six comments without ever pressing
 * Approve or Request changes.
 */
function stanceClause(reviewers: Reviewer[]): string | null {
  const by = (stance: Reviewer['stance']): string[] =>
    reviewers.filter((r) => r.stance === stance).map((r) => r.login)

  // Changes requested outranks an approval: if one person is blocking, that is the
  // state of the PR regardless of who else signed off.
  const blocking = by('changes-requested')
  if (blocking.length > 0) return `Changes requested by ${joinNames(blocking)}`

  const approved = by('approved')
  if (approved.length > 0) return `Approved by ${joinNames(approved)}`

  // Phrased to lead with a capitalised word rather than a login. Every clause here
  // does, which is what lets the sentence be assembled without capitalising its
  // first character — "Cannuk commented" is a different person from `cannuk`.
  const commented = by('commented')
  if (commented.length > 0) return `Comments from ${joinNames(commented)}, no verdict yet`

  return null
}

/**
 * How many failing checks to name before summarising the rest.
 *
 * Same reason as the advisor cap: past three the names stop fitting on a strip, and a
 * PR failing eight checks has one problem rather than eight.
 */
const MAX_NAMED_CHECKS = 3

/**
 * Checks, mentioned only when they change what you would do, and named when they do.
 *
 * A green PR needs no sentence about being green. A failing one does, because
 * "approved" reads as ready and it is not — but "CI failing" was wrong about most of
 * them. Measured across the open PRs on this account, three of the four red ones were
 * failing only `labels` and `ticket`: merge requirements with nothing built or broken.
 * Reading that as a broken build sends you to a CI log to find an unfilled field.
 *
 * So it names them instead of classifying them. There is no dependable way to tell a
 * policy gate from a build gate — both arrive through both of GitHub's check APIs, and
 * `ci-passes` is a commit status that really is about CI — but the name alone is
 * enough for you to know which it is.
 */
function ciClause(status: PrRef['status'], failing: string[]): string | null {
  if (status === 'on-final') return 'Checks still running'
  if (status !== 'go-around') return null

  // The names can be missing on a row cached before they were collected, or when the
  // rollup is red without any individual context saying so. The generic sentence is
  // still true, so it stays as the floor rather than the row going silent about it.
  if (failing.length === 0) return 'Checks failing'

  const named = failing.slice(0, MAX_NAMED_CHECKS)
  const rest = failing.length - named.length
  const list = rest > 0 ? `${named.join(', ')} and ${plural(rest, 'other')}` : joinNames(named)
  return `Failing ${list}`
}

/**
 * How many advisors to name before summarising the rest.
 *
 * Three is where the sentence stops being scannable: #2538 has threads from three
 * people and already runs to two lines on a strip. Beyond that the names stop being
 * the point — the count is.
 */
const MAX_NAMED_ADVISORS = 3

/** How many threads are left and whose they are — the actionable part. */
function threadClause(advisories: number, advisors: Advisor[], hadReview: boolean): string | null {
  if (advisories === 0) {
    // Only worth saying when somebody has reviewed. On a PR with no review and no
    // threads there is nothing to have resolved, and "nothing left to resolve"
    // would imply there had been.
    return hadReview ? 'Nothing left to resolve' : null
  }

  // Named breakdown when we know it. `advisors` can be empty for a PR cached before
  // this data was collected, so the total still has to stand on its own.
  if (advisors.length === 0) return plural(advisories, 'unresolved thread')

  const total = plural(advisories, 'unresolved thread')
  if (advisors.length === 1 && advisors[0]) return `${total} from ${advisors[0].login}`

  const named = advisors.slice(0, MAX_NAMED_ADVISORS)
  const rest = advisors.slice(MAX_NAMED_ADVISORS)
  const parts = named.map((a) => `${a.threads} from ${a.login}`)
  if (rest.length > 0) {
    parts.push(
      `${rest.reduce((sum, a) => sum + a.threads, 0)} from ${plural(rest.length, 'other')}`,
    )
  }
  return `${total} — ${joinNames(parts)}`
}

/**
 * Outdated threads, as their own clause rather than trailing the breakdown.
 *
 * Appended to the per-author list it read as one more author: "…4 from
 * reviewer-c, 10 on outdated code" parses as a fourth entry on first
 * glance. It earns a mention because outdated threads are usually nits already
 * dealt with, so ten of nineteen changes what the number means.
 */
function outdatedClause(advisories: number, advisors: Advisor[]): string | null {
  const outdated = advisors.reduce((sum, a) => sum + a.outdated, 0)
  if (outdated === 0) return null
  if (outdated === advisories) return 'All of them sit on outdated code'
  return `${outdated} of those sit on outdated code`
}

/**
 * The sentence shown under an APPROACH headline, or null when there is nothing
 * to say beyond what the chips already show.
 */
export function describePr(pr: PrRef): string | null {
  const hadReview = pr.reviewers.length > 0

  /**
   * A closed PR says how it ended and how to undo it.
   *
   * Only bot closures reach the renderer — anything you closed yourself is filtered
   * out upstream — so every one of these is revivable, and the way to revive it is
   * on GitHub rather than in here. Said without naming the closer, because that
   * invariant lives in another module and a sentence should not depend on it.
   */
  if (!isOpen(pr) && pr.mergedAt === null) {
    return 'Closed without merging. Reopen it on GitHub to bring it back.'
  }

  /**
   * Say so when nobody has looked yet, and say which kind of nobody.
   *
   * These rows only reach APPROACH because the board stopped requiring a review, and
   * without this they arrive with a title, a chip and nothing else — the one state
   * where silence is indistinguishable from "we failed to load anything".
   */
  if (!hadReview && pr.advisories === 0) {
    /**
     * Name who was asked, or say that nobody was.
     *
     * "Nobody has looked at this yet" is true of both situations and useless for
     * telling them apart — reported on a PR sitting with three requested reviewers,
     * where it read as though no review had been requested at all. Waiting on three
     * people and needing to pick one are opposite problems.
     *
     * The branch comes from `status`, not from whether names are present: `unassigned`
     * is the authoritative "nobody was asked", and a row that knows a request exists
     * but not who it went to must not claim otherwise. The names only fill the
     * sentence in.
     */
    const opening =
      pr.status === 'unassigned'
        ? 'No reviewer has been requested yet'
        : pr.requestedFrom.length > 0
          ? `Requested from ${joinNames(pr.requestedFrom)}, nobody has looked yet`
          : 'Nobody has looked at this yet'
    const ci = ciClause(pr.status, pr.failingChecks)
    return ci ? `${opening}. ${ci}.` : `${opening}.`
  }

  /**
   * Reviewed and fully resolved: the ball is with them, and saying so is the whole
   * point of separating this from a PR nobody has been asked about.
   */
  if (pr.status === 're-review') {
    const names = pr.reviewers.map((r) => r.login)
    const who = names.length > 0 ? ` from ${joinNames(names)}` : ''
    return `Everything is resolved. Waiting on another look${who}.`
  }

  const clauses = [
    stanceClause(pr.reviewers),
    ciClause(pr.status, pr.failingChecks),
    threadClause(pr.advisories, pr.advisors, hadReview),
    outdatedClause(pr.advisories, pr.advisors),
  ].filter((c): c is string => c !== null)

  if (clauses.length === 0) return null
  // Every clause is written to start capitalised, so nothing is transformed here —
  // upper-casing the first character would rewrite a login when one leads.
  return clauses.join('. ') + '.'
}

/**
 * The APPROACH paragraph for a whole session.
 *
 * Describes the PR the row is named after, then names any other open PR the session
 * carries. Those siblings are why the paragraph cannot just describe one PR and
 * stop: a session with two open PRs shows one headline, and silently omitting the
 * other would make the row look further along than it is.
 */
export function describeApproach(session: Session): string | null {
  const lead = headlinePr(session, 'approach')
  if (!lead) return null

  const described = describePr(lead)
  const others = session.prs.filter((pr) => isOpen(pr) && pr.number !== lead.number)
  if (others.length === 0) return described

  const list = joinNames(others.map((pr) => `#${pr.number}`))
  const also = `Also open: ${list}.`
  return described ? `${described} ${also}` : also
}
