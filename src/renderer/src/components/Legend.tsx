import { ADVISORY_ICON, DOT_KEY, PR_STATUS } from '../lib/status.js'
import { Overlay, Row, Section } from './Overlay.js'
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
 * It also keeps itself honest: the status and dot rows are generated from PR_STATUS
 * and DOT_KEY rather than retyped, so a label that changes in the app cannot go
 * stale here.
 */

/**
 * Roughly the order a PR moves through, so the key reads as a progression rather
 * than an alphabet. `cleared-advisory` sits immediately before `cleared` because
 * that is the step it usually is: approved, threads to clear, then mergeable.
 */
const STATUS_ORDER: PrStatus[] = [
  'inbound',
  'on-final',
  'go-around',
  'hold-short',
  'cleared-advisory',
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
  [
    'DEPARTURES',
    'Flight plans you filed — work you intend to start, with no session yet. Launching one opens a terminal in the directory you chose and starts a session with the plan as its prompt',
  ],
  [
    'EN ROUTE',
    'A running session touched in the last 8 hours, with no PR yet or no human review yet. An exited session is not in flight, however recently you left it. CodeRabbit does not count as a reviewer',
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
  [
    'Sweep',
    'A refresh — every session re-read, PR status refetched. The radar button sweeps on demand; hover it to see how stale the board is',
  ],
  ['Tune', 'Click a description to bring that session’s terminal to the front'],
  ['Offset dot', 'New activity only — see THE DOT below'],
  [
    'Dimmed session',
    'The session name faded on APPROACH or LANDED means no terminal is running it; opening resumes from the transcript',
  ],
]

export function Legend({ onClose }: { onClose: () => void }): React.JSX.Element {
  return (
    <Overlay
      title="STRIP MARKING KEY"
      subtitle="The tower vocabulary, and what each piece of it actually means."
      onClose={onClose}
    >
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
            <span className="field bg-cleared-advisory text-cleared-advisory-fg inline-flex items-center gap-1.5 rounded px-2 py-1 text-[11px] leading-none font-semibold">
              <span className="opacity-75">APPROVED</span>
              <span className="inline-flex items-center gap-1 border-l border-current/30 pl-2">
                <ADVISORY_ICON size={10} strokeWidth={2.5} aria-hidden />
                17
              </span>
            </span>
          }
          right="The count after any status is unresolved review threads — other people’s, never yours or a bot’s. It disappears once the PR is merged or closed"
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

      <Section title="THE DOT">
        {DOT_KEY.map((entry) => (
          <Row
            key={entry.label}
            left={
              <span className="flex w-full justify-center">
                <span
                  className={cn('size-2.5 rounded-full', entry.dot, entry.pulse && 'animate-sweep')}
                />
              </span>
            }
            right={entry.label}
          />
        ))}
      </Section>
    </Overlay>
  )
}
