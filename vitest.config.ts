import { defineConfig } from 'vitest/config'

/**
 * Tests run in Node, not jsdom.
 *
 * Everything under test is pure: board classification, sentence composition, title
 * heuristics. None of it touches the DOM, and none of it should — the parts of this
 * app worth testing are the rules, and the rules live in plain functions precisely so
 * they can be exercised without an Electron window or a fake browser.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
