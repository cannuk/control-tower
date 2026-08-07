import { contextBridge, ipcRenderer } from 'electron'
import type { SessionSnapshot, ThemeName, TuneResult } from '../shared/types.js'

/**
 * The entire renderer→main surface. Deliberately a fixed, named list rather
 * than a generic `invoke(channel, ...args)` passthrough — a passthrough would
 * hand the renderer every IPC handler the app ever registers.
 */
const api = {
  getTheme: (): Promise<ThemeName> => ipcRenderer.invoke('prefs:getTheme'),
  setTheme: (theme: ThemeName): Promise<void> => ipcRenderer.invoke('prefs:setTheme', theme),
  getSnapshot: (): Promise<SessionSnapshot> => ipcRenderer.invoke('sessions:snapshot'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),
  tune: (sessionId: string): Promise<TuneResult> => ipcRenderer.invoke('session:tune', sessionId),
  closeWindow: (): Promise<void> => ipcRenderer.invoke('window:close'),
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
}

export type ControlTowerApi = typeof api

contextBridge.exposeInMainWorld('controlTower', api)
