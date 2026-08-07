import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * Local durable store (PLAN.md §4).
 *
 * Uses `node:sqlite`, which Electron 43 ships (Node 24.18) — so there is no
 * native module and no `electron-rebuild` step, which is what the plan had
 * budgeted for with better-sqlite3. It is still flagged experimental upstream, so
 * the surface used here is deliberately boring: tables, prepared statements, and
 * one transaction helper. Nothing that a minor API change could quietly break.
 *
 * What lives here is only the state that is *not* derivable from disk on demand:
 * the transcript scan positions and the PR links extracted from them. The live
 * session snapshot is rebuilt in memory on every sweep and never persisted —
 * caching it would just be a second source of truth to go stale.
 */

let db: DatabaseSync | null = null

export function open(): DatabaseSync {
  if (db) return db

  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  db = new DatabaseSync(join(dir, 'control-tower.db'))

  // WAL so a long scan cannot block a read, and NORMAL sync because losing the
  // last few writes on a hard crash costs one re-scan, not correctness.
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS transcript_scan (
      path      TEXT PRIMARY KEY,
      mtime_ms  INTEGER NOT NULL,
      size      INTEGER NOT NULL,
      -- Byte offset of the last COMPLETE line consumed. Never mid-line: a
      -- transcript is appended to while we read it, so the tail is routinely a
      -- partial JSON object. Resuming mid-line would corrupt every later parse.
      offset    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pr_link (
      session_id  TEXT NOT NULL,
      number      INTEGER NOT NULL,
      url         TEXT NOT NULL,
      repository  TEXT NOT NULL,
      first_seen  TEXT NOT NULL,
      PRIMARY KEY (session_id, number)
    );

    CREATE INDEX IF NOT EXISTS pr_link_session ON pr_link (session_id);
  `)

  return db
}

export interface ScanPosition {
  mtimeMs: number
  size: number
  offset: number
}

export function getScan(path: string): ScanPosition | null {
  const row = open()
    .prepare('SELECT mtime_ms, size, offset FROM transcript_scan WHERE path = ?')
    .get(path) as { mtime_ms: number; size: number; offset: number } | undefined
  if (!row) return null
  return { mtimeMs: row.mtime_ms, size: row.size, offset: row.offset }
}

export function setScan(path: string, position: ScanPosition): void {
  open()
    .prepare(
      `INSERT INTO transcript_scan (path, mtime_ms, size, offset) VALUES (?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms,
                                       size = excluded.size,
                                       offset = excluded.offset`,
    )
    .run(path, position.mtimeMs, position.size, position.offset)
}

export interface StoredPrLink {
  sessionId: string
  number: number
  url: string
  repository: string
  firstSeen: string
}

export function putPrLinks(links: StoredPrLink[]): void {
  if (links.length === 0) return
  const database = open()
  const insert = database.prepare(
    `INSERT INTO pr_link (session_id, number, url, repository, first_seen)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id, number) DO NOTHING`,
  )
  database.exec('BEGIN')
  try {
    for (const link of links) {
      insert.run(link.sessionId, link.number, link.url, link.repository, link.firstSeen)
    }
    database.exec('COMMIT')
  } catch (cause) {
    database.exec('ROLLBACK')
    throw cause
  }
}

/** Every PR link seen so far, grouped by session. */
export function prLinksBySession(): Map<string, StoredPrLink[]> {
  const rows = open()
    .prepare(
      `SELECT session_id, number, url, repository, first_seen
       FROM pr_link ORDER BY number DESC`,
    )
    .all() as {
    session_id: string
    number: number
    url: string
    repository: string
    first_seen: string
  }[]

  const bySession = new Map<string, StoredPrLink[]>()
  for (const row of rows) {
    const link: StoredPrLink = {
      sessionId: row.session_id,
      number: row.number,
      url: row.url,
      repository: row.repository,
      firstSeen: row.first_seen,
    }
    const existing = bySession.get(row.session_id)
    if (existing) existing.push(link)
    else bySession.set(row.session_id, [link])
  }
  return bySession
}

export function close(): void {
  db?.close()
  db = null
}
