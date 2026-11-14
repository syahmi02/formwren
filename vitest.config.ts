import { defineConfig } from 'vitest/config';

// Tests that need a DOM start with the comment: // @vitest-environment jsdom
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['packages/*/test/**/*.test.{ts,tsx}'],
    setupFiles: ['./vitest.setup.ts'],
    // Random-edit runs and real tsc runs compete for the CPU in a full run.
    testTimeout: 30_000,
  },
});
