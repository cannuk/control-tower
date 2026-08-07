import { basename, dirname } from 'node:path'
import type { PrRef, Session, SessionSnapshot, Transponder } from '../../shared/types.js'
import * as cmux from '../providers/cmux.js'
import * as cache from '../store/cache.js'
import { branchOf, cachedDirty, refreshDirty } from './git.js'
import { readRegistry } from './registry.js'
import { indexPrLinks, listTranscripts, resolveCwd } from './transcripts.js'
import { firstUserMessage } from './excerpt.js'
import { heuristicTitle } from './heuristic-title.js'

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
function toPrRefs(
  sessionId: string,
  links: Map<string, cache.StoredPrLink[]>,
  statuses: Map<string, cache.StoredPrStatus>,
): PrRef[] {
  return (links.get(sessionId) ?? []).map((link) => {
    const known = statuses.get(link.repository + "#" + link.number)
    return {
      number: link.number,
      url: link.url,
      repository: link.repository,
      title: known?.title ?? null,
      status: (known?.status as PrRef['status']) ?? 'no-contact',
      advisories: known?.advisories ?? 0,
      outdatedAdvisories: known?.outdatedAdvisories ?? 0,
      humanReviewed: known?.humanReviewed ?? false,
      mergedAt: known?.mergedAt ?? null,
    }
  })
}

/**
 * Pick a summary and record which tier produced it.
 *
 * Order matters and is not just preference: the provider title is free and
 * already computed, our own generated title is the terminal-agnostic one, and the
 * heuristic is the floor that guarantees no strip is ever blank. Reading the
 * transcript head only happens when the first two miss.
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

  const provider = providerTitles.get(sessionId)
  if (provider) return { summary: provider, summarySource: 'provider', sessionState: state }

  if (own) return { summary: own.title, summarySource: 'generated', sessionState: state }

  // The opening message is already in hand from the conversation check above, so
  // the heuristic costs nothing more than string work.
  const heuristic = heuristicTitle(openingMessage)
  if (heuristic) return { summary: heuristic, summarySource: 'heuristic', sessionState: state }

  return { summary: null, summarySource: null, sessionState: state }
}

function transponderFor(
  status: 'busy' | 'idle' | null,
  isLive: boolean,
): Transponder {
  if (!isLive) return 'no-contact'
  if (status === 'busy') return 'airborne'
  if (status === 'idle') return 'holding'
  // Live but silent: the `claude-vscode` entrypoint never writes a heartbeat, so
  // absence of status is not absence of life.
  return 'holding'
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
    warnings.push(`PR link scan failed: ${cause instanceof Error ? cause.message : cause}`)
  }

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
    const cwd = resolveCwd(projectDirName, entry?.cwd ?? null)
    cwds.add(cwd)

    sessions.push({
      sessionId,
      pid: entry?.pid ?? null,
      cwd,
      project: basename(cwd),
      gitBranch: null, // filled below, after the branch read
      gitDirty: false,
      // Three-tier resolution (§8), best available wins.
      ...resolveSummary(sessionId, opening, providerTitles, ownTitles),
      fallbackName: entry?.name ?? basename(cwd),
      transponder: transponderFor(entry?.status ?? null, entry !== undefined),
      lastContact: info.mtimeMs,
      startedAt: entry?.startedAt ?? null,
      transcriptPath: info.path,
      prs: toPrRefs(sessionId, prLinks, prStatuses),
      // Resolved at click time by the provider (see cmux.focus), so this only
      // records whether tuning is plausible at all.
      location: entry ? { providerId: 'cmux', handle: sessionId, exact: true } : null,
      unread: false,
    })
  }

  await refreshDirty(cwds)
  for (const session of sessions) {
    session.gitBranch = branchOf(session.cwd)
    session.gitDirty = cachedDirty(session.cwd)
  }

  return { sessions, sweptAt: Date.now(), warnings }
}
