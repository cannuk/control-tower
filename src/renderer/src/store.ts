import { create } from 'zustand'
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
  scanId: 0,
  departures: [],

  init: async () => {
    try {
      const [theme, titling] = await Promise.all([
        window.controlTower.getTheme(),
        window.controlTower.getTitling(),
      ])
      applyTheme(theme)
      set({ theme, titling })
      await Promise.all([get().refresh(false), get().loadDepartures()])
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
      const snapshot = await window.controlTower.getSnapshot()
      set({ snapshot, loading: false, error: null })
    } catch (cause) {
      set({ error: cause instanceof Error ? cause.message : String(cause), loading: false })
    }
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
