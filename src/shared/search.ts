import { describeApproach } from './describe.js'
import { rowHeadline, type Board, type Departure, type Session } from './types.js'
import type { Boards } from './boards.js'

/**
 * Search across every board at once.
 *
 * The boards answer "where does this sit"; this answers "where did I put that thing".
 * Those are different questions and the tabs cannot serve the second one — finding a
 * session means remembering which board it landed on, which is exactly the fact you
 * have forgotten by the time you are looking for it.
 *
 * Two rules make it worth using rather than a filter on the current tab:
 *
 *   - It searches every board, and reports which one each hit is on. The board is part
 *     of the answer, not a category to pick first.
 *   - It searches rows the boards are *hiding*. A limit trims the oldest rows off
 *     LANDED and EN ROUTE, and a search that inherited that bound would fail to find
 *     precisely the things you can no longer see — the case you most need it for.
 */

/** Which text on a row matched, so a result can say why it is a result. */
export type MatchField = 'title' | 'name' | 'summary' | 'notes' | 'directory'

export type SearchResult =
  | {
      kind: 'session'
      board: Exclude<Board, 'departures'>
      session: Session
      field: MatchField
      snippet: string
    }
  | {
      kind: 'departure'
      board: 'departures'
      departure: Departure
      field: MatchField
      snippet: string
    }

/** One searchable piece of a row: what it is, and the text to match against. */
interface Field {
  field: MatchField
  text: string | null
}

/**
 * Terms, not a phrase.
 *
 * Every whitespace-separated word has to appear somewhere on the row, in any field and
 * any order. Typing "flaky retry" finds a row whose title says flaky and whose summary
 * says retry, which a substring match would miss — and half-remembering two words about
 * a thing is the normal state of looking for it.
 */
function terms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0)
}

/**
 * A window of text around the first term, with ellipses where it was cut.
 *
 * The whole field would be the honest thing to show and the wrong thing: a state line
 * runs to two hundred characters and the result list becomes the board it was meant to
 * summarise. Anchored on the match rather than the start, or a hit in the last sentence
 * of a long summary shows none of it.
 */
const SNIPPET_RADIUS = 44

export function snippetAround(text: string, term: string): string {
  const at = text.toLowerCase().indexOf(term)
  if (at === -1) return text.length > SNIPPET_RADIUS * 2 ? text.slice(0, SNIPPET_RADIUS * 2) : text

  const start = Math.max(0, at - SNIPPET_RADIUS)
  const end = Math.min(text.length, at + term.length + SNIPPET_RADIUS)
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '')
}

/**
 * Does every term appear across these fields, and which field best explains the hit?
 *
 * The reported field is the first one carrying any term, in the order given, so a title
 * match is reported as a title match even when the summary also matches. Fields are
 * ordered by how strongly they identify a row rather than by how likely they are to
 * contain the word.
 */
function match(fields: Field[], wanted: string[]): { field: MatchField; snippet: string } | null {
  const present = fields.filter((f): f is { field: MatchField; text: string } => Boolean(f.text))
  const haystack = present.map((f) => f.text.toLowerCase())
  if (!wanted.every((term) => haystack.some((text) => text.includes(term)))) return null

  for (const [index, field] of present.entries()) {
    const hit = wanted.find((term) => haystack[index]?.includes(term))
    if (hit) return { field: field.field, snippet: snippetAround(field.text, hit) }
  }
  return null
}

/**
 * The state line a strip shows for a session on a given board.
 *
 * Duplicated from the strip's own logic on purpose — it is the text a person can *see*,
 * and searching anything else would find rows by content that is not on screen. Kept
 * narrow: only the two boards that render a state line have one to match.
 */
function stateLine(session: Session, board: Board): string | null {
  if (board === 'approach' || board === 'holding') {
    const composed = describeApproach(session)
    if (composed) return composed
  }
  return session.sessionState
}

/** Every session on the board, with the fields a search may match. */
function sessionFields(session: Session, board: Exclude<Board, 'departures'>): Field[] {
  return [
    { field: 'title', text: rowHeadline(session, board) },
    // The other identity. On a PR-led board this is the session's own name, which is
    // shown beneath the headline and is often the thing you remember it by.
    { field: 'name', text: session.summary },
    { field: 'summary', text: stateLine(session, board) },
    { field: 'directory', text: session.cwd || null },
  ]
}

/**
 * Every row matching the query, in tab order.
 *
 * Tab order rather than relevance. A relevance score would need tuning nobody can see
 * and would reorder the list as you type; going board by board means a result's
 * position is explainable, and the boards you care most about are already leftmost.
 */
export function search(boards: Boards, departures: Departure[], query: string): SearchResult[] {
  const wanted = terms(query)
  if (wanted.length === 0) return []

  const results: SearchResult[] = []

  for (const departure of departures) {
    const hit = match(
      [
        { field: 'title', text: departure.title },
        { field: 'notes', text: departure.notes },
        { field: 'directory', text: departure.cwd },
      ],
      wanted,
    )
    if (hit) results.push({ kind: 'departure', board: 'departures', departure, ...hit })
  }

  const inTabOrder: [Exclude<Board, 'departures'>, Session[]][] = [
    ['holding', boards.holding],
    ['en-route', boards.enRoute],
    ['approach', boards.approach],
    ['landed', boards.landed],
  ]

  for (const [board, sessions] of inTabOrder) {
    for (const session of sessions) {
      const hit = match(sessionFields(session, board), wanted)
      if (hit) results.push({ kind: 'session', board, session, ...hit })
    }
  }

  return results
}
