import type { Departure } from '../../shared/types.js'
import { open } from './cache.js'

/**
 * The DEPARTURES store — filed flight plans.
 *
 * Shares the database file with the caches but is deliberately a separate module,
 * because it has the opposite lifecycle. Everything in `cache.ts` is derivable:
 * transcript offsets, PR status, generated summaries. When their shape changes the
 * honest move is to drop and rebuild, which `cache.ts` does on a schema bump.
 *
 * These rows are not derivable from anything. They exist because you typed them, and
 * nothing on disk could reconstruct them. So this table is created and only ever
 * migrated additively — never dropped, never versioned into a rebuild. Keeping it in
 * a file whose neighbours *are* disposable is exactly why that needs writing down.
 */

function ensure(): void {
  const db = open()
  db.exec(`
    CREATE TABLE IF NOT EXISTS departure (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL,
      notes       TEXT,
      cwd         TEXT,
      created_at  INTEGER NOT NULL
    );
  `)

  /**
   * Manual queue order, added after the table shipped.
   *
   * ALTER rather than a rebuild, because these rows are not reconstructible — see the
   * note at the top of this file. Backfilled from created_at so an existing queue
   * keeps the order it already had rather than scrambling on upgrade.
   *
   * A float, not an integer. Moving a row between two others then costs one UPDATE
   * on the row that moved, by taking the midpoint of its new neighbours; integer
   * positions would mean renumbering everything below the insertion point on every
   * drag. Doubles give ~50 consecutive midpoint splits before precision runs out,
   * and `normalise` below resets the spacing long before that.
   */
  const columns = (db.prepare('PRAGMA table_info(departure)').all() as { name: string }[]).map(
    (c) => c.name,
  )
  if (!columns.includes('position')) {
    db.exec('ALTER TABLE departure ADD COLUMN position REAL')
    db.exec('UPDATE departure SET position = created_at WHERE position IS NULL')
  }
}

/**
 * A `type`, not an `interface`, and that is not a style choice.
 *
 * `node:sqlite` types query results as `Record<string, SQLOutputValue>`. Asserting to
 * a named shape is only allowed if one side is assignable to the other, and an
 * interface gets no implicit index signature — so `Row as` fails where an inline
 * object type (or an alias of one, which does get the index signature) succeeds. Every
 * cast in cache.ts is inline for the same reason.
 */
type Row = {
  id: number
  title: string
  notes: string | null
  cwd: string | null
  created_at: number
  position: number | null
}

const toDeparture = (r: Row): Departure => ({
  id: r.id,
  title: r.title,
  notes: r.notes,
  cwd: r.cwd,
  createdAt: r.created_at,
  position: r.position,
})

/**
 * Queue order: manual position first, arrival time as the tiebreak.
 *
 * The opposite of every other board here, which are newest-first because recent
 * activity is the signal. A queue's signal is the order you put things in — the row
 * at the top is the thing you meant to do next, whether it got there by being filed
 * first or by being dragged there.
 */
export function list(): Departure[] {
  ensure()
  const rows = open()
    .prepare(
      `SELECT id, title, notes, cwd, created_at, position FROM departure
       ORDER BY COALESCE(position, created_at), id`,
    )
    .all() as Row[]
  return rows.map(toDeparture)
}

/**
 * Move a row so it sits at `index` in the current queue.
 *
 * Position is computed as the midpoint between the neighbours it lands between, so
 * exactly one row is written per move. The list is read fresh rather than trusting an
 * index from the renderer against a stale copy — the renderer's view can be one
 * launch behind, and reordering against the wrong neighbours would land the row in
 * the wrong place silently.
 */
export function move(id: number, index: number): void {
  ensure()
  const queue = list().filter((d) => d.id !== id)
  const target = Math.max(0, Math.min(index, queue.length))
  const positionOf = (d: Departure | undefined): number | null =>
    d ? (d.position ?? d.createdAt) : null

  const before = positionOf(queue[target - 1])
  const after = positionOf(queue[target])

  let next: number
  if (before === null && after === null) next = Date.now()
  else if (before === null) next = (after as number) - 1000
  else if (after === null) next = before + 1000
  else next = (before + after) / 2

  open().prepare('UPDATE departure SET position = ? WHERE id = ?').run(next, id)

  // Midpoints halve the gap each time; respace once they get too tight to split
  // again. Cheap, and it keeps the float from ever reaching its precision limit.
  if (before !== null && after !== null && Math.abs(after - before) < 1e-6) normalise()
}

/** Rewrite positions as evenly spaced integers, preserving current order. */
function normalise(): void {
  const db = open()
  const rows = list()
  const update = db.prepare('UPDATE departure SET position = ? WHERE id = ?')
  db.exec('BEGIN')
  try {
    rows.forEach((row, i) => update.run((i + 1) * 1000, row.id))
    db.exec('COMMIT')
  } catch (cause) {
    db.exec('ROLLBACK')
    throw cause
  }
}

export function add(title: string, notes: string | null, cwd: string | null): Departure {
  ensure()
  const now = Date.now()
  // New plans join the back of the queue, which is what `now` gives for free
  // whether or not anything above has been dragged.
  const result = open()
    .prepare(
      'INSERT INTO departure (title, notes, cwd, created_at, position) VALUES (?, ?, ?, ?, ?)',
    )
    .run(title, notes, cwd, now, now)
  return {
    id: Number(result.lastInsertRowid),
    title,
    notes,
    cwd,
    createdAt: now,
    position: now,
  }
}

/**
 * Update in place. Absent fields are left alone rather than nulled, so a caller that
 * only knows about the title cannot silently erase a cwd it never loaded.
 */
export function update(
  id: number,
  fields: { title?: string; notes?: string | null; cwd?: string | null },
): void {
  ensure()
  const sets: string[] = []
  const values: (string | null)[] = []
  if (fields.title !== undefined) {
    sets.push('title = ?')
    values.push(fields.title)
  }
  if (fields.notes !== undefined) {
    sets.push('notes = ?')
    values.push(fields.notes)
  }
  if (fields.cwd !== undefined) {
    sets.push('cwd = ?')
    values.push(fields.cwd)
  }
  if (sets.length === 0) return
  open()
    .prepare(`UPDATE departure SET ${sets.join(', ')} WHERE id = ?`)
    .run(...values, id)
}

export function remove(id: number): void {
  ensure()
  open().prepare('DELETE FROM departure WHERE id = ?').run(id)
}

export function get(id: number): Departure | null {
  ensure()
  const row = open()
    .prepare('SELECT id, title, notes, cwd, created_at, position FROM departure WHERE id = ?')
    .get(id) as Row | undefined
  return row ? toDeparture(row) : null
}
