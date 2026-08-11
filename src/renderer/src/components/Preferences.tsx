import { useState } from 'react'
import { Check } from 'lucide-react'
import { THEME_HINTS, THEME_LABELS, THEMES } from '../../../shared/types.js'
import type { BoardLimits } from '../../../shared/boards.js'
import { cn } from '../lib/utils.js'
import { useStore } from '../store.js'
import { Overlay, Section } from './Overlay.js'

/**
 * The range a board limit accepts, mirroring the clamp in the main process.
 *
 * Duplicated deliberately rather than shared: these are input attributes, and the
 * authoritative guard is the one next to the store that persists the value. If they
 * ever disagree the main process wins, which is the safe direction.
 */
const BOARD_LIMIT_MIN = 1
const BOARD_LIMIT_MAX = 200

/**
 * Preferences.
 *
 * Both settings used to live as their own controls in the title bar — a `TITLE`
 * button whose on/off state was a colour shift and a 10px circle, and a `DISP`
 * hover menu. Neither said what it did without a tooltip, and a title bar that
 * accumulates one control per setting does not scale past the two we have.
 *
 * Row limits are per board and editable, replacing a pair of compile-time constants
 * that were displayed but fixed. They are separate settings because the boards want
 * opposite things: the two that list recent work are better bounded, and the two that
 * queue work needing you are better not.
 */
export function Preferences(): React.JSX.Element {
  const {
    theme,
    setTheme,
    titling,
    toggleTitling,
    boardLimits,
    setBoardLimit,
    launchRoot,
    chooseLaunchRoot,
    clearLaunchRoot,
    closeOverlay,
  } = useStore()

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
              <span className="block text-prose font-medium">{THEME_LABELS[name]}</span>
              <span className="text-text-subtle block text-ui leading-tight">
                {THEME_HINTS[name]}
              </span>
            </span>
          </button>
        ))}
      </Section>

      <Section title="LAUNCHING">
        <div className="flex items-start justify-between gap-3 px-2 py-2">
          <span className="min-w-0">
            <span className="text-text block text-prose">Directory picker starts in</span>
            <span className="text-text-subtle mt-0.5 block text-ui leading-snug">
              {launchRoot ? (
                // Wrapped rather than truncated: which directory this is can hinge on any
                // segment of the path, so the end matters as much as the start. Shown in
                // full because that is how the rest of the app shows a cwd.
                <span className="field text-text-muted break-all">{launchRoot}</span>
              ) : (
                'Wherever macOS last had it. Set one and every plan starts from the same place.'
              )}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => void chooseLaunchRoot()}
              className="field hover:bg-surface-raised text-text-muted hover:text-text ring-border rounded px-2 py-1 text-footnote font-semibold tracking-wider ring-1 transition-colors"
            >
              CHOOSE
            </button>
            {launchRoot && (
              <button
                type="button"
                onClick={() => void clearLaunchRoot()}
                title="Go back to letting macOS decide"
                className="field hover:bg-surface-raised text-text-subtle hover:text-text rounded px-2 py-1 text-footnote font-semibold tracking-wider transition-colors"
              >
                CLEAR
              </button>
            )}
          </span>
        </div>
      </Section>

      <Section title="ROWS PER BOARD">
        {LIMIT_FIELDS.map(({ key, label, hint }) => (
          <Limit
            key={key}
            label={label}
            hint={hint}
            value={boardLimits[key]}
            onChange={(limit) => void setBoardLimit(key, limit)}
          />
        ))}
        <p className="text-text-subtle px-2 pt-1 text-ui leading-snug">
          Anything a limit hides is counted at the foot of the board, never dropped silently.
          DEPARTURES is a list you wrote, so it is never trimmed.
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
        <span className="block text-prose font-medium">{label}</span>
        <span className="text-text-subtle mt-0.5 block text-ui leading-snug">{body}</span>
      </span>
    </button>
  )
}

/**
 * The four boards a limit applies to, in tab order.
 *
 * The hints say what the number costs you rather than what it does, because that is
 * the part you cannot see from the board: capping a queue hides the row that has
 * waited longest, which is the opposite of what you want from a queue.
 */
const LIMIT_FIELDS: { key: keyof BoardLimits; label: string; hint: string }[] = [
  {
    key: 'holding',
    label: 'HOLDING',
    hint: 'What you parked on purpose. Best left at All — a limit here discards a decision you made explicitly.',
  },
  {
    key: 'enRoute',
    label: 'EN ROUTE',
    hint: 'The running sessions you spoke to most recently. This replaced an eight-hour window that emptied the board every night.',
  },
  {
    key: 'approach',
    label: 'APPROACH',
    hint: 'People waiting on you. Best left at All — the row a limit hides is the one that has waited longest.',
  },
  { key: 'landed', label: 'LANDED', hint: 'Recent merges, newest first.' },
]

/**
 * One board's row limit, where empty means no limit.
 *
 * Kept as local text rather than driven straight from the number, because a number
 * input is transiently empty while you clear it to type a new value. Reading that
 * empty string as a number is how a board ends up holding zero rows mid-keystroke, so
 * nothing is committed until the value parses inside the range — and an empty field
 * commits `null`, which is how you say "all of them".
 */
function Limit({
  label,
  hint,
  value,
  onChange,
}: {
  label: string
  hint: string
  value: number | null
  onChange: (limit: number | null) => void
}): React.JSX.Element {
  /**
   * Seeded from the stored value and then left alone.
   *
   * Not synced back from the prop: this field is the only thing that writes it, so an
   * effect pushing the committed number back into the box would only ever fight the
   * keystroke that caused it — and it would clobber a half-typed value the moment a
   * sweep re-rendered. The overlay is short-lived, so reopening it re-seeds.
   */
  const [text, setText] = useState(value === null ? '' : String(value))

  return (
    <label className="flex items-start justify-between gap-3 px-2 py-2">
      <span className="min-w-0">
        <span className="field text-text block text-ui font-semibold tracking-wider">{label}</span>
        <span className="text-text-subtle mt-0.5 block text-ui leading-snug">{hint}</span>
      </span>
      <input
        type="number"
        inputMode="numeric"
        min={BOARD_LIMIT_MIN}
        max={BOARD_LIMIT_MAX}
        placeholder="All"
        value={text}
        aria-label={`${label} row limit, blank for all`}
        onChange={(e) => {
          const next = e.target.value
          setText(next)
          if (next.trim() === '') {
            onChange(null)
            return
          }
          const n = Number(next)
          if (Number.isInteger(n) && n >= BOARD_LIMIT_MIN && n <= BOARD_LIMIT_MAX) onChange(n)
        }}
        className="field bg-surface-raised text-text ring-border focus-visible:ring-ring mt-0.5 w-16 shrink-0 rounded px-2 py-1 text-right text-ui ring-1 outline-none"
      />
    </label>
  )
}
