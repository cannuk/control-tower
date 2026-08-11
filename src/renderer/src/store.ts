import { create } from 'zustand'
import { DEFAULT_BOARD_LIMITS, type BoardLimits } from '../../shared/boards.js'
import type { Board, Departure, SessionSnapshot, ThemeName } from '../../shared/types.js'

interface State {
  theme: ThemeName
  board: Board
  snapshot: SessionSnapshot | null
  loading: boolean
  error: string | null
  /** Bumped on an interval purely so elapsed-time fields re-render. */
  tick: number
  /**
   * Which full-surface overlay is up, if any.
   *
   * One field rather than a boolean per panel, because they are mutually exclusive
   * and two booleans can represent a state the UI cannot draw — both open at once,
   * stacked, with Escape closing an unpredictable one.
   */
  overlay: Overlay
  titling: boolean
  /** How many rows each board holds, null meaning all — see DEFAULT_BOARD_LIMITS. */
  boardLimits: BoardLimits
  /**
   * Bumped once per *manual* sweep, and used as a React key to replay the scan
   * animation.
   *
   * A counter rather than a boolean because the animation has to be able to restart
   * while the previous one is still running — pressing sweep twice should sweep
   * twice. Remounting on a changed key is what guarantees that; toggling a class
   * would need the element to be removed for a frame first.
   *
   * Deliberately not bumped by pushed snapshots. Those arrive on every transcript
   * write and every 60s poll, so tying the effect to them would make the window
   * flash continuously and mean nothing.
   */
  scanId: number
  /**
   * Filed departures, held in the renderer rather than re-fetched per render.
   *
   * Unlike sessions there is no watcher pushing these — nothing outside this app
   * changes them — so the list is authoritative once loaded and every mutation
   * refreshes it from the main process rather than patching it locally. Patching
   * would mean two implementations of the same ordering rule.
   */
  departures: Departure[]

  init: () => Promise<void>
  setTheme: (theme: ThemeName) => Promise<void>
  setBoardLimit: (board: keyof BoardLimits, limit: number | null) => Promise<void>
  setBoard: (board: Board) => void
  refresh: (announce?: boolean) => Promise<void>
  loadDepartures: () => Promise<void>
  addDeparture: (title: string, notes: string | null, cwd: string | null) => Promise<boolean>
  updateDeparture: (
    id: number,
    fields: { title?: string; notes?: string | null; cwd?: string | null },
  ) => Promise<void>
  removeDeparture: (id: number) => Promise<void>
  moveDeparture: (id: number, index: number) => Promise<void>
  setHeld: (sessionId: string, held: boolean) => Promise<void>
  dismissPr: (repository: string, number: number) => Promise<void>
  markRead: (sessionId: string, at: number) => Promise<void>
  launchDeparture: (id: number) => Promise<string | null>
  bumpTick: () => void
  /** Open a panel, or pass the open one to close it. */
  toggleOverlay: (overlay: Exclude<Overlay, null>) => void
  closeOverlay: () => void
  toggleTitling: () => Promise<void>
  subscribe: () => () => void
}

export type Overlay = 'key' | 'preferences' | null

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
  overlay: null,
  titling: true,
  boardLimits: DEFAULT_BOARD_LIMITS,
  scanId: 0,
  departures: [],

  init: async () => {
    try {
      const [theme, titling, board, boardLimits] = await Promise.all([
        window.controlTower.getTheme(),
        window.controlTower.getTitling(),
        window.controlTower.getBoard(),
        window.controlTower.getBoardLimits(),
      ])
      applyTheme(theme)
      set({ theme, titling, board, boardLimits })
      await Promise.all([get().refresh(false), get().loadDepartures()])
    } catch (cause) {
      set({ error: cause instanceof Error ? cause.message : String(cause), loading: false })
    }
  },

  /**
   * Set immediately, persist after. The board re-splits from the new value on the
   * next render, so a slow write must not make the control feel unresponsive.
   */
  setBoardLimit: async (board, limit) => {
    set({ boardLimits: { ...get().boardLimits, [board]: limit } })
    await window.controlTower.setBoardLimits({ [board]: limit })
  },

  setTheme: async (theme) => {
    applyTheme(theme)
    set({ theme })
    await window.controlTower.setTheme(theme)
  },

  // Written through rather than awaited: switching tabs must feel instant, and a
  // failed write costs nothing worse than opening on the previous board next time.
  setBoard: (board) => {
    set({ board })
    void window.controlTower.setBoard(board)
  },

  loadDepartures: async () => {
    set({ departures: await window.controlTower.listDepartures() })
  },

  /** False when the main process refused the row — an empty title. */
  addDeparture: async (title, notes, cwd) => {
    const created = await window.controlTower.addDeparture(title, notes, cwd)
    if (!created) return false
    await get().loadDepartures()
    return true
  },

  updateDeparture: async (id, fields) => {
    await window.controlTower.updateDeparture(id, fields)
    await get().loadDepartures()
  },

  removeDeparture: async (id) => {
    await window.controlTower.removeDeparture(id)
    await get().loadDepartures()
  },

  /**
   * Reorder, applying the move locally before the round trip.
   *
   * The one place in this store that patches its own state instead of reloading. A
   * drop that visibly springs back for a frame while SQLite answers reads as a failed
   * drag, and the main process computes the same order from the same list — so the
   * reload that follows confirms rather than corrects.
   */
  moveDeparture: async (id, index) => {
    const current = get().departures
    const from = current.findIndex((d) => d.id === id)
    if (from !== -1) {
      const next = [...current]
      const [moved] = next.splice(from, 1)
      if (moved) next.splice(index, 0, moved)
      set({ departures: next })
    }
    await window.controlTower.moveDeparture(id, index)
    await get().loadDepartures()
  },

  /**
   * Launch, returning a failure reason or null on success.
   *
   * Reloads the list either way: on success the row is gone from the main process's
   * store, and on failure it deliberately is not, so the caller does not have to know
   * which happened to render the right thing.
   */
  launchDeparture: async (id) => {
    const result = await window.controlTower.launchDeparture(id)
    await get().loadDepartures()
    if (result.ok) {
      // The new session lands on EN ROUTE, so follow it there rather than leaving the
      // user looking at the queue it just left.
      set({ board: 'en-route' })
      return null
    }
    return result.reason
  },

  /**
   * A sweep. `announce` is false for the one fired during startup — the app opening
   * is not a scan you asked for, and a wash of light over an empty board reads as a
   * glitch rather than as feedback.
   */
  refresh: async (announce = true) => {
    set((s) => ({ loading: true, scanId: announce ? s.scanId + 1 : s.scanId }))
    try {
      // `announce` doubles as "a person asked for this", which is also exactly when
      // PR status is worth re-fetching. The silent startup sweep skips it so the
      // first paint does not wait on the network.
      const snapshot = await window.controlTower.getSnapshot(announce)
      set({ snapshot, loading: false, error: null })
    } catch (cause) {
      set({ error: cause instanceof Error ? cause.message : String(cause), loading: false })
    }
  },

  /**
   * Park a session on HOLDING, or send it back.
   *
   * Applied locally before the round trip so the row leaves the board on click. The
   * sweep that follows confirms it; without this the row sits there until the next
   * push and the button reads as broken.
   */
  setHeld: async (sessionId, held) => {
    const snapshot = get().snapshot
    if (snapshot) {
      set({
        snapshot: {
          ...snapshot,
          sessions: snapshot.sessions.map((s) => (s.sessionId === sessionId ? { ...s, held } : s)),
        },
      })
    }
    await window.controlTower.setHeld(sessionId, held)
    await get().refresh(false)
  },

  /**
   * Dismiss a session's new activity without opening it.
   *
   * Tuning already marks read, but that is the wrong tool for a row you have decided
   * you do not need to look at — it would open a terminal to dismiss a dot. Applied
   * locally first so the dot changes on the click rather than on the next sweep.
   */
  markRead: async (sessionId, at) => {
    const snapshot = get().snapshot
    if (snapshot) {
      set({
        snapshot: {
          ...snapshot,
          sessions: snapshot.sessions.map((s) =>
            s.sessionId === sessionId ? { ...s, unread: false } : s,
          ),
        },
      })
    }
    await window.controlTower.markRead(sessionId, at)
  },

  /**
   * Hide a closed pull request everywhere.
   *
   * Removed locally first, because a chip that lingers until the next sweep reads as
   * a click that missed. The sweep that follows makes it permanent.
   */
  dismissPr: async (repository, number) => {
    const snapshot = get().snapshot
    if (snapshot) {
      set({
        snapshot: {
          ...snapshot,
          sessions: snapshot.sessions.map((s) => ({
            ...s,
            prs: s.prs.filter((p) => !(p.repository === repository && p.number === number)),
          })),
        },
      })
    }
    await window.controlTower.dismissPr(repository, number, true)
    await get().refresh(false)
  },

  bumpTick: () => set((s) => ({ tick: s.tick + 1 })),

  toggleOverlay: (overlay) => set((s) => ({ overlay: s.overlay === overlay ? null : overlay })),

  closeOverlay: () => set({ overlay: null }),

  toggleTitling: async () => {
    const next = !get().titling
    set({ titling: next })
    await window.controlTower.setTitling(next)
  },

  /**
   * Take pushed sweeps from the watcher. The initial paint still uses a pull so
   * the board is populated before the first file event, which on a quiet machine
   * could otherwise be minutes away.
   */
  subscribe: () =>
    window.controlTower.onSnapshot((snapshot) => set({ snapshot, loading: false, error: null })),
}))
