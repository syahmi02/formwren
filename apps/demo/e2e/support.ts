import { test as base, expect } from '@playwright/test';

/**
 * Every test starts from the freshly seeded demo database: the server runs with `--test`, which adds a reset route,
 * and the dev server forwards it (step 4, decision 13). Every test also fails on a page error or a console error (N-7).
 * The dev server has no favicon, and the browser's request for one is logged as an error, so that one request is
 * answered with an empty response.
 */
export const test = base.extend<{ problems: string[]; freshData: void }>({
  freshData: [
    async ({ request }, use) => {
      const response = await request.post('/dsx/test/reset');
      expect(response.ok(), 'the test database was reset').toBe(true);
      await use();
    },
    { auto: true },
  ],
  problems: [
    async ({ page }, use) => {
      const problems: string[] = [];
      await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));
      page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
      page.on('console', (message) => {
        // The browser logs every 4xx response. A rejected or conflicting save is a normal answer that the screens handle and the tests provoke on purpose.
        const expectedAnswer = /^Failed to load resource.* (409|422) /.test(message.text());
        if (message.type() === 'error' && !expectedAnswer) problems.push(`console.error: ${message.text()}`);
      });
      await use(problems);
      expect(problems, 'no page errors or console errors').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
