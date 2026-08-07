import { Check } from 'lucide-react'
import { THEME_HINTS, THEME_LABELS, THEMES } from '../../../shared/types.js'
import { EN_ROUTE_WINDOW_HOURS, LANDED_LIMIT } from '../../../shared/boards.js'
import { cn } from '../lib/utils.js'
import { useStore } from '../store.js'
import { Overlay, Section } from './Overlay.js'

/**
 * Preferences.
 *
 * Both settings used to live as their own controls in the title bar — a `TITLE`
 * button whose on/off state was a colour shift and a 10px circle, and a `DISP`
 * hover menu. Neither said what it did without a tooltip, and a title bar that
 * accumulates one control per setting does not scale past the two we have.
 *
 * Board thresholds are shown but not editable. They are real preferences and
 * belong here eventually; they are compile-time constants today, and displaying
 * the values beats pretending they do not exist — you can at least see what the
 * boards are doing without reading the source.
 */
export function Preferences(): React.JSX.Element {
  const { theme, setTheme, titling, toggleTitling, closeOverlay } = useStore()

  return (
    <Overlay
      title="PREFERENCES"
      subtitle="What the tower does on your behalf, and how it looks doing it."
      onClose={closeOverlay}
    >
      <Section title="SESSION SUMMARIES">
        <Toggle
          on={titling}
          onChange={() => void toggleTitling()}
          label="Summarise active sessions"
          body={
            titling
              ? 'On. EN ROUTE sessions get a generated title and a sentence on where the work stands. Each summary is one Claude call against your subscription, cached until the transcript changes — roughly a boardful on first run, then only what moves.'
              : 'Off. No Claude calls are made. Summaries already generated stay on the board; sessions without one fall back to their opening request. APPROACH is unaffected — its state line is composed from review data, never generated.'
          }
        />
      </Section>

      <Section title="DISPLAY">
        {THEMES.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => void setTheme(name)}
            aria-pressed={name === theme}
            className={cn(
              'flex w-full items-start gap-2 rounded px-2 py-2 text-left transition-colors',
              name === theme ? 'bg-surface-raised' : 'hover:bg-surface-raised',
            )}
          >
            <Check
              size={11}
              className={cn('mt-1 shrink-0', name === theme ? 'text-cleared' : 'opacity-0')}
              aria-hidden
            />
            <span className="min-w-0">
              <span className="block text-[12px] font-medium">{THEME_LABELS[name]}</span>
              <span className="text-text-subtle block text-[11px] leading-tight">
                {THEME_HINTS[name]}
              </span>
            </span>
          </button>
        ))}
      </Section>

      <Section title="BOARD THRESHOLDS">
        <p className="text-text-muted text-[11px] leading-snug">
          EN ROUTE holds running sessions touched in the last{' '}
          <span className="field text-text">{EN_ROUTE_WINDOW_HOURS} hours</span>. LANDED holds the
          last <span className="field text-text">{LANDED_LIMIT}</span> merged pull requests. Both
          are fixed for now.
        </p>
      </Section>
    </Overlay>
  )
}

/**
 * A switch that reads as one in both positions.
 *
 * The control this replaces showed nothing at all when it was on, so "on" and
 * "broken" looked identical. Here the track is always visible and the knob moves,
 * which is the part you can read without hovering.
 */
function Toggle({
  on,
  onChange,
  label,
  body,
}: {
  on: boolean
  onChange: () => void
  label: string
  body: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onChange}
      role="switch"
      aria-checked={on}
      className="hover:bg-surface-raised flex w-full items-start gap-3 rounded px-2 py-2 text-left transition-colors"
    >
      <span
        aria-hidden
        className={cn(
          'mt-0.5 flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors',
          on ? 'bg-cleared justify-end' : 'bg-dormant justify-start',
        )}
      >
        <span className={cn('block size-3 rounded-full', on ? 'bg-cleared-fg' : 'bg-dormant-fg')} />
      </span>
      <span className="min-w-0">
        <span className="block text-[12px] font-medium">{label}</span>
        <span className="text-text-subtle mt-0.5 block text-[11px] leading-snug">{body}</span>
      </span>
    </button>
  )
}
