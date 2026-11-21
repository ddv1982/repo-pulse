import globals from 'globals';

export default [
  { ignores: ['.repo-pulse/**', 'test-results/**', 'playwright-report/**', 'playwright/.cache/**', 'coverage/**'] },
  {
    files: ['**/*.{js,cjs}'],
    languageOptions: { globals: globals.nodeBuiltin },
    rules: {
      'no-undef': 'error',
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      // Every function was brought to 30 or below in November 2026; split a function rather than raising this.
      complexity: ['error', 30],
    },
  },
  { files: ['**/*.cjs'], languageOptions: { sourceType: 'commonjs', globals: globals.node } },
  { files: ['src/**/*.js', 'web/**/*.js', 'e2e/**/*.js'], languageOptions: { globals: globals.browser } },
  // UI tests read rendered markup through test/fixtures/dom.js, so a markup change only breaks a test when what a person
  // sees changes. A regular expression over the HTML would pin its exact shape again. See docs/MAINTAINING.md.
  {
    files: ['test/merge-ui.test.js', 'test/sync-status-ui.test.js'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'Literal[regex.pattern=/class=|<\\\\?\\/?(?:div|span|li|ul|a|svg|path|circle|h1|h2|time|button|code|details|summary|section)\\b/]',
          message: 'Check rendered UI with test/fixtures/dom.js (text, one, row) instead of a regular expression over its HTML.',
        },
      ],
    },
  },
];
