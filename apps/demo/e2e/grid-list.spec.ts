/**
 * Journey D1 (REQUIREMENTS section 2) on the list screen, driven with the keyboard and mouse the
 * way a person would. The expected data comes from the fixture service itself, not from the page.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DsxRequest, DsxResponse } from '@fw/core';
import type { Locator, Page } from '@playwright/test';
import { fixtures } from '../src/fixtures.ts';
import { activeCell, activeDescendantIsValid, activePosition, gridOf, headerCell } from './grid-support.ts';
import { expect, test } from './support.ts';

const OUTPUT = join(import.meta.dirname, '.output');

// Tracks of the list Grid.
const T = { status: 0, select: 1, empNo: 2, name: 3, dept: 4, level: 5, active: 6, salary: 7, hired: 8 } as const;
const LAST = T.hired;

interface Emp {
  no: string;
  name: string;
  dept: string;
  level: string;
  active: boolean;
  salary: string;
  hired: string;
}
const LEVEL_NAME: Record<string, string> = { A: 'Junior', B: 'Senior', C: 'Lead' };
const DEPT_NAME: Record<string, string> = { ENG: 'Engineering', SAL: 'Sales', HR: 'Human Resources', FIN: 'Finance', OPS: 'Operations' };

const queryFixture = fixtures['hr.emp.query'];
if (typeof queryFixture !== 'function') throw new Error('hr.emp.query should be a function fixture');
const EMPS: Emp[] = (
  (queryFixture({ datasets: { cond: { columns: [{ id: 'empName', type: 'string' }], rows: [['']] } } } as unknown as DsxRequest) as DsxResponse).datasets?.list
    ?.rows as unknown[][]
).map((r) => ({ no: String(r[0]), name: String(r[1]), dept: String(r[2]), level: String(r[3]), active: r[4] === true, salary: String(r[5]), hired: String(r[6]) }));

/** Exact salary total with BigInt, shown with two places as the footer's pattern does (half away from zero). */
function salaryTotal(salaries: string[]): string {
  let total = 0n;
  for (const s of salaries) {
    const [w = '0', f = ''] = s.split('.');
    total += BigInt(w + f.padEnd(6, '0'));
  }
  const cents = (total + 5000n) / 10000n;
  const text = cents.toString().padStart(3, '0');
  const whole = text.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${whole}.${text.slice(-2)}`;
}
const shownSalary = (s: string): string => salaryTotal([s]);
const shownDate = (d: string): string => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`;

function screen(page: Page) {
  const grid = gridOf(page);
  const row = (no: string): Locator => page.locator(`.fw-grid__row:has(.fw-grid__cell[data-track="${T.empNo}"]:text-is("${no}"))`);
  return {
    grid,
    scroller: page.locator('.fw-grid__scroller'),
    status: page.getByText(/^(Found|Saved|Changes reverted|Nothing to save|Not saved|Save or revert|Failed|Row added|Deleted|No row)/),
    search: page.getByRole('button', { name: 'Search' }),
    add: page.getByRole('button', { name: 'Add row' }),
    del: page.getByRole('button', { name: 'Delete row' }),
    save: page.getByRole('button', { name: 'Save' }),
    revert: page.getByRole('button', { name: 'Revert' }),
    keyword: page.getByRole('textbox', { name: 'Name contains' }),
    dept: page.getByRole('combobox', { name: 'Department' }),
    editor: page.locator('.fw-grid__editor-control'),
    row,
    cell: (no: string, track: number): Locator => row(no).locator(`.fw-grid__cell[data-track="${track}"]`),
    /** Rows in view order, as rendered, with their cell text. Scrolls through the whole Grid in steps. */
    async allRows(): Promise<{ no: string; name: string; dept: string; level: string; active: string; salary: string; hired: string; mark: string; invalid: boolean }[]> {
      const seen = new Map<number, { no: string; name: string; dept: string; level: string; active: string; salary: string; hired: string; mark: string; invalid: boolean }>();
      const height = await page.locator('.fw-grid__scroller').evaluate((el) => el.clientHeight);
      let top = 0;
      for (let i = 0; i < 100; i++) {
        await page.locator('.fw-grid__scroller').evaluate((el, t) => (el.scrollTop = t), top);
        await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
        const rows = await page.locator('.fw-grid__row').evaluateAll((els) =>
          els.map((el) => {
            const t = (n: number) => el.querySelector(`.fw-grid__cell[data-track="${n}"]`)?.textContent ?? '';
            return {
              index: Number((el as HTMLElement).dataset.index),
              no: t(2), name: t(3), dept: t(4), level: t(5), active: t(6), salary: t(7), hired: t(8), mark: t(0),
              invalid: el.querySelector('[data-invalid]') !== null,
            };
          }),
        );
        for (const r of rows) seen.set(r.index, r);
        const max = await page.locator('.fw-grid__scroller').evaluate((el) => el.scrollHeight - el.clientHeight);
        if (top >= max) break;
        top = Math.min(max, top + Math.max(height - 120, 100));
      }
      await page.locator('.fw-grid__scroller').evaluate((el) => (el.scrollTop = 0));
      return [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r);
    },
    async rendered(): Promise<number> {
      return page.locator('.fw-grid__row').count();
    },
    footer: (track: number): Locator => page.locator(`.fw-grid__footer .fw-grid__cell[aria-colindex="${track + 1}"]`),
    async open(): Promise<void> {
      await page.goto('/#list');
      await expect(this.status).toHaveText('Found 25 employees');
      await expect(grid).toBeVisible();
      await expect(row('E001')).toBeVisible();
    },
    async clickCell(no: string, track: number): Promise<void> {
      await this.cell(no, track).click();
      await expect.poll(async () => (await activeCell(page))?.text !== undefined && (await activeCell(page))?.track).toBe(track);
    },
    async activeRowNo(): Promise<string | null> {
      return page.evaluate(() => {
        const root = document.querySelector('.fw-grid');
        const id = root?.getAttribute('aria-activedescendant');
        const el = id ? document.getElementById(id) : null;
        return el?.closest('.fw-grid__row')?.querySelector('.fw-grid__cell[data-track="2"]')?.textContent ?? null;
      });
    },
  };
}
type Screen = ReturnType<typeof screen>;

test.describe('D1: search and list', () => {
  let s: Screen;
  test.beforeEach(async ({ page }) => {
    s = screen(page);
    await s.open();
  });

  test('Search fills the Grid, and a department filter narrows it', async ({ page }) => {
    await expect(s.grid).toHaveAttribute('aria-rowcount', String(EMPS.length + 2 + 1));
    await expect(s.cell('E001', T.name)).toHaveText(EMPS[0]?.name ?? '');
    await expect(s.cell('E001', T.dept)).toHaveText('Engineering');
    await expect(s.cell('E001', T.level)).toHaveText(LEVEL_NAME[EMPS[0]?.level ?? ''] ?? '');
    await expect(s.cell('E001', T.salary)).toHaveText(shownSalary(EMPS[0]?.salary ?? ''));
    await expect(s.cell('E001', T.hired)).toHaveText(shownDate(EMPS[0]?.hired ?? ''));
    const all = await s.allRows();
    expect(all.map((r) => r.no)).toEqual(EMPS.map((e) => e.no));

    // Department filter: choose Engineering and press Search.
    await page.getByRole('button', { name: 'Show options Department' }).click();
    await page.getByRole('option', { name: 'Engineering' }).click();
    await s.search.click();
    const eng = EMPS.filter((e) => e.dept === 'ENG');
    await expect(s.status).toHaveText(`Found ${eng.length} employees`);
    await expect(s.grid).toHaveAttribute('aria-rowcount', String(eng.length + 3));
    const filtered = await s.allRows();
    expect(filtered.map((r) => r.no)).toEqual(eng.map((e) => e.no));
    expect(new Set(filtered.map((r) => r.dept))).toEqual(new Set(['Engineering']));
    await expect(s.footer(T.dept)).toHaveText(String(eng.length));

    // With a name fragment as well.
    await s.keyword.fill('an');
    await s.search.click();
    const both = eng.filter((e) => e.name.toLowerCase().includes('an'));
    await expect(s.status).toHaveText(`Found ${both.length} employees`);
    expect((await s.allRows()).map((r) => r.no)).toEqual(both.map((e) => e.no));
  });

  test('clicking a header sorts ascending, descending, then none; Shift adds a key; aria-sort follows', async ({ page }) => {
    const name = headerCell(page, 'Name');
    const dept = headerCell(page, 'Department');
    const level = headerCell(page, 'Level');
    const order = async () => (await s.allRows()).map((r) => r.no);
    const byName = (dir: 1 | -1) => [...EMPS].sort((a, b) => (a.name < b.name ? -dir : a.name > b.name ? dir : 0)).map((e) => e.no);

    await expect(name).toHaveAttribute('aria-sort', 'none');
    await name.click();
    await expect(name).toHaveAttribute('aria-sort', 'ascending');
    expect(await order()).toEqual(byName(1));
    await name.click();
    await expect(name).toHaveAttribute('aria-sort', 'descending');
    expect(await order()).toEqual(byName(-1));
    await name.click();
    await expect(name).toHaveAttribute('aria-sort', 'none');
    expect(await order()).toEqual(EMPS.map((e) => e.no));

    // Salary is a decimal: compare as exact scaled integers.
    const scaled = (v: string): bigint => {
      const [w = '0', f = ''] = v.split('.');
      return BigInt(w + f.padEnd(6, '0'));
    };
    const salary = headerCell(page, 'Salary');
    await salary.click();
    await salary.click();
    await expect(salary).toHaveAttribute('aria-sort', 'descending');
    expect(await order()).toEqual([...EMPS].sort((a, b) => (scaled(b.salary) > scaled(a.salary) ? 1 : scaled(b.salary) < scaled(a.salary) ? -1 : 0)).map((e) => e.no));
    await salary.click();
    await expect(salary).toHaveAttribute('aria-sort', 'none');

    // Shift-click adds a second key: Department, then Level.
    await dept.click();
    await level.click({ modifiers: ['Shift'] });
    await expect(dept).toHaveAttribute('aria-sort', 'ascending');
    await expect(level).toHaveAttribute('aria-sort', 'ascending');
    const two = [...EMPS].sort((a, b) => (a.dept < b.dept ? -1 : a.dept > b.dept ? 1 : a.level < b.level ? -1 : a.level > b.level ? 1 : 0)).map((e) => e.no);
    expect(await order()).toEqual(two);
    // Shift-click again flips only that key.
    await level.click({ modifiers: ['Shift'] });
    await expect(level).toHaveAttribute('aria-sort', 'descending');
    await expect(dept).toHaveAttribute('aria-sort', 'ascending');
    const flipped = [...EMPS].sort((a, b) => (a.dept < b.dept ? -1 : a.dept > b.dept ? 1 : a.level < b.level ? 1 : a.level > b.level ? -1 : 0)).map((e) => e.no);
    expect(await order()).toEqual(flipped);
    // A plain click starts over with one key.
    await name.click();
    await expect(name).toHaveAttribute('aria-sort', 'ascending');
    await expect(dept).toHaveAttribute('aria-sort', 'none');
    await expect(level).toHaveAttribute('aria-sort', 'none');
  });

  test('dragging a resize handle widens the column and does not sort', async ({ page }) => {
    const dept = headerCell(page, 'Department');
    const before = (await dept.boundingBox())?.width ?? 0;
    expect(before).toBeCloseTo(200, 0);
    const handle = page.locator(`.fw-grid__resize[data-track="${T.dept}"]`);
    const box = await handle.boundingBox();
    if (!box) throw new Error('no resize handle');
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 40, y, { steps: 4 });
    await page.mouse.move(x + 90, y, { steps: 4 });
    await page.mouse.up();
    const after = (await dept.boundingBox())?.width ?? 0;
    expect(after).toBeCloseTo(before + 90, -1);
    await expect(dept).toHaveAttribute('aria-sort', 'none');
    await expect(handle).toHaveAttribute('aria-valuenow', String(Math.round(after)));
    // A body cell in the same column is as wide as its header, and the rows did not change order.
    expect((await s.cell('E002', T.dept).boundingBox())?.width ?? 0).toBeCloseTo(after, 0);
    expect((await s.allRows()).map((r) => r.no)).toEqual(EMPS.map((e) => e.no));
    // The click that ends a drag does not toggle the sort either, and a later click still does.
    await dept.click({ position: { x: 20, y: 10 } });
    await expect(dept).toHaveAttribute('aria-sort', 'ascending');
  });

  test('footer count and totals are exact, and update after edits, add, delete and revert', async ({ page }) => {
    const total = salaryTotal(EMPS.map((e) => e.salary));
    await expect(s.footer(T.dept)).toHaveText('25');
    await expect(s.footer(T.salary)).toHaveText(total);
    // Edit one salary: E001 becomes 100000.000001. The total moves by exactly the difference.
    await s.clickCell('E001', T.salary);
    await page.keyboard.press('F2');
    await page.keyboard.press('Control+A');
    await page.keyboard.type('100000.000001');
    await page.keyboard.press('Enter');
    const edited = EMPS.map((e) => (e.no === 'E001' ? e.salary.replace(/^.*$/, '100000.000001') : e.salary));
    await expect(s.footer(T.salary)).toHaveText(salaryTotal(edited));
    await expect(s.footer(T.dept)).toHaveText('25');
    // Add a row: count 26, and the new row has no salary, so the total is unchanged.
    await s.add.click();
    await expect(s.footer(T.dept)).toHaveText('26');
    await expect(s.footer(T.salary)).toHaveText(salaryTotal(edited));
    // Delete it again.
    await s.del.click();
    await expect(s.footer(T.dept)).toHaveText('25');
    // Revert restores the original total.
    await s.revert.click();
    await expect(s.status).toHaveText('Changes reverted');
    await expect(s.footer(T.salary)).toHaveText(total);
    // A filtered list totals only what it shows.
    await page.getByRole('button', { name: 'Show options Department' }).click();
    await page.getByRole('option', { name: 'Sales' }).click();
    await s.search.click();
    const sales = EMPS.filter((e) => e.dept === 'SAL');
    await expect(s.status).toHaveText(`Found ${sales.length} employees`);
    await expect(s.footer(T.dept)).toHaveText(String(sales.length));
    await expect(s.footer(T.salary)).toHaveText(salaryTotal(sales.map((e) => e.salary)));
  });
});

test.describe('D1: editing', () => {
  let s: Screen;
  test.beforeEach(async ({ page }) => {
    s = screen(page);
    await s.open();
  });

  test('typing on a focused cell opens the editor with that character; Enter and F2 open it with the value; Esc cancels', async ({ page }) => {
    await s.clickCell('E001', T.name);
    await expect(s.editor).toHaveCount(0);
    await page.keyboard.press('Enter');
    await expect(s.editor).toHaveValue(EMPS[0]?.name ?? '');
    await expect(s.editor).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(s.editor).toHaveCount(0);
    await expect(s.grid).toBeFocused();
    await page.keyboard.press('F2');
    await expect(s.editor).toHaveValue(EMPS[0]?.name ?? '');
    await page.keyboard.press('Escape');
    await page.keyboard.press('k');
    await expect(s.editor).toHaveValue('k');
    await page.keyboard.type('ay');
    await expect(s.editor).toHaveValue('kay');
    await page.keyboard.press('Escape');
    await expect(s.editor).toHaveCount(0);
    // Esc wrote nothing and marked nothing.
    await expect(s.cell('E001', T.name)).toHaveText(EMPS[0]?.name ?? '');
    await expect(s.cell('E001', T.status)).toHaveText('');
    await expect(s.status).toHaveText('Found 25 employees');
  });

  test('Enter commits and moves down; Tab commits and moves right, wrapping to the next row', async ({ page }) => {
    await s.clickCell('E001', T.name);
    await page.keyboard.type('Zed Zulu');
    await page.keyboard.press('Enter');
    await expect(s.editor).toHaveCount(0);
    await expect(s.cell('E001', T.name)).toHaveText('Zed Zulu');
    expect(await s.activeRowNo()).toBe('E002');
    expect((await activeCell(page))?.track).toBe(T.name);
    await expect(s.cell('E001', T.status)).toHaveText('U');
    await expect(s.cell('E002', T.status)).toHaveText('');

    // Tab from the last column commits and wraps to the first column of the next row.
    await s.clickCell('E003', T.hired);
    await page.keyboard.press('F2');
    await s.editor.fill('2021-07-04');
    await page.keyboard.press('Tab');
    await expect(s.cell('E003', T.hired)).toHaveText('07/04/2021');
    expect(await s.activeRowNo()).toBe('E004');
    expect((await activeCell(page))?.track).toBe(0);
    // Tab from the middle moves right.
    await s.clickCell('E005', T.name);
    await page.keyboard.type('Quill');
    await page.keyboard.press('Tab');
    await expect(s.cell('E005', T.name)).toHaveText('Quill');
    expect(await s.activeRowNo()).toBe('E005');
    expect((await activeCell(page))?.track).toBe(T.dept);
  });

  test('Tab at the very end of the Grid commits and leaves the Grid', async ({ page }) => {
    await s.clickCell('E001', T.name);
    await page.keyboard.press('Control+End');
    await expect.poll(async () => (await activeCell(page))?.track).toBe(LAST);
    expect(await s.activeRowNo()).toBe('E025');
    await page.keyboard.press('F2');
    await s.editor.fill('2022-02-02');
    await page.keyboard.press('Tab');
    await expect(s.cell('E025', T.hired)).toHaveText('02/02/2022');
    await expect(s.save).toBeFocused();
    await expect(s.editor).toHaveCount(0);
  });

  test('clicking elsewhere commits the edit', async ({ page }) => {
    await s.clickCell('E001', T.name);
    await page.keyboard.type('Click Away');
    await s.cell('E004', T.dept).click();
    await expect(s.editor).toHaveCount(0);
    await expect(s.cell('E001', T.name)).toHaveText('Click Away');
    expect(await s.activeRowNo()).toBe('E004');
    // Clicking on something that is not in the Grid commits too.
    await s.clickCell('E002', T.name);
    await page.keyboard.type('Outside');
    await page.getByText(/^Row \d+ of \d+$/).click();
    await expect(s.editor).toHaveCount(0);
    await expect(s.cell('E002', T.name)).toHaveText('Outside');
    await expect(s.cell('E002', T.status)).toHaveText('U');
  });

  test('text that does not fit stays in the editor, marked invalid, until it is fixed or cancelled', async ({ page }) => {
    await s.clickCell('E002', T.salary);
    const before = await s.cell('E002', T.salary).textContent();
    await page.keyboard.press('F2');
    await page.keyboard.press('Control+A');
    await page.keyboard.type('twelve');
    await page.keyboard.press('Enter');
    await expect(s.editor).toHaveAttribute('aria-invalid', 'true');
    await expect(s.editor).toBeFocused();
    await expect(page.locator('.fw-grid__editor-message[role="alert"]')).toHaveText('Not a valid number');
    await expect(s.cell('E002', T.salary)).toHaveText(before ?? '');
    await expect(s.cell('E002', T.status)).toHaveText('');
    // Typing clears the mark, and a good value commits.
    await page.keyboard.press('Control+A');
    await page.keyboard.type('55000.5');
    await expect(s.editor).not.toHaveAttribute('aria-invalid', 'true');
    await page.keyboard.press('Enter');
    await expect(s.editor).toHaveCount(0);
    await expect(s.cell('E002', T.salary)).toHaveText('55,000.50');
    // Too many integer digits for the column (precision 14, scale 6) is taken by the editor, and Save refuses it and marks the cell.
    await s.clickCell('E004', T.salary);
    await page.keyboard.type('123456789012.5');
    await page.keyboard.press('Enter');
    await expect(s.editor).toHaveCount(0);
    await s.save.click();
    await expect(s.status).toHaveText(/^Not saved:/);
    await expect(s.cell('E004', T.salary)).toHaveAttribute('aria-invalid', 'true');
    await s.revert.click();
    // A name longer than the column's 50 characters is also taken by the editor (only the type is checked there); Save refuses it.
    await s.clickCell('E003', T.name);
    await page.keyboard.type('x'.repeat(60));
    await page.keyboard.press('Enter');
    await expect(s.editor).toHaveCount(0);
    await s.save.click();
    await expect(s.status).toHaveText(/^Not saved:/);
    await expect(s.cell('E003', T.name)).toHaveAttribute('aria-invalid', 'true');
    await s.revert.click();
    await expect(s.cell('E003', T.name)).toHaveText(EMPS[2]?.name ?? '');
  });

  test('each editor type works: text, number (exact long decimal), dropdown, date, checkbox', async ({ page }) => {
    // Text.
    await s.clickCell('E001', T.name);
    await page.keyboard.press('F2');
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Text Edit');
    await page.keyboard.press('Enter');
    await expect(s.cell('E001', T.name)).toHaveText('Text Edit');

    // Number: all 14 digits are kept, even though the cell shows two places.
    await s.clickCell('E001', T.salary);
    await page.keyboard.press('F2');
    await page.keyboard.press('Control+A');
    await page.keyboard.type('12345678.123456');
    await page.keyboard.press('Enter');
    await expect(s.cell('E001', T.salary)).toHaveText('12,345,678.12');
    await s.clickCell('E001', T.salary);
    await page.keyboard.press('F2');
    await expect(s.editor).toHaveValue('12345678.123456');
    await page.keyboard.press('Escape');
    await expect(s.footer(T.salary)).toHaveText(salaryTotal(EMPS.map((e) => (e.no === 'E001' ? '12345678.123456' : e.salary))));

    // Dropdown (options from a Dataset): pick by label, and by typing the first letter.
    await s.clickCell('E002', T.dept);
    await page.keyboard.press('F2');
    await expect(s.editor).toHaveAttribute('aria-label', 'Department');
    await s.editor.selectOption({ label: 'Human Resources' });
    await page.keyboard.press('Enter');
    await expect(s.cell('E002', T.dept)).toHaveText('Human Resources');
    await s.clickCell('E003', T.dept);
    await page.keyboard.type('F');
    await expect(s.editor).toHaveJSProperty('tagName', 'SELECT');
    await page.keyboard.press('Enter');
    await expect(s.cell('E003', T.dept)).toHaveText('Finance');
    // Dropdown with static options.
    await s.clickCell('E004', T.level);
    await page.keyboard.press('F2');
    await s.editor.selectOption({ label: 'Lead' });
    await page.keyboard.press('Enter');
    await expect(s.cell('E004', T.level)).toHaveText('Lead');

    // Date.
    await s.clickCell('E005', T.hired);
    await page.keyboard.press('F2');
    await s.editor.fill('2030-12-31');
    await page.keyboard.press('Enter');
    await expect(s.cell('E005', T.hired)).toHaveText('12/31/2030');

    // Checkbox: a click or Space toggles it, with no editor box.
    const was = EMPS[6]?.active ? 'Yes' : 'No';
    await expect(s.cell('E007', T.active)).toHaveText(was);
    await s.cell('E007', T.active).click();
    await expect(s.cell('E007', T.active)).toHaveText(was === 'Yes' ? 'No' : 'Yes');
    await expect(s.cell('E007', T.status)).toHaveText('U');
    await expect(s.editor).toHaveCount(0);
    await page.keyboard.press(' ');
    await expect(s.cell('E007', T.active)).toHaveText(was);
  });
});

test.describe('D1: row status, add, delete, save, revert', () => {
  let s: Screen;
  test.beforeEach(async ({ page }) => {
    s = screen(page);
    await s.open();
  });

  test('row status marks show on edit; Save reports the count and clears them; Revert restores values', async ({ page }) => {
    await s.clickCell('E001', T.name);
    await page.keyboard.type('Changed One');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Changed Two');
    await page.keyboard.press('Enter');
    await expect(s.cell('E001', T.status)).toHaveText('U');
    await expect(s.cell('E002', T.status)).toHaveText('U');
    await expect(s.row('E001')).toHaveAttribute('data-status', 'updated');
    await expect(s.row('E003')).toHaveAttribute('data-status', 'normal');
    await s.save.click();
    await expect(s.status).toHaveText('Saved 2 rows');
    await expect(s.cell('E001', T.status)).toHaveText('');
    await expect(s.row('E001')).toHaveAttribute('data-status', 'normal');
    await expect(s.cell('E001', T.name)).toHaveText('Changed One');
    await s.save.click();
    await expect(s.status).toHaveText('Nothing to save');

    // Revert: values come back, marks clear.
    await s.clickCell('E003', T.name);
    await page.keyboard.type('Temp');
    await page.keyboard.press('Enter');
    await s.clickCell('E003', T.salary);
    await page.keyboard.type('1');
    await page.keyboard.press('Enter');
    await expect(s.cell('E003', T.status)).toHaveText('U');
    await expect(s.cell('E004', T.status)).toHaveText('');
    await s.revert.click();
    await expect(s.status).toHaveText('Changes reverted');
    await expect(s.cell('E003', T.name)).toHaveText(EMPS[2]?.name ?? '');
    await expect(s.cell('E003', T.salary)).toHaveText(shownSalary(EMPS[2]?.salary ?? ''));
    await expect(s.cell('E003', T.status)).toHaveText('');
    await expect(s.cell('E004', T.status)).toHaveText('');
    // Edits that were saved stay.
    await expect(s.cell('E001', T.name)).toHaveText('Changed One');
  });

  test('Add row adds an inserted row at the end; Save sends it once it is filled in; Delete row removes it', async ({ page }) => {
    await s.add.click();
    await expect(s.status).toHaveText('Row added');
    await expect(s.footer(T.dept)).toHaveText('26');
    await expect(s.grid).toHaveAttribute('aria-rowcount', '29');
    // Focus went to the new row's first editable cell, and the row scrolled into view.
    await expect(s.grid).toBeFocused();
    const a = await activeCell(page);
    expect(a?.index).toBe(25);
    expect(a?.track).toBe(T.empNo);
    expect(await activeDescendantIsValid(page)).toBe(true);
    const newRow = page.locator('.fw-grid__row[data-index="25"]');
    await expect(newRow).toBeVisible();
    await expect(newRow.locator('.fw-grid__cell[data-track="0"]')).toHaveText('I');
    await expect(newRow.locator('.fw-grid__cell[data-track="6"]')).toHaveText('Yes');
    // The name is required and empty, so Save is refused and its cell is marked and focused. The number is left for the server to assign.
    await s.save.click();
    await expect(s.status).toHaveText(/^Not saved:/);
    await expect(newRow.locator('.fw-grid__cell[data-invalid]').first()).toBeVisible();
    expect((await activeCell(page))?.track).toBe(T.name);
    // Fill in the name with the keyboard, then Save.
    await page.keyboard.type('Zoe Zhang');
    await page.keyboard.press('Enter');
    await s.save.click();
    await expect(s.status).toHaveText('Saved 1 row');
    await expect(newRow.locator('.fw-grid__cell[data-track="0"]')).toHaveText('');
    // The server assigned the number and sent it back.
    await expect(newRow.locator('.fw-grid__cell[data-track="2"]')).toHaveText('E026');
    await expect(newRow.locator('.fw-grid__cell[data-invalid]')).toHaveCount(0);
    await expect(s.footer(T.dept)).toHaveText('26');

    // Delete removes the current row, and Save applies it.
    await s.clickCell('E010', T.name);
    await s.del.click();
    await expect(s.status).toHaveText('Deleted 1 row. Save to apply');
    await expect(s.row('E010')).toHaveCount(0);
    await expect(s.footer(T.dept)).toHaveText('25');
    await s.save.click();
    await expect(s.status).toHaveText('Saved 1 row');
    await expect(s.row('E010')).toHaveCount(0);
  });
});

test.describe('D1: data safety', () => {
  let s: Screen;
  test.beforeEach(async ({ page }) => {
    s = screen(page);
    await s.open();
  });

  test('scrolling the edited row out of view keeps the draft, and it lands on that row', async ({ page }) => {
    await s.clickCell('E002', T.name);
    await page.keyboard.type('Draft Survives');
    await expect(s.editor).toHaveValue('Draft Survives');
    // Scroll to the bottom with the mouse wheel.
    await s.scroller.hover();
    await page.mouse.wheel(0, 2000);
    await expect.poll(() => s.scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(200);
    await expect(s.row('E025')).toBeVisible();
    // The editor is still open with its draft, and the active cell is still valid.
    await expect(s.editor).toHaveValue('Draft Survives');
    expect(await activeDescendantIsValid(page)).toBe(true);
    // The row is no longer on screen: the editor is positioned over it, off-screen, so the visible rows are untouched.
    const topRowBox = await s.row('E002').boundingBox();
    const scrollerBox = await s.scroller.boundingBox();
    expect(topRowBox && scrollerBox && topRowBox.y + topRowBox.height <= scrollerBox.y + 80).toBe(true);
    // Commit while scrolled away: the value lands on E002, not on any row that is on screen.
    await s.editor.press('Enter');
    await expect(s.editor).toHaveCount(0);
    expect(await s.activeRowNo()).toBe('E003');
    const rows = await s.allRows();
    const changed = rows.filter((r) => r.mark === 'U');
    expect(changed.map((r) => r.no)).toEqual(['E002']);
    expect(rows.find((r) => r.no === 'E002')?.name).toBe('Draft Survives');
    for (const r of rows) if (r.no !== 'E002') expect(r.name).toBe(EMPS.find((e) => e.no === r.no)?.name);
  });

  test('sorting while an editor is open commits the edit to the right row', async ({ page }) => {
    await s.clickCell('E003', T.name);
    await page.keyboard.type('Aaron Zero');
    await headerCell(page, 'Name').click();
    await expect(s.editor).toHaveCount(0);
    await expect(headerCell(page, 'Name')).toHaveAttribute('aria-sort', 'ascending');
    const rows = await s.allRows();
    expect(rows[0]?.no).toBe('E003');
    expect(rows[0]?.name).toBe('Aaron Zero');
    expect(rows.filter((r) => r.mark === 'U').map((r) => r.no)).toEqual(['E003']);
    for (const r of rows) if (r.no !== 'E003') expect(r.name).toBe(EMPS.find((e) => e.no === r.no)?.name);
    // The same with the keyboard shortcut for sorting.
    await s.clickCell('E010', T.salary);
    await page.keyboard.type('77777');
    await page.keyboard.press('Control+Shift+S');
    await expect(s.editor).toHaveCount(0);
    await expect(s.cell('E010', T.salary)).toHaveText('77,777.00');
    await expect(s.cell('E010', T.status)).toHaveText('U');
    expect((await s.allRows()).filter((r) => r.mark === 'U').map((r) => r.no).sort()).toEqual(['E003', 'E010']);
  });

  test('an edit on a sorted Grid lands on the row that was edited', async ({ page }) => {
    const salary = headerCell(page, 'Salary');
    await salary.click();
    await salary.click();
    await expect(salary).toHaveAttribute('aria-sort', 'descending');
    const before = await s.allRows();
    const third = before[2];
    if (!third) throw new Error('no third row');
    // The third row on screen is not the third row of the data.
    expect(third.no).not.toBe('E003');
    await s.cell(third.no, T.name).click();
    await page.keyboard.type('Sorted Edit');
    await page.keyboard.press('Enter');
    const after = await s.allRows();
    expect(after.map((r) => r.no)).toEqual(before.map((r) => r.no));
    expect(after.filter((r) => r.mark === 'U').map((r) => r.no)).toEqual([third.no]);
    expect(after.find((r) => r.no === third.no)?.name).toBe('Sorted Edit');
    for (const r of after) if (r.no !== third.no) expect(r.name).toBe(EMPS.find((e) => e.no === r.no)?.name);
    expect(await s.activeRowNo()).toBe(before[3]?.no);
  });

  test('a failed Save marks the right cell and moves focus to it, also when sorted', async ({ page }) => {
    const name = headerCell(page, 'Name');
    await name.click();
    await name.click();
    await expect(name).toHaveAttribute('aria-sort', 'descending');
    // E001 (Alice) is now last on screen. Give it a salary the server rejects (minimum is 30,000).
    await s.scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(s.row('E001')).toBeVisible();
    await s.clickCell('E001', T.salary);
    await page.keyboard.type('1000');
    await page.keyboard.press('Enter');
    await s.save.click();
    await expect(s.status).toHaveText('Failed: 1 row was rejected');
    // Scroll away, so that focus has to bring the cell back.
    await s.scroller.evaluate((el) => (el.scrollTop = 0));
    await s.save.focus();
    await s.save.click();
    await expect(s.status).toHaveText(/^(Failed|Not saved)/);
    const cell = s.cell('E001', T.salary);
    await expect(cell).toBeVisible();
    await expect(cell).toHaveAttribute('data-invalid', '');
    await expect(cell).toHaveAttribute('aria-invalid', 'true');
    await expect(cell).toHaveAttribute('title', 'Salary must be at least 30,000');
    // Focus is on the Grid, on that row's salary cell (a row id, not a position).
    await expect(s.grid).toBeFocused();
    const a = await activeCell(page);
    expect(a?.track).toBe(T.salary);
    expect(await s.activeRowNo()).toBe('E001');
    expect(a?.index).toBe(24);
    // Only that cell is marked, in the whole Grid.
    expect((await s.allRows()).filter((r) => r.invalid).map((r) => r.no)).toEqual(['E001']);
    // Fixing the value clears the mark, and Save goes through.
    await page.keyboard.press('F2');
    await page.keyboard.press('Control+A');
    await page.keyboard.type('50000');
    await page.keyboard.press('Enter');
    await expect(cell).not.toHaveAttribute('data-invalid', '');
    await s.save.click();
    await expect(s.status).toHaveText('Saved 1 row');
  });

  test('Search is refused over unsaved edits', async ({ page }) => {
    await s.clickCell('E001', T.name);
    await page.keyboard.type('Unsaved');
    await page.keyboard.press('Enter');
    await s.keyword.fill('Quinn');
    await s.search.click();
    await expect(s.status).toHaveText('Save or revert your changes first');
    await expect(s.cell('E001', T.name)).toHaveText('Unsaved');
    await expect(s.grid).toHaveAttribute('aria-rowcount', '28');
    // After Revert the search runs.
    await s.revert.click();
    await s.search.click();
    await expect(s.status).toHaveText('Found 1 employees');
  });

  test('Save with an editor open saves that edit', async ({ page }) => {
    await s.clickCell('E001', T.name);
    await page.keyboard.type('Open Editor');
    await expect(s.editor).toHaveValue('Open Editor');
    await s.save.click();
    await expect(s.status).toHaveText('Saved 1 row');
    await expect(s.editor).toHaveCount(0);
    await expect(s.cell('E001', T.name)).toHaveText('Open Editor');
    await expect(s.cell('E001', T.status)).toHaveText('');
  });
});

test.describe('D1: selection', () => {
  test('the checkbox column toggles row selection and leaves row status alone', async ({ page }) => {
    const s = screen(page);
    await s.open();
    const box = (no: string) => s.cell(no, T.select).locator('[role="checkbox"]');
    await expect(box('E002')).toHaveAttribute('aria-checked', 'false');
    await box('E002').click();
    await expect(box('E002')).toHaveAttribute('aria-checked', 'true');
    await expect(s.row('E002')).toHaveAttribute('data-selected', '');
    await expect(s.cell('E002', T.status)).toHaveText('');
    await expect(s.row('E002')).toHaveAttribute('data-status', 'normal');
    await s.cell('E004', T.select).click();
    await expect(box('E004')).toHaveAttribute('aria-checked', 'true');
    // Keyboard: Space on the checkbox cell toggles it.
    await page.keyboard.press(' ');
    await expect(box('E004')).toHaveAttribute('aria-checked', 'false');
    await page.keyboard.press(' ');
    await expect(box('E004')).toHaveAttribute('aria-checked', 'true');
    // Nothing was changed, so there is nothing to save.
    await s.save.click();
    await expect(s.status).toHaveText('Nothing to save');
    // Selecting does not mark rows, and unticking works.
    await box('E002').click();
    await expect(box('E002')).toHaveAttribute('aria-checked', 'false');
    expect((await s.allRows()).filter((r) => r.mark !== '').length).toBe(0);
    // Delete row removes the ticked rows rather than the current one.
    await s.cell('E001', T.name).click();
    await s.del.click();
    await expect(s.status).toHaveText('Deleted 1 row. Save to apply');
    await expect(s.row('E004')).toHaveCount(0);
    await expect(s.row('E001')).toBeVisible();
  });
});

test.describe('D1: frozen columns and accessibility', () => {
  test('frozen columns stay in place on horizontal scroll, and nothing overlaps them', async ({ page }) => {
    const s = screen(page);
    await s.open();
    // Widen Department so the Grid has to scroll sideways.
    const handle = page.locator(`.fw-grid__resize[data-track="${T.dept}"]`);
    const box = await handle.boundingBox();
    if (!box) throw new Error('no resize handle');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 300, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    const max = await s.scroller.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(max).toBeGreaterThan(100);
    const sample = () =>
      page.evaluate(() => {
        const row = document.querySelector('.fw-grid__row[data-index="2"]') as HTMLElement;
        const cellOf = (t: number) => row.querySelector(`.fw-grid__cell[data-track="${t}"]`) as HTMLElement;
        const left = (el: Element | null) => el?.getBoundingClientRect().left ?? Number.NaN;
        const rect = cellOf(3).getBoundingClientRect();
        const top = document.elementFromPoint(rect.right - 5, rect.top + rect.height / 2)?.closest('.fw-grid__cell') as HTMLElement | null;
        const hdr = document.querySelector('.fw-grid__header .fw-grid__cell[data-frozen]');
        const ftr = document.querySelector('.fw-grid__footer .fw-grid__cell[data-frozen]');
        return {
          lefts: [0, 1, 2, 3].map((t) => left(cellOf(t))),
          hdr: left(hdr),
          ftr: left(ftr),
          dept: left(cellOf(4)),
          frozenRight: rect.right,
          topTrack: top?.dataset.track ?? null,
          scrollLeft: (document.querySelector('.fw-grid__scroller') as HTMLElement).scrollLeft,
        };
      });
    const start = await sample();
    for (const x of [Math.floor(max / 4), Math.floor(max / 2), max]) {
      await s.scroller.evaluate((el, x) => (el.scrollLeft = x), x);
      await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
      const now = await sample();
      expect(now.scrollLeft).toBeGreaterThan(0);
      expect(now.lefts).toEqual(start.lefts);
      expect(now.hdr).toBe(start.hdr);
      expect(now.ftr).toBe(start.ftr);
      expect(now.dept).toBeLessThan(start.dept);
      expect(now.topTrack, 'cell on top at the frozen block edge').toBe('3');
    }
    // Moving to the last column by keyboard keeps it clear of the frozen block.
    await s.cell('E003', T.name).click();
    await page.keyboard.press('End');
    await expect.poll(async () => (await activeCell(page))?.track).toBe(LAST);
    const clear = await s.cell('E003', T.hired).evaluate((el) => {
      const f = (el.closest('.fw-grid__row')?.querySelector('.fw-grid__cell[data-track="3"]') as HTMLElement).getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const sc = (el.closest('.fw-grid__scroller') as HTMLElement).getBoundingClientRect();
      return r.left >= f.right - 1 && r.right <= sc.right + 1;
    });
    expect(clear).toBe(true);
  });

  test('ARIA: role grid, a valid aria-activedescendant while scrolling, a named editor, and one tab stop', async ({ page }) => {
    const s = screen(page);
    await s.open();
    await expect(page.getByRole('grid')).toHaveCount(1);
    await expect(s.grid).toHaveAttribute('tabindex', '0');
    await expect(s.grid).toHaveAttribute('aria-colcount', '9');
    await expect(page.getByRole('row').first()).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Name' })).toBeVisible();
    await expect(page.getByRole('gridcell').first()).toBeVisible();

    // aria-activedescendant points at the active cell.
    await s.cell('E003', T.dept).click();
    const a = await activeCell(page);
    expect(a?.valid).toBe(true);
    expect(a?.text).toBe('Finance'.replace('Finance', DEPT_NAME[EMPS[2]?.dept ?? ''] ?? ''));
    await expect(s.cell('E003', T.dept)).toHaveAttribute('data-active', '');
    await expect(s.cell('E003', T.dept)).toHaveAttribute('id', a?.id ?? 'missing');
    // It stays valid while the Grid scrolls, even when the cell's row is far out of view.
    for (const top of [0, 100000, 150, 0]) {
      await s.scroller.evaluate((el, t) => (el.scrollTop = t), top);
      await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
      expect(await activeDescendantIsValid(page), `scrollTop ${top}`).toBe(true);
      expect(await s.activeRowNo()).toBe('E003');
    }
    // And while moving with the keys.
    for (let i = 0; i < 22; i++) await page.keyboard.press('ArrowDown');
    await expect.poll(() => s.activeRowNo()).toBe('E025');
    expect(await activeDescendantIsValid(page)).toBe(true);
    await s.scroller.evaluate((el) => (el.scrollTop = 0));
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    expect(await activeDescendantIsValid(page)).toBe(true);

    // The editor has an accessible name: the column header.
    await s.cell('E002', T.name).click();
    await page.keyboard.press('F2');
    await expect(page.getByRole('textbox', { name: 'Name', exact: true }).and(s.editor)).toBeVisible();
    await expect(s.editor).toHaveAttribute('aria-label', 'Name');
    await page.keyboard.press('Escape');
    await s.cell('E002', T.salary).click();
    await page.keyboard.press('F2');
    await expect(s.editor).toHaveAttribute('aria-label', 'Salary');
    await page.keyboard.press('Escape');

    // One tab stop: nothing inside the Grid except its root can take focus.
    expect(await s.grid.locator('[tabindex="0"], input, select, button, a[href]').count()).toBe(0);
    // Tab from the button before it enters once, and Shift+Tab at the first cell leaves again.
    await s.del.focus();
    await page.keyboard.press('Tab');
    await expect(s.grid).toBeFocused();
    expect(await activeDescendantIsValid(page)).toBe(true);
    await page.keyboard.press('Control+Home');
    await expect.poll(() => activePosition(page)).toEqual([0, 0]);
    await page.keyboard.press('Shift+Tab');
    await expect(s.del).toBeFocused();
    // And forwards: Tab walks the cells, and at the very end it leaves for the next control.
    await page.keyboard.press('Tab');
    await expect(s.grid).toBeFocused();
    await page.keyboard.press('Control+End');
    await expect.poll(() => activePosition(page)).toEqual([24, LAST]);
    await page.keyboard.press('Tab');
    await expect(s.save).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(s.revert).toBeFocused();
  });
});

for (const scheme of ['light', 'dark'] as const) {
  test(`full-page screenshot of the list screen, ${scheme}`, async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: scheme, viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const problems: string[] = [];
    await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));
    page.on('pageerror', (error) => problems.push(error.message));
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(m.text());
    });
    const s = screen(page);
    await s.open();
    // Show some state: an edit (U), a selected row, a sorted column.
    await s.clickCell('E002', T.name);
    await page.keyboard.type('Benjamin Hughes Jr');
    await page.keyboard.press('Enter');
    await s.cell('E004', T.select).click();
    await headerCell(page, 'Salary').click();
    mkdirSync(OUTPUT, { recursive: true });
    await page.screenshot({ path: join(OUTPUT, `grid-list-${scheme}.png`), fullPage: true });
    expect(problems).toEqual([]);
    await context.close();
  });
}
