import { create } from 'zustand'
import type { SessionSnapshot, ThemeName } from '../../shared/types.js'

/** Pattern/Landed split threshold (PLAN.md §7). Configurable in M7. */
export const PATTERN_WINDOW_HOURS = 8

/** The three boards a controller works. */
export type Board = 'pattern' | 'landed' | 'holding-short'

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
  board: 'pattern',
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
}))

/**
 * The pattern is scoped by recency, not by transponder state (PLAN.md §7): with
 * 19 of 22 live sessions sitting idle for days, filtering on liveness would bury
 * the handful actually being worked. Landed is everything else, airborne or not.
 */
export function splitByBoard(snapshot: SessionSnapshot | null, now = Date.now()) {
  if (!snapshot) return { pattern: [], landed: [] }
  const cutoff = now - PATTERN_WINDOW_HOURS * 3600_000
  const byRecency = [...snapshot.sessions].sort((a, b) => b.lastContact - a.lastContact)
  return {
    pattern: byRecency.filter((s) => s.lastContact >= cutoff),
    landed: byRecency.filter((s) => s.lastContact < cutoff),
  }
}
