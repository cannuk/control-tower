import type { PrRef } from '../../../shared/types.js'
import { advisoriesAreActionable, PR_STATUS, prTooltip } from '../lib/status.js'
import { cn } from '../lib/utils.js'

/**
 * The primary status: one chip, one flight, resolved by §6 precedence.
 * Clicking opens the PR — the chip is the link, so the flight number stays
 * actionable rather than decorative.
 */
export function StatusChip({ prRef }: { prRef: PrRef }): React.JSX.Element {
  const { label, chip, Icon, inProgress } = PR_STATUS[prRef.status]

  return (
    <button
      type="button"
      onClick={() => void window.controlTower.openExternal(prRef.url)}
      title={prTooltip(prRef)}
      className={cn(
        'no-drag field inline-flex items-center gap-1.5 rounded px-2 py-1',
        'text-[11px] leading-none font-semibold',
        'transition-opacity hover:opacity-75',
        chip,
      )}
    >
      <Icon
        size={11}
        strokeWidth={2.5}
        className={cn(inProgress && 'animate-sweep')}
        aria-hidden
      />
      <span>{prRef.number}</span>
      <span className="opacity-75">{label}</span>
    </button>
  )
}

/**
 * Advisories, deliberately a sibling of the status chip rather than a variant.
 *
 * This is the whole reason the status model has two axes. A flight can be
 * approved and still be carrying unresolved discussion, and those two facts have to
 * be visible at once — `APPROVED · 17 UNRESOLVED` must not be mistakable for `APPROVED`.
 * Amber follows the ATC convention: caution, not failure.
 */
export function AdvisoryChip({ prRef }: { prRef: PrRef }): React.JSX.Element | null {
  if (prRef.advisories === 0) return null

  return (
    <span
      title={prTooltip(prRef)}
      className={cn(
        'field rounded px-2 py-1 text-[11px] leading-none font-semibold',
        advisoriesAreActionable(prRef.status)
          ? 'bg-advisory text-advisory-text'
          : 'text-text-subtle',
      )}
    >
      {prRef.advisories} UNRESOLVED
    </span>
  )
}
