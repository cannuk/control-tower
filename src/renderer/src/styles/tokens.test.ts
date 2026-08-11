import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { THEMES, THEME_HINTS, THEME_LABELS } from '../../../shared/types.js'

/**
 * The token layer's own rules, enforced.
 *
 * tokens.css states that a palette must define every token, because a missing one
 * silently inherits whatever the previous palette set — the failure the layer exists
 * to prevent, and one that shows up as a single wrong colour in one theme, which is
 * exactly the kind of thing nobody notices until it ships. The rule was written down
 * and then checked by hand four times; this checks it instead.
 */

const CSS = readFileSync(join(import.meta.dirname, 'tokens.css'), 'utf8')

/** Token names declared inside one `[data-theme='…']` block (or `:root`). */
function paletteOf(selector: string): Set<string> {
  // Blocks are flat — no nesting inside a palette — so the first `}` ends it.
  const start = CSS.indexOf(selector)
  if (start === -1) throw new Error(`no palette block for ${selector}`)
  const body = CSS.slice(start, CSS.indexOf('}', start))
  return new Set([...body.matchAll(/(--ct-[a-z-]+):/g)].map((m) => m[1] ?? ''))
}

const DEFAULT_PALETTE = paletteOf(":root,\n[data-theme='night-scope']")

describe('every palette is complete', () => {
  it('defines the default palette with tokens at all, so the comparison means something', () => {
    // Guards the parser rather than the CSS: a regex that quietly matched nothing
    // would make every test below pass.
    expect(DEFAULT_PALETTE.size).toBeGreaterThan(25)
  })

  for (const theme of THEMES) {
    if (theme === 'night-scope') continue

    it(`${theme} defines every token the default does`, () => {
      const palette = paletteOf(`[data-theme='${theme}']`)
      const missing = [...DEFAULT_PALETTE].filter((token) => !palette.has(token))
      expect(missing).toEqual([])
    })

    it(`${theme} defines no token the default lacks`, () => {
      // The other direction matters too: a token only one palette sets is one the
      // others inherit from wherever it happens to be declared.
      const extra = [...paletteOf(`[data-theme='${theme}']`)].filter(
        (token) => !DEFAULT_PALETTE.has(token),
      )
      expect(extra).toEqual([])
    })
  }
})

describe('every registered theme exists in both directions', () => {
  it('has a palette in the stylesheet', () => {
    // A theme in the picker with no palette renders as the previous one, silently.
    const orphans = THEMES.filter(
      (t) => t !== 'night-scope' && !CSS.includes(`[data-theme='${t}']`),
    )
    expect(orphans).toEqual([])
  })

  it('has a label and a hint', () => {
    for (const theme of THEMES) {
      expect(THEME_LABELS[theme], `label for ${theme}`).toBeTruthy()
      expect(THEME_HINTS[theme], `hint for ${theme}`).toBeTruthy()
    }
  })

  it('has no palette in the stylesheet that is not registered', () => {
    // The reverse orphan: a palette nothing can select is dead weight that still
    // reads as a working theme when you find it in the file.
    const declared = [...CSS.matchAll(/\[data-theme='([a-z-]+)'\]/g)].map((m) => m[1] ?? '')
    const unregistered = [...new Set(declared)].filter(
      (t) => !(THEMES as readonly string[]).includes(t),
    )
    expect(unregistered).toEqual([])
  })
})
