import Anthropic from '@anthropic-ai/sdk'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Titling backend that calls the Claude API directly.
 *
 * Preferred over the CLI backend whenever a credential exists: ~1s instead of
 * ~6.6s, no transcript written, and it spends an API budget rather than your
 * Claude subscription. It is the fallback in practice only because minting an API
 * key is not always possible.
 */

const MODEL = 'claude-opus-5'

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'At most six words. No trailing punctuation.' },
  },
  required: ['title'],
  additionalProperties: false,
} as const

let client: Anthropic | null = null

/**
 * Whether a credential exists at all.
 *
 * An unset `ANTHROPIC_API_KEY` does not mean there are none — the SDK also reads
 * an OAuth profile written by `ant auth login`, and a bare `new Anthropic()`
 * picks that up with no env var. Checking for the profile directory too is what
 * allows this to work with no key committed anywhere.
 */
export function available(): boolean {
  return (
    Boolean(process.env.ANTHROPIC_API_KEY) ||
    Boolean(process.env.ANTHROPIC_AUTH_TOKEN) ||
    existsSync(join(homedir(), '.config', 'anthropic'))
  )
}

export async function generate(prompt: string): Promise<string | null> {
  client ??= new Anthropic()

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 200,
    // A six-word title needs no deliberation, and low effort keeps latency and
    // spend proportional to the job.
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: prompt }],
  })

  // Check stop_reason before touching content: a refused request returns 200 with
  // an empty content array, so indexing straight into it would throw.
  if (response.stop_reason === 'refusal') return null

  const block = response.content.find((b) => b.type === 'text')
  if (!block || block.type !== 'text') return null

  try {
    const parsed = JSON.parse(block.text) as { title?: unknown }
    if (typeof parsed.title !== 'string') return null
    const title = parsed.title.trim().replace(/[."']+$/, '')
    return title.length > 2 ? title : null
  } catch {
    return null
  }
}
