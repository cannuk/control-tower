import { useState } from 'react'
import { GitBranch, MapPin, PauseCircle, PlayCircle, TriangleAlert, X } from 'lucide-react'
import { describeApproach } from '../../../shared/describe.js'
import { headlinePr, squawk, type Board, type PrRef, type Session } from '../../../shared/types.js'
import { dotFor, sessionDim } from '../lib/status.js'
import { absoluteTime, elapsed } from '../lib/time.js'
import { cn } from '../lib/utils.js'
import { useStore } from '../store.js'
import { StatusChip } from './StatusChip.js'
import { StripAction } from './StripAction.js'

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
  const { setHeld, markRead, dismissPr } = useStore()
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
    board === 'approach' || (board === 'holding' && lead)
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
  /**
   * Mark this row seen. Any deliberate interaction counts.
   *
   * Opening the terminal, opening the PR on GitHub, or clicking the dot all mean the
   * same thing: you have dealt with this row. Tuning used to be the only one, and
   * only when it succeeded — so a session running under VS Code, which cannot be
   * focused, kept its dot lit no matter how many times you clicked it and read the
   * reason why.
   *
   * Synthetic pull-request rows are skipped: they have no transcript, so they can
   * never be unread, and a mark would only add a row keyed on an id no session owns.
   */
  async function seen(): Promise<void> {
    if (session.origin !== 'session') return
    await window.controlTower.markRead(session.sessionId, session.lastContact)
  }

  async function tune(): Promise<void> {
    setTuneError(null)
    // Before the attempt, not after it. Whether cmux can find a tab is unrelated to
    // whether you have looked at the row.
    await seen()
    const result = await window.controlTower.tune(session.sessionId, session.cwd)
    if (!result.ok) setTuneError(result.reason)
  }

  return (
    <article className="border-scope-line hover:bg-surface-raised flex gap-4 border-b px-4 py-5 transition-colors">
      {/* Fixed gutter — the squawk is always four characters in a monospaced
          face, so this column is the same width on every strip. */}
      <div className="flex w-[4rem] shrink-0 items-center gap-2.5 pt-0.5">
        {/*
          Interactive only while it is showing unread, which is the only state where
          clicking changes anything you can see. A generating session is unread too,
          but its dot stays green either way — a button that visibly does nothing
          reads as broken, so it is a plain mark until the session settles.

          The hit area is padded well beyond the 10px dot: a 10px target is a miss
          waiting to happen, and this one sits next to the tune action.
        */}
        {dot.kind === 'unread' ? (
          <button
            type="button"
            onClick={() => void markRead(session.sessionId, session.lastContact)}
            title={dot.label}
            aria-label="Clear new activity on this session"
            className="no-drag -m-1.5 shrink-0 cursor-pointer p-1.5"
          >
            <span className={cn('block size-2.5 rounded-full', dot.dot)} />
          </button>
        ) : (
          <span
            title={dot.label}
            aria-label={dot.label}
            className={cn(
              'size-2.5 shrink-0 rounded-full',
              dot.dot,
              // Only a generating session blips. Anything else drawing the eye is noise.
              dot.pulse && 'animate-blip',
            )}
          />
        )}
        <span
          title="Squawk — short handle for this session"
          className="field text-text-subtle text-ui"
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
            className="no-drag hover:text-accent min-w-0 flex-1 cursor-pointer truncate text-left text-headline leading-6 font-medium"
          >
            {headline}
          </button>

          <span
            title={`Last contact ${absoluteTime(session.lastContact)}`}
            className="field text-text-subtle shrink-0 text-ui"
          >
            {elapsed(session.lastContact)}
          </span>
        </div>

        {/* The other identity. Labelled so it is never ambiguous which is which,
            and kept even when the two texts echo each other: the session name is
            the handle for the tune action, and the PR is what others see. */}
        {lead &&
          (session.origin === 'pull-request' ? (
            /* No session ever existed for this one — GitHub told us about it, not a
               transcript. Says what clicking does, since "resume" would be a lie. */
            <Subtitle
              label="SESSION"
              text="none — click the title to start one"
              dim
              title={`No Claude session created this PR. Opening it starts one in ${session.cwd || 'a directory you choose'}.`}
            />
          ) : (
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
          ))}
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
        {state && <p className="text-text-muted mt-2.5 text-prose leading-relaxed">{state}</p>}

        <div className="text-text-subtle mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-prose">
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
        </div>

        {tuneError && (
          <p className="text-caution mt-2.5 flex items-start gap-1.5 text-prose leading-snug">
            <TriangleAlert size={12} className="mt-0.5 shrink-0" aria-hidden />
            {tuneError}
          </p>
        )}

        {/*
          Everywhere a session can actually be parked or released. APPROACH is
          included because "approved, but I am not merging this yet" is a real state
          with a real reason to wait — a release window, a dependency — and it was
          previously the one row on the board that could not be moved.

          LANDED is not: the work shipped, so there is nothing left to wait for and
          the control would do nothing visible.

          Last element of the strip, matching a filed plan's LAUNCH.
        */}
        {session.origin === 'session' &&
          (board === 'en-route' || board === 'holding' || board === 'approach') && (
            <div className="mt-3">
              <StripAction
                icon={board === 'holding' ? PlayCircle : PauseCircle}
                label={board === 'holding' ? 'RELEASE' : 'HOLD'}
                title={
                  board === 'holding'
                    ? 'Release this — it returns to whichever board it belongs on'
                    : 'Park this on HOLDING, out of the way and kept indefinitely'
                }
                onClick={() => void setHeld(session.sessionId, board !== 'holding')}
              />
            </div>
          )}

        {session.prs.length > 0 && (
          // Flights get their own line. Mixed in with origin and branch they read
          // as more metadata; on their own they read as status. The headline PR
          // comes first so the chip order matches the row's title.
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            {[...session.prs]
              .sort((a, b) => (a.number === lead?.number ? -1 : b.number === lead?.number ? 1 : 0))
              .map((prRef) => (
                <span key={prRef.number} className="inline-flex items-center gap-1.5">
                  <StatusChip prRef={prRef} onOpen={() => void seen()} />
                  {/*
                    Only on a closed PR that a bot closed — the ones you closed
                    yourself have already left the board. This is the override for
                    "the stale bot got this one and it is genuinely dead".

                    Uses the same control every other row action uses. It was a bare
                    11px × first, which read as decoration next to a chip rather than
                    as something to press.
                  */}
                  {prRef.status === 'diverted' && (
                    <StripAction
                      icon={X}
                      label="DISMISS"
                      title={`Hide #${prRef.number} from every board. Reopening it on GitHub brings it back.`}
                      onClick={() => void dismissPr(prRef.repository, prRef.number)}
                    />
                  )}
                </span>
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
    <p className="text-text-subtle mt-2 flex items-baseline gap-2 text-prose" title={title}>
      <span className="field shrink-0 text-footnote tracking-wider opacity-60">{label}</span>
      <span className={cn('min-w-0 truncate', dim && 'opacity-45')}>{text}</span>
    </p>
  )
}
