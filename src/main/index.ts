import { app, BrowserWindow, ipcMain, nativeImage, shell } from 'electron'
import { join } from 'node:path'
import Store from 'electron-store'
import { THEMES, type SessionSnapshot, type ThemeName, type TuneResult } from '../shared/types.js'
import * as cmux from './providers/cmux.js'
import { collect } from './collectors/snapshot.js'
import * as cacheStore from './store/cache.js'
import * as watcher from './watcher.js'

/**
 * The app is called Control Tower, not Electron.
 *
 * Two different things carry that name and only one is settable from here.
 * `productName` in package.json names the packaged bundle, and it is what fixes the
 * macOS menu bar — that string comes from the running bundle's Info.plist, so an
 * unpackaged `electron-vite preview` reports "Electron" no matter what this file
 * does. `app.setName` fixes everything the runtime owns: `app.getName()`, the
 * default application menu, notifications, crash reports.
 *
 * The order below is load-bearing. `userData` is derived from the app name, so
 * setting the name without pinning the path first would relocate the store from
 * `control-tower` to `Control Tower` and silently orphan the database — every
 * cached summary and PR status abandoned, the board rebuilding as though it were a
 * first run, with the old directory still sitting there. Pinned explicitly to the
 * existing path so the name can change without the data moving.
 *
 * Both calls must also precede the `new Store(...)` below, which resolves
 * `userData` when it is constructed rather than when it is read.
 */
app.setPath('userData', join(app.getPath('appData'), 'control-tower'))
app.setName('Control Tower')

/**
 * The Dock icon, for running unpackaged.
 *
 * Same situation as the name: a packaged build takes its icon from the bundle, which
 * is what `build.icon` in package.json points at, and nothing here is needed. But
 * `electron-vite preview` runs Electron's own bundle, so without this the Dock and
 * app switcher show the Electron logo. `app.dock` exists only on macOS.
 *
 * Resolved relative to the built main file rather than `process.cwd()`, which is
 * whatever directory the app happened to be launched from.
 */
function setDockIcon(): void {
  if (process.platform !== 'darwin' || !app.dock) return
  const icon = nativeImage.createFromPath(join(import.meta.dirname, '../../resources/icon.png'))
  // An empty image would blank the Dock icon rather than leave the default.
  if (!icon.isEmpty()) app.dock.setIcon(icon)
}

interface Bounds {
  x?: number
  y?: number
  width: number
  height: number
}

interface Prefs {
  bounds: Bounds
  theme: ThemeName
  /**
   * Whether to generate session titles.
   *
   * A switch rather than a constant because the CLI backend spends your Claude
   * subscription. Small, cached, and capped — but not free, so it has to be
   * refusable without editing code.
   */
  titling: boolean
}

const store = new Store<Prefs>({
  defaults: {
    bounds: { width: 460, height: 720 },
    theme: 'night-scope',
    titling: true,
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
    // Ignored on macOS (the bundle owns it); correct for Linux and Windows.
    icon: join(import.meta.dirname, '../../resources/icon.png'),
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

ipcMain.handle('prefs:getTitling', (): boolean => store.get('titling') !== false)

ipcMain.handle('prefs:setTitling', (_e, on: boolean) => {
  store.set('titling', Boolean(on))
})

ipcMain.handle('prefs:setTheme', (_e, theme: ThemeName) => {
  if (!(THEMES as readonly string[]).includes(theme)) {
    throw new Error(`unknown display mode: ${theme}`)
  }
  store.set('theme', theme)
  win?.setBackgroundColor(firstPaint(theme))
})

// Pull, for the initial paint and the manual sweep button. Live updates arrive
// by push from the watcher instead — see watcher.start below.
ipcMain.handle('sessions:snapshot', (): Promise<SessionSnapshot> => collect())

/**
 * Tune to a session — bring its terminal to the front.
 *
 * Only the cmux adapter exists so far; §5 layers 2 and 3 (tty derivation and a
 * configured command template) land in M5. Until then a session cmux does not
 * know about reports why rather than failing silently.
 */
ipcMain.handle('session:tune', async (_e, sessionId: string, cwd: string): Promise<TuneResult> => {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { ok: false, reason: 'no session id' }
  }

  const focused = await cmux.focus(sessionId)
  if (focused.ok) return focused

  // No live tab, but the session is still resumable — so resume it rather than
  // reporting a dead end. This is the ctrl+C-and-left-it-there case, which is
  // exactly when you most want to get back in.
  if (typeof cwd === 'string' && cwd.length > 0) return cmux.resume(sessionId, cwd)
  return focused
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
  setDockIcon()
  createWindow()
  watcher.start((snapshot) => watcher.pushTo(win, snapshot))
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Release the file watcher and the sqlite handle rather than relying on process
// teardown — a WAL left open can leave -wal/-shm files behind.
app.on('before-quit', () => {
  watcher.stop()
  cacheStore.close()
})
