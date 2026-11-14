import { defineConfig } from '@playwright/test';

const port = 5196;
const ci = Boolean(process.env.CI);

// The designer's browser tests run against its development page (packages/designer/dev), which uses an in-memory host.
// Locally the installed Edge is used. CI uses the chromium that Playwright bundles (N-8).
export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  outputDir: 'e2e/.output/results',
  timeout: 60_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: ci,
  retries: 0,
  reporter: ci ? [['list'], ['html', { open: 'never', outputFolder: 'e2e/.output/report' }]] : [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    ...(ci ? {} : { channel: 'msedge' }),
    viewport: { width: 1500, height: 950 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm exec vite --config packages/designer/dev/vite.config.ts',
    cwd: '../..',
    url: `http://localhost:${port}/dev/index.html`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
