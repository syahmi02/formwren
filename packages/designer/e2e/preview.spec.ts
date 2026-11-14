/** The preview: runs the form with the fixtures' data, follows the text, and never writes to the file. */
import type { Page } from '@playwright/test';
import { demoForm, playground } from './forms.ts';
import { canvas, expect, hostApplied, hostText, openDesigner, selectOnCanvas, setField, settled, test } from './support.ts';

const preview = (page: Page) => page.getByRole('region', { name: 'Preview', exact: true });
const openPreview = async (page: Page): Promise<void> => {
  await page.getByRole('tab', { name: 'Preview' }).click();
  await expect(preview(page)).toBeVisible();
};
/** The values of every text input in the preview. */
const inputValues = (page: Page): Promise<string[]> => preview(page).locator('input').evaluateAll((nodes) => nodes.map((n) => (n as HTMLInputElement).value));

test.describe('preview', () => {
  test('EmployeeEdit shows the fixtures\' data: the first employee, loaded by the real handlers', async ({ page }) => {
    await openDesigner(page, { form: 'EmployeeEdit' });
    await openPreview(page);
    await expect(preview(page)).toContainText('Service calls are answered from the fixtures file (3 services)');
    await expect.poll(() => inputValues(page), { message: 'the name field holds the first fixture row' }).toContain('Alice Carter');
    await expect(preview(page).getByText('Row 1 of')).toBeVisible();
    // The design view is still there when going back, with its selection.
    await page.getByRole('tab', { name: 'Design' }).click();
    await expect(page.getByTestId('overlay')).toBeVisible();
  });

  test('running it does not change the file: typing, clicking Save and moving between rows write nothing', async ({ page }) => {
    const original = demoForm('EmployeeEdit');
    await openDesigner(page, { form: 'EmployeeEdit' });
    await openPreview(page);
    await expect.poll(() => inputValues(page)).toContain('Alice Carter');
    // Found by its label, not by its value: the value changes as soon as it is typed into.
    const name = preview(page).getByLabel('Name', { exact: true });
    await expect(name).toHaveValue('Alice Carter');
    await name.fill('Someone Else');
    await name.press('Tab');
    await preview(page).getByRole('button', { name: /next/i }).first().click().catch(() => undefined);
    await preview(page).getByRole('button', { name: 'Save' }).first().click().catch(() => undefined);
    await page.waitForTimeout(400);
    expect(await hostText(page)).toBe(original);
    expect(await hostApplied(page)).toEqual([]);
    expect(await page.evaluate(() => window.__host.canUndo)).toBe(false);
    // The fixtures text is untouched too.
    const fixtures = await page.evaluate(() => window.__host.readText().length);
    expect(fixtures).toBe(original.length);
  });

  test('it follows text changes: a label edited in the text editor shows in the preview, and so does one edited in the inspector', async ({ page }) => {
    await openDesigner(page, { form: 'EmployeeEdit' });
    await openPreview(page);
    await expect(preview(page).getByText('Name', { exact: true }).first()).toBeVisible();
    const original = await hostText(page);
    // As if typed in the text editor.
    // The Name input's own label. (The first "label": "Name" in the file is a Dataset column's, which no input shows.)
    const changed = original.replace('"props": { "label": "Name" }', '"props": { "label": "Full legal name" }');
    expect(changed).not.toBe(original);
    await page.evaluate((t) => window.__host.setText(t), changed);
    await expect(preview(page).getByText('Full legal name').first()).toBeVisible();
    await expect.poll(() => inputValues(page)).toContain('Alice Carter');

    // And through the designer.
    await page.getByRole('tab', { name: 'Design' }).click();
    await page.evaluate((t) => window.__host.setText(t), original);
    await settled(page);
    await page.getByRole('region', { name: 'Form parts' }).or(page.getByRole('navigation', { name: 'Form parts' })).getByRole('tab', { name: 'Outline' }).click();
    await page.locator('.dz-tree__row[data-id="nameInput"]').click();
    await setField(page, 'label', 'Employee name');
    await openPreview(page);
    await expect(preview(page).getByText('Employee name').first()).toBeVisible();
  });

  test('a form with no fixtures file says so, and still runs', async ({ page }) => {
    await openDesigner(page, { form: 'EmployeeList' });
    await openPreview(page);
    await expect(preview(page)).toContainText('There is no fixtures file');
    await expect(preview(page).getByRole('button', { name: 'Add row' })).toBeVisible();
  });

  test('a fixtures file that is not valid JSON is reported, and the file is untouched', async ({ page }) => {
    const original = demoForm('EmployeeEdit');
    await openDesigner(page, { form: 'EmployeeEdit' });
    await page.evaluate(() => {
      window.__host.setText(window.__host.readText());
    });
    await page.evaluate(() => ((window.__host as unknown as { fixtures: string | null }).fixtures = '{ not json'));
    await openPreview(page);
    await expect(preview(page).getByRole('alert')).toContainText('not valid JSON');
    expect(await hostText(page)).toBe(original);
  });

  test('a form that cannot be read has no preview, only the reason', async ({ page }) => {
    const broken = (await playground(page)).replace('"formatVersion": 1,', '"formatVersion": 1');
    await openDesigner(page, { text: broken });
    await page.getByRole('tab', { name: 'Preview' }).click();
    await expect(page.getByText('The preview needs a form that can be read')).toBeVisible();
    expect(await hostText(page)).toBe(broken);
  });

  // FRAMEWORK.md: sampleRows are what design mode loads in place of initialRows. A running form, and so the
  // preview, starts from initialRows and whatever its service calls bring.
  test('sample rows show in the design view only: the preview runs from initial rows, and the designer view is unchanged afterwards', async ({ page }) => {
    const original = await playground(page);
    await openDesigner(page, { text: original });
    await selectOnCanvas(page, 'btnA');
    await expect(canvas(page).getByText('Apple').first()).toBeVisible();
    await openPreview(page);
    await expect(preview(page).locator('.fw-gridhost').first()).toBeVisible();
    await expect(preview(page).getByText('Apple')).toHaveCount(0);
    await page.getByRole('tab', { name: 'Design' }).click();
    await expect(page.getByTestId('selection')).toHaveAttribute('data-id', 'btnA');
    expect(await hostText(page)).toBe(original);
    expect(await hostApplied(page)).toEqual([]);
  });
});
