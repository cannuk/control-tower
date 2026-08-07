import {
  Check,
  CheckCheck,
  CircleSlash,
  Hand,
  MessageSquare,
  Plane,
  PlaneLanding,
  Radio,
  RotateCcw,
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
  inbound: {
    // Level flight, not a departure. An unreviewed PR is inbound — it is the board's
    // whole premise that these things are arriving, and PlaneTakeoff pointed the
    // wrong way on a tab called APPROACH.
    label: 'NEEDS REVIEW',
    atc: 'inbound, awaiting clearance',
    chip: 'bg-inbound text-inbound-fg',
    Icon: Plane,
  },
  'no-contact': {
    label: 'NO DATA',
    atc: 'no contact',
    chip: 'bg-dormant text-dormant-fg',
    Icon: Radio,
  },
}

/**
 * What the dot on a strip means.
 *
 * One indicator carrying two facts, ordered so the loud state is the actionable one.
 * An earlier version made it liveness alone — green working, cyan alive, dim gone —
 * which was useless on the board you look at most: EN ROUTE *requires* a live
 * process, so `no-contact` is structurally impossible there and every row sat cyan
 * forever. A signal that cannot vary on a board is not a signal on that board.
 *
 * So unread takes the solid fill, and liveness became the modifier:
 *
 *   - generating   green, pulsing. It is working; there is nothing for you to do,
 *                  and this is more specific than "new" so it wins the slot.
 *   - unread       solid cyan. Moved since you last opened it. Clicking clears it.
 *   - read, alive  hollow. Running, nothing new — the quiet resting state, and quiet
 *                  is the point.
 *   - read, gone   dim fill. No process; clicking resumes from the transcript rather
 *                  than jumping to a tab. This is the distinction the dot still earns
 *                  its keep on for APPROACH and LANDED.
 */
export const DOT_KEY: { dot: string; pulse?: boolean; label: string }[] = [
  { dot: 'bg-squawk-live', pulse: true, label: 'Generating a reply right now' },
  { dot: 'bg-squawk-holding', label: 'New activity since you last opened it' },
  { dot: 'bg-transparent ring-1 ring-squawk-lost', label: 'Running, nothing new' },
  { dot: 'bg-squawk-lost', label: 'No process — opening it resumes the session' },
]

export function dotFor(
  transponder: Transponder,
  unread: boolean,
): { dot: string; pulse: boolean; label: string } {
  if (transponder === 'airborne') return { ...DOT_KEY[0]!, pulse: true }
  if (unread) return { ...DOT_KEY[1]!, pulse: false }
  if (transponder === 'no-contact') return { ...DOT_KEY[3]!, pulse: false }
  return { ...DOT_KEY[2]!, pulse: false }
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
