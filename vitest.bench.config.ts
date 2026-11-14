import { defineConfig } from 'vitest/config';

// Timing runs, kept out of the normal test run because timings vary by machine.
export default defineConfig({
  test: {
    include: ['packages/*/bench/**/*.bench.ts'],
    testTimeout: 120_000,
  },
});
