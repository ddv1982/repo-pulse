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
    files: ['test/merge-ui.test.js', 'test/sync-status-ui.test.js', 'test/presentation.test.js'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'Literal[regex.pattern=/class=["\']|\\b(?:href|title|role|id|aria-[a-z-]+|data-[a-z-]+)=["\']|<\\\\?\\/?(?:a|b|p|dd|dt|dl|h[1-6]|ul|ol|li|div|span|strong|time|code|svg|path|circle|line|section|article|details|summary|button|label|input)\\b/]',
          message: 'Check rendered UI with test/fixtures/dom.js (text, one, row) instead of a regular expression over its HTML.',
        },
      ],
    },
  },
];
