import { useState } from 'react'
import { RadarScope } from './icons/RadarScope.js'
import { TowerMark } from './icons/TowerMark.js'
import { absoluteTime, elapsed } from '../lib/time.js'
import { cn } from '../lib/utils.js'
import { useStore } from '../store.js'

/**
 * The window is frameless, so this bar IS the chrome: it owns the drag region.
 * Every interactive child needs .no-drag or it becomes an undraggable dead zone
 * that also can't be clicked.
 *
 * It holds three controls and no status text. It previously carried a `SWEEP 12S`
 * readout beside the title, a `TITLE` toggle and a `DISP` theme menu — one control
 * per setting, each needing a tooltip to explain itself, plus a field that
 * duplicated what the sweep button already means. Settings moved to preferences;
 * the freshness figure moved into the tooltip of the button that controls it, where
 * it is next to the action it describes rather than competing with the app name.
 *
 * 68px tall rather than 56 (--spacing-titlebar, shared with the overlays, which have
 * to clear it): this bar is the app's chrome and its only branding, and
 * at the old height it read as a row of buttons sitting above the boards instead of
 * as the top of a console. The height is what lets the mark be 32px.
 *
 * `pl-24` rather than `pl-20`, because the left inset is not decoration — macOS draws
 * the traffic lights inside this bar (`titleBarStyle: 'hiddenInset'`) and they end
 * around 70px, so 80px of padding left the mark almost touching the close button.
 */
export function TitleBar(): React.JSX.Element {
  const { refresh, loading, snapshot, toggleOverlay, scanId } = useStore()

  // Short enough to read at a glance. The first version was two full sentences, which
  // a native tooltip's hover delay turns into something you give up on before it
  // appears; the exact timestamp still rides along for when the age is ambiguous.
  const sweep = snapshot
    ? `Sweep now — re-read sessions and refetch PR status. Last swept ${elapsed(snapshot.sweptAt)} ago (${absoluteTime(snapshot.sweptAt)})`
    : 'Sweep now — acquiring the first scan'

  return (
    <header className="drag-region border-border-base flex h-titlebar shrink-0 items-center gap-3 border-b pr-4 pl-24">
      <TowerMark size={32} className="shrink-0" />
      {/*
        min-w-0 and truncate, because a flex item defaults to min-width:auto and so
        refuses to shrink below its text. At the window's 380px minimum the wordmark
        would otherwise push the three buttons off the right edge rather than give up
        any of itself.
      */}
      <h1 className="field min-w-0 flex-1 truncate text-headline font-semibold tracking-widest">
        CONTROL TOWER
      </h1>

      <button
        type="button"
        onClick={() => toggleOverlay('key')}
        title="Strip marking key — what every term on a strip means"
        className="no-drag hover:bg-surface-raised text-text-muted hover:text-text rounded p-1.5 transition-colors"
      >
        <span className="field text-footnote font-semibold tracking-wider">KEY</span>
      </button>

      <button
        type="button"
        onClick={() => void refresh()}
        title={sweep}
        aria-label="Sweep now"
        className="no-drag hover:bg-surface-raised text-text-muted hover:text-text relative rounded p-1.5 transition-colors"
      >
        {/* Keyed on scanId so a second press re-flares mid-bloom, and only mounted
            after the first manual sweep — the silent startup scan must not flash the
            button before you have touched it. */}
        {scanId > 0 && <Flare key={scanId} />}

        {/* The slow sweep pulse, not a spinner. A sweep in progress is background
            work; spinning it at animation speed is louder than the event deserves,
            and the same rule already governs the CI-running chip. */}
        <RadarScope size={15} className={cn('relative', loading && 'animate-sweep')} />
      </button>

      <button
        type="button"
        onClick={() => toggleOverlay('preferences')}
        title="Preferences — summaries and display mode"
        className="no-drag hover:bg-surface-raised text-text-muted hover:text-text rounded p-1.5 transition-colors"
      >
        <span className="field text-footnote font-semibold tracking-wider">PREFS</span>
      </button>
    </header>
  )
}

/**
 * One bloom of the return flare, removed once it has played.
 *
 * Unmounts rather than sitting at `opacity: 0`, so repeated sweeps do not leave a
 * stack of finished layers inside the button for the life of the session.
 */
function Flare(): React.JSX.Element | null {
  const [done, setDone] = useState(false)
  if (done) return null
  return <span aria-hidden className="radar-flare" onAnimationEnd={() => setDone(true)} />
}
