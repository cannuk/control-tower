import { useState } from 'react'
import { GitBranch, MapPin, PauseCircle, PlayCircle, TriangleAlert } from 'lucide-react'
import { describeApproach } from '../../../shared/describe.js'
import { headlinePr, squawk, type Board, type PrRef, type Session } from '../../../shared/types.js'
import { dotFor, sessionDim } from '../lib/status.js'
import { absoluteTime, elapsed } from '../lib/time.js'
import { cn } from '../lib/utils.js'
import { useStore } from '../store.js'
import { StatusChip } from './StatusChip.js'

/**
 * One row, drawn as a flight progress strip.
 *
 * A real strip is a horizontal band in a rack with the same field in the same
 * place on every strip, so a controller scans a column instead of reading rows.
 * Two things follow, and they pull against each other:
 *
 *   - Fields align. The transponder dot and squawk sit in a fixed-width gutter,
 *     so the headline and everything beneath it share one content column and the
 *     elapsed-time field lines up down the whole board.
 *   - Fields breathe. Real strips are about an inch tall with visibly separated
 *     boxes — they are scanned at a glance, not read. Density is not the goal;
 *     how fast one strip can be picked out of twenty is.
 *
 * Every strip carries both identities, session and PR — which one leads depends on
 * the board (see `headlinePr`). On APPROACH and LANDED the row exists because of a
 * pull request, so the PR titles it and the session becomes the subtitle. On EN
 * ROUTE that inverts: the work is in flight, often with no PR at all, so the
 * session leads and any PR it has appears beneath. Never only one of the two —
 * whichever is secondary is still the thing you need to recognise the row.
 */
export function FlightStrip({
  session,
  board,
}: {
  session: Session
  board: Board
}): React.JSX.Element {
  const dot = dotFor(session.transponder, session.unread)
  const { setHeld } = useStore()
  const [tuneError, setTuneError] = useState<string | null>(null)

  const lead = headlinePr(session, board)
  const sessionName = session.summary ?? session.fallbackName

  // Session-led boards still surface a PR when there is one. Newest wins, matching
  // `headlinePr` — PR numbers are monotonic, so the highest is the current work.
  const trailingPr: PrRef | null = lead
    ? null
    : ([...session.prs].sort((a, b) => b.number - a.number)[0] ?? null)

  // A PR with no fetched title yet still leads, falling back to its number —
  // deferring to the session name would make the row jump when the title lands.
  const headline = lead ? (lead.title ?? `#${lead.number}`) : sessionName

  /**
   * The state line, from whichever source the board has.
   *
   * APPROACH is composed from review data and EN ROUTE from a generated summary.
   * HOLDING shows the generated one too, frozen: the titler only summarises EN ROUTE,
   * so a parked session keeps whatever it last said. That is the right answer here —
   * coming back to a hold, the question is what this was doing when you parked it.
   * APPROACH takes the deterministic one even if a summary happens to exist: the
   * row is there because a PR needs attention, and exactly who is waiting on what
   * beats a paraphrase of the conversation that produced it.
   */
  const state =
    board === 'approach'
      ? describeApproach(session)
      : board === 'en-route' || board === 'holding'
        ? session.sessionState
        : null

  /**
   * Resolve the terminal at click time rather than trusting `session.location`.
   *
   * The snapshot's handle can be seconds stale — a tab closed since the last
   * sweep would either focus the wrong thing or fail confusingly. The provider
   * re-resolves by session id on every call, and falls back to resuming the
   * session when no tab is live at all.
   */
  async function tune(): Promise<void> {
    setTuneError(null)
    const result = await window.controlTower.tune(session.sessionId, session.cwd)
    if (!result.ok) {
      setTuneError(result.reason)
      return
    }
    // Opening the terminal is what "viewing" means here — there is no detail view to
    // read inside Control Tower. Only on success: a tune that failed showed you
    // nothing, so dismissing the activity would lose it.
    await window.controlTower.markRead(session.sessionId, session.lastContact)
  }

  return (
    <article className="border-scope-line hover:bg-surface-raised flex gap-4 border-b px-4 py-5 transition-colors">
      {/* Fixed gutter — the squawk is always four characters in a monospaced
          face, so this column is the same width on every strip. */}
      <div className="flex w-[4rem] shrink-0 items-center gap-2.5 pt-0.5">
        <span
          title={dot.label}
          aria-label={dot.label}
          className={cn(
            'size-2.5 shrink-0 rounded-full',
            dot.dot,
            // Only a generating session pulses. Anything else drawing the eye is noise.
            dot.pulse && 'animate-sweep',
          )}
        />
        <span
          title="Squawk — short handle for this session"
          className="field text-text-subtle text-[11px]"
        >
          {squawk(session.sessionId)}
        </span>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-4">
          <button
            type="button"
            onClick={() => void tune()}
            title="Tune to this flight — bring its terminal to the front, or resume it"
            className="no-drag hover:text-accent min-w-0 flex-1 cursor-pointer truncate text-left text-[14px] leading-6 font-medium"
          >
            {headline}
          </button>

          <span
            title={`Last contact ${absoluteTime(session.lastContact)}`}
            className="field text-text-subtle shrink-0 text-[11px]"
          >
            {elapsed(session.lastContact)}
          </span>
        </div>

        {/* The other identity. Labelled so it is never ambiguous which is which,
            and kept even when the two texts echo each other: the session name is
            the handle for the tune action, and the PR is what others see. */}
        {lead && (
          <Subtitle
            label="SESSION"
            text={sessionName}
            dim={sessionDim(session.transponder)}
            title={
              sessionDim(session.transponder)
                ? 'No terminal is running this session — opening it resumes from the transcript'
                : undefined
            }
          />
        )}
        {trailingPr && (
          <Subtitle
            label={`PR ${trailingPr.number}`}
            text={trailingPr.title ?? 'title not fetched yet'}
          />
        )}

        {/* Where the work actually stands. Both boards answer that question, but
            from different material: EN ROUTE from a summary of the transcript,
            APPROACH from the PR's own review data, composed rather than generated
            (see shared/describe.ts). Deliberately allowed to wrap onto two lines
            rather than truncate — cut off mid-clause tells you less than nothing. */}
        {state && <p className="text-text-muted mt-2.5 text-[12px] leading-relaxed">{state}</p>}

        <div className="text-text-subtle mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px]">
          <span className="inline-flex items-center gap-1.5" title="Origin">
            <MapPin size={12} aria-hidden />
            <span className="field">{session.project}</span>
          </span>

          {session.gitBranch && (
            <span className="inline-flex min-w-0 items-center gap-1.5" title="Branch">
              <GitBranch size={12} aria-hidden />
              <span className="field max-w-[18rem] truncate">{session.gitBranch}</span>
              {session.gitDirty && <span title="Uncommitted changes">*</span>}
            </span>
          )}

          {/*
            Only on the two boards a session can move between. APPROACH and LANDED are
            defined by PR state, so parking a row there would either do nothing visible
            or hide something somebody is waiting on — the control would be a lie
            either way.

            Right-aligned and quiet: it is an occasional action, not part of reading
            the row, and it should not compete with origin and branch for the eye.
          */}
          {(board === 'en-route' || board === 'holding') && (
            <button
              type="button"
              onClick={() => void setHeld(session.sessionId, board === 'en-route')}
              title={
                board === 'en-route'
                  ? 'Park this on HOLDING — out of EN ROUTE, kept indefinitely'
                  : 'Send this back to EN ROUTE'
              }
              className="no-drag hover:bg-surface hover:text-text ml-auto inline-flex items-center gap-1.5 rounded px-2 py-1 transition-colors"
            >
              {board === 'en-route' ? (
                <PauseCircle size={12} aria-hidden />
              ) : (
                <PlayCircle size={12} aria-hidden />
              )}
              <span className="field text-[10px] font-semibold tracking-wider">
                {board === 'en-route' ? 'HOLD' : 'RELEASE'}
              </span>
            </button>
          )}
        </div>

        {tuneError && (
          <p className="text-caution mt-2.5 flex items-start gap-1.5 text-[12px] leading-snug">
            <TriangleAlert size={12} className="mt-0.5 shrink-0" aria-hidden />
            {tuneError}
          </p>
        )}

        {session.prs.length > 0 && (
          // Flights get their own line. Mixed in with origin and branch they read
          // as more metadata; on their own they read as status. The headline PR
          // comes first so the chip order matches the row's title.
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            {[...session.prs]
              .sort((a, b) => (a.number === lead?.number ? -1 : b.number === lead?.number ? 1 : 0))
              .map((prRef) => (
                <StatusChip key={prRef.number} prRef={prRef} />
              ))}
          </div>
        )}
      </div>
    </article>
  )
}

function Subtitle({
  label,
  text,
  dim = false,
  title,
}: {
  label: string
  text: string
  /** The session this names has no running process. */
  dim?: boolean
  title?: string
}): React.JSX.Element {
  return (
    <p className="text-text-subtle mt-2 flex items-baseline gap-2 text-[12px]" title={title}>
      <span className="field shrink-0 text-[10px] tracking-wider opacity-60">{label}</span>
      <span className={cn('min-w-0 truncate', dim && 'opacity-45')}>{text}</span>
    </p>
  )
}
