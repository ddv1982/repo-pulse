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
    },
  },
  { files: ['**/*.cjs'], languageOptions: { sourceType: 'commonjs', globals: globals.node } },
  { files: ['src/**/*.js', 'web/**/*.js', 'e2e/**/*.js'], languageOptions: { globals: globals.browser } },
];
