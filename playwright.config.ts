import { defineConfig } from '@playwright/test';

const port = 5180;
// The browser tests use the real demo server on its own port and database file, so a running `pnpm demo` is never touched.
const serverPort = 5301;
// The answer delay the fixtures had, so busy states are visible and a click can land before the results.
const serverDelayMs = 200;
const ci = Boolean(process.env.CI);

// Locally the installed Edge is used. CI uses the chromium that Playwright bundles (N-8).
export default defineConfig({
  testDir: 'apps/demo/e2e',
  testMatch: '**/*.spec.ts',
  outputDir: 'apps/demo/e2e/.output/results',
  timeout: 60_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: ci,
  retries: 0,
  reporter: ci ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    ...(ci ? {} : { channel: 'msedge' }),
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      // A fresh database every run, with the reset route that the tests use between tests (step 4, decision 13).
      command: `node apps/demo/server/main.ts --test --reset --db apps/demo/.data/e2e.db --port ${serverPort} --delay ${serverDelayMs}`,
      port: serverPort,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `pnpm --filter demo exec fw dev --port ${port}`,
      url: `http://localhost:${port}/`,
      env: { FW_DSX_TARGET: `http://127.0.0.1:${serverPort}` },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
