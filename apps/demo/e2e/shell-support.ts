/**
 * Locators and helpers for the step 5 specs (shell, lookup and validation). The demo runs inside the shell, so every screen
 * is a page of it, and the pages of tabs that aren't active stay mounted but hidden. A locator that names a role only finds
 * what is visible, so "the active page" is the scope the specs work in.
 */
import type { Locator, Page } from '@playwright/test';
import { expect } from './support.ts';

export const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

export type ScreenTitle = 'Employees' | 'Employee list' | 'Departments';

export function shellOf(page: Page) {
  const menu = page.getByRole('navigation', { name: 'Menu' });
  const strip = page.getByRole('tablist', { name: 'Open screens' });
  const active = page.locator('.fw-shell__page:not([hidden])');
  return {
    menu,
    strip,
    active,
    pages: page.locator('.fw-shell__page'),
    tabs: strip.getByRole('tab'),
    /** The menu button of a screen. */
    item: (title: ScreenTitle): Locator => menu.getByRole('button', { name: title, exact: true }),
    /** The shell's tab for a screen (not the form's own Details and Summary tabs). */
    tab: (title: ScreenTitle): Locator => strip.getByRole('tab', { name: title, exact: true }),
    closeButton: (title: ScreenTitle): Locator => page.getByRole('button', { name: `Close ${title}`, exact: true }),
    confirm: page.getByRole('alertdialog', { name: 'Confirm' }),
    errorDialog: page.getByRole('alertdialog', { name: 'Something went wrong' }),
    busy: page.locator('.fw-shell__busy'),
    /** The titles of the open tabs, left to right. */
    async titles(): Promise<string[]> {
      return strip.getByRole('tab').allTextContents();
    },
    /** Opens a screen from the menu and waits until its tab is the selected one. */
    async open(title: ScreenTitle): Promise<void> {
      await this.item(title).click();
      await expect(this.tab(title)).toHaveAttribute('aria-selected', 'true');
    },
  };
}

/** The Employees screen (the edit screen with the "Find employee" field), as seen in the active page. */
export function employeesOf(page: Page) {
  const active = shellOf(page).active;
  return {
    status: active.locator('[data-id="statusLabel"]'),
    rowInfo: active.getByText(/^Row \d+ of \d+$/),
    keyword: active.getByRole('textbox', { name: 'Name contains' }),
    search: active.getByRole('button', { name: 'Search', exact: true }),
    name: active.getByRole('textbox', { name: 'Name', exact: true }),
    salary: active.getByRole('textbox', { name: 'Salary', exact: true }),
    find: active.getByRole('textbox', { name: 'Find employee' }),
    findButton: active.getByRole('button', { name: '...', exact: true }),
    /** The label next to the field that shows the chosen employee's name. */
    found: active.locator('[data-id="pickNameLabel"] .fw-label'),
    next: active.getByRole('button', { name: 'Next', exact: true }),
    previous: active.getByRole('button', { name: 'Previous', exact: true }),
    save: active.getByRole('button', { name: 'Save', exact: true }),
    revert: active.getByRole('button', { name: 'Revert', exact: true }),
    async waitLoaded(): Promise<void> {
      await expect(active.getByText('Found 25 employees')).toBeVisible();
    },
    /** Types into a text field the way a user does: click, select all, type, then Enter. */
    async enter(field: Locator, text: string): Promise<void> {
      await field.click();
      await field.press('Control+A');
      if (text === '') await field.press('Backspace');
      else await field.pressSequentially(text);
      await field.press('Enter');
    },
  };
}

/** The lookup popup: a modal dialog titled "Find employee" that holds a form. */
export function lookupOf(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Find employee' });
  return {
    dialog,
    keyword: dialog.getByRole('textbox', { name: 'Number starts with, or name contains' }),
    search: dialog.getByRole('button', { name: 'Search', exact: true }),
    ok: dialog.getByRole('button', { name: 'OK', exact: true }),
    cancel: dialog.getByRole('button', { name: 'Cancel', exact: true }),
    close: dialog.getByRole('button', { name: 'Close Find employee', exact: true }),
    grid: dialog.getByRole('grid'),
    status: dialog.locator('[data-id="statusLabel"]'),
    /** The cell with this employee number. */
    row: (empNo: string): Locator => dialog.locator(`.fw-grid__row:has(.fw-grid__cell:text-is("${empNo}"))`),
    cell: (empNo: string, track: number): Locator => dialog.locator(`.fw-grid__row:has(.fw-grid__cell:text-is("${empNo}")) .fw-grid__cell[data-track="${track}"]`),
    rows: dialog.locator('.fw-grid__row[data-row-id]'),
  };
}

/** Counts the requests that go to one service, so a test can say "nothing was sent". */
export function watchService(page: Page, service: string): { readonly calls: string[] } {
  const calls: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes(`/dsx/v1/tx/${service}`)) calls.push(request.postData() ?? '');
  });
  return { calls };
}
