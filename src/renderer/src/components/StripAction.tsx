import type { LucideIcon } from 'lucide-react'
import { cn } from '../lib/utils.js'

/**
 * The control that moves a row to another board.
 *
 * There are three of these and they are one idea: LAUNCH turns a filed plan into a
 * live session, HOLD parks a session, RELEASE un-parks it. They were three different
 * buttons in two different places — LAUNCH a filled green block in its own row on
 * DEPARTURES, HOLD a quiet text link tucked into the metadata line on EN ROUTE — so
 * the same gesture looked like three unrelated features and you had to find each one
 * separately.
 *
 * One shape, one position: last element of the strip, aligned left. Outlined rather
 * than filled, because a filled green button competes directly with the READY TO
 * MERGE chip a few pixels above it, and on a board of twenty rows twenty loud
 * buttons is just noise — the row is what you are reading, this is what you do to it.
 */
export function StripAction({
  icon: Icon,
  label,
  title,
  onClick,
  disabled = false,
}: {
  icon: LucideIcon
  label: string
  title: string
  onClick: () => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'no-drag border-border-base inline-flex items-center gap-1.5 rounded border px-2.5 py-1.5',
        'transition-colors',
        disabled
          ? 'text-text-subtle opacity-50'
          : 'text-text-muted hover:bg-surface-raised hover:text-text',
      )}
    >
      <Icon size={12} aria-hidden />
      <span className="field text-[10px] font-semibold tracking-wider">{label}</span>
    </button>
  )
}
