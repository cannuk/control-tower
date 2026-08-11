import { useState } from 'react'
import { FolderOpen, GripVertical, PlaneTakeoff, Trash2, TriangleAlert } from 'lucide-react'
import type { Departure } from '../../../shared/types.js'
import { elapsed } from '../lib/time.js'
import { cn } from '../lib/utils.js'
import { useStore } from '../store.js'
import { StripAction } from './StripAction.js'

/**
 * DEPARTURES — filed flight plans, and the only board you author.
 *
 * Every other board observes something that already exists. This one is the queue of
 * work that does not exist yet, and launching a row is what turns it into a session:
 * a cmux workspace opened at the chosen directory, running `claude` with the plan as
 * its opening prompt.
 *
 * Drawn as strips like everything else, deliberately. A filed plan is a strip that
 * has not entered the rack yet, which is exactly what a flight progress strip is
 * before pushback — so the metaphor costs nothing and the board reads continuously
 * with its neighbours.
 */
export function Departures(): React.JSX.Element {
  const { departures, moveDeparture } = useStore()
  /** Index the dragged row would land at, for the insertion line. */
  const [over, setOver] = useState<number | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)

  function drop(index: number): void {
    const id = dragging
    setOver(null)
    setDragging(null)
    if (id !== null) void moveDeparture(id, index)
  }

  return (
    <div>
      <FilePlan />

      {departures.length === 0 ? (
        <div className="text-text-subtle flex flex-col items-center gap-2 px-6 py-14 text-center">
          <PlaneTakeoff size={20} aria-hidden />
          <p className="field text-text-muted text-ui font-semibold tracking-wider">
            NOTHING FILED
          </p>
          <p className="max-w-[24rem] text-ui">
            File the next thing you intend to pick up. Launching it opens a terminal in the
            directory you choose and starts a session with the plan as its prompt.
          </p>
        </div>
      ) : (
        departures.map((item, index) => (
          <div
            key={item.id}
            onDragOver={(e) => {
              // Required, or the browser refuses the drop entirely. The midpoint test
              // decides whether the row lands above or below the one under the cursor,
              // which is what makes a drag feel like it is inserting rather than
              // swapping.
              e.preventDefault()
              const box = e.currentTarget.getBoundingClientRect()
              setOver(e.clientY < box.top + box.height / 2 ? index : index + 1)
            }}
            onDrop={(e) => {
              e.preventDefault()
              drop(over ?? index)
            }}
          >
            {over === index && <InsertionLine />}
            <PlanStrip
              item={item}
              dragging={dragging === item.id}
              onDragStart={() => setDragging(item.id)}
              onDragEnd={() => {
                setDragging(null)
                setOver(null)
              }}
            />
            {over === index + 1 && index === departures.length - 1 && <InsertionLine />}
          </div>
        ))
      )}
    </div>
  )
}

/** Where the row will land. Drawn in the accent so it cannot be read as content. */
function InsertionLine(): React.JSX.Element {
  return <div className="bg-accent mx-4 h-0.5 rounded-full" />
}

/**
 * The filing form.
 *
 * Collapsed to a single field until it has focus. A staging area is only useful if
 * capturing a thought is faster than the thought — a three-field form permanently
 * open would make filing feel like paperwork, and the directory is the part you can
 * decide later.
 */
function FilePlan(): React.JSX.Element {
  const { addDeparture } = useStore()
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [cwd, setCwd] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  async function file(): Promise<void> {
    if (title.trim().length === 0) return
    const ok = await addDeparture(title, notes.length > 0 ? notes : null, cwd)
    if (!ok) return
    setTitle('')
    setNotes('')
    setCwd(null)
    setOpen(false)
  }

  return (
    <div className="border-scope-line border-b px-4 py-4">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onFocus={() => setOpen(true)}
        // Enter files it. The whole point is capture speed, and reaching for a button
        // to save one line is the friction that stops you bothering.
        onKeyDown={(e) => {
          if (e.key === 'Enter') void file()
          if (e.key === 'Escape') setOpen(false)
        }}
        placeholder="File a flight plan — what do you want to pick up next?"
        className="bg-surface border-border-base focus:border-accent w-full rounded border px-3 py-2.5 text-prose outline-none"
      />

      {open && (
        <div className="mt-2.5 flex flex-col gap-2.5">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Detail, links, constraints — sent to the session after the title (optional)"
            rows={3}
            className="bg-surface border-border-base focus:border-accent w-full resize-y rounded border px-3 py-2 text-prose leading-relaxed outline-none"
          />

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void window.controlTower.chooseDirectory().then((d) => d && setCwd(d))}
              title="Where the session should run"
              className="border-border-base hover:bg-surface-raised text-text-muted hover:text-text inline-flex items-center gap-1.5 rounded border px-2.5 py-1.5 text-ui"
            >
              <FolderOpen size={12} aria-hidden />
              {cwd ? 'Change directory' : 'Choose directory'}
            </button>

            {cwd && <span className="field text-text-subtle min-w-0 truncate text-ui">{cwd}</span>}

            <button
              type="button"
              onClick={() => void file()}
              disabled={title.trim().length === 0}
              className={cn(
                'field ml-auto rounded px-3 py-1.5 text-ui font-semibold tracking-wider',
                title.trim().length === 0
                  ? 'bg-dormant text-dormant-fg opacity-50'
                  : 'bg-accent text-accent-fg hover:opacity-85',
              )}
            >
              FILE
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function PlanStrip({
  item,
  dragging,
  onDragStart,
  onDragEnd,
}: {
  item: Departure
  dragging: boolean
  onDragStart: () => void
  onDragEnd: () => void
}): React.JSX.Element {
  const { launchDeparture, removeDeparture, updateDeparture } = useStore()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** Set while the handle is held, which is what arms `draggable`. */
  const [grabbed, setGrabbed] = useState(false)

  /**
   * Editing happens in place, one field at a time.
   *
   * No edit mode and no save button. A plan is two short strings you scribbled to
   * get them out of your head, and the same speed argument that collapsed the filing
   * form to a single input applies to changing one afterwards — a modal to fix a typo
   * is the reason nobody fixes the typo.
   */
  const [editing, setEditing] = useState<'title' | 'notes' | null>(null)
  const [draft, setDraft] = useState('')

  function open(field: 'title' | 'notes'): void {
    setDraft(field === 'title' ? item.title : (item.notes ?? ''))
    setEditing(field)
  }

  /**
   * Commit on blur as well as on the keyboard, because clicking away is what people
   * actually do. An empty title is refused rather than saved — the row would become
   * unidentifiable, and the main process rejects it anyway.
   */
  async function commit(): Promise<void> {
    const field = editing
    setEditing(null)
    if (!field) return
    const value = draft.trim()
    if (field === 'title') {
      if (value.length === 0 || value === item.title) return
      await updateDeparture(item.id, { title: value })
    } else {
      const next = value.length > 0 ? value : null
      if (next === (item.notes ?? null)) return
      await updateDeparture(item.id, { notes: next })
    }
  }

  async function launch(): Promise<void> {
    setError(null)
    setBusy(true)
    // The reason comes back rather than being thrown: a missing directory is an
    // ordinary state of a half-filed plan, not an exception.
    const reason = await launchDeparture(item.id)
    setBusy(false)
    if (reason) setError(reason)
  }

  async function chooseDirectory(): Promise<void> {
    const picked = await window.controlTower.chooseDirectory()
    if (picked) await updateDeparture(item.id, { cwd: picked })
  }

  return (
    <article
      // Draggable on the whole strip, but only from the handle: `draggable` on the
      // article would make selecting the notes text start a drag instead.
      draggable={grabbed}
      onDragStart={onDragStart}
      onDragEnd={() => {
        setGrabbed(false)
        onDragEnd()
      }}
      className={cn(
        'border-scope-line hover:bg-surface-raised flex gap-4 border-b px-4 py-5 transition-colors',
        dragging && 'opacity-40',
      )}
    >
      <div className="flex w-[4rem] shrink-0 items-center gap-1.5 pt-0.5">
        <span
          onMouseDown={() => setGrabbed(true)}
          onMouseUp={() => setGrabbed(false)}
          title="Drag to reorder the queue"
          className="text-text-subtle hover:text-text -ml-1 cursor-grab active:cursor-grabbing"
        >
          <GripVertical size={13} aria-hidden />
        </span>
        <span className="field text-text-subtle text-ui">PLAN</span>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-4">
          {editing === 'title' ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => void commit()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commit()
                if (e.key === 'Escape') setEditing(null)
              }}
              className="bg-surface border-accent min-w-0 flex-1 rounded border px-2 py-1 text-headline leading-6 font-medium outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={() => open('title')}
              title="Click to rename"
              className="hover:bg-surface min-w-0 flex-1 cursor-text rounded px-2 py-1 -mx-2 text-left text-headline leading-6 font-medium transition-colors"
            >
              {item.title}
            </button>
          )}
          <span className="field text-text-subtle shrink-0 text-ui">{elapsed(item.createdAt)}</span>
        </div>

        {editing === 'notes' ? (
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commit()}
            // Enter inserts a newline here — notes are prose, and the prompt this
            // becomes is multi-line. Escape abandons, blur commits.
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditing(null)
            }}
            rows={Math.min(8, Math.max(3, draft.split('\n').length + 1))}
            placeholder="Detail, links, constraints — sent to the session after the title"
            className="bg-surface border-accent mt-2.5 w-full resize-y rounded border px-2 py-1.5 text-prose leading-relaxed outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => open('notes')}
            title="Click to edit the detail"
            className={cn(
              'hover:bg-surface mt-2.5 block w-full cursor-text rounded px-2 py-1 -mx-2 text-left',
              'text-prose leading-relaxed whitespace-pre-wrap transition-colors',
              item.notes ? 'text-text-muted' : 'text-text-subtle italic',
            )}
          >
            {/* An empty plan still offers somewhere to put detail. Without this the
                only way to add notes to an existing plan was to delete and refile it. */}
            {item.notes ?? 'Add detail…'}
          </button>
        )}

        {/* The directory is shown as a control, not a field, because it is the one
            thing that must be set before this row can do anything. An unset cwd is
            offered as the fix rather than reported as a gap. */}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-prose">
          <button
            type="button"
            onClick={() => void chooseDirectory()}
            title={item.cwd ?? 'Choose where this session should run'}
            className={cn(
              'inline-flex min-w-0 items-center gap-1.5 rounded px-1.5 py-1 -mx-1.5 transition-colors',
              'hover:bg-surface',
              item.cwd ? 'text-text-subtle hover:text-text' : 'text-caution',
            )}
          >
            <FolderOpen size={12} aria-hidden />
            <span className="field max-w-[22rem] truncate">
              {item.cwd ?? 'no directory set — choose one'}
            </span>
          </button>
        </div>

        {error && (
          <p className="text-caution mt-2.5 flex items-start gap-1.5 text-prose leading-snug">
            <TriangleAlert size={12} className="mt-0.5 shrink-0" aria-hidden />
            {error}
          </p>
        )}

        <div className="mt-3 flex items-center gap-2">
          <StripAction
            icon={PlaneTakeoff}
            label={busy ? 'CLEARING' : 'LAUNCH'}
            title="Open a terminal here and start a session with this plan"
            onClick={() => void launch()}
            disabled={busy}
          />

          <button
            type="button"
            onClick={() => void removeDeparture(item.id)}
            title="Remove this flight plan"
            className="text-text-subtle hover:text-alert hover:bg-surface rounded p-1.5 transition-colors"
          >
            <Trash2 size={12} aria-hidden />
          </button>
        </div>
      </div>
    </article>
  )
}
