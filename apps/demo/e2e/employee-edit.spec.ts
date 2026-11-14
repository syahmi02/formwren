import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DsxRequest, DsxResponse } from '@fw/core';
import type { Locator, Page } from '@playwright/test';
import { fixtures } from '../src/fixtures.ts';
import { expect, test } from './support.ts';

const OUTPUT = join(import.meta.dirname, '.output');

// The fixture's own rows, so the expected values here come from the data and not from a copy of it.
const searchFixture = fixtures['hr.emp.search'];
if (typeof searchFixture !== 'function') throw new Error('hr.emp.search should be a function fixture');
const search = searchFixture({ datasets: { cond: { rows: [['']] } } } as unknown as DsxRequest) as DsxResponse;
const EMPLOYEES = search.datasets?.list?.rows as unknown[][];
const DEPARTMENTS: Record<string, string> = { ENG: 'Engineering', SAL: 'Sales', HR: 'Human Resources', FIN: 'Finance', OPS: 'Operations' };
const LEVELS: Record<string, string> = { A: 'Junior', B: 'Senior', C: 'Lead' };
const emp = (index: number) => {
  const row = EMPLOYEES[index] as [string, string, string, string, boolean, string, string];
  return { empNo: row[0], name: row[1], dept: row[2], level: row[3], active: row[4], salary: row[5], hiredOn: row[6] };
};

/** Sums six-place decimal text exactly, as micro-units. */
function totalOf(overrides: Record<number, string> = {}): string {
  let micro = 0n;
  EMPLOYEES.forEach((_, i) => {
    const [whole = '0', frac = ''] = (overrides[i] ?? emp(i).salary).split('.');
    micro += BigInt(whole + frac.padEnd(6, '0'));
  });
  const digits = micro.toString().padStart(7, '0');
  return `${digits.slice(0, -6)}.${digits.slice(-6)}`;
}

class Demo {
  readonly rowInfo: Locator;
  readonly status: Locator;
  readonly total: Locator;
  readonly name: Locator;
  readonly salary: Locator;
  readonly department: Locator;
  readonly active: Locator;
  readonly activeLabel: Locator;
  readonly next: Locator;
  readonly previous: Locator;
  readonly save: Locator;
  readonly revert: Locator;
  readonly search: Locator;
  readonly tabs: Locator;

  constructor(readonly page: Page) {
    this.rowInfo = page.getByText(/^Row \d+ of \d+$/);
    this.status = page.getByText(/^(Found|Saved|Changes reverted|Nothing to save|Not saved|Failed)/);
    this.total = page.getByText(/^Total salary: /);
    this.name = page.getByRole('textbox', { name: 'Name', exact: true });
    this.salary = page.getByRole('textbox', { name: 'Salary', exact: true });
    this.department = page.getByRole('combobox', { name: 'Department' });
    this.active = page.getByRole('checkbox', { name: 'Active' });
    // The box and text are what a user clicks. The input itself sits under the box.
    this.activeLabel = page.getByText('Active', { exact: true });
    this.next = page.getByRole('button', { name: 'Next' });
    this.previous = page.getByRole('button', { name: 'Previous' });
    this.save = page.getByRole('button', { name: 'Save' });
    this.revert = page.getByRole('button', { name: 'Revert' });
    this.search = page.getByRole('button', { name: 'Search' });
    this.tabs = page.getByRole('tablist', { name: 'Pages' });
  }

  async open(): Promise<void> {
    await this.page.goto('/');
    await expect(this.status).toHaveText('Found 25 employees');
  }

  /** Types into a text field the way a user does: click, select all, type, then Enter. */
  async enter(field: Locator, text: string): Promise<void> {
    await field.click();
    await field.press('Control+A');
    await field.pressSequentially(text);
    await field.press('Enter');
  }

  async expectRow(index: number): Promise<void> {
    const e = emp(index);
    await expect(this.rowInfo).toHaveText(`Row ${index + 1} of ${EMPLOYEES.length}`);
    await expect(this.name).toHaveValue(e.name);
    await expect(this.salary).toHaveValue(e.salary);
    await expect(this.department).toHaveValue(DEPARTMENTS[e.dept] as string);
    await expect(this.page.getByRole('radio', { name: LEVELS[e.level] as string, exact: true })).toBeChecked();
    if (e.active) await expect(this.active).toBeChecked();
    else await expect(this.active).not.toBeChecked();
    const [year, month, day] = e.hiredOn.split('-').map(Number);
    await expect(this.page.getByRole('spinbutton', { name: /^month/ })).toHaveText(String(month));
    await expect(this.page.getByRole('spinbutton', { name: /^day/ })).toHaveText(String(day));
    await expect(this.page.getByRole('spinbutton', { name: /^year/ })).toHaveText(String(year));
  }

  async saveAndExpect(message: string): Promise<void> {
    await this.save.click();
    await expect(this.status).toHaveText(message);
  }
}

test.describe('Employee edit', () => {
  let demo: Demo;
  test.beforeEach(async ({ page }) => {
    demo = new Demo(page);
    await demo.open();
  });

  test('search loads 25 employees and the row label reads correctly', async ({ page }) => {
    expect(EMPLOYEES).toHaveLength(25);
    await demo.expectRow(0);
    await expect(demo.previous).toBeDisabled();
    await expect(demo.next).toBeEnabled();
    // A search with a keyword reloads fewer rows.
    await page.getByRole('textbox', { name: 'Name contains' }).fill('an');
    await demo.search.click();
    const expected = EMPLOYEES.filter((row) => String(row[1]).toLowerCase().includes('an')).length;
    expect(expected).toBeGreaterThan(0);
    expect(expected).toBeLessThan(25);
    await expect(demo.status).toHaveText(`Found ${expected} employees`);
    await expect(demo.rowInfo).toHaveText(`Row 1 of ${expected}`);
  });

  test('Next and Previous move through the rows and the bound inputs follow', async () => {
    await demo.next.click();
    await demo.expectRow(1);
    await demo.next.click();
    await demo.expectRow(2);
    await demo.previous.click();
    await demo.expectRow(1);
    await demo.previous.click();
    await demo.expectRow(0);
    await expect(demo.previous).toBeDisabled();
    // Walk to the end: every row shows its own values, and Next is disabled on the last.
    for (let i = 1; i < EMPLOYEES.length; i++) {
      await demo.next.click();
      await demo.expectRow(i);
    }
    await expect(demo.next).toBeDisabled();
  });

  test('typing changes nothing until Enter or blur, and Esc restores', async () => {
    const original = emp(0).salary;
    const baseline = `Total salary: ${totalOf()}`;
    await expect(demo.total).toHaveText(baseline);

    // Typing alone: the field shows the draft, the model (seen through the total) is unchanged.
    await demo.salary.click();
    await demo.salary.press('Control+A');
    await demo.salary.pressSequentially('60000.5');
    await expect(demo.salary).toHaveValue('60000.5');
    await expect(demo.total).toHaveText(baseline);
    // Enter commits.
    await demo.salary.press('Enter');
    await expect(demo.total).toHaveText(`Total salary: ${totalOf({ 0: '60000.5' })}`);

    // Esc restores the bound value and commits nothing.
    await demo.salary.press('Control+A');
    await demo.salary.pressSequentially('1.25');
    await demo.salary.press('Escape');
    await expect(demo.salary).toHaveValue(/^60000\.5(0{0,5})$/);
    await demo.salary.press('Tab');
    await expect(demo.total).toHaveText(`Total salary: ${totalOf({ 0: '60000.5' })}`);

    // Blur commits too.
    await demo.salary.click();
    await demo.salary.press('Control+A');
    await demo.salary.pressSequentially(original);
    await expect(demo.total).toHaveText(`Total salary: ${totalOf({ 0: '60000.5' })}`);
    await demo.rowInfo.click();
    await expect(demo.total).toHaveText(baseline);
  });

  test('an edit makes the row updated, so Save sends exactly that row', async () => {
    await demo.enter(demo.name, 'Alicia Carter');
    await demo.next.click();
    await demo.expectRow(1);
    await demo.saveAndExpect('Saved 1 row');
    // Back on the first row the edit is still there, and Save has cleared the changes.
    await demo.previous.click();
    await expect(demo.name).toHaveValue('Alicia Carter');
    await demo.saveAndExpect('Nothing to save');
  });

  test('two edited rows are two rows to save; an edit put back is no change', async () => {
    await demo.enter(demo.name, 'Alicia Carter');
    await demo.next.click();
    await demo.enter(demo.name, 'Ben Hughes');
    await demo.next.click();
    await demo.enter(demo.name, 'Someone Else');
    await demo.enter(demo.name, emp(2).name);
    await demo.saveAndExpect('Saved 2 rows');
  });

  test('a long decimal salary stays exact through edit, display, navigation and the total', async () => {
    const exact = '12345678.123456';
    await demo.enter(demo.salary, exact);
    await expect(demo.salary).toHaveValue(exact);
    await demo.next.click();
    await demo.expectRow(1);
    await demo.previous.click();
    await expect(demo.salary).toHaveValue(exact);
    await demo.page.getByRole('tab', { name: 'Summary' }).click();
    await expect(demo.total).toHaveText(`Total salary: ${totalOf({ 0: exact })}`);
    await demo.saveAndExpect('Saved 1 row');
    await demo.page.getByRole('tab', { name: 'Details' }).click();
    await expect(demo.salary).toHaveValue(exact);
  });

  test('text that does not fit a number column stays on screen marked invalid', async () => {
    const baseline = `Total salary: ${totalOf()}`;
    await demo.enter(demo.salary, 'twelve');
    await expect(demo.salary).toHaveValue('twelve');
    await expect(demo.salary).toHaveAttribute('aria-invalid', 'true');
    await expect(demo.page.getByText("This value isn't valid")).toBeVisible();
    // It stays after leaving the field too, and the model is untouched.
    await demo.salary.press('Tab');
    await expect(demo.salary).toHaveValue('twelve');
    await expect(demo.salary).toHaveAttribute('aria-invalid', 'true');
    await expect(demo.total).toHaveText(baseline);
    await demo.saveAndExpect('Nothing to save');
    // Other text that is not a number is not a fit either.
    for (const text of ['1.2.3', '12,5', '1e5', '--4']) {
      await demo.enter(demo.salary, text);
      await expect(demo.salary, `"${text}" stays on screen`).toHaveValue(text);
      await expect(demo.salary, `"${text}" is marked invalid`).toHaveAttribute('aria-invalid', 'true');
    }
    // A good value clears the mark.
    await demo.enter(demo.salary, '100.5');
    await expect(demo.salary).not.toHaveAttribute('aria-invalid', 'true');
    await expect(demo.page.getByText("This value isn't valid")).toHaveCount(0);
  });

  test('a number with too many digits is stored, and Save refuses it with a message', async () => {
    await demo.enter(demo.salary, '123456789.5');
    await expect(demo.salary).not.toHaveAttribute('aria-invalid', 'true');
    await demo.save.click();
    await expect(demo.status).toHaveText(/^Not saved: /);
    await demo.enter(demo.salary, '100.5');
    await demo.saveAndExpect('Saved 1 row');
  });

  test('Esc on text that does not fit goes back to the bound value', async () => {
    await demo.enter(demo.salary, 'twelve');
    await expect(demo.salary).toHaveAttribute('aria-invalid', 'true');
    await demo.salary.press('Escape');
    await expect(demo.salary).toHaveValue(emp(0).salary);
    await expect(demo.salary).not.toHaveAttribute('aria-invalid', 'true');
  });

  test('Checkbox writes straight to the current row', async () => {
    await expect(demo.active).toBeChecked();
    await demo.activeLabel.click();
    await expect(demo.active).not.toBeChecked();
    await demo.next.click();
    await demo.previous.click();
    await expect(demo.active).not.toBeChecked();
    // Keyboard: Space toggles it back, which puts the row back to unchanged.
    await demo.active.focus();
    await demo.page.keyboard.press('Space');
    await expect(demo.active).toBeChecked();
    await demo.saveAndExpect('Nothing to save');
    await demo.activeLabel.click();
    await demo.saveAndExpect('Saved 1 row');
  });

  test('RadioGroup writes straight to the current row (mouse and keyboard)', async ({ page }) => {
    await expect(page.getByRole('radio', { name: 'Junior' })).toBeChecked();
    await page.getByText('Lead', { exact: true }).click();
    await expect(page.getByRole('radio', { name: 'Lead' })).toBeChecked();
    await demo.next.click();
    await demo.expectRow(1);
    await demo.previous.click();
    await expect(page.getByRole('radio', { name: 'Lead' })).toBeChecked();
    // Arrow keys move the selection and write it.
    await page.getByRole('radio', { name: 'Lead' }).focus();
    await page.keyboard.press('ArrowUp');
    await expect(page.getByRole('radio', { name: 'Senior' })).toBeChecked();
    await demo.saveAndExpect('Saved 1 row');
  });

  test('ComboBox writes straight to the current row (mouse)', async ({ page }) => {
    await expect(demo.department).toHaveValue('Engineering');
    await page.getByRole('button', { name: 'Show options Department' }).click();
    await page.getByRole('option', { name: 'Finance' }).click();
    await expect(demo.department).toHaveValue('Finance');
    await demo.next.click();
    await demo.previous.click();
    await expect(demo.department).toHaveValue('Finance');
    await demo.saveAndExpect('Saved 1 row');
  });

  test('ComboBox filters by typing and selects with the keyboard', async ({ page }) => {
    await demo.department.click();
    await demo.department.press('Control+A');
    await demo.department.pressSequentially('Hum');
    const options = page.getByRole('option');
    await expect(options).toHaveCount(1);
    await expect(page.getByRole('option', { name: 'Human Resources' })).toBeVisible();
    await demo.department.press('ArrowDown');
    await demo.department.press('Enter');
    await expect(demo.department).toHaveValue('Human Resources');
    await expect(page.getByRole('option')).toHaveCount(0);
    await demo.next.click();
    await demo.previous.click();
    await expect(demo.department).toHaveValue('Human Resources');
    await demo.saveAndExpect('Saved 1 row');
  });

  test('DatePicker takes a typed date and writes it to the current row', async ({ page }) => {
    const month = page.getByRole('spinbutton', { name: /^month/ });
    await month.click();
    await page.keyboard.type('03042020');
    await expect(month).toHaveText('3');
    await expect(page.getByRole('spinbutton', { name: /^day/ })).toHaveText('4');
    await expect(page.getByRole('spinbutton', { name: /^year/ })).toHaveText('2020');
    await demo.next.click();
    await demo.expectRow(1);
    await demo.previous.click();
    await expect(month).toHaveText('3');
    await expect(page.getByRole('spinbutton', { name: /^day/ })).toHaveText('4');
    await expect(page.getByRole('spinbutton', { name: /^year/ })).toHaveText('2020');
    await demo.saveAndExpect('Saved 1 row');
  });

  test('the total label stays exact after edits', async () => {
    await demo.page.getByRole('tab', { name: 'Summary' }).click();
    await expect(demo.total).toHaveText(`Total salary: ${totalOf()}`);
    await demo.page.getByRole('tab', { name: 'Details' }).click();
    await demo.enter(demo.salary, '0.000001');
    await demo.next.click();
    await demo.enter(demo.salary, '99999999.999999');
    await demo.next.click();
    await demo.enter(demo.salary, '10');
    await demo.page.getByRole('tab', { name: 'Summary' }).click();
    await expect(demo.total).toHaveText(`Total salary: ${totalOf({ 0: '0.000001', 1: '99999999.999999', 2: '10' })}`);
  });

  test('Save reports the row count and clears changes; Revert restores the loaded values', async ({ page }) => {
    await demo.saveAndExpect('Nothing to save');
    await demo.enter(demo.name, 'Changed Name');
    await demo.enter(demo.salary, '1.5');
    await demo.next.click();
    await page.getByText('Senior', { exact: true }).first().click();
    await demo.revert.click();
    await expect(demo.status).toHaveText('Changes reverted');
    await demo.expectRow(1);
    await demo.previous.click();
    await demo.expectRow(0);
    await demo.saveAndExpect('Nothing to save');
    await page.getByRole('tab', { name: 'Summary' }).click();
    await expect(demo.total).toHaveText(`Total salary: ${totalOf()}`);
    await page.getByRole('tab', { name: 'Details' }).click();

    await demo.enter(demo.name, 'Changed Again');
    await demo.saveAndExpect('Saved 1 row');
    await demo.revert.click();
    // Saved changes are the new baseline, so Revert keeps them.
    await expect(demo.name).toHaveValue('Changed Again');
  });

  test('arrow keys move between tabs, and hidden pages keep their values', async ({ page }) => {
    const details = page.getByRole('tab', { name: 'Details' });
    const summary = page.getByRole('tab', { name: 'Summary' });
    await details.focus();
    await page.keyboard.press('ArrowRight');
    await expect(summary).toBeFocused();
    await expect(summary).toHaveAttribute('aria-selected', 'true');
    await expect(demo.total).toBeVisible();
    await expect(demo.name).toBeHidden();
    await page.keyboard.press('ArrowRight');
    await expect(details).toBeFocused();
    await expect(details).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowLeft');
    await expect(summary).toBeFocused();
    await page.keyboard.press('Home');
    await expect(details).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('End');
    await expect(summary).toHaveAttribute('aria-selected', 'true');

    // Change something while Summary is showing (the Details page is hidden), then come back.
    await demo.next.click();
    await expect(demo.name).toBeHidden();
    await page.keyboard.press('Home');
    await details.click();
    await demo.expectRow(1);
    await demo.enter(demo.name, 'Kept Value');
    await summary.click();
    await demo.previous.click();
    await demo.next.click();
    await details.click();
    await expect(demo.name).toHaveValue('Kept Value');
    await expect(demo.salary).toHaveValue(emp(1).salary);
  });

  test('keyboard only: Tab reaches every control in a sensible order, with a visible focus', async ({ page }) => {
    // The accessible name of whatever has focus, from the browser's own accessibility tree.
    const focused = async () => {
      const snapshot = await page.locator(':focus').ariaSnapshot();
      return snapshot.split('\n')[0]?.replace(/^- /, '').replace(/ \[.*\]$/, '').replace(/:.*$/, '') ?? '';
    };
    const visibleFocus = () =>
      page.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        const mark = el.closest('[data-focus-visible="true"]');
        const style = getComputedStyle(el);
        const outline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
        return { mark: mark !== null, outline, focusVisible: el.matches(':focus-visible') };
      });

    const seen: string[] = [];
    // The shell adds three menu buttons and the tab strip before the form. The cap is only a stop for a runaway loop.
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      if ((await page.evaluate(() => document.activeElement?.tagName)) === 'BODY') break;
      const name = await focused();
      seen.push(name);
      const focus = await visibleFocus();
      expect(focus.mark || focus.outline, `focus is visible on ${name}`).toBe(true);
      expect(focus.focusVisible, `:focus-visible on ${name}`).toBe(true);
    }
    test.info().annotations.push({ type: 'tab order', description: seen.join(' > ') });
    expect(seen).toEqual([
      // The shell: the menu, then the one open tab (the strip is a single Tab stop).
      'button "Employees"',
      'button "Employee list"',
      'button "Departments"',
      'tab "Employees"',
      // The form: Previous is disabled, so it is skipped.
      'textbox "Name contains"',
      'button "Search"',
      'textbox "Find employee"',
      'button "..."',
      'button "Next"',
      'tab "Details"',
      'textbox "Name"',
      'textbox "Salary"',
      'spinbutton "month, Hired on"',
      'spinbutton "day, Hired on"',
      'spinbutton "year, Hired on"',
      'button "Open calendar Hired on"',
      'combobox "Department"',
      'radio "Junior"',
      'checkbox "Active"',
      'button "Save"',
      'button "Revert"',
    ]);
  });

  test('Enter in the keyword field is a way to search without the mouse', async ({ page }) => {
    const keyword = page.getByRole('textbox', { name: 'Name contains' });
    await keyword.fill('Quinn');
    await keyword.press('Enter');
    // The keyword field commits on Enter, and its change event runs the search.
    await expect(demo.status).toHaveText('Found 1 employees');
    await expect(demo.rowInfo).toHaveText('Row 1 of 1');
  });
});

for (const scheme of ['light', 'dark'] as const) {
  test(`full-page screenshot, ${scheme}`, async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: scheme, viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const problems: string[] = [];
    await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));
    page.on('pageerror', (error) => problems.push(error.message));
    page.on('console', (message) => message.type() === 'error' && problems.push(message.text()));
    const demo = new Demo(page);
    await demo.open();
    await demo.next.click();
    await demo.expectRow(1);
    mkdirSync(OUTPUT, { recursive: true });
    await page.screenshot({ path: join(OUTPUT, `employee-edit-${scheme}.png`), fullPage: true });
    const background = await page.evaluate(() => getComputedStyle(document.querySelector('.fw-form') as Element).backgroundColor);
    test.info().annotations.push({ type: 'form background', description: background });
    expect(problems).toEqual([]);
    await context.close();
    // The two schemes must really differ.
    const expectedLight = scheme === 'light';
    const [r, g, b] = (background.match(/\d+/g) ?? []).map(Number) as [number, number, number];
    const luminance = (r + g + b) / 3;
    expect(expectedLight ? luminance > 128 : luminance < 128, `form background ${background} suits ${scheme}`).toBe(true);
  });
}
