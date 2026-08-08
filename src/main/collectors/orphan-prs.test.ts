import { describe, expect, it } from 'vitest'
import { inferCwd, parsePrSessionId, prSessionId, sessionOnBranch } from './orphan-prs.js'
import type { PrRef, Session } from '../../shared/types.js'

/**
 * Pull requests no session accounts for.
 *
 * The stakes here are asymmetric and that shapes every rule: attaching a PR to the
 * wrong session, or launching one in the wrong repository, is worse than admitting we
 * do not know. Measured on a real board, the weakest inference was wrong for two
 * repositories out of seven.
 */

const session = (over: Partial<Session> = {}): Session => ({
  sessionId: 's',
  origin: 'session',
  pid: null,
  cwd: '/repos/web-app',
  project: 'web-app',
  gitBranch: null,
  gitDirty: false,
  summary: 's',
  summarySource: 'generated',
  sessionState: null,
  fallbackName: 's',
  transponder: 'idle',
  lastContact: 0,
  startedAt: null,
  transcriptPath: '/t.jsonl',
  prs: [],
  location: null,
  unread: false,
  held: false,
  ...over,
})

const pr = (over: Partial<PrRef> = {}): PrRef =>
  ({ repository: 'acme/web-app', number: 1, ...over }) as PrRef

describe('matching a PR to a session by branch', () => {
  it('finds the session on that branch', () => {
    const s = session({ sessionId: 'on-it', gitBranch: 'feat/thing' })
    expect(sessionOnBranch([session(), s], 'feat/thing')?.sessionId).toBe('on-it')
  })

  it('prefers the most recently touched when a branch is checked out twice', () => {
    // Worktrees make this ordinary rather than exotic.
    const old = session({ sessionId: 'old', gitBranch: 'feat/thing', lastContact: 100 })
    const recent = session({ sessionId: 'recent', gitBranch: 'feat/thing', lastContact: 900 })
    expect(sessionOnBranch([old, recent], 'feat/thing')?.sessionId).toBe('recent')
  })

  it('matches nothing when the PR has no branch recorded', () => {
    expect(sessionOnBranch([session({ gitBranch: 'feat/thing' })], null)).toBeNull()
  })

  it('does not match a different branch', () => {
    expect(sessionOnBranch([session({ gitBranch: 'other' })], 'feat/thing')).toBeNull()
  })
})

describe('inferring where to launch', () => {
  it('uses the session on the branch, which is evidence rather than a guess', () => {
    const s = session({ cwd: '/repos/worktree-a', gitBranch: 'feat/thing' })
    expect(inferCwd([s], 'acme/web-app', 'feat/thing')).toBe('/repos/worktree-a')
  })

  it('falls back to a directory named after the repository', () => {
    // Fixes the measured failure: PRs opened against `looker` from a chat-sdk session
    // inferred the chat-sdk checkout, because that is where you were sitting.
    const wrong = session({ cwd: '/repos/web-app', prs: [pr({ repository: 'acme/looker' })] })
    const right = session({ cwd: '/repos/looker' })
    expect(inferCwd([wrong, right], 'acme/looker', null)).toBe('/repos/looker')
  })

  it('falls back to where PRs for that repo were opened', () => {
    const s = session({ cwd: '/repos/somewhere', prs: [pr({ repository: 'acme/web-app' })] })
    expect(inferCwd([s], 'acme/web-app', null)).toBe('/repos/somewhere')
  })

  it('returns null rather than guessing a fourth time', () => {
    // Null becomes a question for the user, not a session in the wrong repo.
    expect(inferCwd([session({ cwd: '/repos/unrelated' })], 'acme/never-seen', null)).toBeNull()
  })
})

describe('the synthetic session id', () => {
  it('round-trips', () => {
    const id = prSessionId('acme/web-app', 2493)
    expect(parsePrSessionId(id)).toEqual({ repository: 'acme/web-app', number: 2493 })
  })

  it('survives a repository name containing a dash or dot', () => {
    const id = prSessionId('acme/android-chat.sdk', 52)
    expect(parsePrSessionId(id)).toEqual({ repository: 'acme/android-chat.sdk', number: 52 })
  })

  it('refuses a real session id, so a click cannot be misrouted', () => {
    expect(parsePrSessionId('7f93a14d-fe98-4c75-9bea-849eb4cea0f9')).toBeNull()
    expect(parsePrSessionId('pr:no-number')).toBeNull()
  })
})
