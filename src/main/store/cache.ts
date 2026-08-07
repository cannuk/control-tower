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

  // pr_status is a pure cache, so a shape change is rebuilt rather than migrated.
  // Anything expensive to recompute (scan offsets, PR links, generated titles)
  // is never dropped by this.
  db.exec('CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)')
  const PR_STATUS_SCHEMA = 3
  const current = (
    db.prepare("SELECT value FROM schema_meta WHERE key = 'pr_status'").get() as
      { value: number } | undefined
  )?.value
  if (current !== PR_STATUS_SCHEMA) {
    db.exec('DROP TABLE IF EXISTS pr_status')
    db.prepare(
      "INSERT INTO schema_meta (key, value) VALUES ('pr_status', ?) " +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(PR_STATUS_SCHEMA)
  }

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

    CREATE TABLE IF NOT EXISTS pr_status (
      repository  TEXT NOT NULL,
      number      INTEGER NOT NULL,
      status      TEXT NOT NULL,
      title       TEXT,
      advisories  INTEGER NOT NULL,
      outdated    INTEGER NOT NULL,
      -- Merged and closed are final. Persisting that lets later polls skip them
      -- entirely rather than re-asking GitHub about settled history.
      terminal    INTEGER NOT NULL,
      -- A non-Bot review or review thread exists. The board's core distinction.
      human_reviewed INTEGER NOT NULL DEFAULT 0,
      merged_at   TEXT,
      fetched_at  INTEGER NOT NULL,
      PRIMARY KEY (repository, number)
    );

    CREATE TABLE IF NOT EXISTS session_title (
      session_id     TEXT PRIMARY KEY,
      title          TEXT NOT NULL,
      -- Transcript size when the title was written. A title describes a moment;
      -- this is how we notice the session has moved on enough to need a new one.
      size_at_title  INTEGER NOT NULL,
      generated_at   INTEGER NOT NULL
    );

    /**
     * Summarising attempts that produced nothing usable.
     *
     * A rejected generation used to write no row at all, which made "never
     * summarised" and "summarised and refused" indistinguishable — so the same two
     * sessions were re-attempted on every single sweep, forever, each one a real
     * subprocess and a real call. Recording the attempt against the transcript size
     * makes the retry conditional on the session actually moving on.
     *
     * Kept separate from session_title rather than added as a column, because that
     * table feeds the display join and a failed attempt has no title to show.
     */
    CREATE TABLE IF NOT EXISTS title_attempt (
      session_id    TEXT PRIMARY KEY,
      size_at_try   INTEGER NOT NULL,
      attempted_at  INTEGER NOT NULL
    );
  `)

  // Added after session_title shipped. ALTER rather than a rebuild: regenerating
  // every title would re-spend usage for a column that is additive.
  const columns = (db.prepare('PRAGMA table_info(session_title)').all() as { name: string }[]).map(
    (c) => c.name,
  )
  if (!columns.includes('state')) {
    db.exec('ALTER TABLE session_title ADD COLUMN state TEXT')
  }

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

export interface StoredPrStatus {
  repository: string
  number: number
  title: string | null
  status: string
  advisories: number
  outdatedAdvisories: number
  terminal: boolean
  humanReviewed: boolean
  mergedAt: string | null
  fetchedAt: number
}

/** How long an open PR's status is served from cache before a refetch. */
const PR_STATUS_TTL_MS = 60_000

/**
 * PRs worth asking GitHub about: everything linked, minus settled ones, minus
 * those refreshed within the TTL. Grouped by repository so the caller can build
 * one aliased query.
 */
export function prsNeedingRefresh(now = Date.now()): Map<string, number[]> {
  const rows = open()
    .prepare(
      `SELECT DISTINCT l.repository AS repository, l.number AS number
       FROM pr_link l
       LEFT JOIN pr_status s ON s.repository = l.repository AND s.number = l.number
       WHERE s.number IS NULL
          OR (s.terminal = 0 AND s.fetched_at < ?)
       ORDER BY l.repository, l.number`,
    )
    .all(now - PR_STATUS_TTL_MS) as { repository: string; number: number }[]

  const byRepo = new Map<string, number[]>()
  for (const row of rows) {
    const existing = byRepo.get(row.repository)
    if (existing) existing.push(row.number)
    else byRepo.set(row.repository, [row.number])
  }
  return byRepo
}

export function putPrStatus(rows: StoredPrStatus[]): void {
  if (rows.length === 0) return
  const database = open()
  const upsert = database.prepare(
    `INSERT INTO pr_status (repository, number, title, status, advisories, outdated, terminal,
                            human_reviewed, merged_at, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repository, number) DO UPDATE SET title = excluded.title,
                                                  status = excluded.status,
                                                  advisories = excluded.advisories,
                                                  outdated = excluded.outdated,
                                                  terminal = excluded.terminal,
                                                  human_reviewed = excluded.human_reviewed,
                                                  merged_at = excluded.merged_at,
                                                  fetched_at = excluded.fetched_at`,
  )
  database.exec('BEGIN')
  try {
    for (const r of rows) {
      upsert.run(
        r.repository,
        r.number,
        r.title,
        r.status,
        r.advisories,
        r.outdatedAdvisories,
        r.terminal ? 1 : 0,
        r.humanReviewed ? 1 : 0,
        r.mergedAt,
        r.fetchedAt,
      )
    }
    database.exec('COMMIT')
  } catch (cause) {
    database.exec('ROLLBACK')
    throw cause
  }
}

/** Last-known status for every PR, keyed `repository#number`. */
export function prStatuses(): Map<string, StoredPrStatus> {
  const rows = open()
    .prepare(
      `SELECT repository, number, title, status, advisories, outdated, terminal,
                     human_reviewed, merged_at, fetched_at
              FROM pr_status`,
    )
    .all() as {
    repository: string
    number: number
    title: string | null
    status: string
    advisories: number
    outdated: number
    terminal: number
    human_reviewed: number
    merged_at: string | null
    fetched_at: number
  }[]
  return new Map(
    rows.map((r) => [
      `${r.repository}#${r.number}`,
      {
        repository: r.repository,
        number: r.number,
        title: r.title,
        status: r.status,
        advisories: r.advisories,
        outdatedAdvisories: r.outdated,
        terminal: r.terminal === 1,
        humanReviewed: r.human_reviewed === 1,
        mergedAt: r.merged_at,
        fetchedAt: r.fetched_at,
      },
    ]),
  )
}

export interface GeneratedTitle {
  sessionId: string
  title: string
  /** One or two sentences on where the session actually is. Null until generated. */
  state: string | null
  sizeAtTitle: number
  /** Epoch ms this summary was written. Orders the refresh rotation. */
  generatedAt?: number
}

export function getGeneratedTitle(sessionId: string): GeneratedTitle | null {
  const row = open()
    .prepare(
      `SELECT session_id, title, state, size_at_title, generated_at
       FROM session_title WHERE session_id = ?`,
    )
    .get(sessionId) as
    | {
        session_id: string
        title: string
        state: string | null
        size_at_title: number
        generated_at: number
      }
    | undefined
  if (!row) return null
  return {
    sessionId: row.session_id,
    title: row.title,
    state: row.state,
    sizeAtTitle: row.size_at_title,
    generatedAt: row.generated_at,
  }
}

/** Every generated title and state, for the snapshot join. */
export function generatedTitles(): Map<string, { title: string; state: string | null }> {
  const rows = open().prepare('SELECT session_id, title, state FROM session_title').all() as {
    session_id: string
    title: string
    state: string | null
  }[]
  return new Map(rows.map((r) => [r.session_id, { title: r.title, state: r.state }]))
}

/**
 * The transcript size at which summarising last failed for each session.
 *
 * Returned as a map so the titler can check every candidate in one read rather
 * than a query per session per sweep.
 */
export function failedTitleSizes(): Map<string, number> {
  const rows = open().prepare('SELECT session_id, size_at_try FROM title_attempt').all() as {
    session_id: string
    size_at_try: number
  }[]
  return new Map(rows.map((r) => [r.session_id, r.size_at_try]))
}

/** Record that summarising produced nothing usable at this transcript size. */
export function putFailedTitles(attempts: { sessionId: string; size: number }[]): void {
  if (attempts.length === 0) return
  const database = open()
  const upsert = database.prepare(
    `INSERT INTO title_attempt (session_id, size_at_try, attempted_at) VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET size_at_try = excluded.size_at_try,
                                          attempted_at = excluded.attempted_at`,
  )
  const now = Date.now()
  for (const a of attempts) upsert.run(a.sessionId, a.size, now)
}

export function putGeneratedTitles(titles: GeneratedTitle[]): void {
  if (titles.length === 0) return
  const database = open()
  const upsert = database.prepare(
    `INSERT INTO session_title (session_id, title, state, size_at_title, generated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET title = excluded.title,
                                          state = excluded.state,
                                          size_at_title = excluded.size_at_title,
                                          generated_at = excluded.generated_at`,
  )
  // A success supersedes any earlier failure, so the attempt record goes with it.
  const clearAttempt = database.prepare('DELETE FROM title_attempt WHERE session_id = ?')
  database.exec('BEGIN')
  try {
    const now = Date.now()
    for (const t of titles) {
      upsert.run(t.sessionId, t.title, t.state, t.sizeAtTitle, now)
      clearAttempt.run(t.sessionId)
    }
    database.exec('COMMIT')
  } catch (cause) {
    database.exec('ROLLBACK')
    throw cause
  }
}
