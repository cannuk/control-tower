import { Search, X } from 'lucide-react'
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
      title: 'Still running and being worked, with no pull request open yet',
    },
    {
      id: 'approach',
      label: 'APPROACH',
      count: counts.approach,
      title: 'On approach — every pull request that has not merged yet',
    },
    { id: 'landed', label: 'LANDED', count: counts.landed, title: 'Recently merged' },
  ]

  return (
    <nav
      role="tablist"
      className="border-border-base flex h-[52px] shrink-0 items-center gap-1.5 border-b px-3"
    >
      {/*
        Search sits with the tabs but is not one of them. A row can be on any board, and
        the whole reason to search is that you have forgotten which — a SEARCH tab would
        ask you to pick a board first, which is the problem.

        Leftmost, because when it is open it takes the bar over and a field that expands
        rightwards from the middle shoves every tab as you type.
      */}
      <SearchControl />
      <span aria-hidden className="bg-border-base mr-0.5 h-5 w-px shrink-0" />
      {boards.map(({ id, label, count, title }) => (
        <button
          key={id}
          role="tab"
          aria-selected={board === id}
          title={unread[id] ? `${title} — new activity you have not opened` : title}
          onClick={() => setBoard(id)}
          className={cn(
            'field relative shrink-0 rounded px-3.5 py-2.5 text-[11.5px] font-semibold tracking-wider transition-colors',
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

/**
 * The magnifier, and the field it becomes.
 *
 * One control in two states rather than a permanent field: the bar has five tabs in it
 * already, and a search box sitting empty on a dashboard is an invitation to a feature
 * most glances do not need. Closed it is an icon; open it takes the space it needs.
 *
 * The tabs stay visible and clickable while it is open, so clicking a board is how you
 * leave a search — the same gesture as going anywhere else, and one you would try
 * anyway.
 */
function SearchControl(): React.JSX.Element {
  const { query, openSearch, setQuery, closeSearch } = useStore()

  if (query === null) {
    return (
      <button
        type="button"
        onClick={openSearch}
        title="Search every board by title, summary or directory"
        aria-label="Search"
        className="text-text-subtle hover:text-text hover:bg-surface-raised shrink-0 rounded p-2 transition-colors"
      >
        <Search size={14} aria-hidden />
      </button>
    )
  }

  return (
    <span className="bg-surface-raised ring-border flex min-w-0 flex-1 items-center gap-1.5 rounded px-2 ring-1">
      <Search size={13} aria-hidden className="text-text-subtle shrink-0" />
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        // Escape closes rather than clearing: with an empty field those are the same
        // keystroke twice, and an input you cannot get out of with Escape is a trap.
        onKeyDown={(e) => {
          if (e.key === 'Escape') closeSearch()
        }}
        placeholder="Search titles and summaries…"
        aria-label="Search every board"
        className="text-text placeholder:text-text-subtle min-w-0 flex-1 bg-transparent py-2 text-ui outline-none"
      />
      <button
        type="button"
        onClick={closeSearch}
        title="Close search"
        aria-label="Close search"
        className="text-text-subtle hover:text-text shrink-0 rounded p-1 transition-colors"
      >
        <X size={13} aria-hidden />
      </button>
    </span>
  )
}
