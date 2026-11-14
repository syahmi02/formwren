import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', 'docs/**', '.vscode-test/**'] },
  ...tseslint.configs.recommended,
  {
    // Matches TypeScript: a leading underscore marks a parameter as intentionally unused.
    rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] },
  },
  {
    // FRAMEWORK.md §5.1: the core layers stay free of React so they can be tested without a browser.
    files: ['packages/core/**/*.ts', 'packages/format/**/*.ts', 'packages/grid/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['react', 'react-dom', 'react-dom/*'] }],
    },
  },
);
