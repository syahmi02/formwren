import type { DsxRequest, DsxResponse } from '@fw/core';
import type { Page } from '@playwright/test';
import { fixtures } from '../src/fixtures.ts';
import { expect, test } from './support.ts';

const searchFixture = fixtures['hr.emp.search'];
if (typeof searchFixture !== 'function') throw new Error('hr.emp.search should be a function fixture');
const rows = (searchFixture({ datasets: { cond: { rows: [['']] } } } as unknown as DsxRequest) as DsxResponse).datasets?.list
  ?.rows as unknown[][];
const firstSalary = String(rows[0]?.[5]);

function screen(page: Page) {
  return {
    status: page.getByText(/^(Found|Saved|Changes reverted|Nothing to save|Not saved|Save or revert|Failed)/),
    rowInfo: page.getByText(/^Row \d+ of \d+$/),
    keyword: page.getByRole('textbox', { name: 'Name contains' }),
    name: page.getByRole('textbox', { name: 'Name', exact: true }),
    salary: page.getByRole('textbox', { name: 'Salary', exact: true }),
    search: page.getByRole('button', { name: 'Search' }),
    next: page.getByRole('button', { name: 'Next' }),
    previous: page.getByRole('button', { name: 'Previous' }),
    save: page.getByRole('button', { name: 'Save' }),
    revert: page.getByRole('button', { name: 'Revert' }),
    async enter(field: ReturnType<Page['getByRole']>, text: string) {
      await field.click();
      await field.press('Control+A');
      await field.pressSequentially(text);
      await field.press('Enter');
    },
  };
}

test.describe('Data safety', () => {
  let s: ReturnType<typeof screen>;
  test.beforeEach(async ({ page }) => {
    s = screen(page);
    await page.goto('/');
    await expect(s.status).toHaveText('Found 25 employees');
  });

  test('a focused field is not written when search results arrive', async ({ page }) => {
    const matches = rows.filter((r) => String(r[1]).toLowerCase().includes('an'));
    expect(matches.length).toBeGreaterThan(1);
    await s.keyword.fill('an');
    await s.search.click();
    // The fixture answers after a delay, so this click lands before the results.
    await s.name.click();
    await expect(s.status).toHaveText(`Found ${matches.length} employees`);
    await expect(s.rowInfo).toHaveText(`Row 1 of ${matches.length}`);
    await expect(s.name).toHaveValue(String(matches[0]?.[1]));
    await s.rowInfo.click();
    await s.save.click();
    await expect(s.status).toHaveText('Nothing to save');
    // No employee's name changed: walk every loaded row.
    for (let i = 1; i < matches.length; i++) {
      await s.next.click();
      await expect(s.name).toHaveValue(String(matches[i]?.[1]));
    }
    await page.getByText('Row').first().waitFor();
  });

  test('Save with text in the search box saves the edit and runs no search', async () => {
    await s.enter(s.name, 'Alicia Carter');
    await s.keyword.click();
    await s.keyword.pressSequentially('Quinn');
    await s.save.click();
    await expect(s.status).toHaveText('Saved 1 row');
    await expect(s.rowInfo).toHaveText('Row 1 of 25');
    await expect(s.name).toHaveValue('Alicia Carter');
  });

  test('search is refused over unsaved changes', async () => {
    await s.enter(s.name, 'Alicia Carter');
    await s.keyword.fill('Quinn');
    await s.search.click();
    await expect(s.status).toHaveText('Save or revert your changes first');
    await expect(s.rowInfo).toHaveText('Row 1 of 25');
    await expect(s.name).toHaveValue('Alicia Carter');
  });

  test('Enter then Tab commits once, shows the stored form, and Save sends one row', async () => {
    await s.salary.click();
    await s.salary.press('Control+A');
    await s.salary.pressSequentially('1,234.5');
    await s.salary.press('Enter');
    await s.salary.press('Tab');
    await expect(s.salary).toHaveValue(/^1234\.5(0{0,5})$/);
    await s.save.click();
    await expect(s.status).toHaveText('Saved 1 row');
  });

  test('rejected text is cleared by Revert', async () => {
    await s.enter(s.salary, 'twelve');
    await expect(s.salary).toHaveAttribute('aria-invalid', 'true');
    await s.revert.click();
    await expect(s.status).toHaveText('Changes reverted');
    await expect(s.salary).toHaveValue(firstSalary);
    await expect(s.salary).not.toHaveAttribute('aria-invalid', 'true');
  });

  test('focus stays on Next when it becomes disabled, and Tab moves on', async ({ page }) => {
    await s.next.click();
    for (let i = 2; i < rows.length; i++) await s.next.press('Enter');
    await expect(s.rowInfo).toHaveText(`Row ${rows.length} of ${rows.length}`);
    await expect(s.next).toBeFocused();
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
    await s.next.press('Enter');
    await expect(s.rowInfo).toHaveText(`Row ${rows.length} of ${rows.length}`);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('tab', { name: 'Details' })).toBeFocused();
  });

  test('a disabled Previous is not a Tab stop', async ({ page }) => {
    await expect(s.previous).toBeDisabled();
    // Walk forward from the Search button to Next. Whatever sits between them (the lookup field and its button), Previous is never stopped on.
    await s.search.focus();
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      expect(await s.previous.evaluate((el) => el === document.activeElement), 'Previous has focus').toBe(false);
      if (await s.next.evaluate((el) => el === document.activeElement)) break;
    }
    await expect(s.next).toBeFocused();
    // Backwards from Next, the stop before it is not Previous either.
    await page.keyboard.press('Shift+Tab');
    await expect(s.previous).not.toBeFocused();
    await expect(page.getByRole('button', { name: '...' })).toBeFocused();
  });
});
