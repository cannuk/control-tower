import { create } from 'zustand'
import type { Board, SessionSnapshot, ThemeName } from '../../shared/types.js'

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

  init: () => Promise<void>
  setTheme: (theme: ThemeName) => Promise<void>
  setBoard: (board: Board) => void
  refresh: (announce?: boolean) => Promise<void>
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

  init: async () => {
    try {
      const [theme, titling] = await Promise.all([
        window.controlTower.getTheme(),
        window.controlTower.getTitling(),
      ])
      applyTheme(theme)
      set({ theme, titling })
      await get().refresh(false)
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
