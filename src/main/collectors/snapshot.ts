import { basename, dirname } from 'node:path'
import type { PrRef, Session, SessionSnapshot, Transponder } from '../../shared/types.js'
import * as cmux from '../providers/cmux.js'
import * as cache from '../store/cache.js'
import { branchOf, cachedDirty, refreshDirty } from './git.js'
import { readRegistry } from './registry.js'
import { indexPrLinks, listTranscripts, resolveCwd } from './transcripts.js'
import { firstUserMessage } from './excerpt.js'
import { heuristicTitle } from './heuristic-title.js'
import { inferCwd, prSession, sessionOnBranch } from './orphan-prs.js'
import { lastActivityAt } from './review-activity.js'

/**
 * Assemble one sweep from the four sources (PLAN.md §2).
 *
 * The join key is the Claude session id throughout. Each source contributes only
 * what it actually knows, and none is trusted for anything else:
 *
 *   registry    -> liveness, pid, cwd, start time
 *   transcripts -> last contact, PR links
 *   cmux        -> the human-readable summary
 *   git         -> branch and dirty state
 *
 * The union is intentionally transcript-driven rather than registry-driven. The
 * registry only describes *running* processes, so a session that exited still has
 * a transcript and still belongs on the LANDED board — building from the registry
 * would erase your history the moment a process died.
 */

/**
 * Join a session's PR links to their last-known GitHub state.
 *
 * A link with no cached status renders as `no-contact` rather than being hidden:
 * the PR provably exists — the session created it — so dropping it would be a
 * worse lie than admitting the state is unknown.
 */
const prKey = (repository: string, number: number): string => repository + '#' + number

/** One PR, joined to its last-known status. Shared by the link and discovery paths. */
function toPrRef(
  repository: string,
  number: number,
  url: string,
  statuses: Map<string, cache.StoredPrStatus>,
): PrRef {
  const known = statuses.get(prKey(repository, number))
  return {
    number,
    url,
    repository,
    title: known?.title ?? null,
    status: (known?.status as PrRef['status']) ?? 'no-contact',
    advisories: known?.advisories ?? 0,
    outdatedAdvisories: known?.outdatedAdvisories ?? 0,
    advisors: known?.advisors ?? [],
    reviewers: known?.reviewers ?? [],
    requestedFrom: known?.requestedFrom ?? [],
    failingChecks: known?.failingChecks ?? [],
    humanReviewed: known?.humanReviewed ?? false,
    mergedAt: known?.mergedAt ?? null,
  }
}

function toPrRefs(
  sessionId: string,
  links: Map<string, cache.StoredPrLink[]>,
  statuses: Map<string, cache.StoredPrStatus>,
  dismissed: Set<string>,
): PrRef[] {
  return (links.get(sessionId) ?? [])
    .filter((link) => {
      const known = statuses.get(link.repository + '#' + link.number)
      const isClosed = known?.status === 'diverted'

      /**
       * A PR you closed yourself is finished business and leaves the board.
       *
       * One a stale bot closed stays: those are the ones worth reviving, and the row
       * is the thread back to the session that built it. This is the whole of the
       * distinction — a rule rather than a chore, because the answer is already
       * recorded on the PR.
       */
      if (isClosed && known?.closedByHuman) return false

      /**
       * Dismissal is the manual override, for a bot-closed PR you have decided
       * against. It only holds while the PR is still closed, so reopening one on
       * GitHub brings it back — the revival happens where the PR lives and the board
       * follows, which is why there is no list of hidden things to un-hide from.
       */
      if (!dismissed.has(link.repository + '#' + link.number)) return true
      return !isClosed
    })
    .map((link) => {
      const known = statuses.get(link.repository + '#' + link.number)
      return {
        number: link.number,
        url: link.url,
        repository: link.repository,
        title: known?.title ?? null,
        status: (known?.status as PrRef['status']) ?? 'no-contact',
        advisories: known?.advisories ?? 0,
        outdatedAdvisories: known?.outdatedAdvisories ?? 0,
        advisors: known?.advisors ?? [],
        reviewers: known?.reviewers ?? [],
        requestedFrom: known?.requestedFrom ?? [],
        failingChecks: known?.failingChecks ?? [],
        humanReviewed: known?.humanReviewed ?? false,
        mergedAt: known?.mergedAt ?? null,
      }
    })
}

/**
 * Pick a summary and record which tier produced it.
 *
 * Ours wins over the terminal's, and that ordering is the entire point of §8. A
 * provider title is written once, at the start, and then drifts: cmux titled this
 * project's own session "Check new day skill status" while it was ten megabytes deep
 * in building Control Tower, and the board went on showing that for hours. Ours is
 * regenerated whenever the transcript grows, so it describes the session as it is
 * rather than as it opened.
 *
 * The previous order had the provider first on the reasoning that it is free and
 * already computed. True, and beside the point — a free answer that is wrong costs
 * more than a cheap one that is right, and the code that generates ours cites this
 * exact session's stale title as its justification while this function quietly
 * preferred it.
 *
 * cmux's title stays as the second tier, because for a session we have not
 * summarised yet it is still better than the opening request. The heuristic is the
 * floor that guarantees no strip is ever blank.
 */
function resolveSummary(
  sessionId: string,
  openingMessage: string,
  providerTitles: Map<string, string>,
  ownTitles: Map<string, { title: string; state: string | null }>,
): Pick<Session, 'summary' | 'summarySource' | 'sessionState'> {
  const own = ownTitles.get(sessionId)

  // The generated state travels with the session even when the provider's title
  // wins the headline: they answer different questions, and a cmux title does not
  // preclude us having something to say about where the work stands.
  const state = own?.state ?? null

  if (own) return { summary: own.title, summarySource: 'generated', sessionState: state }

  const provider = providerTitles.get(sessionId)
  if (provider) return { summary: provider, summarySource: 'provider', sessionState: state }

  // The opening message is already in hand from the conversation check above, so
  // the heuristic costs nothing more than string work.
  const heuristic = heuristicTitle(openingMessage)
  if (heuristic) return { summary: heuristic, summarySource: 'heuristic', sessionState: state }

  return { summary: null, summarySource: null, sessionState: state }
}

/**
 * Liveness, from the registry heartbeat.
 *
 * The middle state is `idle`, not `holding`. HOLDING is now a board you put things
 * on, and one word meaning both "the process is not mid-turn" and "I parked this"
 * is the same collision `hold-short` already caused — a name that reads right in
 * two places and means different things in each.
 */
function transponderFor(status: 'busy' | 'idle' | null, isLive: boolean): Transponder {
  if (!isLive) return 'no-contact'
  if (status === 'busy') return 'airborne'
  // Live but silent: the `claude-vscode` entrypoint never writes a heartbeat, so
  // absence of status is not absence of life.
  return 'idle'
}

export async function collect(): Promise<SessionSnapshot> {
  const warnings: string[] = []

  const { entries, warnings: registryWarnings } = await readRegistry()
  warnings.push(...registryWarnings)

  const { transcripts, warnings: transcriptWarnings } = listTranscripts()
  warnings.push(...transcriptWarnings)

  try {
    indexPrLinks(transcripts)
  } catch (cause) {
    warnings.push(`PR link scan failed: ${cause instanceof Error ? cause.message : String(cause)}`)
  }

  const readMarks = cache.readMarks()
  const held = cache.heldSessions()
  const dismissed = cache.dismissedPrs()
  const prLinks = cache.prLinksBySession()
  const prStatuses = cache.prStatuses()
  const providerTitles = cmux.titles()
  const ownTitles = cache.generatedTitles()
  const byPid = new Map(entries.map((e) => [e.sessionId, e]))

  // Every cwd we will need a branch for, resolved before the git refresh so one
  // pass covers them all.
  const sessions: Session[] = []
  const cwds = new Set<string>()

  for (const [sessionId, info] of transcripts) {
    /**
     * Only real conversations belong on the board.
     *
     * Opening a file in the IDE, or starting a terminal to run a command, can
     * create a transcript that contains nothing but machine-authored notices.
     * Those are not sessions you had — they are artifacts — and listing them
     * pads the board with rows you can neither act on nor recognise.
     *
     * `firstUserMessage` escalates past its fast-path window before answering
     * null, so this filter cannot silently discard a session whose opening
     * prompt merely arrived late.
     */
    const opening = firstUserMessage(info.path)
    if (opening === null) continue

    const entry = byPid.get(sessionId)
    const projectDirName = basename(dirname(info.path))
    // The transcript is passed so a session with no live process can still report
    // where it ran — see resolveCwd.
    const cwd = resolveCwd(projectDirName, entry?.cwd ?? null, info.path)
    cwds.add(cwd)

    sessions.push({
      sessionId,
      origin: 'session',
      pid: entry?.pid ?? null,
      cwd,
      project: basename(cwd),
      gitBranch: null, // filled below, after the branch read
      gitDirty: false,
      // Three-tier resolution (§8), best available wins.
      ...resolveSummary(sessionId, opening, providerTitles, ownTitles),
      fallbackName: entry?.name ?? basename(cwd),
      transponder: transponderFor(entry?.status ?? null, entry !== undefined),
      lastContact: info.lastActivityMs,
      startedAt: entry?.startedAt ?? null,
      transcriptPath: info.path,
      prs: toPrRefs(sessionId, prLinks, prStatuses, dismissed),
      // Resolved at click time by the provider (see cmux.focus), so this only
      // records whether tuning is plausible at all.
      location: entry ? { providerId: 'cmux', handle: sessionId, exact: true } : null,
      // Filled in below, once the row's PRs can be consulted.
      unread: false,
      held: held.has(sessionId),
    })
  }

  await refreshDirty(cwds)
  for (const session of sessions) {
    session.gitBranch = branchOf(session.cwd)
    session.gitDirty = cachedDirty(session.cwd)
  }

  /**
   * Reconcile what GitHub says you have open against what the transcripts recorded.
   *
   * Runs after branches are resolved, because matching a PR to a session is done on
   * the branch it is checked out on — the one attachment that is evidence rather
   * than inference.
   */
  const known = new Set(sessions.flatMap((s) => s.prs.map((pr) => prKey(pr.repository, pr.number))))
  for (const pr of cache.authoredPrs()) {
    const key = prKey(pr.repository, pr.number)
    if (known.has(key)) continue
    if (dismissed.has(key)) continue

    const ref = toPrRef(pr.repository, pr.number, pr.url, prStatuses)

    // A session sitting on the PR's branch is plainly working on it, so the PR joins
    // that row rather than starting one of its own.
    const owner = sessionOnBranch(sessions, pr.headRef)
    if (owner) {
      owner.prs.push(ref)
      continue
    }

    sessions.push(prSession(pr, ref, inferCwd(sessions, pr.repository, pr.headRef)))
  }

  /**
   * Unread, resolved last so that every source of activity is already attached.
   *
   * After PR reconciliation on purpose: a PR discovered from GitHub can join an
   * existing row or create one, and both cases change the answer. Computing this in
   * the session loop above missed every PR that arrived here, which is all of the
   * session-less ones and any attached by branch.
   */
  const activity = new Map<string, number>()
  for (const session of sessions) {
    const reviewedAt = session.prs.map(
      (pr) => prStatuses.get(prKey(pr.repository, pr.number))?.lastHumanReviewAt ?? null,
    )
    const at = lastActivityAt(session.transcriptPath ? session.lastContact : null, reviewedAt)
    activity.set(session.sessionId, at)

    /**
     * A row with no mark yet is *read*, not unread — it is seeded just below at
     * whatever activity it already had. Treating unknown as unread would flag every
     * row on the first sweep after a change like this ships, and an inbox that starts
     * full teaches you to ignore it.
     */
    session.unread = at > (readMarks.get(session.sessionId) ?? at)
  }

  // Seeded from the same value the flag is compared against, and for PR rows too —
  // they are keyed on a synthetic id, but that id is stable, and it is the only way a
  // review arriving after first sight can be told from one that predates it.
  cache.seedRead(
    sessions
      .filter((s) => !readMarks.has(s.sessionId))
      .map((s) => ({ sessionId: s.sessionId, activityAt: activity.get(s.sessionId) ?? 0 })),
  )

  return { sessions, sweptAt: Date.now(), warnings }
}
