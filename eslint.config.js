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
