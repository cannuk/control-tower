import { useEffect, useState } from 'react'
import { Radar } from 'lucide-react'
import { FlightStrip } from './components/FlightStrip.js'
import { Departures } from './components/Departures.js'
import { Legend } from './components/Legend.js'
import { Preferences } from './components/Preferences.js'
import { Tabs } from './components/Tabs.js'
import { TitleBar } from './components/TitleBar.js'
import { splitByBoard } from '../../shared/boards.js'
import { useStore } from './store.js'

export function App(): React.JSX.Element {
  const {
    init,
    snapshot,
    board,
    error,
    bumpTick,
    overlay,
    closeOverlay,
    subscribe,
    scanId,
    departures,
  } = useStore()

  useEffect(() => {
    void init()
  }, [init])

  // Live updates. The unsubscribe matters under StrictMode, which mounts twice —
  // without it every pushed sweep would be handled twice over.
  useEffect(() => subscribe(), [subscribe])

  // Elapsed-time fields go stale silently otherwise — nothing else re-renders
  // them, so every strip would show the age it had at load, forever.
  useEffect(() => {
    const id = setInterval(bumpTick, 30_000)
    return () => clearInterval(id)
  }, [bumpTick])

  // Escape closes whichever panel is up. Any overlay that traps you is worse than
  // no overlay, and the listener lives here rather than in the panels so it works
  // before either has taken focus.
  useEffect(() => {
    if (overlay === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeOverlay()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [overlay, closeOverlay])

  const { enRoute, approach, landed, olderCount, collapsed } = splitByBoard(snapshot)
  const folded =
    board === 'approach' ? collapsed.approach : board === 'landed' ? collapsed.landed : 0
  const strips =
    board === 'approach'
      ? approach
      : board === 'en-route'
        ? enRoute
        : board === 'landed'
          ? landed
          : []

  return (
    <div className="bg-bg text-text relative flex h-full flex-col overflow-hidden">
      {/* The scan sweep. Keyed on scanId so pressing sweep again restarts it mid-
          flight, and mounted above the rack but below the panels — a sweep should
          wash over the boards, not over an open dialog. */}
      {scanId > 0 && <ScanSweep key={scanId} />}

      {overlay === 'key' && <Legend onClose={closeOverlay} />}
      {overlay === 'preferences' && <Preferences />}

      <TitleBar />
      <Tabs
        departuresCount={departures.length}
        enRouteCount={enRoute.length}
        approachCount={approach.length}
        landedCount={landed.length}
      />

      <main className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <p className="text-alert field px-3 py-4 text-[11px]">
            SCOPE FAILURE — could not read sessions: {error}
          </p>
        )}

        {!error && board === 'departures' && <Departures />}

        {!error && board !== 'departures' && strips.length === 0 && (
          <Placeholder
            icon={<Radar size={20} aria-hidden />}
            title={EMPTY[board].title}
            body={EMPTY[board].body}
          />
        )}

        {strips.map((session) => (
          <FlightStrip key={session.sessionId} session={session} board={board} />
        ))}

        {/* Named, not silently dropped. A bounded board that admits its bound is
            honest; one that just stops is lossy and you cannot tell. */}
        {folded > 0 && (
          <p className="text-text-subtle field border-scope-line border-t px-3 py-3 text-[10px]">
            {folded} EARLIER SESSION{folded === 1 ? '' : 'S'} FOLDED IN — ALREADY REPRESENTED BY THE
            ROW FOR {folded === 1 ? 'ITS' : 'THEIR'} PULL REQUEST
          </p>
        )}

        {board === 'landed' && olderCount > 0 && (
          <p className="text-text-subtle field border-scope-line border-t px-3 py-3 text-[10px]">
            {olderCount} SESSION{olderCount === 1 ? '' : 'S'} OFF THE BOARDS — NOT IN FLIGHT,
            NOTHING IN REVIEW, NOTHING SHIPPED RECENTLY
          </p>
        )}
      </main>

      {snapshot && snapshot.warnings.length > 0 && (
        <footer className="border-border-base text-caution field shrink-0 border-t px-2.5 py-1 text-[10px]">
          {snapshot.warnings.length} ADVISORY FROM LAST SWEEP
        </footer>
      )}
    </div>
  )
}

/** Empty-state copy per board, so "nothing here" still says what it means. */
const EMPTY: Record<'en-route' | 'approach' | 'landed', { title: string; body: string }> = {
  approach: {
    title: 'NOBODY WAITING',
    body: 'No unmerged PR has been reviewed or commented on by a human. Nothing needs a decision from you right now.',
  },
  'en-route': {
    title: 'NOTHING IN THE AIR',
    body: 'No running session touched in the last 8 hours that is still waiting on its first human review.',
  },
  landed: {
    title: 'NOTHING SHIPPED',
    body: 'No pull request has merged recently.',
  },
}

/**
 * One pass of the scan band, which removes itself when it finishes.
 *
 * Self-unmounting rather than left in the tree: an element with a completed
 * `forwards` animation is still a compositing layer over the whole window, and
 * leaving one per sweep would stack them up for the life of the session.
 */
function ScanSweep(): React.JSX.Element | null {
  const [done, setDone] = useState(false)
  if (done) return null
  return (
    <div aria-hidden className="scan-sweep absolute z-10" onAnimationEnd={() => setDone(true)} />
  )
}

function Placeholder({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode
  title: string
  body: string
}): React.JSX.Element {
  return (
    <div className="text-text-subtle flex flex-col items-center gap-2 px-6 py-16 text-center">
      {icon}
      <p className="field text-text-muted text-[11px] font-semibold tracking-wider">{title}</p>
      <p className="max-w-[22rem] text-[11px]">{body}</p>
    </div>
  )
}
