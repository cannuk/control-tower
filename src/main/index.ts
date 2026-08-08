import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from 'electron'
import { join } from 'node:path'
import Store from 'electron-store'
import {
  BOARDS,
  THEMES,
  type Board,
  type Departure,
  type SessionSnapshot,
  type ThemeName,
  type TuneResult,
} from '../shared/types.js'
import * as cmux from './providers/cmux.js'
import { collect } from './collectors/snapshot.js'
import { readRegistry } from './collectors/registry.js'
import * as cacheStore from './store/cache.js'
import * as staging from './store/staging.js'
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
   * The tab you were last on.
   *
   * Persisted because the app is restarted often — during development constantly,
   * and by anyone who quits it at the end of a day — and coming back to a different
   * board than you left reads as the app having lost your place.
   */
  board: Board
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
    // APPROACH by default: on a first run the useful question is who is waiting on
    // you, not what you were doing.
    board: 'approach',
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
    // Deliberately not awaited: the handler must return its verdict synchronously.
    void shell.openExternal(url)
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

/** Empty and whitespace-only input mean "not set", not "set to a blank string". */
function blankToNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
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

/**
 * Validated on read, for the same reason as the display mode.
 *
 * A stored board name can outlive its board — `holding` became `departures` in this
 * app's own history, and a stale value would select a tab that renders nothing while
 * every tab looks unselected. Repair the file rather than carry the bad value.
 */
function readBoard(): Board {
  const stored = store.get('board') as unknown
  if (typeof stored === 'string' && (BOARDS as readonly string[]).includes(stored)) {
    return stored as Board
  }
  const fallback: Board = 'approach'
  store.set('board', fallback)
  return fallback
}

ipcMain.handle('prefs:getBoard', (): Board => readBoard())

ipcMain.handle('prefs:setBoard', (_e, board: Board) => {
  if (!(BOARDS as readonly string[]).includes(board)) return
  store.set('board', board)
})

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

  /**
   * Liveness decides this, not whether cmux still has a tab.
   *
   * The previous order tried `focus` first and only resumed when it failed — but a
   * cmux tab outlives the process inside it. Quit a session and its workspace is
   * still there, so focus succeeded and handed you a bare shell: the session was
   * never resumed, and the reported bug was exactly that ("it just opens terminal").
   *
   * The registry is re-read here rather than trusted from the renderer's snapshot,
   * which can be a sweep behind — long enough for a session to have exited between
   * the board you are looking at and the click.
   */
  const { entries } = await readRegistry()
  const entry = entries.find((e) => e.sessionId === sessionId)

  if (entry) {
    const focused = await cmux.focus(sessionId)
    if (focused.ok) return focused

    /**
     * Running, but cmux has no tab for it. Never resume — that would start a second
     * copy of a session that is already going.
     *
     * The common case is not a closed tab, it is a session that was never in cmux:
     * two of eighteen live sessions here run under the VS Code extension. Saying
     * "cmux has no tab, it may have been closed" would send you looking for
     * something that never existed, so the entrypoint is named instead. Only the
     * cmux adapter exists so far — PLAN.md §5 layers 2 and 3, tty derivation and a
     * configured command template, are what would make these focusable.
     */
    if (entry.entrypoint !== 'cli') {
      return {
        ok: false,
        reason: `this session is running under ${entry.entrypoint}, not in a terminal Control Tower can focus`,
      }
    }
    return focused
  }

  // Not running. Resume it, which is the whole point of clicking a row whose
  // process is gone — the ctrl+C-and-left-it-there case.
  if (typeof cwd === 'string' && cwd.length > 0) return cmux.resume(sessionId, cwd)
  return { ok: false, reason: 'no directory recorded for this session' }
})

ipcMain.handle('staging:list', (): Departure[] => staging.list())

ipcMain.handle(
  'staging:add',
  (_e, title: string, notes: string | null, cwd: string | null): Departure | null => {
    const clean = typeof title === 'string' ? title.trim() : ''
    // A blank flight plan is a row you cannot identify or act on, so it is refused
    // here rather than stored and rendered as an empty strip.
    if (clean.length === 0) return null
    return staging.add(clean, blankToNull(notes), blankToNull(cwd))
  },
)

ipcMain.handle(
  'staging:update',
  (_e, id: number, fields: { title?: string; notes?: string | null; cwd?: string | null }) => {
    const next: { title?: string; notes?: string | null; cwd?: string | null } = {}
    if (typeof fields?.title === 'string' && fields.title.trim().length > 0) {
      next.title = fields.title.trim()
    }
    if (fields?.notes !== undefined) next.notes = blankToNull(fields.notes)
    if (fields?.cwd !== undefined) next.cwd = blankToNull(fields.cwd)
    staging.update(id, next)
  },
)

ipcMain.handle('staging:remove', (_e, id: number) => staging.remove(id))

ipcMain.handle('staging:move', (_e, id: number, index: number) => {
  if (!Number.isInteger(index) || index < 0) return
  staging.move(id, index)
})

/**
 * Turn a filed departure into a live session.
 *
 * On success the row is deleted: it has taken off, and the session it became will
 * appear on EN ROUTE on the next sweep. Leaving it would show the same work twice on
 * two boards. There is a gap of a second or two where it is on neither — the session
 * has to write a transcript before the watcher can see it — which is the cost of not
 * keeping a second source of truth for "is this thing running yet".
 *
 * Deleted only when the workspace was actually created. A failed launch keeps the
 * plan, because losing what you typed because cmux was not running would be the
 * worst possible outcome here.
 */
ipcMain.handle('staging:launch', async (_e, id: number): Promise<TuneResult> => {
  const item = staging.get(id)
  if (!item) return { ok: false, reason: 'that flight plan no longer exists' }
  if (!item.cwd) {
    return { ok: false, reason: 'no directory set — edit the plan and choose where to run it' }
  }

  const prompt = item.notes ? `${item.title}\n\n${item.notes}` : item.title
  const result = await cmux.launch(item.cwd, prompt)
  if (result.ok) staging.remove(id)
  return result
})

/** Native directory picker, so a cwd never has to be typed from memory. */
ipcMain.handle('dialog:chooseDirectory', async (): Promise<string | null> => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    message: 'Where should this session run?',
  })
  return canceled ? null : (filePaths[0] ?? null)
})

/**
 * Mark a session seen up to a moment.
 *
 * The timestamp comes from the renderer's snapshot rather than `Date.now()`, so a
 * click marks read exactly what was on screen. Using the server clock would also
 * dismiss anything written between the sweep you were looking at and the click.
 */
ipcMain.handle('session:markRead', (_e, sessionId: string, at: number) => {
  if (typeof sessionId !== 'string' || !Number.isFinite(at)) return
  cacheStore.markRead(sessionId, at)
})

ipcMain.handle('pr:setDismissed', (_e, repository: string, number: number, dismissed: boolean) => {
  if (typeof repository !== 'string' || !Number.isInteger(number)) return
  cacheStore.setPrDismissed(repository, number, Boolean(dismissed))
})

ipcMain.handle('session:setHeld', (_e, sessionId: string, held: boolean) => {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return
  cacheStore.setHeld(sessionId, Boolean(held))
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
