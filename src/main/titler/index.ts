import { statSync } from 'node:fs'
import { firstUserMessage, recentUserMessages } from '../collectors/excerpt.js'
import * as cache from '../store/cache.js'
import * as api from './api.js'
import * as cli from './cli.js'

/**
 * Layer 2 of §8 — Control Tower generating its own session summaries.
 *
 * The provider-agnostic half of the titling story, and the only part that keeps
 * working if you change terminals. It also fixes a subtler problem: a terminal's
 * title is written once and then drifts. cmux titled this project's own session
 * "Check new day skill status" while it was megabytes deep in building Control
 * Tower — accurate for the first question asked, useless as a description of the
 * work. Reading recent turns alongside the opening request is what keeps a summary
 * true as a session moves.
 *
 * Triggered by the file watcher, never by a Claude Code hook. A hook would mean
 * editing your settings.json, colliding with cmux's own Stop hook, and working
 * only for Claude Code.
 */

/**
 * Per-batch caps, split by whether a session has ever been summarised.
 *
 * First summaries and refreshes have different economics and deserve different
 * limits. Filling EN ROUTE is a bounded one-off — ~16 sessions, ~5.6K tokens
 * total — and until it finishes the board shows blank space where the state
 * should be, so it should complete in minutes. Refreshing is unbounded in
 * principle, because an active session changes constantly and would otherwise be
 * due on every sweep, so that is what the interval below exists to rate-limit.
 *
 * Conflating the two is what made the board look broken: the fill inherited the
 * refresh cadence and crawled at 3 every 5 minutes.
 */
const FIRST_PER_BATCH = 5
const REFRESH_PER_BATCH = 3

/**
 * Two fields, one call.
 *
 * The state costs nothing extra: the prompt is already assembled and sent, and
 * asking for two sentences alongside the title adds ~60 output tokens. Generating
 * them separately would double the call count for no benefit.
 *
 * The labelled format exists for the headless backend, which has no structured
 * output and must be parsed. The API backend enforces the same two fields through
 * a schema and ignores the labels.
 */
const INSTRUCTION = [
  'Summarise this coding session for a dashboard. Reply in exactly this format:',
  '',
  'TITLE: at most six words naming what the session is working on',
  'STATE: one or two sentences on where it currently stands — what has been done,',
  'what is in progress, what is blocked',
  '',
  'Prefer concrete nouns from the conversation — feature, customer, repo or file',
  'names — over generic verbs like "implement" or "investigate". Weight the most',
  'recent turns most heavily: they are where the session actually is. Write the',
  'state in plain past or present tense with no preamble.',
  '',
  // Without this the model treats a thin excerpt as a request it cannot fulfil and
  // answers with questions instead: "I don't have enough context to write an
  // accurate summary… What was completed? What's in progress?". That is not a
  // summary, so the guard below discards it and the row stays blank. There is no
  // one to answer the question, and a hedged summary of the opening request is
  // worth more on a strip than nothing.
  'This is a one-shot request with nobody to answer follow-up questions. If the',
  'material is thin, summarise what it does show and hedge the state. Never ask a',
  'question, never explain what you are missing, and never decline.',
].join('\n')

/**
 * Shortest gap between *refresh* batches.
 *
 * Without this, refreshing runs on every sweep — and the GitHub poll alone fires
 * one every 60 seconds, so a worst case of 3 calls a minute is reachable purely
 * from the app sitting open. `needsSummary` cannot help here: an active session
 * genuinely has changed every minute, so it says yes every time. That is exactly
 * the case a spend ceiling has to cover, and it must not depend on a freshness
 * heuristic saying no.
 *
 * First summaries are deliberately exempt. There are at most a boardful of them,
 * each session qualifies once, and until it happens the row shows a gap where its
 * state should be.
 */
const MIN_REFRESH_INTERVAL_MS = 5 * 60_000

let lastRefreshAt = 0

export type Backend = 'api' | 'cli' | null

/**
 * Which backend to use, API first.
 *
 * Resolved per call rather than cached: a credential can appear while the app is
 * running (`ant auth login` in a terminal), and requiring a restart to notice
 * would be a confusing way to fail.
 */
export function backend(): Backend {
  if (api.available()) return 'api'
  if (cli.available()) return 'cli'
  return null
}

function buildPrompt(transcriptPath: string): string | null {
  const first = firstUserMessage(transcriptPath)
  const recent = recentUserMessages(transcriptPath, 3)
  if (!first && recent.length === 0) return null

  const parts = [INSTRUCTION]
  if (first) parts.push(`Opening request:\n${first.slice(0, 4000)}`)
  if (recent.length > 0) {
    parts.push(`Most recent turns:\n${recent.join('\n---\n').slice(0, 4000)}`)
  }
  return parts.join('\n\n')
}

/** Current transcript size — the cache key, so a stat failure must not fake one. */
function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

export interface TitleCandidate {
  sessionId: string
  transcriptPath: string
}

/**
 * Summarise a few sessions and report how many were written.
 *
 * Sessions with no summary yet are worked through first and on every sweep, so
 * EN ROUTE fills within a couple of minutes of the app opening. Only once the
 * board is full does the slow refresh cadence take over.
 *
 * That ordering is the whole point. An earlier version put both kinds of work
 * behind the refresh interval and the result looked broken rather than thrifty:
 * thirteen of sixteen EN ROUTE rows sat blank, filling three every five minutes,
 * while the cache held sixty summaries for sessions no board displays.
 *
 * Sequential, not parallel — the CLI backend spawns a Claude Code process per
 * call, and five at once would be five of those competing for the machine.
 */
export async function run(candidates: TitleCandidate[]): Promise<number> {
  const chosen = backend()
  if (chosen === null) return 0

  const failedAt = cache.failedTitleSizes()
  const measured = candidates
    .map((c) => ({
      ...c,
      size: sizeOf(c.transcriptPath),
      previous: cache.getGeneratedTitle(c.sessionId),
    }))
    .filter((c) => c.size > 0)

  // Never summarised, or summarised before the state field existed — either way the
  // row currently has nothing to say. Sessions where the last attempt at this exact
  // size produced nothing usable are held back until the transcript moves on, since
  // re-sending an identical prompt can only fail identically. Smallest transcript
  // first: those are the fastest to excerpt, so the board fills visibly sooner.
  const first = measured
    .filter((c) => c.previous === null || c.previous.state === null)
    .filter((c) => failedAt.get(c.sessionId) !== c.size)
    .sort((a, b) => a.size - b.size)
    .slice(0, FIRST_PER_BATCH)

  /**
   * Re-summarising sessions that already have a state. Only reached once nothing
   * is waiting on a first summary, so a busy board can never starve the fill.
   *
   * The cache key is transcript size and nothing else. Transcripts are append-only,
   * so a byte-identical size means nothing has happened since the last summary and
   * there is provably nothing new to say — no threshold to tune, no staleness
   * window, no clock. An earlier version required 50KB *and* 25% growth, which was
   * a spend control wearing a correctness costume: it let an active session's
   * summary go stale for however long another 50KB takes to write.
   */
  let refresh: typeof measured = []
  if (first.length === 0 && Date.now() - lastRefreshAt >= MIN_REFRESH_INTERVAL_MS) {
    // Oldest summary first. Every EN ROUTE session is usually "changed", so taking
    // them in list order would spend all the slots on the same busiest sessions
    // forever and never reach the quieter ones.
    refresh = measured
      .filter((c) => c.previous !== null && c.size !== c.previous.sizeAtTitle)
      .sort((a, b) => (a.previous?.generatedAt ?? 0) - (b.previous?.generatedAt ?? 0))
      .slice(0, REFRESH_PER_BATCH)
    if (refresh.length > 0) lastRefreshAt = Date.now()
  }

  const due = [...first, ...refresh]
  if (due.length === 0) return 0

  const written: cache.GeneratedTitle[] = []
  const failed: { sessionId: string; size: number }[] = []
  for (const candidate of due) {
    const prompt = buildPrompt(candidate.transcriptPath)
    // No excerpt to send: recorded as a failure so this is not re-derived every
    // sweep for a transcript that has not changed.
    if (!prompt) {
      failed.push({ sessionId: candidate.sessionId, size: candidate.size })
      continue
    }
    try {
      const result = chosen === 'api' ? await api.generate(prompt) : await cli.generate(prompt)
      if (result) {
        written.push({
          sessionId: candidate.sessionId,
          title: result.title,
          state: result.state,
          sizeAtTitle: candidate.size,
        })
      } else {
        // The model answered but not usably — a refusal, a question, an
        // explanation. Nothing to display, and nothing an identical retry would
        // change, so hold off until the transcript grows.
        failed.push({ sessionId: candidate.sessionId, size: candidate.size })
      }
    } catch {
      // Transport-level failure — timeout, spawn error, a network blip. Unlike a
      // refusal this says nothing about the input, so it is deliberately *not*
      // recorded: the next sweep should try again.
    }
  }

  cache.putGeneratedTitles(written)
  cache.putFailedTitles(failed)
  // The CLI backend leaves a transcript behind per call; clear them before they
  // accumulate. Cheap, and a no-op for the API backend.
  if (chosen === 'cli') cli.prune()
  return written.length
}
