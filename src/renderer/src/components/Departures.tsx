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
          <p className="field text-text-muted text-[11px] font-semibold tracking-wider">
            NOTHING FILED
          </p>
          <p className="max-w-[24rem] text-[11px]">
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
        className="bg-surface border-border-base focus:border-accent w-full rounded border px-3 py-2.5 text-[12px] outline-none"
      />

      {open && (
        <div className="mt-2.5 flex flex-col gap-2.5">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Detail, links, constraints — sent to the session after the title (optional)"
            rows={3}
            className="bg-surface border-border-base focus:border-accent w-full resize-y rounded border px-3 py-2 text-[12px] leading-relaxed outline-none"
          />

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void window.controlTower.chooseDirectory().then((d) => d && setCwd(d))}
              title="Where the session should run"
              className="border-border-base hover:bg-surface-raised text-text-muted hover:text-text inline-flex items-center gap-1.5 rounded border px-2.5 py-1.5 text-[11px]"
            >
              <FolderOpen size={12} aria-hidden />
              {cwd ? 'Change directory' : 'Choose directory'}
            </button>

            {cwd && (
              <span className="field text-text-subtle min-w-0 truncate text-[11px]">{cwd}</span>
            )}

            <button
              type="button"
              onClick={() => void file()}
              disabled={title.trim().length === 0}
              className={cn(
                'field ml-auto rounded px-3 py-1.5 text-[11px] font-semibold tracking-wider',
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
        <span className="field text-text-subtle text-[11px]">PLAN</span>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-4">
          <p className="min-w-0 flex-1 text-[14px] leading-6 font-medium">{item.title}</p>
          <span className="field text-text-subtle shrink-0 text-[11px]">
            {elapsed(item.createdAt)}
          </span>
        </div>

        {item.notes && (
          <p className="text-text-muted mt-2.5 text-[12px] leading-relaxed whitespace-pre-wrap">
            {item.notes}
          </p>
        )}

        {/* The directory is shown as a control, not a field, because it is the one
            thing that must be set before this row can do anything. An unset cwd is
            offered as the fix rather than reported as a gap. */}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px]">
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
          <p className="text-caution mt-2.5 flex items-start gap-1.5 text-[12px] leading-snug">
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
