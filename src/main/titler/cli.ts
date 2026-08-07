import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import type { Generated } from './types.js'

/**
 * Titling backend that shells out to headless Claude Code (`claude -p`).
 *
 * Chosen because it needs **no API key** — it reuses the Claude Code credential
 * already on the machine, which matters when you cannot mint a key in your org.
 * The cost is that it spends your Claude subscription rather than an API budget,
 * and takes ~6.6s per call against roughly 1s for the SDK. So this is the
 * fallback: `titler/index.ts` prefers the API whenever a credential exists.
 *
 * Every flag below exists because of a measured problem, not defensively:
 *
 *   --settings '{"hooks":{}}'   Claude Code otherwise runs the hooks from
 *                               ~/.claude/settings.json. A titling call should
 *                               have no side effects on your tooling.
 *   --strict-mcp-config         Skips loading MCP servers entirely. A six-word
 *   --mcp-config '{...}'        summary needs no tools, and loading them is the
 *                               slowest part of startup.
 *   stdin closed                Without it `-p` waits 3 seconds for stdin that
 *                               never arrives — 11.4s per call instead of 6.6s.
 *   cwd = TITLER_DIR            `claude -p` writes a transcript into the project
 *                               directory for its cwd. Run from a normal repo and
 *                               every titling call appears on the board as a
 *                               session — which would then need titling. Pointing
 *                               it at our own directory contains the damage, and
 *                               `prune()` clears it afterwards.
 */

const MODEL = 'haiku'
const TIMEOUT_MS = 60_000

const BINARIES = [
  join(homedir(), '.local/bin/claude'),
  '/usr/local/bin/claude',
  '/opt/homebrew/bin/claude',
]

export function findClaude(): string | null {
  return BINARIES.find((p) => existsSync(p)) ?? null
}

export function available(): boolean {
  return findClaude() !== null
}

/** Scratch cwd for headless calls, so their transcripts land somewhere we own. */
function titlerDir(): string {
  const dir = join(app.getPath('userData'), 'titler')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * The project directory Claude Code writes our headless transcripts into.
 *
 * Claude mangles a cwd into a directory name by replacing every non-alphanumeric
 * character with `-`, not just path separators. Getting that wrong is how the
 * first version of this silently pruned nothing: it produced
 * `-Users-sean@gladly.com-Library-Application Support-…` while the real directory
 * was `-Users-sean-gladly-com-Library-Application-Support-…`, because `@`, `.` and
 * spaces are all collapsed too.
 */
export function projectDir(): string {
  const mangled =
    '-' +
    titlerDir()
      .replace(/^\//, '')
      .replace(/[^A-Za-z0-9]/g, '-')
  return join(homedir(), '.claude', 'projects', mangled)
}

/**
 * Delete transcripts headless calls left behind.
 *
 * Each `claude -p` call writes one, and left alone they accumulate — and worse,
 * every one carries a real user message (the titling prompt), so the board would
 * happily list them as sessions that then need titling.
 *
 * Each file's recorded `cwd` is checked before deleting. The directory name is
 * derived from a mangling rule owned by another program, and that rule has already
 * been wrong once here; a wrong guess must prune nothing rather than delete
 * somebody's transcript.
 */
export function prune(): void {
  const expected = titlerDir()
  const dir = projectDir()
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.jsonl')) continue
      const path = join(dir, file)
      if (recordedCwd(path) === expected) rmSync(path, { force: true })
    }
  } catch {
    /* nothing to prune */
  }
}

/** The `cwd` a transcript records, read from its opening lines. */
function recordedCwd(path: string): string | null {
  try {
    const head = readFileSync(path, 'utf8').slice(0, 8192)
    for (const line of head.split('\n')) {
      if (!line.startsWith('{')) continue
      try {
        const parsed = JSON.parse(line) as { cwd?: unknown }
        if (typeof parsed.cwd === 'string') return parsed.cwd
      } catch {
        break // truncated line: nothing complete left in the window
      }
    }
  } catch {
    /* unreadable */
  }
  return null
}

function runHeadless(prompt: string): Promise<string | null> {
  const bin = findClaude()
  if (!bin) return Promise.resolve(null)

  return new Promise((resolve) => {
    const child = spawn(
      bin,
      [
        '-p',
        prompt,
        '--model',
        MODEL,
        '--settings',
        JSON.stringify({ hooks: {} }),
        '--strict-mcp-config',
        '--mcp-config',
        JSON.stringify({ mcpServers: {} }),
      ],
      {
        cwd: titlerDir(),
        // stdin ignored, not piped — an open pipe is what causes the 3s stall.
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    // Drained and discarded: `-p` writes warnings here, and an unread pipe that
    // fills would deadlock the child.
    child.stderr.on('data', () => {})

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve(null)
    }, TIMEOUT_MS)

    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0 ? stdout : null)
    })
  })
}

/**
 * A title and state, or null.
 *
 * Headless mode has no structured-output equivalent, so the response is free text
 * on the same channel that carries refusals, errors and chatty preambles. It is
 * therefore parsed and checked rather than trusted: the agreed shape is
 * `TITLE: …` then `STATE: …`, and anything that fails to produce a plausible
 * title is discarded so the heuristic stays in place.
 */
export async function generate(prompt: string): Promise<Generated | null> {
  const raw = await runHeadless(prompt)
  if (raw === null) return null

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
   * `STATE:` has to match to end-of-string because the state may legitimately be
   * two sentences on two lines — but a model that has answered often keeps going:
   * a horizontal rule, an offer to help, a follow-up question. Taking everything
   * and collapsing whitespace glued all of that into one paragraph, and one strip
   * read "…looking for Matt's replies on the PR. --- To proceed with the review,
   * I'll need the PR URL or number. Which PR should I review?".
   *
   * A blank line is the boundary because the answer itself never contains one:
   * two sentences of state are consecutive lines at most.
   */
  const state = ((stateMatch?.[1] ?? '').split(/\n[ \t]*\n/)[0] ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 400)
  return { title, state: state.length > 10 ? state : null }
}
