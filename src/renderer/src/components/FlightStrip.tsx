import { useState } from 'react'
import { GitBranch, MapPin, TriangleAlert } from 'lucide-react'
import { squawk, type Session } from '../../../shared/types.js'
import { TRANSPONDER } from '../lib/status.js'
import { absoluteTime, elapsed } from '../lib/time.js'
import { cn } from '../lib/utils.js'
import { AdvisoryChip, StatusChip } from './StatusChip.js'

/**
 * One session, drawn as a flight progress strip.
 *
 * A real strip is a horizontal band in a rack with the same field in the same
 * place on every strip, so a controller scans a column instead of reading rows.
 * Two things follow from that, and they pull in opposite directions:
 *
 *   - Fields align. The transponder dot and squawk live in a fixed-width gutter,
 *     so the description and the metadata beneath it share one content column
 *     and the elapsed-time field lines up down the whole list.
 *   - Fields breathe. Real strips are about an inch tall with visibly separated
 *     field boxes — they are scanned at a glance, not read. Packing rows tighter
 *     raises information density and lowers the thing that actually matters,
 *     which is how fast one strip can be picked out of twenty.
 */
export function FlightStrip({ session }: { session: Session }): React.JSX.Element {
  const transponder = TRANSPONDER[session.transponder]
  const description = session.summary ?? session.fallbackName
  const [tuneError, setTuneError] = useState<string | null>(null)

  /**
   * Resolve the terminal at click time rather than trusting `session.location`.
   *
   * The snapshot's handle can be seconds stale — a tab closed since the last
   * sweep would either focus the wrong thing or fail confusingly. The provider
   * re-resolves by session id on every call, so the click is always acting on
   * what is true now. It also means this works before the collectors exist,
   * which is why the button is live in M1 instead of waiting for M5.
   */
  async function tune(): Promise<void> {
    setTuneError(null)
    const result = await window.controlTower.tune(session.sessionId)
    if (!result.ok) setTuneError(result.reason)
  }

  return (
    <article
      className={cn(
        'border-scope-line hover:bg-surface-raised flex gap-3 border-b px-3 py-3.5 transition-colors',
        session.unread && 'strip-cocked',
      )}
    >
      {/* Fixed gutter — the squawk is always four characters in a monospaced
          face, so this column is the same width on every strip. */}
      <div className="flex w-[3.5rem] shrink-0 items-center gap-2 pt-px">
        <span
          title={transponder.label}
          aria-label={transponder.label}
          className={cn(
            'size-2 shrink-0 rounded-full',
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
        <div className="flex items-baseline gap-3">
          <button
            type="button"
            onClick={() => void tune()}
            title="Tune to this flight — bring its terminal to the front"
            className="no-drag hover:text-accent min-w-0 flex-1 cursor-pointer truncate text-left text-[13px] leading-5 font-medium"
          >
            {description}
            {session.summary === null && (
              <span className="text-text-subtle field ml-2 text-[10px] font-normal">
                NO SUMMARY
              </span>
            )}
          </button>

          <span
            title={`Last contact ${absoluteTime(session.lastContact)}`}
            className="field text-text-subtle shrink-0 text-[11px]"
          >
            {elapsed(session.lastContact)}
          </span>
        </div>

        <div className="text-text-subtle mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px]">
          <span className="inline-flex items-center gap-1.5" title="Origin">
            <MapPin size={11} aria-hidden />
            <span className="field">{session.project}</span>
          </span>

          {session.gitBranch && (
            <span className="inline-flex min-w-0 items-center gap-1.5" title="Branch">
              <GitBranch size={11} aria-hidden />
              <span className="field max-w-[15rem] truncate">{session.gitBranch}</span>
              {session.gitDirty && <span title="Uncommitted changes">*</span>}
            </span>
          )}
        </div>

        {tuneError && (
          <p className="text-caution mt-2 flex items-start gap-1.5 text-[11px] leading-snug">
            <TriangleAlert size={11} className="mt-0.5 shrink-0" aria-hidden />
            {tuneError}
          </p>
        )}

        {session.prs.length > 0 && (
          // Flights get their own line. Mixed in with origin and branch they
          // read as more metadata; on their own they read as status.
          <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
            {session.prs.map((prRef) => (
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
