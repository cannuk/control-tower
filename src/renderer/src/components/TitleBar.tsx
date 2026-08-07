import { Check, RadioTower, Radar } from 'lucide-react'
import { THEME_HINTS, THEME_LABELS, THEMES } from '../../../shared/types.js'
import { elapsed } from '../lib/time.js'
import { cn } from '../lib/utils.js'
import { useStore } from '../store.js'

/**
 * The window is frameless, so this bar IS the chrome: it owns the drag region.
 * Every interactive child needs .no-drag or it becomes an undraggable dead zone
 * that also can't be clicked.
 *
 * The readout mimics a facility status line: who you are, when the scope last
 * swept. `SWEEP 12S` rather than "updated 12 seconds ago" — same information,
 * fixed width, scans without reading.
 */
export function TitleBar(): React.JSX.Element {
  const { theme, setTheme, refresh, loading, snapshot, toggleLegend, titling, toggleTitling } =
    useStore()

  return (
    <header className="drag-region border-border-base flex h-14 shrink-0 items-center gap-2.5 border-b pr-3 pl-20">
      <RadioTower size={13} className="text-accent shrink-0" aria-hidden />
      <h1 className="field text-[11px] font-semibold tracking-widest">CONTROL TOWER</h1>

      <span className="field text-text-subtle flex-1 text-[11px]">
        {snapshot ? `SWEEP ${elapsed(snapshot.sweptAt)}` : 'ACQUIRING'}
      </span>

      <button
        type="button"
        onClick={() => void toggleTitling()}
        title={
          titling
            ? 'Session titling is on — generating summaries costs Claude usage. Click to stop.'
            : 'Session titling is off — strips fall back to their opening request. Click to resume.'
        }
        className={cn(
          'no-drag hover:bg-surface-raised rounded p-1.5 transition-colors',
          titling ? 'text-cleared' : 'text-text-subtle hover:text-text',
        )}
      >
        <span className="field text-[10px] font-semibold tracking-wider">
          {titling ? 'TITLE' : 'TITLE ○'}
        </span>
      </button>

      <button
        type="button"
        onClick={toggleLegend}
        title="Strip marking key — what every term means"
        className="no-drag hover:bg-surface-raised text-text-muted hover:text-text rounded p-1.5 transition-colors"
      >
        <span className="field text-[10px] font-semibold tracking-wider">KEY</span>
      </button>

      <button
        type="button"
        onClick={() => void refresh()}
        title="Sweep now"
        className="no-drag hover:bg-surface-raised text-text-muted hover:text-text rounded p-1.5 transition-colors"
      >
        <Radar size={13} className={cn(loading && 'animate-spin')} aria-hidden />
      </button>

      <div className="no-drag group relative">
        <button
          type="button"
          title="Display mode"
          className="hover:bg-surface-raised text-text-muted hover:text-text rounded p-1.5 transition-colors"
        >
          <span className="field text-[10px] font-semibold tracking-wider">DISP</span>
        </button>
        {/* Hover-driven for M1; becomes a Radix dropdown once the palette count
            outgrows what a hover menu can hold. */}
        <div className="bg-surface border-border-strong invisible absolute right-0 z-10 mt-1 w-52 rounded-md border p-1 opacity-0 shadow-2xl transition-all group-hover:visible group-hover:opacity-100">
          {THEMES.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => void setTheme(name)}
              className={cn(
                'flex w-full items-start gap-1.5 rounded px-2 py-1.5 text-left transition-colors',
                name === theme ? 'bg-surface-raised' : 'hover:bg-surface-raised',
              )}
            >
              <Check
                size={11}
                className={cn('mt-0.5 shrink-0', name === theme ? 'text-cleared' : 'opacity-0')}
                aria-hidden
              />
              <span className="min-w-0">
                <span className="block text-[12px] font-medium">{THEME_LABELS[name]}</span>
                <span className="text-text-subtle block text-[10px] leading-tight">
                  {THEME_HINTS[name]}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </header>
  )
}
