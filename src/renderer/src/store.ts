import { create } from 'zustand'
import { isOpen, onApproach, type Board, type Session, type SessionSnapshot, type ThemeName } from '../../shared/types.js'

/**
 * How recent a session must be to count as "in the air" on EN ROUTE.
 *
 * Only EN ROUTE needs a recency bound. APPROACH and LANDED are defined by PR
 * state, which is meaningful however long ago you last typed — a PR with feedback
 * waiting does not stop mattering because you closed the terminal. EN ROUTE has no
 * such anchor, so without a window it would list every session you have ever run
 * that never got reviewed: ~90 rows of history rather than today's work.
 */
export const EN_ROUTE_WINDOW_HOURS = 8

/** How many recently merged PRs the LANDED board holds. */
export const LANDED_LIMIT = 10

interface State {
  theme: ThemeName
  board: Board
  snapshot: SessionSnapshot | null
  loading: boolean
  error: string | null
  /** Bumped on an interval purely so elapsed-time fields re-render. */
  tick: number
  legendOpen: boolean

  init: () => Promise<void>
  setTheme: (theme: ThemeName) => Promise<void>
  setBoard: (board: Board) => void
  refresh: () => Promise<void>
  bumpTick: () => void
  toggleLegend: () => void
  subscribe: () => () => void
}

/**
 * Applying the display mode is a DOM write, not React state — the attribute
 * lives on <html>, above the React root, and every token resolves from it.
 */
function applyTheme(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme
}

export const useStore = create<State>((set, get) => ({
  theme: 'night-scope',
  board: 'approach',
  snapshot: null,
  loading: true,
  error: null,
  tick: 0,
  legendOpen: false,

  init: async () => {
    try {
      const theme = await window.controlTower.getTheme()
      applyTheme(theme)
      set({ theme })
      await get().refresh()
    } catch (cause) {
      set({ error: cause instanceof Error ? cause.message : String(cause), loading: false })
    }
  },

  setTheme: async (theme) => {
    applyTheme(theme)
    set({ theme })
    await window.controlTower.setTheme(theme)
  },

  setBoard: (board) => set({ board }),

  refresh: async () => {
    set({ loading: true })
    try {
      const snapshot = await window.controlTower.getSnapshot()
      set({ snapshot, loading: false, error: null })
    } catch (cause) {
      set({ error: cause instanceof Error ? cause.message : String(cause), loading: false })
    }
  },

  bumpTick: () => set((s) => ({ tick: s.tick + 1 })),

  toggleLegend: () => set((s) => ({ legendOpen: !s.legendOpen })),

  /**
   * Take pushed sweeps from the watcher. The initial paint still uses a pull so
   * the board is populated before the first file event, which on a quiet machine
   * could otherwise be minutes away.
   */
  subscribe: () =>
    window.controlTower.onSnapshot((snapshot) => set({ snapshot, loading: false, error: null })),
}))

const prKey = (repository: string, number: number): string => repository + '#' + number

/**
 * Sort every session onto its board.
 *
 * Precedence is deliberate, because a session can hold several PRs at once:
 * APPROACH wins over everything, since a PR a human is waiting on is the most
 * actionable thing on the board and must not be buried by a sibling PR that
 * happens to have merged.
 */
export function splitByBoard(snapshot: SessionSnapshot | null, now = Date.now()) {
  const empty = { enRoute: [], approach: [], landed: [], olderCount: 0 }
  if (!snapshot) return empty

  const sessions = [...snapshot.sessions].sort((a, b) => b.lastContact - a.lastContact)

  // The N most recently merged PRs across the whole board. Deduped by key first:
  // one PR is often linked from several sessions, and it should occupy one slot.
  const mergedByKey = new Map<string, number>()
  for (const session of sessions) {
    for (const pr of session.prs) {
      if (!pr.mergedAt) continue
      mergedByKey.set(prKey(pr.repository, pr.number), Date.parse(pr.mergedAt))
    }
  }
  const recentlyMerged = new Set(
    [...mergedByKey.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, LANDED_LIMIT)
      .map(([key]) => key),
  )

  const cutoff = now - EN_ROUTE_WINDOW_HOURS * 3600_000
  const approach: Session[] = []
  const landed: Session[] = []
  const enRoute: Session[] = []
  let olderCount = 0

  for (const session of sessions) {
    if (session.prs.some(onApproach)) {
      approach.push(session)
    } else if (
      // LANDED means finished, so nothing still in flight may appear here — not
      // even alongside a merge. A session can hold several PRs, and one merged
      // sibling must not file the whole session under "shipped" while an open PR
      // is still sitting there: that is work you would never look for again.
      !session.prs.some(isOpen) &&
      session.prs.some((pr) => recentlyMerged.has(prKey(pr.repository, pr.number)))
    ) {
      landed.push(session)
    } else if (session.lastContact >= cutoff) {
      enRoute.push(session)
    } else {
      // Not on any board: no live PR conversation, nothing recently shipped, and
      // not touched today. Counted so the board can say so rather than pretending
      // these sessions do not exist.
      olderCount += 1
    }
  }

  // LANDED reads as a shipping log, so order it by merge time rather than by when
  // the session was last touched.
  const mergeTime = (session: Session): number =>
    Math.max(
      ...session.prs.map((pr) => (pr.mergedAt ? Date.parse(pr.mergedAt) : 0)),
      0,
    )
  landed.sort((a, b) => mergeTime(b) - mergeTime(a))

  return { enRoute, approach, landed, olderCount }
}
