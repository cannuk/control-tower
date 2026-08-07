import Anthropic from '@anthropic-ai/sdk'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { firstUserMessage, recentUserMessages } from './collectors/excerpt.js'
import * as cache from './store/cache.js'

/**
 * Layer 2 of §8 — Control Tower generating its own session summaries.
 *
 * This is the provider-agnostic half of the titling story. cmux supplies titles
 * for the sessions it has persisted, but that covers a fraction of the board and
 * evaporates entirely if you switch terminals; this does not depend on any
 * terminal existing.
 *
 * Triggered by the file watcher rather than by a Claude Code hook. Installing a
 * hook would mean editing your `settings.json`, colliding with cmux's own `Stop`
 * hook, and only ever working for Claude Code — watching the transcript avoids
 * all three.
 *
 * Rejected: `claude -p`. It needs no separate credential, which is tempting given
 * none is configured here, but it spawns a full Claude Code process per title
 * (seconds, not milliseconds) and — worse — inherits your hook configuration, so
 * titling 80 sessions would fire cmux's Stop and feed hooks 80 times. A one-shot
 * 20-token call should not have side effects on your terminal.
 */

const MODEL = 'claude-opus-5'

/** Titles generated per sweep. Small on purpose — see the note in `run`. */
const PER_SWEEP = 3

/** Re-title once a transcript has grown enough that the summary may be wrong. */
const REGROWTH_BYTES = 50 * 1024
const REGROWTH_FACTOR = 1.25

const SYSTEM = [
  'You name developer coding sessions for a dashboard.',
  'Given the opening request and the most recent turns, produce a title of at most',
  'six words describing what the session is actually working on.',
  'Prefer concrete nouns from the request — feature names, customer names, file or',
  'repo names — over generic verbs like "implement" or "investigate".',
  'No trailing punctuation. No quotes. Do not start with "Session" or "Task".',
].join(' ')

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'At most six words. No trailing punctuation.' },
  },
  required: ['title'],
  additionalProperties: false,
} as const

let client: Anthropic | null = null
let credentialChecked = false
let credentialAvailable = false

/**
 * Whether a credential exists at all.
 *
 * An unset `ANTHROPIC_API_KEY` does not mean there are no credentials — the SDK
 * also resolves an OAuth profile written by `ant auth login`, and a bare
 * `new Anthropic()` picks that up with no env var. Checking for the profile
 * directory as well is what lets this work without a key in a public repo.
 */
export function hasCredential(): boolean {
  if (credentialChecked) return credentialAvailable
  credentialChecked = true
  credentialAvailable =
    Boolean(process.env.ANTHROPIC_API_KEY) ||
    Boolean(process.env.ANTHROPIC_AUTH_TOKEN) ||
    existsSync(join(homedir(), '.config', 'anthropic'))
  return credentialAvailable
}

function getClient(): Anthropic {
  client ??= new Anthropic()
  return client
}

/** Has this session grown enough since its last generated title to redo it? */
function needsTitle(sessionId: string, size: number): boolean {
  const previous = cache.getGeneratedTitle(sessionId)
  if (!previous) return true
  return size > previous.sizeAtTitle + REGROWTH_BYTES && size > previous.sizeAtTitle * REGROWTH_FACTOR
}

async function generate(transcriptPath: string): Promise<string | null> {
  const first = firstUserMessage(transcriptPath)
  const recent = recentUserMessages(transcriptPath, 3)
  if (!first && recent.length === 0) return null

  const parts: string[] = []
  if (first) parts.push(`Opening request:\n${first.slice(0, 4000)}`)
  if (recent.length > 0) parts.push(`Most recent turns:\n${recent.join('\n---\n').slice(0, 4000)}`)

  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 200,
    system: SYSTEM,
    // A six-word title needs no deliberation, and low effort keeps latency and
    // spend proportional to the job.
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: parts.join('\n\n') }],
  })

  // Guard the refusal case before reading content: a refused request returns 200
  // with an empty content array, so indexing straight into it would throw.
  if (response.stop_reason === 'refusal') return null

  const text = response.content.find((block) => block.type === 'text')
  if (!text || text.type !== 'text') return null

  try {
    const parsed = JSON.parse(text.text) as { title?: unknown }
    if (typeof parsed.title !== 'string') return null
    const title = parsed.title.trim().replace(/[."']+$/, '')
    return title.length > 2 ? title : null
  } catch {
    return null
  }
}

export interface TitleCandidate {
  sessionId: string
  transcriptPath: string
}

/**
 * Current transcript size, read here rather than passed in.
 *
 * It is the regrowth signal, so a placeholder value would silently disable
 * re-titling: a session titled at "size 0" can never grow past it, and the title
 * would be frozen at whatever the session was about in its first few turns.
 */
function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/**
 * Title a few sessions and report how many were written.
 *
 * Deliberately capped per sweep instead of draining the queue. A first run has
 * ~80 untitled sessions; firing 80 concurrent requests would be a burst of spend
 * and latency for a cosmetic field, and the board is perfectly usable in the
 * meantime because Layer 3 has already filled every strip. Titles arrive over the
 * following minutes and each one is cached, so the queue drains once and stays
 * drained.
 */
export async function run(candidates: TitleCandidate[]): Promise<number> {
  if (!hasCredential()) return 0

  const due = candidates
    .map((c) => ({ ...c, size: sizeOf(c.transcriptPath) }))
    .filter((c) => c.size > 0 && needsTitle(c.sessionId, c.size))
    .slice(0, PER_SWEEP)
  if (due.length === 0) return 0

  const results = await Promise.all(
    due.map(async (candidate) => {
      try {
        const title = await generate(candidate.transcriptPath)
        if (!title) return null
        return { sessionId: candidate.sessionId, title, sizeAtTitle: candidate.size }
      } catch {
        // A failed title is not worth surfacing: Layer 3 already shows something,
        // and the next sweep retries.
        return null
      }
    }),
  )

  const written = results.filter((r): r is NonNullable<typeof r> => r !== null)
  cache.putGeneratedTitles(written)
  return written.length
}
