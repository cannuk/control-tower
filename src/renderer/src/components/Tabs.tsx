import type { Board } from '../../../shared/types.js'
import { cn } from '../lib/utils.js'
import { useStore } from '../store.js'

interface BoardSpec {
  id: Board
  label: string
  count: number
  title: string
}

/**
 * The four boards, left to right in the order work moves through them:
 * queued, being worked, under review, shipped.
 *
 * That ordering is the point. The previous split was by recency, which answered
 * "when did I last type here" — a fact about a process, not about whether anyone
 * is waiting on you. This answers where the work sits.
 */
export function Tabs({
  holdingCount,
  enRouteCount,
  approachCount,
  landedCount,
}: {
  holdingCount: number
  enRouteCount: number
  approachCount: number
  landedCount: number
}): React.JSX.Element {
  const { board, setBoard } = useStore()

  const boards: BoardSpec[] = [
    {
      id: 'holding',
      label: 'HOLDING',
      count: holdingCount,
      title: 'Holding short — work staged for a future session',
    },
    {
      id: 'en-route',
      label: 'EN ROUTE',
      count: enRouteCount,
      title: 'Still running and being worked — no PR yet, or no human has reviewed it',
    },
    {
      id: 'approach',
      label: 'APPROACH',
      count: approachCount,
      title: 'On approach — unmerged PR that a human has reviewed or commented on',
    },
    { id: 'landed', label: 'LANDED', count: landedCount, title: 'Recently merged' },
  ]

  return (
    <nav
      role="tablist"
      className="border-border-base flex shrink-0 items-center gap-1 border-b px-3 py-2.5"
    >
      {boards.map(({ id, label, count, title }) => (
        <button
          key={id}
          role="tab"
          aria-selected={board === id}
          title={title}
          onClick={() => setBoard(id)}
          className={cn(
            'field rounded px-3 py-2 text-[11px] font-semibold tracking-wider transition-colors',
            board === id ? 'bg-surface-raised text-text' : 'text-text-subtle hover:text-text',
          )}
        >
          {label}
          <span
            className={cn(
              'ml-1.5 tabular-nums',
              // A zero count should recede; a non-zero one on APPROACH is the
              // number you actually came here to read.
              count === 0 ? 'opacity-35' : id === 'approach' ? 'text-caution' : 'opacity-60',
            )}
          >
            {count}
          </span>
        </button>
      ))}
    </nav>
  )
}
