import { useEffect, useState } from 'react'
import type { Board } from '../../shared/types.js'
import { Radar, SearchX } from 'lucide-react'
import { FlightStrip } from './components/FlightStrip.js'
import { Departures } from './components/Departures.js'
import { Legend } from './components/Legend.js'
import { Preferences } from './components/Preferences.js'
import { Tabs } from './components/Tabs.js'
import { TitleBar } from './components/TitleBar.js'
import { sessionsOn, splitByBoard, type Boards } from '../../shared/boards.js'
import { search, type SearchResult } from '../../shared/search.js'

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
    boardLimits,
    query,
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

  const boards = splitByBoard(snapshot, boardLimits)
  const { enRoute, holding, approach, landed, olderCount, collapsed, trimmed } = boards
  const folded =
    board === 'approach' ? collapsed.approach : board === 'landed' ? collapsed.landed : 0
  const strips = sessionsOn(boards, board)

  /**
   * Search results, classified with the limits removed.
   *
   * Deliberately not searching `boards`. The limits trim the oldest rows off LANDED and
   * EN ROUTE, and a search bounded the same way could not find the rows you can no
   * longer see — which is most of the reason to search at all. Every row still reports
   * the board it belongs to, so a trimmed row is found and correctly labelled LANDED.
   */
  const searching = query !== null && query.trim().length > 0
  const results = searching
    ? search(
        splitByBoard(snapshot, { enRoute: null, holding: null, approach: null, landed: null }),
        departures,
        query,
      )
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
        counts={{
          departures: departures.length,
          'en-route': enRoute.length,
          holding: holding.length,
          approach: approach.length,
          landed: landed.length,
        }}
        unread={{
          // A filed plan has no session and so no activity to have missed.
          departures: false,
          'en-route': enRoute.some((s) => s.unread),
          holding: holding.some((s) => s.unread),
          approach: approach.some((s) => s.unread),
          landed: landed.some((s) => s.unread),
        }}
      />

      <main className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <p className="text-alert field px-3 py-4 text-ui">
            SCOPE FAILURE — could not read sessions: {error}
          </p>
        )}

        {/*
          Results take the whole surface while a query is live, rather than filtering the
          current board. A search that only narrowed the tab you happened to be on would
          keep the thing you are looking for hidden on another one.
        */}
        {!error && searching && <Results results={results} query={query} />}

        {!error && !searching && board === 'departures' && <Departures />}

        {!error && !searching && board !== 'departures' && strips.length === 0 && (
          <Placeholder
            icon={<Radar size={20} aria-hidden />}
            title={EMPTY[board].title}
            body={EMPTY[board].body}
          />
        )}

        {!searching &&
          strips.map((session) => (
            <FlightStrip key={session.sessionId} session={session} board={board} />
          ))}

        {/* Named, not silently dropped. A bounded board that admits its bound is
            honest; one that just stops is lossy and you cannot tell. */}
        {!searching && folded > 0 && (
          <p className="text-text-subtle field border-scope-line border-t px-3 py-3 text-footnote">
            {folded} EARLIER SESSION{folded === 1 ? '' : 'S'} FOLDED IN — ALREADY REPRESENTED BY THE
            ROW FOR {folded === 1 ? 'ITS' : 'THEIR'} PULL REQUEST
          </p>
        )}

        {!searching && board !== 'departures' && trimmed[BOARD_KEY[board]] > 0 && (
          <p className="text-text-subtle field border-scope-line border-t px-3 py-3 text-footnote">
            {trimmed[BOARD_KEY[board]]} MORE NOT SHOWN — THIS BOARD IS SET TO HOLD {strips.length}.
            RAISE IT IN PREFERENCES.
          </p>
        )}

        {!searching && board === 'landed' && olderCount > 0 && (
          <p className="text-text-subtle field border-scope-line border-t px-3 py-3 text-footnote">
            {olderCount} SESSION{olderCount === 1 ? '' : 'S'} OFF THE BOARDS — NOT RUNNING, AND NO
            PULL REQUEST OF ANY KIND
          </p>
        )}
      </main>

      {snapshot && snapshot.warnings.length > 0 && (
        <footer className="border-border-base text-caution field shrink-0 border-t px-2.5 py-1 text-footnote">
          {snapshot.warnings.length} ADVISORY FROM LAST SWEEP
        </footer>
      )}
    </div>
  )
}

/**
 * Tab name to limits key. Only the four inferred boards have limits — DEPARTURES is a
 * list you wrote, and trimming that would be deleting your own rows.
 */
const BOARD_KEY: Record<Exclude<Board, 'departures'>, keyof Boards['trimmed']> = {
  'en-route': 'enRoute',
  holding: 'holding',
  approach: 'approach',
  landed: 'landed',
}

/** Empty-state copy per board, so "nothing here" still says what it means. */
const EMPTY: Record<Exclude<Board, 'departures'>, { title: string; body: string }> = {
  approach: {
    title: 'NOBODY WAITING',
    body: 'Nothing has an open pull request. Everything is either still being worked, parked, or already merged.',
  },
  'en-route': {
    title: 'NOTHING IN THE AIR',
    body: 'No running session without a pull request open. Anything that has one is on APPROACH, and a session whose process has exited is not in the air at all.',
  },
  holding: {
    title: 'NOTHING PARKED',
    body: 'Anything you send here is set aside without disappearing — a session you are not working on, or an approved pull request you are not ready to merge. No time limit, and it stays even after the terminal closes. Use HOLD on a row to park one.',
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
      <p className="field text-text-muted text-ui font-semibold tracking-wider">{title}</p>
      <p className="max-w-[22rem] text-ui">{body}</p>
    </div>
  )
}

/** Board name as it appears on its tab, for labelling where a result came from. */
const BOARD_LABEL: Record<Board, string> = {
  departures: 'DEPARTURES',
  holding: 'HOLDING',
  'en-route': 'EN ROUTE',
  approach: 'APPROACH',
  landed: 'LANDED',
}

/** What matched, in words, so the label reads as a sentence rather than a field name. */
const FIELD_LABEL: Record<SearchResult['field'], string> = {
  title: 'title',
  name: 'session name',
  summary: 'summary',
  notes: 'notes',
  directory: 'directory',
}

/**
 * Search results, drawn as a board of their own.
 *
 * Real strips rather than a list of links: a result is the row, and everything you would
 * do to it on its own board — tune it, rename it, park it, open its PR — should work
 * here too. `FlightStrip` is already board-aware, so passing each hit's own board makes
 * it render exactly as it does there, chips and actions included.
 *
 * Each row carries a line above it naming the board it belongs to and quoting what
 * matched. Both halves earn their place: the board is the fact you had forgotten and
 * came here to recover, and the quote is why this row is in a list you did not expect it
 * in — a hit in a summary is otherwise invisible, since the summary is truncated on the
 * strip below.
 */
function Results({
  results,
  query,
}: {
  results: SearchResult[]
  query: string
}): React.JSX.Element {
  const { closeSearch, setBoard } = useStore()

  /**
   * Acting on a result ends the search, and lands you on that row's own board.
   *
   * Returning to whichever tab you were on before would put the row you just chose back
   * out of sight, which is the opposite of what clicking it meant. The result already
   * told you which board it was on; this takes you there, so the row is on screen where
   * the label said it would be.
   */
  const leave = (board: Board) => () => {
    closeSearch()
    setBoard(board)
  }

  if (results.length === 0) {
    return (
      <Placeholder
        icon={<SearchX size={20} aria-hidden />}
        title="NO MATCH"
        body={`Nothing on any board matches “${query.trim()}”. Every word has to appear somewhere on a row — title, session name, summary, notes or directory — so try fewer of them.`}
      />
    )
  }

  return (
    <>
      <p className="text-text-subtle field border-scope-line border-b px-4 py-2 text-footnote tracking-wider">
        {results.length} MATCH{results.length === 1 ? '' : 'ES'} ACROSS EVERY BOARD, INCLUDING ROWS
        A LIMIT IS HIDING
      </p>

      {results.map((result) => (
        <div key={resultKey(result)}>
          <p className="text-text-subtle border-scope-line flex flex-wrap items-baseline gap-x-2 border-b px-4 pt-3 text-footnote">
            <span className="field text-text-muted shrink-0 tracking-wider">
              {BOARD_LABEL[result.board]}
            </span>
            <span className="shrink-0 opacity-60">matched in {FIELD_LABEL[result.field]}:</span>
            <span className="min-w-0 italic">{result.snippet}</span>
          </p>

          {result.kind === 'session' ? (
            <FlightStrip
              session={result.session}
              board={result.board}
              onActivate={leave(result.board)}
            />
          ) : (
            /* A filed plan has no strip of its own — DEPARTURES renders its whole list
               as one editable unit — so it appears here as what it is: a title and the
               directory it would run in. Editing stays on its own board, where the
               ordering and launch controls live. */
            <button
              type="button"
              onClick={leave('departures')}
              title="Open DEPARTURES, where this plan can be edited or launched"
              className="border-scope-line hover:bg-surface-raised no-drag flex w-full flex-col gap-1 border-b px-4 py-5 text-left transition-colors"
            >
              <span className="text-headline leading-6 font-medium">{result.departure.title}</span>
              <span className="field text-text-subtle text-ui">
                {result.departure.cwd ?? 'no directory set'}
              </span>
            </button>
          )}
        </div>
      ))}
    </>
  )
}

/** Stable per row, and distinct across the two kinds — ids collide between them. */
function resultKey(result: SearchResult): string {
  return result.kind === 'session'
    ? `s:${result.session.sessionId}:${result.board}`
    : `d:${result.departure.id}`
}
