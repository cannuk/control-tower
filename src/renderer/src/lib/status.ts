import {
  CircleSlash,
  Hand,
  Check,
  PlaneLanding,
  PlaneTakeoff,
  RotateCcw,
  Radio,
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
    label: 'APPROVED',
    atc: 'cleared to land',
    chip: 'bg-cleared text-cleared-fg',
    Icon: Check,
  },
  inbound: {
    label: 'NEEDS REVIEW',
    atc: 'inbound, awaiting clearance',
    chip: 'bg-inbound text-inbound-fg',
    Icon: PlaneTakeoff,
  },
  'no-contact': {
    label: 'NO DATA',
    atc: 'no contact',
    chip: 'bg-dormant text-dormant-fg',
    Icon: Radio,
  },
}

/**
 * The liveness dot has no label, only a tooltip — so it can carry both readings
 * at once and costs nothing to skip.
 */
export const TRANSPONDER: Record<Transponder, { dot: string; label: string }> = {
  airborne: { dot: 'bg-squawk-live', label: 'Working now — airborne' },
  holding: { dot: 'bg-transparent ring-1 ring-squawk-holding', label: 'Idle — holding' },
  'no-contact': { dot: 'bg-squawk-lost', label: 'No heartbeat — no contact' },
}

/** Advisories stop mattering once the PR is merged or closed. */
export function advisoriesAreActionable(status: PrStatus): boolean {
  return status !== 'landed' && status !== 'diverted'
}

/**
 * The tooltip is where the aviation reading lives, alongside the detail the chip
 * omits: outdated threads, and the plain meaning of the approved-but-contested
 * case that the two-axis model exists to expose.
 */
export function prTooltip(prRef: PrRef): string {
  const { status, advisories, outdatedAdvisories, repository, number } = prRef
  const { label, atc } = PR_STATUS[status]
  const parts = [`${repository}#${number}`, `${label} — ${atc}`]

  if (advisories > 0) {
    parts.push(`${advisories} unresolved review thread${advisories === 1 ? '' : 's'}`)
    if (outdatedAdvisories > 0) parts.push(`${outdatedAdvisories} of them outdated`)
    if (status === 'cleared') parts.push('cleared to land, but advisories still stand')
  }

  return parts.join(' · ')
}
