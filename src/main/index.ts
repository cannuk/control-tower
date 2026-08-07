import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import Store from 'electron-store'
import { THEMES, type SessionSnapshot, type ThemeName, type TuneResult } from '../shared/types.js'
import { PLACEHOLDER_SNAPSHOT } from './placeholder.js'
import * as cmux from './providers/cmux.js'

interface Bounds {
  x?: number
  y?: number
  width: number
  height: number
}

interface Prefs {
  bounds: Bounds
  theme: ThemeName
}

const store = new Store<Prefs>({
  defaults: {
    bounds: { width: 460, height: 720 },
    theme: 'night-scope',
  },
})

let win: BrowserWindow | null = null

/**
 * The native window paints before the renderer stylesheet loads, so this has to
 * approximate each palette's --ct-bg. A mismatch shows as a flash on launch and
 * again on every display-mode change. Keep in sync with tokens.css by eye —
 * there is no way to read a CSS custom property from the main process.
 */
function firstPaint(theme: ThemeName): string {
  switch (theme) {
    case 'day-cab':
      return '#f5f7f8'
    case 'amber-sector':
      return '#191410'
    default:
      return '#111619'
  }
}

function createWindow(): void {
  const bounds = store.get('bounds')

  win = new BrowserWindow({
    ...bounds,
    minWidth: 380,
    minHeight: 320,
    show: false,
    frame: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: firstPaint(readTheme()),
    webPreferences: {
      // .mjs, not .js — electron-vite emits the preload as ESM because the
      // package is `"type": "module"`. Pointing at .js silently yields a window
      // with no `controlTower` bridge and no error in the main process.
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  win.once('ready-to-show', () => win?.show())

  // Anything not our own URL opens in the user's browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const persist = debounce(() => {
    if (!win || win.isDestroyed() || win.isMinimized()) return
    store.set('bounds', win.getBounds())
  }, 400)
  win.on('resize', persist)
  win.on('move', persist)

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

function debounce(fn: () => void, ms: number): () => void {
  let t: NodeJS.Timeout | undefined
  return () => {
    if (t) clearTimeout(t)
    t = setTimeout(fn, ms)
  }
}

/**
 * Never trust the stored display mode.
 *
 * `electron-store` happily returns whatever was on disk, including a palette
 * name from an older build. A stale value doesn't crash — `[data-theme="runway"]`
 * simply matches no rule, so tokens fall through to `:root` and the app *looks*
 * fine while the mode picker shows nothing selected and the label lookup is
 * undefined. That silent half-broken state is worse than an error, so validate
 * on read and repair the file.
 */
function readTheme(): ThemeName {
  const stored = store.get('theme') as unknown
  if (typeof stored === 'string' && (THEMES as readonly string[]).includes(stored)) {
    return stored as ThemeName
  }
  const fallback: ThemeName = 'night-scope'
  store.set('theme', fallback)
  return fallback
}

ipcMain.handle('prefs:getTheme', (): ThemeName => readTheme())

ipcMain.handle('prefs:setTheme', (_e, theme: ThemeName) => {
  if (!(THEMES as readonly string[]).includes(theme)) {
    throw new Error(`unknown display mode: ${theme}`)
  }
  store.set('theme', theme)
  win?.setBackgroundColor(firstPaint(theme))
})

/**
 * M1 serves a fixed snapshot so the UI can be built and judged at real density
 * before the collectors exist. M2 replaces this with the live registry +
 * transcript readers and pushes on a watcher tick instead of on request.
 */
ipcMain.handle('sessions:snapshot', (): SessionSnapshot => ({
  ...PLACEHOLDER_SNAPSHOT,
  sweptAt: Date.now(),
}))

/**
 * Tune to a session — bring its terminal to the front.
 *
 * Only the cmux adapter exists so far; §5 layers 2 and 3 (tty derivation and a
 * configured command template) land in M5. Until then a session cmux does not
 * know about reports why rather than failing silently.
 */
ipcMain.handle('session:tune', async (_e, sessionId: string): Promise<TuneResult> => {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { ok: false, reason: 'no session id' }
  }
  return cmux.focus(sessionId)
})

ipcMain.handle('shell:openExternal', (_e, url: string) => {
  // Only ever hand http(s) to the OS — a file:// or custom scheme from the
  // renderer would be a way to launch arbitrary local handlers.
  const parsed = URL.parse(url)
  if (parsed?.protocol === 'https:' || parsed?.protocol === 'http:') {
    return shell.openExternal(url)
  }
  return Promise.reject(new Error(`refusing to open non-http url: ${url}`))
})

ipcMain.handle('window:close', () => win?.close())
ipcMain.handle('window:minimize', () => win?.minimize())

void app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
