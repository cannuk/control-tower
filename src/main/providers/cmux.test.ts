import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { shellQuote } from './cmux.js'

/**
 * Shell quoting for launched sessions.
 *
 * Asserted against a real `/bin/sh` rather than against an expected string. The
 * question is not "does this produce the escaping I had in mind" — it is "does a
 * shell hand back exactly the text that went in", and only a shell can answer that.
 * An expected-string test would pass just as happily with quoting that is subtly
 * wrong in a way the shell notices and I did not.
 *
 * This matters more than anywhere else in the app: a filed plan is prose you typed,
 * and `cmux --command` feeds it to a shell.
 */
function roundTrip(text: string): string {
  return execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(text)}`]).toString()
}

describe('shellQuote', () => {
  const cases: [name: string, text: string][] = [
    ['plain text', 'add a retry to the upload path'],
    ['an apostrophe', "fix the widget's resize handler"],
    ['several apostrophes', "it's the user's session's problem"],
    ['double quotes', 'rename "old" to "new"'],
    ['newlines', 'first line\nsecond line\nthird'],
    ['a dollar sign', 'set $HOME and $PATH correctly'],
    ['backticks', 'replace `foo` with `bar`'],
    ['command substitution', 'run $(whoami) and `id -u`'],
    ['a semicolon and a destructive tail', 'tidy up; rm -rf /tmp/nothing'],
    ['pipes and redirects', 'cat a.txt | grep b > c.txt 2>&1'],
    ['a backslash', 'match \\d+ in the log'],
    ['glob characters', 'delete *.tmp and ?.log'],
    ['leading and trailing space', '  padded  '],
    ['a lone quote', "'"],
    ['empty', ''],
  ]

  for (const [name, text] of cases) {
    it(`passes ${name} through unchanged`, () => {
      expect(roundTrip(text)).toBe(text)
    })
  }

  it('never lets the shell execute what it quotes', () => {
    // If quoting failed, the substitution would run and the output would differ.
    const attack = '$(echo pwned) `echo pwned`'
    expect(roundTrip(attack)).toBe(attack)
    expect(roundTrip(attack)).not.toContain('pwned\n')
  })

  it('produces a single argument, not several words', () => {
    const words = execFileSync('/bin/sh', [
      '-c',
      `set -- ${shellQuote('three separate words')}; echo $#`,
    ])
      .toString()
      .trim()
    expect(words).toBe('1')
  })
})
