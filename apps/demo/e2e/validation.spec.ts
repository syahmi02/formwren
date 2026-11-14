/**
 * Step 5 validation (decision 5, 6; FR-026): Save with a missing required value sends nothing, marks the field or cell,
 * and moves focus to it, on each of the three screens. Required inputs show a cue and `aria-required`.
 * Several tests here follow the review fixes of step 5 (the intended behaviour), and are marked as such.
 */
import type { Page } from '@playwright/test';
import { snapshot } from './p4-support.ts';
import { employeesOf, shellOf, watchService } from './shell-support.ts';
import { expect, test } from './support.ts';

const activeTrack = (page: Page): Promise<number | null> =>
  page.evaluate(() => {
    const root = document.activeElement?.closest('.fw-grid') ?? null;
    const id = root?.getAttribute('aria-activedescendant');
    const el = id ? document.getElementById(id) : null;
    return el ? Number((el as HTMLElement).dataset.track) : null;
  });

test.describe('Validation: Employees', () => {
  test('Save with a missing name sends nothing, marks the field and focuses it', async ({ page }) => {
    const e = employeesOf(page);
    const saves = watchService(page, 'hr.emp.save');
    await page.goto('/');
    await e.waitLoaded();
    const before = snapshot();
    await e.enter(e.name, '');
    await e.save.click();
    await expect(e.status).toHaveText(/^Not saved: /);
    await expect(e.name).toHaveAttribute('aria-invalid', 'true');
    await expect(e.name).toBeFocused();
    await expect(shellOf(page).active.getByText(/required/i).first()).toBeVisible();
    expect(saves.calls).toHaveLength(0);
    expect(snapshot()).toEqual(before);
    // Typing a name clears the mark, and the same Save goes through.
    await e.enter(e.name, 'Alicia Carter');
    await expect(e.name).not.toHaveAttribute('aria-invalid', 'true');
    await e.save.click();
    await expect(e.status).toHaveText('Saved 1 row');
    expect(saves.calls).toHaveLength(1);
  });

  test('required inputs show a cue and aria-required, and optional ones do not', async ({ page }) => {
    const e = employeesOf(page);
    await page.goto('/');
    await e.waitLoaded();
    await expect(e.name).toHaveAttribute('aria-required', 'true');
    await expect(e.salary).not.toHaveAttribute('aria-required', 'true');
    const cue = (id: string) =>
      page.evaluate((id) => {
        const label = document.querySelector(`.fw-shell__page:not([hidden]) [data-id="${id}"] label`);
        if (!label) return 'no label';
        return getComputedStyle(label, '::after').content;
      }, id);
    const required = await cue('nameInput');
    expect(required, 'the required label has a visible marker').not.toMatch(/^(none|normal|"")$/);
    expect(required).not.toBe('no label');
    expect(await cue('salaryInput')).toMatch(/^(none|normal|"")$/);
  });

  test('(review fix) text in a search box never blocks Save of a valid edit', async ({ page }) => {
    const e = employeesOf(page);
    await page.goto('/');
    await e.waitLoaded();
    // Longer than the 50 characters of the search column.
    await e.keyword.fill('x'.repeat(80));
    await e.keyword.press('Tab');
    await e.enter(e.name, 'Alicia Carter');
    await e.save.click();
    await expect(e.status).toHaveText('Saved 1 row');
  });

  test('(review fix) the invalid row is made current and its hidden page is shown, then the field is focused', async ({ page }) => {
    const e = employeesOf(page);
    const saves = watchService(page, 'hr.emp.save');
    await page.goto('/');
    await e.waitLoaded();
    await e.next.click();
    await e.next.click();
    await expect(e.rowInfo).toHaveText('Row 3 of 25');
    await e.enter(e.name, '');
    // Move to another row and to the other page of the form. The invalid name is now on a row and a page that are not showing.
    await e.previous.click();
    await shellOf(page).active.getByRole('tab', { name: 'Summary' }).click();
    await expect(e.name).toBeHidden();
    await e.save.click();
    await expect(e.status).toHaveText(/^Not saved: /);
    await expect(e.rowInfo).toHaveText('Row 3 of 25');
    await expect(shellOf(page).active.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true');
    await expect(e.name).toBeFocused();
    await expect(e.name).toHaveAttribute('aria-invalid', 'true');
    expect(saves.calls).toHaveLength(0);
  });
});

test.describe('Validation: Employee list', () => {
  test('Save with a new row that has no name sends nothing, marks the cell and focuses the Grid there', async ({ page }) => {
    const shell = shellOf(page);
    const saves = watchService(page, 'hr.emp.saveList');
    await page.goto('/#list');
    await expect(shell.active.getByText('Found 25 employees')).toBeVisible();
    const before = snapshot();
    await shell.active.getByRole('button', { name: 'Add row' }).click();
    await shell.active.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(shell.active.getByText(/^Not saved:/)).toBeVisible();
    await expect(shell.active.locator('.fw-grid__cell[data-invalid]')).toHaveCount(1);
    await expect(shell.active.getByRole('grid')).toBeFocused();
    expect(await activeTrack(page)).toBe(3);
    expect(saves.calls).toHaveLength(0);
    expect(snapshot()).toEqual(before);
  });

  test('a required column shows its cue in the Grid header or cell, and a cleared name is refused too', async ({ page }) => {
    const shell = shellOf(page);
    const saves = watchService(page, 'hr.emp.saveList');
    await page.goto('/#list');
    await expect(shell.active.getByText('Found 25 employees')).toBeVisible();
    const cell = shell.active.locator('.fw-grid__row[data-index="0"] .fw-grid__cell[data-track="3"]');
    await cell.click();
    await page.keyboard.press('F2');
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Enter');
    await shell.active.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(shell.active.getByText(/^Not saved:/)).toBeVisible();
    await expect(cell).toHaveAttribute('data-invalid', /.*/);
    expect(saves.calls).toHaveLength(0);
  });
});

test.describe('Validation: Departments', () => {
  test('Save with a department that has no name sends nothing, marks the cell and focuses the Grid', async ({ page }) => {
    const shell = shellOf(page);
    const saves = watchService(page, 'hr.dept.saveAll');
    await page.goto('/#dept');
    await expect(shell.active.getByText('5 departments')).toBeVisible();
    const before = snapshot();
    await shell.active.getByRole('button', { name: 'Add department' }).click();
    await page.keyboard.type('QA');
    await page.keyboard.press('Enter');
    await shell.active.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(shell.active.getByText(/^Not saved:/)).toBeVisible();
    const deptGrid = shell.active.getByRole('grid').nth(0);
    await expect(deptGrid.locator('.fw-grid__cell[data-invalid]')).toHaveCount(1);
    await expect(deptGrid).toBeFocused();
    expect(await activeTrack(page)).toBe(3);
    expect(saves.calls).toHaveLength(0);
    expect(snapshot()).toEqual(before);
  });

  test('Save with an employee that has no name sends nothing, marks the cell and the name input', async ({ page }) => {
    const shell = shellOf(page);
    const saves = watchService(page, 'hr.dept.saveAll');
    await page.goto('/#dept');
    await expect(shell.active.getByText('5 departments')).toBeVisible();
    await expect(shell.active.getByRole('button', { name: 'Add employee' })).toBeEnabled();
    const before = snapshot();
    await shell.active.getByRole('button', { name: 'Add employee' }).click();
    await shell.active.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(shell.active.getByText(/^Not saved:/)).toBeVisible();
    await expect(shell.active.getByRole('grid').nth(1).locator('.fw-grid__cell[data-invalid]')).toHaveCount(1);
    const name = shell.active.getByRole('textbox', { name: 'Name', exact: true });
    await expect(name).toBeFocused();
    await expect(name).toHaveAttribute('aria-required', 'true');
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(saves.calls).toHaveLength(0);
    expect(snapshot()).toEqual(before);
  });
});
