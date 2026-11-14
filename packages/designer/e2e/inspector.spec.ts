/** The inspector: typed editors that commit on blur and Enter only, `=` expressions, the binding picker, events and diagnostics. */
import { playground } from './forms.ts';
import { expect, hostApplied, hostText, hostUndo, inspector, lineDiff, nodeOf, openDesigner, selectOnCanvas, setField, settled, showDiff, showTab, outlineRow, test } from './support.ts';

const node = nodeOf;

test.describe('typed editors commit on blur and Enter only', () => {
  test('typing writes nothing until Enter or blur, Escape puts the old text back', async ({ page }) => {
    const original = await playground(page);
    await openDesigner(page, { text: original });
    await selectOnCanvas(page, 'btnA');
    const field = inspector(page).getByLabel('text', { exact: true });
    await field.click();
    await field.fill('');
    await page.keyboard.type('Alpha', { delay: 20 });
    expect(await hostApplied(page)).toEqual([]);
    expect(await hostText(page)).toBe(original);
    await page.keyboard.press('Escape');
    await expect(field).toHaveValue('A');
    expect(await hostApplied(page)).toEqual([]);

    // Blur commits.
    await field.fill('Beta');
    expect(await hostApplied(page)).toEqual([]);
    await page.keyboard.press('Tab');
    await settled(page);
    expect((await node(page, 'btnA')).props.text).toBe('Beta');
    expect(await hostApplied(page)).toHaveLength(1);

    // Enter commits, once.
    await field.fill('Gamma');
    await field.press('Enter');
    await settled(page);
    expect((await node(page, 'btnA')).props.text).toBe('Gamma');
    expect(await hostApplied(page)).toHaveLength(2);
    // Leaving the field afterwards writes nothing more.
    await page.keyboard.press('Tab');
    expect(await hostApplied(page)).toHaveLength(2);
  });

  test('a number field takes a number or nothing, refuses text with a message beside it, and empty takes the value away', async ({ page }) => {
    const original = await playground(page);
    await openDesigner(page, { text: original });
    await selectOnCanvas(page, 'nameInput');
    const max = inspector(page).getByLabel('maxLength', { exact: true });
    await max.fill('20');
    await max.press('Enter');
    await settled(page);
    expect((await node(page, 'nameInput')).props.maxLength).toBe(20);
    const diff = lineDiff(original, await hostText(page));
    expect(diff.added.length, showDiff(diff)).toBeLessThanOrEqual(2);

    await max.fill('lots');
    await max.press('Enter');
    await expect(inspector(page).getByRole('alert')).toContainText('Enter a number');
    await expect(max).toHaveAttribute('aria-invalid', 'true');
    expect((await node(page, 'nameInput')).props.maxLength).toBe(20);

    await max.fill('');
    await max.press('Enter');
    await settled(page);
    expect((await node(page, 'nameInput')).props.maxLength).toBeUndefined();
    expect(await hostText(page)).toBe(original);
  });

  test('layout fields: a number is one line, empty takes an edge away, text is refused', async ({ page }) => {
    const original = await playground(page);
    await openDesigner(page, { text: original });
    await selectOnCanvas(page, 'btnA');
    await setField(page, 'width', '100');
    const diff = lineDiff(original, await hostText(page));
    expect(diff.removed, showDiff(diff)).toHaveLength(1);
    expect(diff.added, showDiff(diff)).toHaveLength(1);
    expect((await node(page, 'btnA')).layout).toEqual({ left: 40, top: 40, width: 100, height: 32 });
    const field = inspector(page).getByLabel('top', { exact: true });
    await field.fill('abc');
    await field.press('Enter');
    await expect(inspector(page).getByRole('alert')).toContainText('Enter a number');
    expect((await node(page, 'btnA')).layout.top).toBe(40);
    // Switching the layout from left to right anchoring: add right, take left away.
    await field.press('Escape');
    await setField(page, 'right', '24');
    await setField(page, 'left', '');
    expect((await node(page, 'btnA')).layout).toEqual({ top: 40, right: 24, width: 100, height: 32 });
  });

  test('a choice is a list and a checkbox writes at once, and a value can be taken away', async ({ page }) => {
    await openDesigner(page, { text: await playground(page) });
    await selectOnCanvas(page, 'btnA');
    await inspector(page).getByLabel('variant', { exact: true }).selectOption('primary');
    await settled(page);
    expect((await node(page, 'btnA')).props.variant).toBe('primary');
    await inspector(page).getByLabel('disabled', { exact: true }).check();
    await settled(page);
    expect((await node(page, 'btnA')).props.disabled).toBe(true);
    await inspector(page).getByRole('button', { name: 'Remove the value of disabled' }).click();
    await settled(page);
    expect((await node(page, 'btnA')).props.disabled).toBeUndefined();
  });
});

test.describe('expressions', () => {
  test('an = expression can be typed in a boolean field, and a bad reference is shown as a problem with the message from fw check', async ({ page }) => {
    await openDesigner(page, { text: await playground(page) });
    await selectOnCanvas(page, 'btnA');
    await inspector(page).getByRole('button', { name: 'Use an expression for disabled' }).click();
    const field = inspector(page).getByLabel('disabled', { exact: true });
    await field.fill('=vars.busy');
    await field.press('Enter');
    await settled(page);
    expect((await node(page, 'btnA')).props.disabled).toBe('=vars.busy');
    const problems = inspector(page).getByRole('region', { name: 'Problems' });
    await expect(problems).toContainText('No variable named "busy"');
    await expect(problems).toContainText('Error');

    // Plain text that is not an expression is refused in that field.
    await field.fill('yes');
    await field.press('Enter');
    await expect(inspector(page).getByRole('alert')).toContainText('An expression starts with =');
    expect((await node(page, 'btnA')).props.disabled).toBe('=vars.busy');

    // A good expression clears the problem. The form needs the variable first, which comes through the text editor.
    await field.press('Escape');
    await field.fill('=1 == 1');
    await field.press('Enter');
    await settled(page);
    await expect(problems).toHaveCount(0);
  });

  test('a number field takes an = expression too, and the expression survives as text', async ({ page }) => {
    await openDesigner(page, { text: await playground(page) });
    await selectOnCanvas(page, 'nameInput');
    const max = inspector(page).getByLabel('maxLength', { exact: true });
    await max.fill('=1 + 2');
    await max.press('Enter');
    await settled(page);
    expect((await node(page, 'nameInput')).props.maxLength).toBe('=1 + 2');
    await expect(max).toHaveValue('=1 + 2');
    await max.fill('=1 +');
    await max.press('Enter');
    await settled(page);
    await expect(inspector(page).getByRole('region', { name: 'Problems' })).toBeVisible();
  });
});

test.describe('bindings', () => {
  test('the picker offers the form\'s columns, picking writes the binding, and none takes it away', async ({ page }) => {
    const original = await playground(page);
    await openDesigner(page, { text: original });
    await selectOnCanvas(page, 'nameInput');
    const picker = inspector(page).getByLabel('Pick a column for value');
    const options = await picker.locator('option').allTextContents();
    expect(options.join('|')).toContain('dsA.name');
    expect(options.join('|')).toContain('dsA.qty');
    await picker.selectOption({ label: options.find((o) => o.includes('dsA.qty')) as string });
    await settled(page);
    expect((await node(page, 'nameInput')).bind.value).toBe('dsA.qty');
    await picker.selectOption({ index: 0 });
    await settled(page);
    expect((await node(page, 'nameInput')).bind).toBeUndefined();
    await hostUndo(page);
    await hostUndo(page);
    expect(await hostText(page)).toBe(original);
  });

  test('a Dataset binding offers Dataset ids', async ({ page }) => {
    await openDesigner(page, { text: await playground(page) });
    await selectOnCanvas(page, 'grid', { x: 300, y: 100 });
    const picker = inspector(page).getByLabel('Pick a Dataset for dataset');
    expect(await picker.locator('option').allTextContents()).toContain('dsA');
    await expect(picker).toHaveValue('dsA');
  });

  test('a binding to a column that is not there is written as typed and shown as a problem, and the problem goes when it is fixed', async ({ page }) => {
    await openDesigner(page, { text: await playground(page) });
    await selectOnCanvas(page, 'nameInput');
    const field = inspector(page).getByLabel('value (binding)');
    await field.fill('dsA.nope');
    await field.press('Enter');
    await settled(page);
    expect((await node(page, 'nameInput')).bind.value).toBe('dsA.nope');
    const problems = inspector(page).getByRole('region', { name: 'Problems' });
    await expect(problems).toBeVisible();
    await expect(problems).toContainText(/nope/);
    // The picker has no match for it, and says to pick.
    await expect(inspector(page).getByLabel('Pick a column for value')).toHaveValue('');
    await field.fill('dsA.name');
    await field.press('Enter');
    await settled(page);
    await expect(problems).toHaveCount(0);
  });

  test('a binding to a Dataset that is not there is a problem on the component that has it', async ({ page, problems }) => {
    await openDesigner(page, { text: await playground(page) });
    await selectOnCanvas(page, 'grid', { x: 300, y: 100 });
    const field = inspector(page).getByLabel('dataset (binding)');
    await field.fill('dsMissing');
    await field.press('Enter');
    await settled(page);
    await expect(inspector(page).getByRole('region', { name: 'Problems' })).toContainText('dsMissing');
    // The runtime in the canvas logs the unbound Grid with console.error. That is the one console error this test expects.
    const expected = problems.filter((p) => /Grid grid has no Dataset bound/.test(p));
    expect(expected.length).toBeGreaterThan(0);
    problems.splice(0, problems.length, ...problems.filter((p) => !expected.includes(p)));
  });
});

test.describe('events', () => {
  test('a handler name is set, changed and taken away, and the event key goes with it', async ({ page }) => {
    const original = await playground(page);
    await openDesigner(page, { text: original });
    await selectOnCanvas(page, 'btnA');
    await expect(inspector(page).getByLabel('click (event)')).toHaveValue('onA');
    await setField(page, 'click (event)', 'onAlpha');
    expect((await node(page, 'btnA')).events).toEqual({ click: 'onAlpha' });
    const diff = lineDiff(original, await hostText(page));
    expect(diff.removed, showDiff(diff)).toHaveLength(1);
    expect(diff.added, showDiff(diff)).toHaveLength(1);
    await setField(page, 'click (event)', '');
    expect((await node(page, 'btnA')).events).toBeUndefined();
    await hostUndo(page);
    await hostUndo(page);
    expect(await hostText(page)).toBe(original);
  });
});

test.describe('options list', () => {
  test('options of a radio group: add, edit and remove, as value and label', async ({ page }) => {
    await openDesigner(page, { form: 'EmployeeEdit' });
    await showTab(page, 'Outline');
    await outlineRow(page, 'levelRadio').click();
    const box = inspector(page).getByRole('group', { name: 'options' });
    await expect(box.getByLabel('options option 1 value')).toHaveValue('A');
    await box.getByRole('button', { name: 'Add option' }).click();
    await settled(page);
    const value = box.getByLabel('options option 4 value');
    await value.fill('D');
    await value.press('Enter');
    const label = box.getByLabel('options option 4 label');
    await label.fill('Intern');
    await label.press('Enter');
    await settled(page);
    expect((await node(page, 'levelRadio')).props.options[3]).toEqual({ value: 'D', label: 'Intern' });
    await box.getByRole('button', { name: 'Remove option 4 of options' }).click();
    await settled(page);
    expect((await node(page, 'levelRadio')).props.options).toHaveLength(3);
  });
});
