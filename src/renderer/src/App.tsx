import { useEffect } from 'react'
import { PlaneTakeoff, Radar } from 'lucide-react'
import { FlightStrip } from './components/FlightStrip.js'
import { Legend } from './components/Legend.js'
import { Tabs } from './components/Tabs.js'
import { TitleBar } from './components/TitleBar.js'
import { splitByBoard, useStore } from './store.js'

export function App(): React.JSX.Element {
  const { init, snapshot, board, error, bumpTick, legendOpen, toggleLegend, subscribe } =
    useStore()

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

  // Escape closes the key. Any overlay that traps you is worse than no overlay.
  useEffect(() => {
    if (!legendOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') toggleLegend()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [legendOpen, toggleLegend])

  const { enRoute, approach, landed, olderCount } = splitByBoard(snapshot)
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
      {legendOpen && <Legend onClose={toggleLegend} />}

      <TitleBar />
      <Tabs
        holdingCount={0}
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

        {!error && board === 'holding' && (
          <Placeholder
            icon={<PlaneTakeoff size={20} aria-hidden />}
            title="HOLDING SHORT"
            body="A staging area for work you intend to pick up — add an item here and launch it as a session later. Not built yet."
          />
        )}

        {!error && board !== 'holding' && strips.length === 0 && (
          <Placeholder
            icon={<Radar size={20} aria-hidden />}
            title={EMPTY[board].title}
            body={EMPTY[board].body}
          />
        )}

        {strips.map((session) => (
          <FlightStrip key={session.sessionId} session={session} board={board} />
        ))}

        {board === 'landed' && olderCount > 0 && (
          // Named, not silently dropped. A bounded board that admits its bound is
          // honest; one that just stops is lossy and you cannot tell.
          <p className="text-text-subtle field border-scope-line border-t px-3 py-3 text-[10px]">
            {olderCount} SESSION{olderCount === 1 ? '' : 'S'} OFF THE BOARDS — NOTHING IN REVIEW,
            NOTHING SHIPPED RECENTLY
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
    body: 'No session touched in the last 8 hours that is still waiting on its first human review.',
  },
  landed: {
    title: 'NOTHING SHIPPED',
    body: 'No pull request has merged recently.',
  },
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
