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
  open().exec(`
    CREATE TABLE IF NOT EXISTS departure (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL,
      notes       TEXT,
      cwd         TEXT,
      created_at  INTEGER NOT NULL
    );
  `)
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
}

const toDeparture = (r: Row): Departure => ({
  id: r.id,
  title: r.title,
  notes: r.notes,
  cwd: r.cwd,
  createdAt: r.created_at,
})

/**
 * Oldest first, so the board reads as a queue.
 *
 * The opposite of every other board here, which are newest-first because recent
 * activity is the signal. A queue's signal is order of arrival: the thing at the top
 * is the thing you meant to do next.
 */
export function list(): Departure[] {
  ensure()
  const rows = open()
    .prepare('SELECT id, title, notes, cwd, created_at FROM departure ORDER BY created_at, id')
    .all() as Row[]
  return rows.map(toDeparture)
}

export function add(title: string, notes: string | null, cwd: string | null): Departure {
  ensure()
  const now = Date.now()
  const result = open()
    .prepare('INSERT INTO departure (title, notes, cwd, created_at) VALUES (?, ?, ?, ?)')
    .run(title, notes, cwd, now)
  return {
    id: Number(result.lastInsertRowid),
    title,
    notes,
    cwd,
    createdAt: now,
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
    .prepare('SELECT id, title, notes, cwd, created_at FROM departure WHERE id = ?')
    .get(id) as Row | undefined
  return row ? toDeparture(row) : null
}
