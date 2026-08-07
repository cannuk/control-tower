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
 * CI, mentioned only when it changes what you would do.
 *
 * A green PR needs no sentence about being green. A failing one does, because
 * "approved" reads as ready and it is not.
 */
function ciClause(status: PrRef['status']): string | null {
  if (status === 'go-around') return 'CI failing'
  if (status === 'on-final') return 'CI still running'
  return null
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
 * luiscarrero-gladly, 10 on outdated code" parses as a fourth entry on first
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
  const clauses = [
    stanceClause(pr.reviewers),
    ciClause(pr.status),
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
