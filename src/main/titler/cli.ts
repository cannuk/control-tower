import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { parseGenerated } from './parse.js'
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

/**
 * Scratch cwd for headless calls, so their transcripts land somewhere we own.
 *
 * Deliberately pure — deriving the path must not create it. This used to `mkdirSync`
 * on every call, which made merely *asking where the directory is* a filesystem
 * write, and `transcripts.ts` asks at module load to build its exclusion set. Module
 * bodies run before any statement in `index.ts`, including the one that pins
 * `userData`, so adding `productName` to package.json — which changes what
 * `app.getName()` returns, and therefore the default `userData` — silently created a
 * stray `~/Library/Application Support/Control Tower/titler/` on the next launch.
 * The directory was empty and harmless; the same ordering with a database in it
 * would not have been.
 */
function titlerDir(): string {
  return join(app.getPath('userData'), 'titler')
}

/** The same directory, created. Only the code that actually runs a call needs this. */
function ensureTitlerDir(): string {
  const dir = titlerDir()
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * The project directory Claude Code writes our headless transcripts into.
 *
 * Claude mangles a cwd into a directory name by replacing every non-alphanumeric
 * character with `-`, not just path separators. Getting that wrong is how the
 * first version of this silently pruned nothing: it produced
 * `-Users-alex@example.com-Library-Application Support-…` while the real directory
 * was `-Users-alex-example-com-Library-Application-Support-…`, because `@`, `.` and
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
        cwd: ensureTitlerDir(),
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
 * A title and state from one headless call, or null.
 *
 * The parsing lives in parse.ts, which has no Electron dependency and so can be
 * tested — it is the half of this that has been wrong.
 */
export async function generate(prompt: string): Promise<Generated | null> {
  const raw = await runHeadless(prompt)
  if (raw === null) return null
  return parseGenerated(raw)
}
