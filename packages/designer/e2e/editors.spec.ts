/** The Dataset editor and the Grid columns editor. Every result text must still pass `fw check`. */
import type { Page } from '@playwright/test';
import { checkErrors, fwCheck, playground, withoutHandlers } from './forms.ts';
import { expect, hostApplied, hostParsed, nodeOf, type FormNode, hostText, hostUndo, inspector, lineDiff, openDesigner, selectOnCanvas, settled, showDiff, showTab, test } from './support.ts';

const datasetsPanel = (page: Page) => page.getByRole('region', { name: 'Datasets' });
const gridPanel = (page: Page) => inspector(page).getByRole('region', { name: 'Grid columns' });

async function commit(page: Page, label: string, value: string, scope = datasetsPanel(page)): Promise<void> {
  const field = scope.getByLabel(label, { exact: true });
  await field.fill(value);
  await field.press('Enter');
  await settled(page);
}

async function expectValid(page: Page, what: string): Promise<void> {
  expect(await checkErrors(page, await hostText(page)), `the text must pass fw check after: ${what}`).toEqual([]);
}

const gridProps = async (page: Page): Promise<NonNullable<FormNode['props']>> => (await nodeOf(page, 'grid')).props ?? {};

test.describe('Dataset editor', () => {
  test('lists the Datasets and shows the columns, their types and the sample rows', async ({ page }) => {
    await openDesigner(page, { text: await playground(page) });
    await showTab(page, 'Datasets');
    const panel = datasetsPanel(page);
    await expect(panel.getByLabel('Dataset', { exact: true })).toHaveValue('dsA');
    await expect(panel.getByLabel('name id', { exact: true })).toHaveValue('name');
    await expect(panel.getByLabel('qty type', { exact: true })).toHaveValue('int');
    await expect(panel.getByLabel('Row 1, name', { exact: true })).toHaveValue('Apple');
    await expect(panel.getByLabel('Row 1, qty', { exact: true })).toHaveValue('3');
  });

  test('renaming a column updates the bindings and the Grid cells in the text, in one undo step', async ({ page }) => {
    const original = await playground(page);
    await openDesigner(page, { text: original });
    await showTab(page, 'Datasets');
    await commit(page, 'name id', 'title');
    const text = await hostText(page);
    const form = JSON.parse(text);
    expect(form.datasets[0].columns[0].id).toBe('title');
    expect(form.datasets[0].sampleRows[0]).toEqual({ title: 'Apple', qty: 3 });
    const input = form.components.find((c: { id: string }) => c.id === 'nameInput');
    expect(input.bind.value).toBe('dsA.title');
    const grid = form.components.find((c: { id: string }) => c.id === 'grid');
    expect(grid.props.recordRows[0].cells[0].field).toBe('title');
    await expectValid(page, 'rename column');
    // Only the lines that name the column changed.
    const diff = lineDiff(original, text);
    expect(diff.removed.length, showDiff(diff)).toBeLessThanOrEqual(6);
    expect(await hostApplied(page)).toHaveLength(1);
    await hostUndo(page);
    expect(await hostText(page)).toBe(original);
  });

  test('renaming a column keeps the order of the keys in the sample rows, so only the key text changes', async ({ page }) => {
    await openDesigner(page, { text: await playground(page) });
    await showTab(page, 'Datasets');
    await commit(page, 'name id', 'title');
    const row = (await hostParsed(page)).datasets[0].sampleRows[0];
    expect(Object.keys(row)).toEqual(['title', 'qty']);
  });

  test('renaming to a name the Dataset already has is refused with a message, and nothing is written', async ({ page }) => {
    const original = await playground(page);
    await openDesigner(page, { text: original });
    await showTab(page, 'Datasets');
    await commit(page, 'name id', 'qty');
    await expect(page.getByRole('alert').filter({ hasText: 'already has a column "qty"' })).toBeVisible();
    expect(await hostText(page)).toBe(original);
  });

  test('removing a column that a binding or a Grid uses is refused with the message that says what uses it', async ({ page }) => {
    const original = await playground(page);
    await openDesigner(page, { text: original });
    await showTab(page, 'Datasets');
    await datasetsPanel(page).getByRole('button', { name: 'Delete column name' }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'still used by' });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('Column "dsA.name" is still used by');
    // It says where: the binding and the Grid cell.
    await expect(alert).toContainText('bind.value');
    await expect(alert).toContainText('recordRows');
    expect(await hostText(page)).toBe(original);
    expect(await hostApplied(page)).toEqual([]);

    // A Dataset that is bound is refused too.
    await datasetsPanel(page).getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Dataset "dsA" is still used by' })).toBeVisible();
    expect(await hostText(page)).toBe(original);
  });

  test('an unused column can be added, typed, moved and removed', async ({ page }) => {
    const original = await playground(page);
    await openDesigner(page, { text: original });
    await showTab(page, 'Datasets');
    const panel = datasetsPanel(page);
    await panel.getByRole('button', { name: 'Add column' }).click();
    await settled(page);
    expect((await hostParsed(page)).datasets[0].columns.map((c: { id: string }) => c.id)).toEqual(['name', 'qty', 'col3']);
    await panel.getByLabel('col3 type', { exact: true }).selectOption('decimal');
    await settled(page);
    await commit(page, 'col3 precision', '10');
    await commit(page, 'col3 scale', '2');
    await panel.getByLabel('col3 required', { exact: true }).check();
    await settled(page);
    expect((await hostParsed(page)).datasets[0].columns[2]).toEqual({ id: 'col3', type: 'decimal', precision: 10, scale: 2, required: true });
    await expectValid(page, 'add and set a column');
    await panel.getByRole('button', { name: 'Move column col3 up' }).click();
    await settled(page);
    expect((await hostParsed(page)).datasets[0].columns.map((c: { id: string }) => c.id)).toEqual(['name', 'col3', 'qty']);
    await expectValid(page, 'move a column');
    await panel.getByRole('button', { name: 'Delete column col3' }).click();
    await settled(page);
    expect(await hostText(page)).toBe(original);
  });

  test('sample rows are checked against the column type: a whole number, a number, true or false', async ({ page }) => {
    const original = await playground(page);
    await openDesigner(page, { text: original });
    await showTab(page, 'Datasets');
    const panel = datasetsPanel(page);

    const qty = panel.getByLabel('Row 1, qty', { exact: true });
    await qty.fill('abc');
    await qty.press('Enter');
    await expect(panel.getByRole('alert').filter({ hasText: 'takes a whole number' })).toBeVisible();
    await qty.fill('2.5');
    await qty.press('Enter');
    await expect(panel.getByRole('alert').filter({ hasText: 'takes a whole number' })).toBeVisible();
    expect(await hostText(page)).toBe(original);
    await qty.fill('7');
    await qty.press('Enter');
    await settled(page);
    // Stored as a number, not as text.
    expect((await hostParsed(page)).datasets[0].sampleRows[0].qty).toBe(7);
    await expect(panel.getByRole('alert')).toHaveCount(0);

    // A boolean and a float column.
    await panel.getByRole('button', { name: 'Add column' }).click();
    await panel.getByLabel('col3 type', { exact: true }).selectOption('boolean');
    await panel.getByRole('button', { name: 'Add column' }).click();
    await panel.getByLabel('col4 type', { exact: true }).selectOption('float');
    await settled(page);
    const flag = panel.getByLabel('Row 1, col3', { exact: true });
    await flag.fill('yes');
    await flag.press('Enter');
    await expect(panel.getByRole('alert').filter({ hasText: 'takes true or false' })).toBeVisible();
    await flag.fill('true');
    await flag.press('Enter');
    const ratio = panel.getByLabel('Row 1, col4', { exact: true });
    await ratio.fill('1.5x');
    await ratio.press('Enter');
    await expect(panel.getByRole('alert').filter({ hasText: 'takes a number' })).toBeVisible();
    await ratio.fill('1.5');
    await ratio.press('Enter');
    await settled(page);
    expect((await hostParsed(page)).datasets[0].sampleRows[0]).toEqual({ name: 'Apple', qty: 7, col3: true, col4: 1.5 });
    await expectValid(page, 'typed sample cells');

    // A second row, which starts empty, and removing a row.
    await panel.getByRole('button', { name: 'Add sample row' }).click();
    await settled(page);
    expect((await hostParsed(page)).datasets[0].sampleRows).toHaveLength(2);
    await panel.getByRole('button', { name: 'Remove sample row 2' }).click();
    await settled(page);
    expect((await hostParsed(page)).datasets[0].sampleRows).toHaveLength(1);
  });

  test('changing a column to a type its sample rows do not fit is refused with the row and the value in the message', async ({ page }) => {
    const original = await playground(page);
    await openDesigner(page, { text: original });
    await showTab(page, 'Datasets');
    await datasetsPanel(page).getByLabel('qty type', { exact: true }).selectOption('boolean');
    await expect(page.getByRole('alert').filter({ hasText: "doesn't fit boolean" })).toBeVisible();
    expect(await hostText(page)).toBe(original);
  });

  test('Dataset keys must be columns, and confirmUnsaved is a checkbox', async ({ page }) => {
    await openDesigner(page, { text: await playground(page) });
    await showTab(page, 'Datasets');
    const panel = datasetsPanel(page);
    await commit(page, 'keys', 'nope');
    await expect(page.getByRole('alert').filter({ hasText: 'is not a column of "dsA"' })).toBeVisible();
    await commit(page, 'keys', 'name');
    expect((await hostParsed(page)).datasets[0].keys).toEqual(['name']);
    await panel.getByLabel('confirmUnsaved', { exact: true }).check();
    await settled(page);
    expect((await hostParsed(page)).datasets[0].confirmUnsaved).toBe(true);
    await expectValid(page, 'keys and confirmUnsaved');
  });

  test('a new Dataset can be added and renamed, and then deleted when nothing uses it', async ({ page }) => {
    const original = await playground(page);
    await openDesigner(page, { text: original });
    await showTab(page, 'Datasets');
    const panel = datasetsPanel(page);
    await panel.getByRole('button', { name: 'Add Dataset' }).click();
    await settled(page);
    // The new Dataset is in the list. The picker stays where it was, so it is picked here.
    await panel.getByLabel('Dataset', { exact: true }).selectOption('ds1');
    await commit(page, 'id', 'dsNew');
    expect((await hostParsed(page)).datasets.map((d: { id: string }) => d.id)).toEqual(['dsA', 'dsNew']);
    await expectValid(page, 'add and rename a Dataset');
    await panel.getByRole('button', { name: 'Delete', exact: true }).click();
    await settled(page);
    expect(await hostText(page)).toBe(original);
  });
});

test.describe('Grid columns editor', () => {
  test('add, set the field, move, change the width and header, and remove, each leaving a Grid that passes fw check', async ({ page }) => {
    const original = await playground(page);
    await openDesigner(page, { text: original });
    await selectOnCanvas(page, 'grid', { x: 300, y: 100 });
    const panel = gridPanel(page);
    await expect(panel.getByLabel('Column 1 header', { exact: true })).toHaveValue('Name');
    await expect(panel.getByLabel('Column 2 field', { exact: true })).toHaveValue('qty');

    await panel.getByRole('button', { name: 'Add column', exact: true }).click();
    await settled(page);
    let props = await gridProps(page);
    expect(props.columns).toHaveLength(3);
    expect(props.recordRows[0].cells).toHaveLength(3);
    expect(props.headerRows[0].cells).toHaveLength(3);
    await expectValid(page, 'add a Grid column');

    // Point the new column at a field of the bound Dataset, name its header, give it a width and an editor.
    await panel.getByLabel('Column 3 field', { exact: true }).selectOption('name');
    await settled(page);
    await commit(page, 'Column 3 header', 'Again', panel);
    await commit(page, 'Column 3 width', '150', panel);
    await panel.getByLabel('Column 3 editor', { exact: true }).selectOption('text');
    await settled(page);
    props = await gridProps(page);
    expect(props.recordRows[0].cells[2]).toMatchObject({ field: 'name', editor: 'text' });
    expect(props.headerRows[0].cells[2].text).toBe('Again');
    expect(props.columns[2].width).toBe(150);
    await expectValid(page, 'set field, header, width and editor');

    // Move it to the front: track, header cell and record cell move together.
    await panel.getByRole('button', { name: 'Column 3 move left' }).click();
    await settled(page);
    await panel.getByRole('button', { name: 'Column 2 move left' }).click();
    await settled(page);
    props = await gridProps(page);
    expect(props.headerRows[0].cells.map((c: { text: string }) => c.text)).toEqual(['Again', 'Name', 'Qty']);
    expect(props.recordRows[0].cells.map((c: { field: string }) => c.field)).toEqual(['name', 'name', 'qty']);
    expect(props.columns[0].width).toBe(150);
    await expectValid(page, 'move a Grid column');

    // Remove it again: the Grid is as it was.
    await panel.getByRole('button', { name: 'Column 1 remove' }).click();
    await settled(page);
    await expectValid(page, 'remove a Grid column');
    expect(await hostText(page)).toBe(original);
    const cli = fwCheck(withoutHandlers(await hostText(page)), 'Grid');
    expect(cli.status, cli.output).toBe(0);
  });

  test('the last column cannot be removed, and a non-number width is refused with a message', async ({ page }) => {
    await openDesigner(page, { text: await playground(page) });
    await selectOnCanvas(page, 'grid', { x: 300, y: 100 });
    const panel = gridPanel(page);
    await panel.getByRole('button', { name: 'Column 2 remove' }).click();
    await settled(page);
    await expect(panel.getByRole('button', { name: 'Column 1 remove' })).toBeDisabled();
    const width = panel.getByLabel('Column 1 width', { exact: true });
    await width.fill('wide');
    await width.press('Enter');
    await expect(panel.getByRole('alert')).toContainText('Enter a width in pixels');
    await expectValid(page, 'remove the second Grid column');
  });

  test('a Grid with merged header cells says so, and a move next to a merged cell is refused without writing', async ({ page }) => {
    await openDesigner(page, { form: 'EmployeeList' });
    const original = await hostText(page);
    await showTab(page, 'Outline');
    await page.locator('.dz-tree__row[data-id="empGrid"]').click();
    const panel = gridPanel(page);
    await expect(panel.getByTestId('grid-merged-note')).toContainText('merged cells');
    // Column 5 (dept) sits under the merged "Job" header: moving it is refused.
    await panel.getByRole('button', { name: 'Column 5 move right' }).click();
    await expect(page.getByRole('alert').first()).toContainText(/merged|can't/);
    expect(await hostText(page)).toBe(original);
    expect(await hostApplied(page)).toEqual([]);
  });
});
