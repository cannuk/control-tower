import type { PrRef, Session, SessionSnapshot } from '../shared/types.js'

/**
 * M1 fixture — the traffic on the board before the collectors exist.
 *
 * These are real shapes captured from a live machine: real session summaries,
 * real PR numbers, and the real unresolved-thread counts observed through the
 * GitHub GraphQL API. Using genuine data rather than `Test Flight #1` is
 * deliberate — it is the only way to judge strip density honestly. A strip that
 * looks fine holding "Test Session" falls apart holding
 * "Add quick replies support to web-v2 chat widget" plus three status chips.
 *
 * Deleted in M2, when the collectors produce this shape from disk.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE

function pr(
  number: number,
  status: PrRef['status'],
  advisories = 0,
  outdatedAdvisories = 0,
): PrRef {
  return {
    number,
    url: `https://github.com/sagansystems/chat-sdk/pull/${number}`,
    repository: 'sagansystems/chat-sdk',
    status,
    advisories,
    outdatedAdvisories,
  }
}

const BRANCH = 'sean/beacon-chilipiper-integration'

function flight(
  partial: Pick<Session, 'sessionId' | 'summary' | 'transponder' | 'lastContact'> &
    Partial<Session>,
): Session {
  return {
    pid: null,
    cwd: '/Users/you/Documents/Development/sagan/chat-sdk',
    project: 'chat-sdk',
    gitBranch: BRANCH,
    gitDirty: true,
    fallbackName: 'chat-sdk',
    startedAt: null,
    transcriptPath: null,
    prs: [],
    location: { providerId: 'cmux', handle: 'surface:0', exact: true },
    unread: false,
    ...partial,
  }
}

const now = Date.now()

const SESSIONS: Session[] = [
  flight({
    sessionId: '7f93a14d-fe98-4c75-9bea-849eb4cea0f9',
    summary: 'Check new day skill status',
    transponder: 'airborne',
    lastContact: now - 20_000,
  }),
  flight({
    sessionId: '16df0408-f656-42c9-b492-1a4b41f1dc25',
    summary: 'Add quick replies support to web-v2 chat widget',
    transponder: 'holding',
    lastContact: now - 3 * MINUTE,
    // The case the whole two-axis status model exists for: cleared to land, CI
    // green, and still carrying 17 advisories. One chip would call this ready.
    prs: [pr(2538, 'cleared', 17, 6)],
    unread: true,
  }),
  flight({
    sessionId: 'fc6b0720-7057-40aa-980d-08b4b4588c67',
    summary: 'Design Shopify product mapping strategy',
    transponder: 'holding',
    lastContact: now - 4 * MINUTE,
    cwd: '/Users/you/Documents/Development/sagan/chat-sdk-smithoptics',
    project: 'chat-sdk-smithoptics',
    gitBranch: 'cannuk/smithoptics-beacon',
    fallbackName: 'chat-sdk-smithoptics',
  }),
  flight({
    sessionId: 'af9e89fa-ab54-4c62-baec-efb1401c29a8',
    summary: 'Run phase 1 of beacon customer setup guide',
    transponder: 'holding',
    lastContact: now - 6 * MINUTE,
    // The conflict alert: red, and the only thing on the board that must be
    // handled before anything else.
    prs: [pr(2545, 'go-around', 3)],
  }),
  flight({
    sessionId: '7d0765ed-4817-49b8-9015-8583110ac6b7',
    summary: 'Review legacyUI setting from master',
    transponder: 'holding',
    lastContact: now - 41 * MINUTE,
    // Three flights on one strip — the layout has to survive this.
    prs: [pr(2520, 'on-final'), pr(2521, 'landed'), pr(2522, 'inbound', 2)],
  }),
  flight({
    sessionId: '55abf5f2-22d3-405c-9f73-e390169dc89d',
    summary: 'Return focus to the element that opened the V1 chat when it closes',
    transponder: 'holding',
    lastContact: now - 2 * HOUR,
    cwd: '/Users/you/Documents/Development/sagan/chat-sdk/.claude/worktrees/sean-ada-focus-restore',
    gitBranch: 'sean/ada-focus-restore',
    fallbackName: 'sean-ada-focus-restore',
    prs: [pr(2523, 'cleared', 7, 1)],
  }),
  flight({
    sessionId: 'd80e7406-ece9-4613-9cd6-bb89df6f9465',
    summary: 'Debug widget loading issue on a customer site',
    transponder: 'holding',
    lastContact: now - 9 * HOUR,
    cwd: '/Users/you/Documents/Development/sagan/dev-chat-extension',
    project: 'dev-chat-extension',
    gitBranch: 'sean/override-css-isolation',
    fallbackName: 'dev-chat-extension',
  }),
  flight({
    sessionId: '4efd6cb2-2ae7-4034-9b84-e5edebbada4b',
    // No summary and no location — exercises the NO CALLSIGN and un-tunable paths.
    summary: null,
    transponder: 'no-contact',
    lastContact: now - 27 * HOUR,
    fallbackName: 'chat-sdk-a3',
    location: null,
    prs: [pr(2453, 'hold-short', 26, 11)],
  }),
]

export const PLACEHOLDER_SNAPSHOT: SessionSnapshot = {
  sessions: SESSIONS,
  sweptAt: now,
  warnings: [],
}
