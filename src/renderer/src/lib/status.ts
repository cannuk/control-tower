import {
  Check,
  CheckCheck,
  CircleSlash,
  Hand,
  MessageSquare,
  Plane,
  PlaneLanding,
  Radio,
  Reply,
  RotateCcw,
  RotateCw,
  UserPlus,
  Warehouse,
  type LucideIcon,
} from 'lucide-react'
import type { PrRef, PrStatus, Transponder } from '../../../shared/types.js'

interface StatusPresentation {
  /**
   * What the chip shows. Deliberately the engineering term, not the aviation
   * one — see the note below.
   */
  label: string
  /** The aviation reading, surfaced in the tooltip. Flavor, never load-bearing. */
  atc: string
  /** Tailwind classes; all resolve to semantic tokens, never a literal color. */
  chip: string
  Icon: LucideIcon
  /**
   * Work is in progress. Renders as the slow sweep pulse rather than a spinner —
   * a rotating aircraft icon reads as a crash, not as an approach, and a fast
   * spinner is louder than a background CI run deserves.
   */
  inProgress?: boolean
}

/**
 * PLAN.md §6.
 *
 * The audience is a software engineer who enjoys running their sessions like a
 * control tower — not a controller. That distinction sets one rule, and it runs
 * in both directions:
 *
 *   Facts you act on stay in your language. `APPROVED`, `CI FAILED`,
 *   `CHANGES REQ` — you already own these words, and a chip that said
 *   `HOLD SHORT` forced a translation on every glance to recover a fact you
 *   knew on sight. Cognitive cost on the critical path, paid per glance.
 *
 *   Scenery gets the full aviation treatment. Strips, squawks, sweeps, boards,
 *   the palettes, the cocked-strip marker, the color convention, the empty-state
 *   copy. None of it stands between you and a fact, so it is free to commit hard
 *   — and it is what makes the app feel like a tower rather than a table.
 *
 * So the aviation vocabulary moves to the tooltip and the chrome. It is still
 * here, in `atc` — you just never have to decode it to work.
 */
export const PR_STATUS: Record<PrStatus, StatusPresentation> = {
  landed: {
    label: 'MERGED',
    atc: 'landed',
    chip: 'bg-landed text-landed-fg',
    Icon: PlaneLanding,
  },
  diverted: {
    label: 'CLOSED',
    atc: 'diverted',
    chip: 'bg-transparent text-alert ring-1 ring-alert',
    Icon: CircleSlash,
  },
  'at-gate': {
    label: 'DRAFT',
    atc: 'at the gate',
    chip: 'bg-dormant text-dormant-fg',
    Icon: Warehouse,
  },
  'go-around': {
    label: 'CI FAILED',
    atc: 'go around — approach aborted',
    chip: 'bg-alert text-alert-fg',
    Icon: RotateCcw,
  },
  'on-final': {
    label: 'CI RUNNING',
    atc: 'on final',
    chip: 'bg-approach text-approach-fg',
    Icon: PlaneLanding,
    inProgress: true,
  },
  'hold-short': {
    label: 'CHANGES REQ',
    atc: 'holding short',
    chip: 'bg-transparent text-caution ring-1 ring-caution',
    Icon: Hand,
  },
  cleared: {
    label: 'READY TO MERGE',
    atc: 'cleared to land',
    chip: 'bg-cleared text-cleared-fg',
    Icon: CheckCheck,
  },
  /**
   * Approved, but threads are still open.
   *
   * A dimmed green rather than amber, and APPROVED rather than READY TO MERGE. Both
   * states are on one axis — this got a yes — and the only question is how far along
   * it they are, so hue stays constant and intensity moves. Amber implied a setback
   * next to changes-requested and CI failure, when in fact nothing has gone wrong.
   *
   * The distinction still has to survive being glanced at, which is why the word
   * changes too: "merge it" and "somebody left comments you wanted to assess first"
   * are different actions.
   */
  'cleared-advisory': {
    label: 'APPROVED',
    atc: 'cleared to land, advisories still stand',
    chip: 'bg-cleared-advisory text-cleared-advisory-fg',
    Icon: Check,
  },
  /**
   * Nobody has been asked and nobody has looked.
   *
   * The outlined form of the same cyan `inbound` uses, because it belongs to the same
   * family — waiting on a review — while being the one member of it where the next
   * move is yours. Filled means asked; outlined means not yet.
   */
  unassigned: {
    label: 'NO REVIEWER',
    atc: 'no clearance requested',
    chip: 'bg-transparent text-inbound ring-1 ring-inbound',
    Icon: UserPlus,
  },
  inbound: {
    // Level flight, not a departure. An unreviewed PR is inbound — it is the board's
    // whole premise that these things are arriving, and PlaneTakeoff pointed the
    // wrong way on a tab called APPROACH.
    label: 'NEEDS REVIEW',
    atc: 'inbound, awaiting clearance',
    chip: 'bg-inbound text-inbound-fg',
    Icon: Plane,
  },
  /**
   * Reviewed, with threads still open: your move.
   *
   * Amber rather than cyan, because the cyan family means "waiting on them" and this
   * is the one that is waiting on you. Filled, where CHANGES REQ is outlined amber —
   * both are your move, and the filled one has no formal verdict attached.
   */
  'in-review': {
    label: 'IN REVIEW',
    atc: 'in contact, working the conversation',
    chip: 'bg-caution text-caution-fg',
    Icon: Reply,
  },
  /**
   * Reviewed, everything resolved, waiting for another pass.
   *
   * The state that prompted splitting this apart: it used to read NEEDS REVIEW, which
   * is what a PR nobody had been asked to look at also said.
   */
  're-review': {
    label: 'NEEDS RE-REVIEW',
    atc: 're-established, awaiting a second look',
    chip: 'bg-inbound text-inbound-fg',
    Icon: RotateCw,
  },
  'no-contact': {
    label: 'NO DATA',
    atc: 'no contact',
    chip: 'bg-dormant text-dormant-fg',
    Icon: Radio,
  },
}

/**
 * What the dot on a strip means: **new activity, and nothing else.**
 *
 * It carried liveness through two revisions and should not have. Whether a session
 * process still exists is a fact about the session, and every strip already names its
 * session explicitly — so that belongs on the session field, which can dim itself,
 * rather than encoded into a mark that then means two unrelated things at once.
 * `sessionDim` below is where it went.
 *
 * The three states are one axis, from most to least urgent:
 *
 *   - generating  green, pulsing. New activity still arriving.
 *   - unread      solid cyan. New activity, finished arriving.
 *   - read        hollow. Nothing new, and quiet is the point.
 *
 * Generating stays a distinct state rather than folding into unread because it is
 * the same fact one step fresher — output is landing as you look at it.
 */
export type DotKind = 'generating' | 'unread' | 'quiet'

export const DOT_KEY: { kind: DotKind; dot: string; pulse?: boolean; label: string }[] = [
  {
    kind: 'generating',
    dot: 'bg-squawk-live',
    pulse: true,
    label: 'Generating right now — new output still arriving',
  },
  {
    kind: 'unread',
    dot: 'bg-squawk-holding',
    label: 'New activity since you last opened it — click to clear',
  },
  {
    kind: 'quiet',
    dot: 'bg-transparent ring-1 ring-squawk-lost',
    label: 'Nothing new since you last opened it',
  },
]

export function dotFor(
  transponder: Transponder,
  unread: boolean,
): { kind: DotKind; dot: string; pulse: boolean; label: string } {
  if (transponder === 'airborne') return { ...DOT_KEY[0]!, pulse: true }
  if (unread) return { ...DOT_KEY[1]!, pulse: false }
  return { ...DOT_KEY[2]!, pulse: false }
}

/**
 * Styling for the session name when its process is gone.
 *
 * Dimmed rather than annotated: "there is no longer a terminal for this" is a
 * property of the session, so it reads best as the session's own name fading. Only
 * ever visible on APPROACH and LANDED — EN ROUTE requires a live process, so nothing
 * there can be dim, which is exactly why this does not belong on the dot.
 */
export function sessionDim(transponder: Transponder): boolean {
  return transponder === 'no-contact'
}

/** The fill an unread marker uses, wherever it appears. */
export const UNREAD_DOT = 'bg-squawk-holding'

/** The icon that marks the thread count inside a status chip. */
export const ADVISORY_ICON = MessageSquare

/**
 * Whether to show the thread count at all.
 *
 * Unresolved threads stop being a question once the PR is merged or closed — the
 * decision they were holding up has been taken. Showing "3" on a MERGED chip would
 * read as outstanding work on something already finished.
 */
export function advisoriesAreActionable(status: PrStatus): boolean {
  return status !== 'landed' && status !== 'diverted'
}

/** The count to show inside the chip, or 0 for none. */
export function chipAdvisories(prRef: PrRef): number {
  return advisoriesAreActionable(prRef.status) ? prRef.advisories : 0
}

/**
 * The tooltip is where the aviation reading lives, alongside the detail the chip
 * omits: what the count is counting, and how much of it is stale.
 */
export function prTooltip(prRef: PrRef): string {
  const { status, advisories, outdatedAdvisories, repository, number } = prRef
  const { label, atc } = PR_STATUS[status]
  const parts = [`${repository}#${number}`, `${label} — ${atc}`]

  if (advisories > 0) {
    parts.push(`${advisories} unresolved review thread${advisories === 1 ? '' : 's'}`)
    if (outdatedAdvisories > 0) parts.push(`${outdatedAdvisories} of them outdated`)
    if (!advisoriesAreActionable(status)) parts.push('no longer actionable — the PR is closed')
  }

  return parts.join(' · ')
}
