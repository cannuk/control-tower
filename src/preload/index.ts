import { contextBridge, ipcRenderer } from 'electron'
import type { Board, Departure, SessionSnapshot, ThemeName, TuneResult } from '../shared/types.js'

/**
 * The entire renderer→main surface. Deliberately a fixed, named list rather
 * than a generic `invoke(channel, ...args)` passthrough — a passthrough would
 * hand the renderer every IPC handler the app ever registers.
 */
const api = {
  getTheme: (): Promise<ThemeName> => ipcRenderer.invoke('prefs:getTheme'),
  setTheme: (theme: ThemeName): Promise<void> => ipcRenderer.invoke('prefs:setTheme', theme),
  getBoard: (): Promise<Board> => ipcRenderer.invoke('prefs:getBoard'),
  setBoard: (board: Board): Promise<void> => ipcRenderer.invoke('prefs:setBoard', board),
  getSnapshot: (): Promise<SessionSnapshot> => ipcRenderer.invoke('sessions:snapshot'),
  getTitling: (): Promise<boolean> => ipcRenderer.invoke('prefs:getTitling'),
  setTitling: (on: boolean): Promise<void> => ipcRenderer.invoke('prefs:setTitling', on),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),
  tune: (sessionId: string, cwd: string): Promise<TuneResult> =>
    ipcRenderer.invoke('session:tune', sessionId, cwd),
  markRead: (sessionId: string, at: number): Promise<void> =>
    ipcRenderer.invoke('session:markRead', sessionId, at),

  /**
   * Subscribe to pushed sweeps. Returns an unsubscribe function — without one,
   * a re-mounting renderer stacks listeners on the same channel and every
   * snapshot gets handled N times.
   */
  onSnapshot: (handler: (snapshot: SessionSnapshot) => void): (() => void) => {
    const wrapped = (_e: unknown, snapshot: SessionSnapshot): void => handler(snapshot)
    ipcRenderer.on('sessions:pushed', wrapped)
    return () => ipcRenderer.off('sessions:pushed', wrapped)
  },
  closeWindow: (): Promise<void> => ipcRenderer.invoke('window:close'),
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke('window:minimize'),

  // DEPARTURES. `add` resolves null when the title was blank — the main process
  // refuses it rather than storing a row that cannot be identified.
  listDepartures: (): Promise<Departure[]> => ipcRenderer.invoke('staging:list'),
  addDeparture: (
    title: string,
    notes: string | null,
    cwd: string | null,
  ): Promise<Departure | null> => ipcRenderer.invoke('staging:add', title, notes, cwd),
  updateDeparture: (
    id: number,
    fields: { title?: string; notes?: string | null; cwd?: string | null },
  ): Promise<void> => ipcRenderer.invoke('staging:update', id, fields),
  removeDeparture: (id: number): Promise<void> => ipcRenderer.invoke('staging:remove', id),
  moveDeparture: (id: number, index: number): Promise<void> =>
    ipcRenderer.invoke('staging:move', id, index),
  launchDeparture: (id: number): Promise<TuneResult> => ipcRenderer.invoke('staging:launch', id),
  chooseDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:chooseDirectory'),
}

export type ControlTowerApi = typeof api

contextBridge.exposeInMainWorld('controlTower', api)
