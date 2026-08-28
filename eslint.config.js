import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Type-aware rules, on `src` only.
    //
    // Two rules, deliberately — not `recommendedTypeChecked`, which reports 111
    // problems here, almost all `no-unsafe-*` from Hono's `c.req.json()`
    // returning `any`. That is a real cleanup but a different one, and bundling
    // it here would have meant turning the whole set off again.
    //
    // These two are the ones a `Result` type cannot replace. A typed error only
    // reaches a caller that is waiting for it; these catch the async work no
    // caller is waiting for — a dropped promise, an `async` function handed to
    // a callback whose signature returns `void`. Every such site is invisible
    // to the type system by construction, so without these rules an error
    // vocabulary is only as good as the places someone remembered to await.
    //
    // `ignoreVoid` stays on: an explicit `void` remains the way to say "this
    // rejection is handled elsewhere or genuinely does not matter". What backs
    // that claim at runtime is `reportUnhandled` in `utils/interrupt.ts`.
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': [
        'error',
        { ignoreVoid: true },
      ],
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    // PoC sources: browser/ runs in the page, and the host driver embeds
    // page.evaluate() snippets that legitimately reference DOM globals. Plain
    // JS needs this because no-undef is only switched off for TypeScript.
    files: ['poc/**/*.js', 'poc/**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
  {
    // poc/*/out/ holds bundles the PoC produced; poc/*/vendor/ holds prebundled
    // third-party bundlers. Both are build artifacts, not source.
    ignores: ['**/dist/', '**/node_modules/', 'poc/*/out/', 'poc/*/vendor/'],
  }
)
