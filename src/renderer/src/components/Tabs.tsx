import type { Board } from '../../../shared/types.js'
import { UNREAD_DOT } from '../lib/status.js'
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
 *
 * Given a fixed 52px height rather than padding, so it sizes against the title bar
 * deliberately: these are the two fixed bands above a scrolling rack, and one
 * noticeably thinner than the other reads as an accident.
 */
export function Tabs({
  counts,
  unread,
}: {
  counts: Record<Board, number>
  /**
   * Boards holding at least one session with activity you have not opened.
   *
   * Separate from the count on purpose: the count says how much is here, the dot says
   * whether any of it has moved since you looked. A full board can be entirely read.
   */
  unread: Record<Board, boolean>
}): React.JSX.Element {
  const { board, setBoard } = useStore()

  const boards: BoardSpec[] = [
    {
      id: 'departures',
      label: 'DEPARTURES',
      count: counts.departures,
      title: 'Filed flight plans — work you intend to start, not a session yet',
    },
    {
      id: 'holding',
      label: 'HOLDING',
      count: counts.holding,
      title: 'Parked by you — set aside without being forgotten',
    },
    {
      id: 'en-route',
      label: 'EN ROUTE',
      count: counts['en-route'],
      title: 'Still running and being worked — no PR yet, or no human has reviewed it',
    },
    {
      id: 'approach',
      label: 'APPROACH',
      count: counts.approach,
      title: 'On approach — unmerged PR that a human has reviewed or commented on',
    },
    { id: 'landed', label: 'LANDED', count: counts.landed, title: 'Recently merged' },
  ]

  return (
    <nav
      role="tablist"
      className="border-border-base flex h-[52px] shrink-0 items-center gap-1.5 border-b px-3"
    >
      {boards.map(({ id, label, count, title }) => (
        <button
          key={id}
          role="tab"
          aria-selected={board === id}
          title={unread[id] ? `${title} — new activity you have not opened` : title}
          onClick={() => setBoard(id)}
          className={cn(
            'field relative rounded px-3.5 py-2.5 text-[11.5px] font-semibold tracking-wider transition-colors',
            board === id ? 'bg-surface-raised text-text' : 'text-text-subtle hover:text-text',
          )}
        >
          {/* Placed over the tab's top-right corner rather than inline, or the label
              would shift each time it appears and disappears. It stays lit until every
              session on the board has been opened. */}
          {unread[id] && (
            <span
              aria-hidden
              className={cn('absolute top-1 right-1 size-2 rounded-full', UNREAD_DOT)}
            />
          )}
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
