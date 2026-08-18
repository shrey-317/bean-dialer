import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist',
      'dev-dist',
      'coverage',
      'playwright-report',
      'test-results',
      'screenshots',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Build/dev scripts and the e2e stub server run in Node, not the browser.
    files: ['scripts/**/*.mjs', 'e2e/**/*.mjs', '*.config.{ts,js}'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // The timer is built out of effects; a stale closure there means a wrong shot time.
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Dexie schema strings and Recharts render props both legitimately produce
      // shapes TS can't narrow; prefer explicit casts over blanket any.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
);
