import { ADVISORY_ICON, DOT_KEY, PR_STATUS } from '../lib/status.js'
import { Overlay, Row, Section, Subhead } from './Overlay.js'
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
 * The phases a pull request passes through, and which statuses belong to each.
 *
 * Thirteen statuses in one flat list was an alphabet: correct, ordered roughly by
 * progression, and still something you had to read end to end to find the one you were
 * looking at. Five named phases turn the same thirteen into short lists, and the phase
 * names answer the question a key is for — not "what does this chip say" but "where in
 * the process am I".
 *
 * A `Record` keyed by `PrStatus` rather than an array, so the compiler enforces that
 * every status appears. Adding a fourteenth status without deciding where it belongs is
 * a type error rather than a chip that quietly never appears in the key.
 */
const PHASES = [
  ['Waiting on a reviewer', 'Nobody has posted a review yet.'],
  ['Under review', 'Somebody has looked; the question is whose move it is.'],
  ['Checks', 'What the build and the merge requirements say.'],
  ['Verdict in', 'A human has given an answer.'],
  ['Off the board', 'Finished, or never started.'],
] as const

type Phase = (typeof PHASES)[number][0]

const PHASE_OF: Record<PrStatus, Phase> = {
  unassigned: 'Waiting on a reviewer',
  inbound: 'Waiting on a reviewer',
  'in-review': 'Under review',
  're-review': 'Under review',
  'on-final': 'Checks',
  'go-around': 'Checks',
  'hold-short': 'Verdict in',
  // Immediately before `cleared`, because that is the step it usually is: approved,
  // threads to clear, then mergeable.
  'cleared-advisory': 'Verdict in',
  cleared: 'Verdict in',
  landed: 'Off the board',
  diverted: 'Off the board',
  'at-gate': 'Off the board',
  'no-contact': 'Off the board',
}

/** Statuses in a phase, in the order they are declared above. */
const STATUS_ORDER: PrStatus[] = [
  'unassigned',
  'inbound',
  'in-review',
  're-review',
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
    'HOLDING',
    'Sessions you parked yourself — the one board Control Tower does not decide. Holds a session from EN ROUTE or a pull request from APPROACH you are not ready to merge. No time limit and no liveness check, so it keeps something exactly as long as you want it kept',
  ],
  [
    'EN ROUTE',
    'The running sessions you spoke to most recently, that have no pull request yet — as many as you set in preferences. Opening one moves the work to APPROACH. An exited session is not in flight, however recently you left it',
  ],
  [
    'APPROACH',
    'Any pull request that has not merged — awaiting its first look, mid-review, or approved with comments worth reading. Independent of whether its session is still running, because the PR is the live thing. CodeRabbit never counts as a reviewer in the counts or the summary',
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
    'Closed PRs',
    'Only ones a bot closed are shown — those are the ones worth reviving. Anything you closed yourself has already left the board, and DISMISS hides a bot-closed one you have decided against',
  ],
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
        {PHASES.map(([phase, gloss]) => (
          <div key={phase}>
            <Subhead>
              <span className="text-text-muted font-semibold">{phase}</span> — {gloss}
            </Subhead>
            {STATUS_ORDER.filter((status) => PHASE_OF[status] === phase).map((status) => {
              const { label, atc, chip, Icon } = PR_STATUS[status]
              return (
                <Row
                  key={status}
                  left={
                    <span
                      /* StatusChip's own classes, so a sample in the key is the thing it
                         describes: same padding, same weight, same 75% on the label.
                         whitespace-nowrap because a chip is a fixed token — allowed to be
                         wider than its column, never taller. */
                      className={cn(
                        'field inline-flex items-center gap-1.5 rounded px-2.5 py-1.5',
                        'text-ui leading-none font-semibold whitespace-nowrap',
                        chip,
                      )}
                    >
                      <Icon size={11} strokeWidth={2.5} aria-hidden />
                      <span className="opacity-75">{label}</span>
                    </span>
                  }
                  right={atc}
                />
              )
            })}
          </div>
        ))}
        <Subhead>
          <span className="text-text-muted font-semibold">The whole chip</span> — as it appears on a
          strip.
        </Subhead>
        <Row
          left={
            <span className="field bg-cleared-advisory text-cleared-advisory-fg inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-ui leading-none font-semibold whitespace-nowrap">
              <span>2493</span>
              <span className="opacity-75">APPROVED</span>
              <span className="ml-0.5 inline-flex items-center gap-1 border-l border-current/30 pl-2">
                <ADVISORY_ICON size={10} strokeWidth={2.5} aria-hidden />
                17
              </span>
            </span>
          }
          right="The pull request number, its status, and the count of unresolved review threads — other people’s, never yours or a bot’s. The count goes once the PR is merged or closed. Clicking the chip opens the PR"
        />
      </Section>

      <Section title="BOARDS">
        {BOARDS.map(([name, meaning]) => (
          <Row
            key={name}
            left={<span className="field text-ui font-semibold">{name}</span>}
            right={meaning}
          />
        ))}
      </Section>

      <Section title="STRIP MARKINGS">
        {MARKINGS.map(([name, meaning]) => (
          <Row
            key={name}
            left={<span className="text-ui font-medium">{name}</span>}
            right={meaning}
          />
        ))}
      </Section>

      <Section title="THE DOT">
        {DOT_KEY.map((entry) => (
          <Row
            key={entry.label}
            left={
              <span className="inline-flex items-center gap-2">
                <span
                  className={cn('size-2.5 rounded-full', entry.dot, entry.pulse && 'animate-blip')}
                />
                <span className="text-ui font-medium capitalize">{entry.kind}</span>
              </span>
            }
            right={entry.label}
          />
        ))}
      </Section>
    </Overlay>
  )
}
