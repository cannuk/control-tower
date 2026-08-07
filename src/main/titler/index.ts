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

/** Titles generated per sweep. Small on purpose — see `run`. */
const PER_SWEEP = 3

/** Re-title once a transcript has grown enough that the summary may be wrong. */
const REGROWTH_BYTES = 50 * 1024
const REGROWTH_FACTOR = 1.25

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
].join('\n')

/**
 * Shortest gap between titling batches.
 *
 * Without this, titling runs on every sweep — and the GitHub poll alone fires one
 * every 60 seconds, so a worst case of 3 calls a minute is reachable purely from
 * the app sitting open. `needsTitle` already gates most of that, but a spend
 * ceiling should not depend on a freshness heuristic holding.
 */
const MIN_BATCH_INTERVAL_MS = 5 * 60_000

let lastBatchAt = 0

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

/** Current transcript size — the regrowth signal, so it must be real. */
function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function needsTitle(sessionId: string, size: number): boolean {
  const previous = cache.getGeneratedTitle(sessionId)
  if (!previous) return true

  // Titled before the state field existed. Without this the sessions generated
  // earliest would be the last to ever get a state — they are already titled, so
  // regrowth is the only other trigger — and the feature would look broken on
  // precisely the sessions that have been on the board longest.
  if (previous.state === null) return true

  return (
    size > previous.sizeAtTitle + REGROWTH_BYTES && size > previous.sizeAtTitle * REGROWTH_FACTOR
  )
}

export interface TitleCandidate {
  sessionId: string
  transcriptPath: string
}

/**
 * Title a few sessions and report how many were written.
 *
 * Capped per sweep rather than draining the queue. A first run has ~80 untitled
 * sessions; firing them all would be a burst of latency and quota for a field the
 * heuristic has already filled, so the board stays readable while real titles
 * arrive over the following minutes. Each is cached, so the queue drains once.
 *
 * Sequential, not parallel — the CLI backend spawns a Claude Code process per
 * call, and three at once would be three of those competing for the machine.
 */
export async function run(candidates: TitleCandidate[]): Promise<number> {
  const chosen = backend()
  if (chosen === null) return 0

  // The very first batch runs immediately: an empty board with no titles is the
  // one moment where waiting five minutes is clearly wrong.
  if (lastBatchAt !== 0 && Date.now() - lastBatchAt < MIN_BATCH_INTERVAL_MS) return 0

  const due = candidates
    .map((c) => ({ ...c, size: sizeOf(c.transcriptPath) }))
    .filter((c) => c.size > 0 && needsTitle(c.sessionId, c.size))
    .slice(0, PER_SWEEP)
  if (due.length === 0) return 0

  lastBatchAt = Date.now()

  const written: cache.GeneratedTitle[] = []
  for (const candidate of due) {
    const prompt = buildPrompt(candidate.transcriptPath)
    if (!prompt) continue
    try {
      const result = chosen === 'api' ? await api.generate(prompt) : await cli.generate(prompt)
      if (result) {
        written.push({
          sessionId: candidate.sessionId,
          title: result.title,
          state: result.state,
          sizeAtTitle: candidate.size,
        })
      }
    } catch {
      // A failed title is not worth surfacing: the heuristic already shows
      // something, and the next sweep retries.
    }
  }

  cache.putGeneratedTitles(written)
  // The CLI backend leaves a transcript behind per call; clear them before they
  // accumulate. Cheap, and a no-op for the API backend.
  if (chosen === 'cli') cli.prune()
  return written.length
}
