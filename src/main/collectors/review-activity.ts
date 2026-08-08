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
