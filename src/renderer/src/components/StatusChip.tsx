import type { PrRef } from '../../../shared/types.js'
import { ADVISORY_ICON, chipAdvisories, PR_STATUS, prTooltip } from '../lib/status.js'
import { cn } from '../lib/utils.js'

/**
 * One chip per pull request: number, status, and the count of threads still open.
 *
 * Unresolved threads were a second chip beside this one, on the reasoning that
 * "approved" and "approved with 17 open threads" must not look the same. That
 * conclusion was right and the mechanism was wrong. Two chips read as two
 * independent facts to reconcile, when a row is only ever answering one question —
 * what is this PR waiting on — and the count is part of that answer, not a rival to
 * it.
 *
 * So the distinction moved into the status itself (`cleared` versus
 * `cleared-advisory`, see PrStatus) where it changes the colour and the word, and
 * the number became an attribute of the chip it qualifies. Approved-and-clean is
 * now green and says READY; approved-with-threads is amber, says APPROVED, and
 * carries the count.
 *
 * Clicking opens the PR — the chip is the link, so the flight number stays
 * actionable rather than decorative.
 */
export function StatusChip({ prRef }: { prRef: PrRef }): React.JSX.Element {
  const { label, chip, Icon, inProgress } = PR_STATUS[prRef.status]
  const advisories = chipAdvisories(prRef)

  return (
    <button
      type="button"
      onClick={() => void window.controlTower.openExternal(prRef.url)}
      title={prTooltip(prRef)}
      className={cn(
        'no-drag field inline-flex items-center gap-1.5 rounded px-2.5 py-1.5',
        'text-[11px] leading-none font-semibold',
        'transition-opacity hover:opacity-75',
        chip,
      )}
    >
      <Icon size={11} strokeWidth={2.5} className={cn(inProgress && 'animate-sweep')} aria-hidden />
      <span>{prRef.number}</span>
      <span className="opacity-75">{label}</span>

      {advisories > 0 && (
        // Divided from the label rather than merely spaced. Inside one chip the
        // count needs to read as a separate field, or "APPROVED 19" parses as a
        // status whose name ends in a number. `border-current` keeps the rule in
        // whatever colour the chip already is, across all three themes.
        <span className="ml-0.5 inline-flex items-center gap-1 border-l border-current/30 pl-2">
          <ADVISORY_ICON size={10} strokeWidth={2.5} aria-hidden />
          {advisories}
        </span>
      )}
    </button>
  )
}
