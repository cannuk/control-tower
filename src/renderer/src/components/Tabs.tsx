import { cn } from '../lib/utils.js'
import { useStore, type Board } from '../store.js'

interface BoardSpec {
  id: Board
  label: string
  count?: number
  title: string
}

/**
 * The three boards a controller works, in the order traffic moves through them:
 * what's in the air now, what's already down, and what's still waiting to go.
 *
 * "PATTERN" is the traffic pattern — the circuit around the field where active
 * aircraft are being worked. "HOLDING SHORT" is the runway threshold, where a
 * flight waits with clearance pending: exactly a queued-but-unstarted task.
 */
export function Tabs({
  patternCount,
  landedCount,
}: {
  patternCount: number
  landedCount: number
}): React.JSX.Element {
  const { board, setBoard } = useStore()

  const boards: BoardSpec[] = [
    {
      id: 'pattern',
      label: 'PATTERN',
      count: patternCount,
      title: 'In the pattern — touched in the last 8 hours',
    },
    { id: 'landed', label: 'LANDED', count: landedCount, title: 'Down — everything older' },
    {
      // Reachable even though the queue itself is unbuilt. A disabled tab tells
      // you nothing about what it's for; the board behind it explains itself and
      // shows where the app is going.
      id: 'holding-short',
      label: 'HOLDING SHORT',
      count: 0,
      title: 'Queued for departure — the board is live, the queue lands in M8',
    },
  ]

  return (
    <nav
      role="tablist"
      className="border-border-base flex shrink-0 items-center gap-1.5 border-b px-2.5 py-2"
    >
      {boards.map(({ id, label, count, title }) => (
        <button
          key={id}
          role="tab"
          aria-selected={board === id}
          title={title}
          onClick={() => setBoard(id)}
          className={cn(
            'field rounded px-2.5 py-1.5 text-[11px] font-semibold tracking-wider transition-colors',
            board === id ? 'bg-surface-raised text-text' : 'text-text-subtle hover:text-text',
          )}
        >
          {label}
          {count !== undefined && <span className="ml-1.5 opacity-60">{count}</span>}
        </button>
      ))}
    </nav>
  )
}
