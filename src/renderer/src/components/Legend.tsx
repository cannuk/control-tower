import { X } from 'lucide-react'
import { PR_STATUS, TRANSPONDER } from '../lib/status.js'
import type { PrStatus } from '../../../shared/types.js'
import { cn } from '../lib/utils.js'

/**
 * The strip-marking key.
 *
 * Real facilities post one: a printed card mapping every mark and abbreviation to
 * its meaning, so nobody has to hold the whole vocabulary in their head. Ours
 * does the same job and resolves the tension in this app's design — the aviation
 * framing can stay committed and consistent precisely *because* there is one
 * place that decodes all of it. Without a key, every flourish is a private joke
 * that costs the reader something.
 *
 * It also keeps itself honest: the status rows are generated from PR_STATUS and
 * TRANSPONDER rather than retyped, so a label that changes in the app cannot go
 * stale here.
 */

const STATUS_ORDER: PrStatus[] = [
  'inbound',
  'on-final',
  'go-around',
  'hold-short',
  'cleared',
  'landed',
  'diverted',
  'at-gate',
  'no-contact',
]

/**
 * Boards in pipeline order, with the rule that puts a session on each. Written
 * out because the rules are the product: "why is this here" should be answerable
 * without reading the source.
 */
const BOARDS: [string, string][] = [
  ['HOLDING', 'Staged work you intend to start — not a session yet'],
  [
    'EN ROUTE',
    'Touched in the last 8 hours, with no PR yet or no human review yet. CodeRabbit does not count as a reviewer',
  ],
  [
    'APPROACH',
    'An unmerged PR a human has reviewed or commented on — feedback to address, or an approval with comments worth reading first',
  ],
  [
    'LANDED',
    'Recently merged, newest first. A session with any still-open PR never appears here, even if a sibling PR merged',
  ],
]

const MARKINGS: [string, string][] = [
  ['Squawk', 'Short handle for a session, e.g. 16DF — first four characters of its id'],
  ['Sweep', 'A refresh. SWEEP 12S means the data is 12 seconds old'],
  ['Tune', 'Click a description to bring that session’s terminal to the front'],
  ['Cocked strip', 'Nudged right with a marked edge — the session has output you have not seen'],
  ['Offset dot', 'Filled and pulsing = working now. Hollow = idle. Dim = no heartbeat'],
]

export function Legend({ onClose }: { onClose: () => void }): React.JSX.Element {
  return (
    <div
      className="bg-bg/80 absolute inset-0 z-20 overflow-y-auto backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-surface border-border-strong m-3 rounded-lg border p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="field text-[11px] font-semibold tracking-widest">
              STRIP MARKING KEY
            </h2>
            <p className="text-text-subtle mt-1 text-[11px]">
              The tower vocabulary, and what each piece of it actually means.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Close"
            className="hover:bg-surface-raised text-text-muted hover:text-text -mt-1 rounded p-1.5"
          >
            <X size={14} aria-hidden />
          </button>
        </div>

        <Section title="PULL REQUEST STATUS">
          {STATUS_ORDER.map((status) => {
            const { label, atc, chip, Icon } = PR_STATUS[status]
            return (
              <Row
                key={status}
                left={
                  <span
                    className={cn(
                      'field inline-flex items-center gap-1.5 rounded px-2 py-1',
                      'text-[11px] leading-none font-semibold',
                      chip,
                    )}
                  >
                    <Icon size={11} strokeWidth={2.5} aria-hidden />
                    {label}
                  </span>
                }
                right={atc}
              />
            )
          })}
          <Row
            left={
              <span className="field bg-advisory text-advisory-text rounded px-2 py-1 text-[11px] leading-none font-semibold">
                N UNRESOLVED
              </span>
            }
            right="advisories — review threads still open, shown even when approved"
          />
        </Section>

        <Section title="BOARDS">
          {BOARDS.map(([name, meaning]) => (
            <Row
              key={name}
              left={<span className="field text-[11px] font-semibold">{name}</span>}
              right={meaning}
            />
          ))}
        </Section>

        <Section title="STRIP MARKINGS">
          {MARKINGS.map(([name, meaning]) => (
            <Row
              key={name}
              left={<span className="text-[11px] font-medium">{name}</span>}
              right={meaning}
            />
          ))}
        </Section>

        <Section title="TRANSPONDER">
          {(Object.keys(TRANSPONDER) as (keyof typeof TRANSPONDER)[]).map((key) => (
            <Row
              key={key}
              left={
                <span className="inline-flex items-center gap-2">
                  <span className={cn('size-2 rounded-full', TRANSPONDER[key].dot)} />
                  <span className="field text-[11px]">{key}</span>
                </span>
              }
              right={TRANSPONDER[key].label}
            />
          ))}
        </Section>
      </div>
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="mb-4 last:mb-0">
      <h3 className="field text-text-subtle mb-2 text-[10px] font-semibold tracking-widest">
        {title}
      </h3>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  )
}

function Row({
  left,
  right,
}: {
  left: React.ReactNode
  right: string
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <span className="flex w-[7.5rem] shrink-0 justify-start">{left}</span>
      <span className="text-text-muted min-w-0 flex-1 text-[11px] leading-snug">{right}</span>
    </div>
  )
}
