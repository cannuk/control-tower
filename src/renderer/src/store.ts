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
  legendOpen: boolean
  titling: boolean

  init: () => Promise<void>
  setTheme: (theme: ThemeName) => Promise<void>
  setBoard: (board: Board) => void
  refresh: () => Promise<void>
  bumpTick: () => void
  toggleLegend: () => void
  toggleTitling: () => Promise<void>
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
  titling: true,

  init: async () => {
    try {
      const [theme, titling] = await Promise.all([
        window.controlTower.getTheme(),
        window.controlTower.getTitling(),
      ])
      applyTheme(theme)
      set({ theme, titling })
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
