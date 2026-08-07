import { useState } from 'react'
import { GitBranch, MapPin, TriangleAlert } from 'lucide-react'
import { headlinePr, squawk, type Board, type PrRef, type Session } from '../../../shared/types.js'
import { TRANSPONDER } from '../lib/status.js'
import { absoluteTime, elapsed } from '../lib/time.js'
import { cn } from '../lib/utils.js'
import { AdvisoryChip, StatusChip } from './StatusChip.js'

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
  const transponder = TRANSPONDER[session.transponder]
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
    if (!result.ok) setTuneError(result.reason)
  }

  return (
    <article
      className={cn(
        'border-scope-line hover:bg-surface-raised flex gap-4 border-b px-4 py-5 transition-colors',
        session.unread && 'strip-cocked',
      )}
    >
      {/* Fixed gutter — the squawk is always four characters in a monospaced
          face, so this column is the same width on every strip. */}
      <div className="flex w-[4rem] shrink-0 items-center gap-2.5 pt-0.5">
        <span
          title={transponder.label}
          aria-label={transponder.label}
          className={cn(
            'size-2.5 shrink-0 rounded-full',
            transponder.dot,
            // Only an airborne flight pulses. An idle one drawing the eye is noise.
            session.transponder === 'airborne' && 'animate-sweep',
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
        {lead && <Subtitle label="SESSION" text={sessionName} />}
        {trailingPr && (
          <Subtitle
            label={`PR ${trailingPr.number}`}
            text={trailingPr.title ?? 'title not fetched yet'}
          />
        )}

        {/* Where the work actually stands, on the board where that is the
            question. Deliberately allowed to wrap onto two lines rather than
            truncate — a state summary cut off mid-clause tells you less than no
            state at all, and EN ROUTE is short enough to afford the height. */}
        {board === 'en-route' && session.sessionState && (
          <p className="text-text-muted mt-2.5 text-[12px] leading-relaxed">
            {session.sessionState}
          </p>
        )}

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
                <span key={prRef.number} className="inline-flex items-center gap-1.5">
                  <StatusChip prRef={prRef} />
                  <AdvisoryChip prRef={prRef} />
                </span>
              ))}
          </div>
        )}
      </div>
    </article>
  )
}

function Subtitle({ label, text }: { label: string; text: string }): React.JSX.Element {
  return (
    <p className="text-text-subtle mt-2 flex items-baseline gap-2 text-[12px]">
      <span className="field shrink-0 text-[10px] tracking-wider opacity-60">{label}</span>
      <span className="min-w-0 truncate">{text}</span>
    </p>
  )
}
