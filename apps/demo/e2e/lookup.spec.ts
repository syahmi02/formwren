/**
 * Journey D3 (REQUIREMENTS section 2) and the popup rules of step 5: the "Find employee" field on the Employees screen
 * and the lookup popup it opens, against the real server. A unique match fills the field with no popup; anything
 * else opens the popup, which is modal, returns `{ empNo, empName }` and leaves the opener alone when cancelled.
 */
import type { DsxRequest, DsxResponse } from '@fw/core';
import type { Page } from '@playwright/test';
import { fixtures } from '../src/fixtures.ts';
import { employeesOf, lookupOf, shellOf, sleep, watchService } from './shell-support.ts';
import { expect, test } from './support.ts';

// The seeded employees, from the fixture's own rows, so the expected names come from the data and not from a copy of it.
const searchFixture = fixtures['hr.emp.search'];
if (typeof searchFixture !== 'function') throw new Error('hr.emp.search should be a function fixture');
const ROWS = ((searchFixture({ datasets: { cond: { rows: [['']] } } } as unknown as DsxRequest) as DsxResponse).datasets?.list?.rows ?? []) as string[][];
const nameOf = (empNo: string): string => {
  const row = ROWS.find((r) => r[0] === empNo);
  if (!row) throw new Error(`No employee ${empNo}`);
  return row[1] as string;
};
const E02 = ['E020', 'E021', 'E022', 'E023', 'E024', 'E025'];
const TRACK = { empNo: 0, empName: 1, dept: 2 } as const;

/** The popup's cell for an employee number, and the track the number is in. */
test.describe('D3: lookup popup', () => {
  let page: Page;
  const emp = (p: Page) => employeesOf(p);
  const lookup = (p: Page) => lookupOf(p);

  test.beforeEach(async ({ page: current }) => {
    page = current;
    await page.goto('/');
    await emp(page).waitLoaded();
  });

  /** What the screen shows once an employee is settled on: the field, the name beside it and the row they are on. */
  async function expectSettled(empNo: string): Promise<void> {
    const e = emp(page);
    await expect(e.find).toHaveValue(empNo);
    await expect(e.found).toHaveText(nameOf(empNo));
    await expect(e.name).toHaveValue(nameOf(empNo));
    await expect(e.rowInfo).toHaveText(`Row ${Number(empNo.slice(1))} of 25`);
    await expect(e.status).toHaveText(`${nameOf(empNo)} (${empNo})`);
  }

  async function openFromTyping(text: string): Promise<void> {
    const e = emp(page);
    await e.find.click();
    await e.find.press('Control+A');
    await e.find.pressSequentially(text);
    await e.find.press('Enter');
    await expect(lookup(page).dialog).toBeVisible();
    await expect(lookup(page).status).not.toHaveText('');
  }

  test('a number typed in full fills code and name with no popup, in any case', async () => {
    const e = emp(page);
    const lookups = watchService(page, 'hr.emp.lookup');
    await e.enter(e.find, 'E007');
    await expectSettled('E007');
    expect(lookups.calls).toHaveLength(1);
    await e.enter(e.find, 'e012');
    await expectSettled('E012');
    // Leaving the field with Tab does the same as Enter.
    await e.find.click();
    await e.find.press('Control+A');
    await e.find.pressSequentially('E003');
    await e.find.press('Tab');
    await expectSettled('E003');
    await expect(lookup(page).dialog).toHaveCount(0);
  });

  test('a part of a name that matches one employee fills code and name with no popup', async () => {
    const e = emp(page);
    await e.enter(e.find, 'quinn');
    await expectSettled('E017');
    await expect(lookup(page).dialog).toHaveCount(0);
    // Text around it is ignored.
    await e.enter(e.find, '  Xavier  ');
    await expectSettled('E024');
    await expect(lookup(page).dialog).toHaveCount(0);
  });

  test('a code that matches several opens the popup with that search', async () => {
    const l = lookup(page);
    await openFromTyping('E02');
    await expect(l.keyword).toHaveValue('E02');
    await expect(l.status).toHaveText('6 employees');
    await expect(l.rows).toHaveCount(6);
    for (const empNo of E02) await expect(l.cell(empNo, TRACK.empName)).toHaveText(nameOf(empNo));
    // The popup puts the cursor in its own search box.
    await expect(l.keyword).toBeFocused();
    // It is a search like any other: a narrower one narrows the rows.
    await l.keyword.fill('E022');
    await l.keyword.press('Enter');
    await expect(l.status).toHaveText('1 employee');
    await expect(l.rows).toHaveCount(1);
    await l.keyword.fill('an');
    await l.search.click();
    const expected = ROWS.filter((row) => (row[1] ?? '').toLowerCase().includes('an') || (row[0] ?? '').toLowerCase().startsWith('an')).length;
    await expect(l.status).toHaveText(`${expected} employees`);
  });

  test('a name that matches several opens the popup too, and the button opens it with no text', async () => {
    const e = emp(page);
    const l = lookup(page);
    await openFromTyping('an');
    await expect(l.keyword).toHaveValue('an');
    await page.keyboard.press('Escape');
    await expect(l.dialog).toHaveCount(0);
    await e.findButton.click();
    await expect(l.dialog).toBeVisible();
    await expect(l.keyword).toHaveValue('');
    await expect(l.status).toHaveText('25 employees');
    await expect(l.ok).toBeEnabled();
  });

  test('double-clicking a row fills both fields', async () => {
    const l = lookup(page);
    await openFromTyping('E02');
    await l.cell('E023', TRACK.empName).dblclick();
    await expect(l.dialog).toHaveCount(0);
    await expectSettled('E023');
  });

  test('Enter on a row fills both fields', async () => {
    const l = lookup(page);
    await openFromTyping('E02');
    await l.cell('E024', TRACK.empName).click();
    await expect(l.dialog).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(l.dialog).toHaveCount(0);
    await expectSettled('E024');
  });

  test('the keyboard alone can pick: arrow to a row, then Enter', async () => {
    const l = lookup(page);
    await openFromTyping('E02');
    await l.cell('E020', TRACK.empName).click();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(l.dialog).toHaveCount(0);
    await expectSettled('E022');
  });

  test('OK fills both fields from the current row', async () => {
    const l = lookup(page);
    await openFromTyping('E02');
    await l.cell('E022', TRACK.empName).click();
    await l.ok.click();
    await expect(l.dialog).toHaveCount(0);
    await expectSettled('E022');
    // With no click in the list, OK takes the row the list starts on.
    await openFromTyping('E02');
    await l.ok.click();
    await expect(l.dialog).toHaveCount(0);
    await expectSettled('E020');
  });

  test('Cancel, the close button and Esc leave the field and the screen as they were', async () => {
    const e = emp(page);
    const l = lookup(page);
    await e.enter(e.find, 'E005');
    await expectSettled('E005');

    await openFromTyping('E02');
    await l.cancel.click();
    await expect(l.dialog).toHaveCount(0);
    await expectSettled('E005');

    await openFromTyping('E02');
    await page.keyboard.press('Escape');
    await expect(l.dialog).toHaveCount(0);
    await expectSettled('E005');

    await openFromTyping('E02');
    await l.close.click();
    await expect(l.dialog).toHaveCount(0);
    await expectSettled('E005');

    // The same with a lookup that was started from an empty field: it goes back to empty.
    await e.enter(e.find, '');
    await expect(e.find).toHaveValue('');
    await expect(e.found).toHaveText('');
    await openFromTyping('zz');
    await page.keyboard.press('Escape');
    await expect(l.dialog).toHaveCount(0);
    await expect(e.find).toHaveValue('');
    await expect(e.found).toHaveText('');
    await expect(e.rowInfo).toHaveText('Row 5 of 25');
  });

  test('focus returns to the opener after the popup closes, however it closes', async () => {
    const e = emp(page);
    const l = lookup(page);
    // Opened with the button.
    for (const how of ['Escape', 'Cancel', 'Close', 'Double-click', 'OK']) {
      await e.findButton.click();
      await expect(l.dialog).toBeVisible();
      await expect(l.rows.first()).toBeVisible();
      if (how === 'Escape') await page.keyboard.press('Escape');
      if (how === 'Cancel') await l.cancel.click();
      if (how === 'Close') await l.close.click();
      if (how === 'Double-click') await l.cell('E004', TRACK.empName).dblclick();
      if (how === 'OK') {
        await l.cell('E006', TRACK.empName).click();
        await l.ok.click();
      }
      await expect(l.dialog).toHaveCount(0);
      await expect(e.findButton, `focus is back on the button after ${how}`).toBeFocused();
    }
    // Opened by typing in the field and pressing Enter: it goes back to the field.
    await openFromTyping('E01');
    await page.keyboard.press('Escape');
    await expect(l.dialog).toHaveCount(0);
    await expect(e.find).toBeFocused();
    await openFromTyping('E01');
    await l.cell('E014', TRACK.empName).dblclick();
    await expect(l.dialog).toHaveCount(0);
    await expect(e.find).toBeFocused();
  });

  test('only the popup is interactive while it is open', async () => {
    const e = emp(page);
    const l = lookup(page);
    const shell = shellOf(page);
    // Where the opener's Next button is, to click there later.
    const next = await e.next.boundingBox();
    const menuItem = await shell.item('Departments').boundingBox();
    if (!next || !menuItem) throw new Error('the opener has no boxes');
    await e.findButton.click();
    await expect(l.dialog).toBeVisible();
    await expect(l.rows.first()).toBeVisible();

    // The screen under the popup is taken out of reach: inert (or aria-hidden), which also removes it from assistive technology.
    // Playwright's role queries do not look at `inert`, so the attribute is read from the page.
    const outOfReach = (selector: string) =>
      page.evaluate((sel) => document.querySelector(sel)?.closest('[inert], [aria-hidden="true"]') !== null, selector);
    expect(await outOfReach('[data-id="nextButton"]'), 'the opener form is out of reach').toBe(true);
    expect(await outOfReach('.fw-shell__menu'), 'the menu is out of reach').toBe(true);
    expect(await outOfReach('.fw-shell__tabs'), 'the tab strip is out of reach').toBe(true);
    expect(await outOfReach('.fw-shell__popup'), 'the popup itself is reachable').toBe(false);

    // Not reachable with the mouse: a click on the opener's button, on the menu or beside the popup does nothing.
    await page.mouse.click(next.x + next.width / 2, next.y + next.height / 2);
    await page.mouse.click(menuItem.x + menuItem.width / 2, menuItem.y + menuItem.height / 2);
    await page.mouse.click(5, 5);
    await expect(l.dialog).toBeVisible();

    // Not reachable with the keyboard: Tab goes around inside the popup.
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null), `Tab stop ${i + 1} is in the popup`).toBe(true);
    }
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Shift+Tab');
      expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null), `Shift+Tab stop ${i + 1} is in the popup`).toBe(true);
    }
    // Typing goes into the popup.
    await l.keyword.click();
    await page.keyboard.type('Quinn');
    await expect(l.keyword).toHaveValue('Quinn');
    // Enter commits the text and searches. (Esc in a field with a draft first puts the draft back, as in every input; the next Esc closes.)
    await page.keyboard.press('Enter');
    await expect(l.status).toHaveText('1 employee');

    await page.keyboard.press('Escape');
    await expect(l.dialog).toHaveCount(0);
    // Nothing the clicks aimed at happened, and the opener works again.
    await expect(e.rowInfo).toHaveText('Row 1 of 25');
    await expect(e.keyword).toHaveValue('');
    expect(await shell.titles()).toEqual(['Employees']);
    await e.next.click();
    await expect(e.rowInfo).toHaveText('Row 2 of 25');
  });

  test('with no match the popup says so, and OK has nothing to take', async () => {
    const e = emp(page);
    const l = lookup(page);
    await openFromTyping('zzzz');
    await expect(l.status).toHaveText('No employee matches');
    await expect(l.rows).toHaveCount(0);
    await expect(l.ok).toBeDisabled();
    // A new search from inside the popup can find someone, and the popup then closes with them.
    await l.keyword.fill('Samuel');
    await l.keyword.press('Enter');
    await expect(l.status).toHaveText('1 employee');
    await l.cell('E019', TRACK.empName).dblclick();
    await expect(l.dialog).toHaveCount(0);
    await expectSettled('E019');
    // And back to nothing found.
    await openFromTyping('qqq');
    await expect(l.status).toHaveText('No employee matches');
    await page.keyboard.press('Escape');
    await expect(l.dialog).toHaveCount(0);
    await expectSettled('E019');
    await expect(e.find).toBeFocused();
  });

  test("the popup's own form state does not leak into the opener", async () => {
    const e = emp(page);
    const l = lookup(page);
    // The opener and the popup both have a Dataset called dsCond, a keyword and dsEmp rows.
    await e.keyword.fill('Quinn');
    await e.keyword.press('Tab');
    await e.enter(e.name, 'Alicia Carter');
    await expect(e.rowInfo).toHaveText('Row 1 of 25');

    await e.findButton.click();
    await expect(l.dialog).toBeVisible();
    // The popup starts from its own empty search and the full list, whatever the opener's search holds.
    await expect(l.keyword).toHaveValue('');
    await expect(l.status).toHaveText('25 employees');
    await l.keyword.fill('zz');
    await l.keyword.press('Enter');
    await expect(l.status).toHaveText('No employee matches');
    await page.keyboard.press('Escape');
    await expect(l.dialog).toHaveCount(0);

    // The opener kept its own search text, its 25 rows and its unsaved edit.
    await expect(e.keyword).toHaveValue('Quinn');
    await expect(e.rowInfo).toHaveText('Row 1 of 25');
    await expect(e.name).toHaveValue('Alicia Carter');
    await e.next.click();
    await expect(e.rowInfo).toHaveText('Row 2 of 25');
    await e.previous.click();

    // A second popup starts from scratch too: not from where the first one ended.
    await e.findButton.click();
    await expect(l.dialog).toBeVisible();
    await expect(l.keyword).toHaveValue('');
    await expect(l.status).toHaveText('25 employees');
    await l.cell('E009', TRACK.empName).dblclick();
    await expect(l.dialog).toHaveCount(0);
    await expectSettled('E009');

    // Choosing someone moved the opener's current row, and the edit on the first row is still there and still the only change.
    await e.previous.click();
    await expect.poll(async () => (await e.rowInfo.textContent()) ?? '').toMatch(/^Row \d+ of 25$/);
    await e.search.click();
    await expect(e.status).toHaveText('Save or revert your changes first');
    await sleep(100);
    const saves = watchService(page, 'hr.emp.save');
    await e.save.click();
    await expect(e.status).toHaveText('Saved 1 row');
    expect(saves.calls).toHaveLength(1);
  });

  test('(review fix) the screen is out of reach the moment the popup starts to open, with a loading message', async () => {
    const e = emp(page);
    const l = lookup(page);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((done) => (release = done));
    await page.route('**/dsx/v1/tx/hr.emp.lookup', async (route) => {
      await gate;
      await route.continue();
    });
    const next = await e.next.boundingBox();
    if (!next) throw new Error('no box');
    await e.findButton.click();
    // The popup's own answer is held back, so this is the time between the click and the popup being ready.
    const outOfReach = await page.evaluate(() => document.querySelector('[data-id="nextButton"]')?.closest('[inert], [aria-hidden="true"]') !== null);
    expect(outOfReach, 'the opener is out of reach while the popup loads').toBe(true);
    await expect(page.getByText(/Loading/).first()).toBeVisible();
    await page.mouse.click(next.x + next.width / 2, next.y + next.height / 2);
    release();
    await expect(l.dialog).toBeVisible();
    await expect(l.rows.first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(l.dialog).toHaveCount(0);
    await expect(e.rowInfo).toHaveText('Row 1 of 25');
  });

  test('(review fix) a late answer for text the user has since changed is ignored', async () => {
    const e = emp(page);
    const l = lookup(page);
    let calls = 0;
    await page.route('**/dsx/v1/tx/hr.emp.lookup', async (route) => {
      calls++;
      // The first answer (for E02, which would open the popup) is slow. The second is the server's normal one.
      if (calls === 1) await sleep(1500);
      await route.continue();
    });
    await e.find.click();
    await e.find.pressSequentially('E02');
    await e.find.press('Enter');
    // The user changes their mind before the answer arrives.
    await e.find.press('Control+A');
    await e.find.pressSequentially('Quinn');
    await e.find.press('Enter');
    await sleep(2500);
    await expect(l.dialog).toHaveCount(0);
    await expectSettled('E017');
  });

  test('the popup opens in front of any tab of the shell and leaves the other tabs alone', async () => {
    const e = emp(page);
    const l = lookup(page);
    const shell = shellOf(page);
    await shell.open('Departments');
    await expect(shell.active.getByText('5 departments')).toBeVisible();
    await shell.open('Employees');
    await e.findButton.click();
    await expect(l.dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(l.dialog).toHaveCount(0);
    await shell.open('Departments');
    // The departments screen kept its own rows, which a popup with an `dsEmp` of its own must not have replaced.
    await expect(shell.active.getByRole('grid')).toHaveCount(2);
    await expect(shell.active.getByText('5 departments')).toBeVisible();
  });
});
