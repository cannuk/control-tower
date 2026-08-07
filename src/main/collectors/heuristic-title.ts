/**
 * Layer 3 of §8: a title from the first user message, with no model involved.
 *
 * This is the floor, and it carries more weight than "fallback" suggests — it is
 * what every session shows when no credential is configured, and what the LANDED
 * board shows permanently, since paying to title hundreds of finished sessions
 * would be absurd.
 *
 * The transformations are all lossy on purpose. A first message is a paragraph;
 * a strip has one line. What matters is that the words kept are the ones that
 * distinguish this session from the others on the board — which is why file paths
 * and hostnames survive (they are usually the subject) while pleasantries and
 * URLs do not.
 */

/** Openers that carry no information about the task. */
const FILLER = new RegExp(
  '^(?:' +
    [
      'hey|hi|hello|ok|okay|so|now|alright|right',
      'i want(?: you)? to|i need(?: you)? to|i think|i would like to|id like to',
      "let'?s|lets|can you|could you|please|would you",
      'we need to|we should|we have to|we want to',
      'you need to|help me',
    ].join('|') +
    ')\\b[\\s,:-]*',
  'i',
)

export function heuristicTitle(firstMessage: string | null): string | null {
  if (!firstMessage) return null

  let text = firstMessage

  // Slash commands are the clearest possible signal — use the command itself.
  const slash = /^\/([a-z][\w-]*)/i.exec(text.trim())
  if (slash?.[1]) return capitalize(slash[1].replace(/-/g, ' '))

  // An expanded prompt template often opens with its own markdown heading, which
  // is already a hand-written title — better than anything derivable from the
  // prose beneath it.
  const heading = /^#{1,3}\s+(.{3,64}?)\s*$/m.exec(text.trimStart().split('\n')[0] ?? '')
  if (heading?.[1]) return capitalize(heading[1].trim())

  // `@docs/beacon-customer-setup-guide.md` -> `beacon-customer-setup-guide`.
  // The basename is usually the subject of the request, so it stays.
  text = text.replace(/@([\w./-]+)/g, (_m, path: string) => {
    const base = path.split('/').pop() ?? path
    return base.replace(/\.[a-z]+$/i, '')
  })

  // A GitHub PR or issue URL carries exactly one useful token: the number.
  text = text.replace(
    /https?:\/\/(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+\/(?:pull|issues)\/(\d+)\S*/gi,
    (_m, number: string) => '#' + number,
  )

  // Otherwise keep the host and drop the path: a customer hostname is usually the
  // subject ("phase 1 for acme.com"), while the path is noise. Code-forge hosts
  // are the exception — "github.com" on its own says nothing about the task.
  text = text.replace(/https?:\/\/([^\s/]+)(\/\S*)?/g, (_m, host: string) =>
    /^(?:www\.)?(?:github|gitlab|bitbucket)\.com$/i.test(host) ? '' : host,
  )

  // Fenced code, inline code, and newlines all become single spaces: a strip is
  // one line, so structure cannot survive anyway.
  text = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()

  // Stop at the first sentence boundary — the opening clause is the ask, the rest
  // is qualification. Requires the period to be followed by a space so version
  // numbers and hostnames survive.
  const sentence = /^(.{16,}?[.!?])(?:\s|$)/.exec(text)
  if (sentence?.[1]) text = sentence[1]

  text = text
    .replace(FILLER, '')
    .replace(/[.!?,\s]+$/, '')
    .trim()
  if (text.length < 3) return null

  return capitalize(truncateWords(text, 64))
}

function truncateWords(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  // Only break on a word if that leaves most of the budget used; otherwise a
  // single long token would collapse the title to almost nothing.
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…'
}

function capitalize(text: string): string {
  // Only touch the first character. Title-casing the rest would mangle
  // identifiers, hostnames, and file names, which are the informative parts.
  return text.charAt(0).toUpperCase() + text.slice(1)
}
