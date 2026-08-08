import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

/**
 * Flat config (eslint 9). There was a `lint` script and no config at all, so the
 * command always errored — a check that looks like it passes CI and cannot.
 *
 * Type-aware linting is deliberately on. Every rule that has actually caught
 * something in this codebase needs types to work: floating promises in IPC handlers,
 * unchecked index access on query results, and `any` leaking out of JSON.parse at
 * the three boundaries where this app reads another program's data.
 */
export default tseslint.config(
  {
    // Build output, dependencies, and the packaged bundle. `dist` in particular
    // holds a whole copy of Electron.
    ignores: ['out/**', 'dist/**', 'node_modules/**', '*.tsbuildinfo'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // Uses the same three project files the build does, so lint and typecheck
        // cannot disagree about what is in scope.
        project: ['./tsconfig.node.json', './tsconfig.web.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      /**
       * Unused variables are an error, except a leading underscore.
       *
       * IPC handlers take `(_e, ...)` and genuinely do not want the event, so the
       * underscore convention is load-bearing here rather than a style preference.
       */
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      /**
       * `void` is how this codebase says "deliberately not awaited" — theme writes,
       * tune calls from click handlers. Allowing it keeps the rule useful for the
       * accidental cases instead of being suppressed wholesale.
       */
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      // Template literals are how nearly every message in this app is built, and
      // interpolating a number or a boolean into one is intended, not a mistake.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true, allowNullish: true },
      ],
    },
  },

  // This config file, and any other plain JS: not in a tsconfig project, so
  // type-aware rules cannot run on them and would error trying.
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },

  // Main and preload: Node globals, no DOM.
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts'],
    languageOptions: { globals: globals.node },
  },

  // Renderer: browser globals, plus the hooks rules.
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },

  // Tests run in Node under vitest and import from every layer.
  {
    files: ['src/**/*.test.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
)
