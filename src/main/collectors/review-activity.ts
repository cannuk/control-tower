/**
 * When somebody else last reviewed a pull request.
 *
 * This is the signal HOLDING releases on: park a PR while you wait for another round,
 * and it comes back the moment the round arrives. So the question is narrow and the
 * exclusions are the whole of it — "somebody else" means not a bot and **not you**.
 *
 * The author exclusion is not defensive tidying. Resolving threads and replying is
 * exactly what you do right before parking something, and those replies are recorded
 * as reviews and thread comments by the same API. Measured on a real PR: a reviewer
 * approved at 17:51 and the author replied at 22:13 — count the author and every hold
 * releases itself seconds after it is placed, on your own activity.
 *
 * Pure and separate from `github.ts` so it can be tested; that module reaches the
 * network and the cache, which reaches Electron.
 */

export interface ReviewEvent {
  /** ISO timestamp from `submittedAt` or `createdAt`. */
  at: string | null | undefined
  /** GitHub login, or null for a deleted account. */
  login: string | null | undefined
  isBot: boolean
}

/**
 * Epoch ms of the most recent event by someone other than the author or a bot, or
 * null when nobody else has touched it.
 *
 * Unparseable and absent timestamps are skipped rather than treated as now: this
 * value is compared against a hold's age, and a bad parse landing on "now" would
 * release every hold on every sweep.
 */
export function lastHumanReviewAt(
  events: ReviewEvent[],
  authorLogin: string | null,
): number | null {
  let newest: number | null = null

  for (const event of events) {
    if (event.isBot) continue
    if (!event.at) continue
    // A deleted account is still somebody else, so a null login only fails this
    // check when the author's login is also unknown — in which case we cannot tell
    // them apart and the safe answer is to ignore the event.
    if (event.login == null || event.login === authorLogin) continue

    const at = Date.parse(event.at)
    if (Number.isNaN(at)) continue
    if (newest === null || at > newest) newest = at
  }

  return newest
}

/**
 * When a row last changed, across every source that counts as a change.
 *
 * Unread was wired to the transcript's mtime alone, which is only half of what a row
 * is. A session row is also a pull request: somebody approving it, requesting changes,
 * or leaving six threads on it is new activity by any reading of the word, and none of
 * it writes a byte to the transcript. So a PR reviewed while the terminal sat idle
 * stayed marked read, and rows with no session at all — which have no transcript to
 * grow — could never go unread under any circumstances.
 *
 * Review time, not the PR's `updatedAt`. `updatedAt` moves when *you* push, and a row
 * that flags itself because you just committed to it is noise that trains you to
 * ignore the dot. `lastHumanReviewAt` has already excluded you and the bots.
 *
 * Zero when nothing is known, which reads as "no activity ever" and leaves the row
 * read. Callers seed a new row's read mark with this same value, so a PR reviewed long
 * before Control Tower first saw it does not arrive already shouting.
 */
export function lastActivityAt(transcriptAt: number | null, reviewedAt: (number | null)[]): number {
  let newest = transcriptAt ?? 0
  for (const at of reviewedAt) {
    if (at !== null && at > newest) newest = at
  }
  return newest
}
