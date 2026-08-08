import type { Generated } from './types.js'

/**
 * Parse the headless backend's free-text reply.
 *
 * Its own module so it can be tested. `cli.ts` imports `electron` for `app.getPath`,
 * which cannot load outside an Electron process — and this is the part of that file
 * worth testing, because it is the part that has been wrong.
 *
 * Headless mode has no structured-output equivalent, so the reply arrives on the same
 * channel that carries refusals, errors and chatty preambles. Everything here treats
 * the text as untrusted: the agreed shape is `TITLE:` then `STATE:`, and anything
 * that fails to yield a plausible title is discarded so the heuristic stays in place.
 */
export function parseGenerated(raw: string): Generated | null {
  const titleMatch = /^\s*TITLE:\s*(.+)$/im.exec(raw)
  const stateMatch = /^\s*STATE:\s*([\s\S]+)$/im.exec(raw)

  // No labels at all: fall back to treating the first line as the title, which is
  // what a model that ignored the format almost always produces.
  const rawTitle = (titleMatch?.[1] ?? raw.trim().split('\n')[0] ?? '').trim()
  const title = rawTitle.replace(/^["'`]+|["'`.]+$/g, '').trim()

  if (!title) return null
  // A real title is a handful of words. Anything longer is the model explaining
  // itself, declining, or erroring — none of which belong on a strip.
  if (title.length > 70 || title.split(/\s+/).length > 10) return null

  /**
   * The state ends at the first blank line, not at the end of the output.
   *
   * `STATE:` has to match to end-of-string because the state may legitimately be two
   * sentences on two lines — but a model that has answered often keeps going: a
   * horizontal rule, an offer to help, a follow-up question. Taking everything and
   * collapsing whitespace glued all of that into one paragraph, and one strip read
   * "…looking for the reviewer's replies on the PR. --- To proceed with the review,
   * I'll need the PR URL or number. Which PR should I review?".
   *
   * A blank line is the boundary because the answer itself never contains one: two
   * sentences of state are consecutive lines at most.
   */
  const state = ((stateMatch?.[1] ?? '').split(/\n[ \t]*\n/)[0] ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 400)

  return { title, state: state.length > 10 ? state : null }
}
