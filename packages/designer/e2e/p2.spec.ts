/**
 * Proof test P2 on the designer (FRAMEWORK.md section 8, N-5): every gesture produces the smallest text change.
 * The host's text is checked after each step, as the file on disk would be.
 */
import { demoForm, playground, saveUnchanged, standardLayoutProblem, withUnknownKeys } from './forms.ts';
import {
  banner,
  boxOf,
  canvas,
  drag,
  hostApplied,
  hostRedo,
  hostText,
  hostUndo,
  inspector,
  expect,
  leftTab,
  lineDiff,
  lostKeys,
  openDesigner,
  outlineRow,
  overlay,
  selectOnCanvas,
  setField,
  settled,
  showDiff,
  showTab,
  test,
  unknownKeys,
} from './support.ts';

const DEMO_FORMS = ['EmployeeList', 'EmployeeEdit', 'DepartmentEmployees', 'EmployeeLookup'];

test.describe('no change, no diff', () => {
  for (const name of DEMO_FORMS) {
    test(`${name}: the writer gives the same text, and looking around writes nothing`, async ({ page }) => {
      const original = demoForm(name);
      // Saving the unchanged form through the writer is a zero diff.
      await page.goto('/dev/index.html?form=EmployeeList');
      expect(await saveUnchanged(page, original)).toBe(original);

      await openDesigner(page, { form: name });
      expect(await hostText(page)).toBe(original);
      // Select every component the canvas shows, walk with Tab, press Escape, switch the panels and the view.
      const ids = await canvas(page).locator('.fw-host[data-id]').evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).dataset.id as string));
      for (const id of ids.slice(0, 12)) {
        const box = await canvas(page).locator(`.fw-host[data-id="${id}"]`).boundingBox();
        if (!box || box.width < 10 || box.height < 10) continue;
        const area = await overlay(page).boundingBox();
        if (!area || box.x + 4 > area.x + area.width - 2 || box.y + 4 > area.y + area.height - 2) continue;
        await page.mouse.click(box.x + 3, box.y + 3);
      }
      await page.keyboard.press('Tab');
      await page.keyboard.press('Escape');
      await showTab(page, 'Outline');
      await showTab(page, 'Datasets');
      await page.getByRole('tab', { name: 'Preview' }).click();
      await page.getByRole('tab', { name: 'Design' }).click();
      expect(await hostApplied(page)).toEqual([]);
      expect(await hostText(page)).toBe(original);
      expect(await page.evaluate(() => window.__host.canUndo)).toBe(false);
    });
  }

  test('a gesture that changes nothing writes nothing, and a move and its reverse restore the exact text', async ({ page }) => {
    const original = await playground(page);
    await openDesigner(page, { text: original });
    const box = await selectOnCanvas(page, 'btnA');
    // A click with a tiny wobble under the drag threshold.
    await drag(page, { x: box.x + 4, y: box.y + 4 }, { x: box.x + 5, y: box.y + 5 }, { steps: 1 });
    // The same text typed back into a field.
    await setField(page, 'text', 'A');
    expect(await hostApplied(page)).toEqual([]);
    expect(await hostText(page)).toBe(original);

    await drag(page, { x: box.x + 4, y: box.y + 4 }, { x: box.x + 4 + 16, y: box.y + 4 + 8 });
    const moved = await hostText(page);
    expect(moved).not.toBe(original);
    const fresh = await boxOf(page, 'btnA');
    await drag(page, { x: fresh.x + 4, y: fresh.y + 4 }, { x: fresh.x + 4 - 16, y: fresh.y + 4 - 8 });
    expect(await hostText(page)).toBe(original);
    await hostUndo(page);
    expect(await hostText(page)).toBe(moved);
    await hostUndo(page);
    expect(await hostText(page)).toBe(original);
  });
});

test.describe('the smallest change', () => {
  test('moving one component is a one-line diff, and undo and redo restore the exact text', async ({ page }) => {
    const original = await playground(page);
    await openDesigner(page, { text: original });
    const box = await selectOnCanvas(page, 'btnA');
    await drag(page, { x: box.x + 4, y: box.y + 4 }, { x: box.x + 4 + 24, y: box.y + 4 + 16 });
    const moved = await hostText(page);
    const diff = lineDiff(original, moved);
    expect(diff.removed.length, showDiff(diff)).toBe(1);
    expect(diff.added.length, showDiff(diff)).toBe(1);
    expect(diff.added[0]).toContain('"left": 64');
    expect(diff.added[0]).toContain('"top": 56');
    expect(await hostApplied(page)).toHaveLength(1);
    expect(await standardLayoutProblem(page, moved)).toBeNull();
    await hostUndo(page);
    expect(await hostText(page)).toBe(original);
    await hostRedo(page);
    expect(await hostText(page)).toBe(moved);
  });

  test('a property edit is one line, and so is an id rename of a component nothing refers to', async ({ page }) => {
    const original = await playground(page);
    await openDesigner(page, { text: original });
    await selectOnCanvas(page, 'btnA');
    await setField(page, 'text', 'Alpha');
    const edited = await hostText(page);
    const diff = lineDiff(original, edited);
    expect(diff.removed, showDiff(diff)).toHaveLength(1);
    expect(diff.added, showDiff(diff)).toHaveLength(1);
    expect(diff.added[0]).toContain('"text": "Alpha"');

    await setField(page, 'id', 'btnAlpha');
    const renamed = lineDiff(edited, await hostText(page));
    expect(renamed.removed, showDiff(renamed)).toHaveLength(1);
    expect(renamed.added, showDiff(renamed)).toHaveLength(1);
    expect(renamed.added[0]).toContain('"id": "btnAlpha"');
  });

  test('adding and removing the last key of an object touches one extra line at most (the comma)', async ({ page }) => {
    const original = await playground(page);
    await openDesigner(page, { text: original });
    await selectOnCanvas(page, 'btnB');
    // btnB has props, layout and no events: adding an event adds a key at the end of the object.
    await setField(page, 'click (event)', 'onB');
    const edited = await hostText(page);
    const diff = lineDiff(original, edited);
    expect(diff.added.length, showDiff(diff)).toBeLessThanOrEqual(2);
    expect(diff.removed.length, showDiff(diff)).toBeLessThanOrEqual(1);
    expect(diff.added.join('\n')).toContain('"click": "onB"');
    await setField(page, 'click (event)', '');
    expect(await hostText(page)).toBe(original);
  });
});

test.describe('unknown keys survive every gesture', () => {
  test('moving, resizing, nudging, editing, renaming, re-parenting, reordering, adding, Dataset edits, undo and redo', async ({ page }) => {
    const original = await withUnknownKeys(page);
    const keys0 = unknownKeys(original);
    expect(keys0.size).toBeGreaterThan(10);
    await openDesigner(page, { text: original });
    expect(await page.getByTestId('readonly-badge').count()).toBe(0);

    const check = async (what: string, allowedLoss: string[] = []): Promise<void> => {
      const text = await hostText(page);
      expect(lostKeys(keys0, unknownKeys(text)).filter((k) => !allowedLoss.includes(k)), `unknown keys lost after: ${what}`).toEqual([]);
    };

    // Move.
    let box = await selectOnCanvas(page, 'btnA');
    await drag(page, { x: box.x + 4, y: box.y + 4 }, { x: box.x + 28, y: box.y + 20 });
    await check('move');
    // Resize with the east handle.
    const handle = await page.getByTestId('handle-e').boundingBox();
    if (!handle) throw new Error('no handle');
    await drag(page, { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }, { x: handle.x + handle.width / 2 + 16, y: handle.y + handle.height / 2 });
    await check('resize');
    // Nudge.
    await overlay(page).focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowDown');
    await settled(page);
    await check('nudge');
    // Property, event, binding, id.
    await setField(page, 'text', 'Changed');
    await setField(page, 'click (event)', 'onChanged');
    await check('property and event');
    await setField(page, 'id', 'btnRenamed');
    await check('rename');
    // Outline: reorder, move in, move out.
    await showTab(page, 'Outline');
    await outlineRow(page, 'btnRenamed').click();
    await outlineRow(page, 'btnRenamed').press('Alt+ArrowDown');
    await check('reorder');
    // btnB is above `box` after the reorder, so box has a sibling above that is not a container: move `anchored` into `box`.
    await outlineRow(page, 'anchored').click();
    await outlineRow(page, 'anchored').press('Alt+ArrowRight');
    await check('move into');
    await outlineRow(page, 'anchored').press('Alt+ArrowLeft');
    await check('move out');
    // Add from the palette by dropping onto the canvas.
    await showTab(page, 'Components');
    const item = await page.locator('.dz-palette__item[data-type="Checkbox"]').boundingBox();
    const form = await boxOf(page, 'box');
    if (!item) throw new Error('no palette item');
    await drag(page, { x: item.x + 10, y: item.y + 10 }, { x: form.x + 200, y: form.y + 120 });
    await check('add by drop');
    // Dataset editor: rename a column (rewrites bindings and Grid cells), change its type.
    await showTab(page, 'Datasets');
    const colId = page.getByLabel('name id', { exact: true });
    await colId.fill('title');
    await colId.press('Enter');
    await settled(page);
    await check('rename column');
    const after = JSON.parse(await hostText(page));
    expect(after.datasets[0].columns[0].id).toBe('title');
    expect(after.datasets[0].columns[0].x_col).toBe(true);

    // Undo everything, then redo everything: the keys are there at each step, and the original is back at the bottom.
    const steps = await page.evaluate(() => window.__host.undoStack.length);
    for (let i = 0; i < steps; i++) {
      await hostUndo(page);
      await check(`undo ${i + 1}`);
    }
    expect(await hostText(page)).toBe(original);
    for (let i = 0; i < steps; i++) {
      await hostRedo(page);
      await check(`redo ${i + 1}`);
    }
    // Deleting a component removes its own unknown keys and nothing else's.
    await page.getByRole('tab', { name: 'Design' }).click();
    box = await selectOnCanvas(page, 'btnB');
    await overlay(page).focus();
    await page.keyboard.press('Delete');
    await settled(page);
    const afterDelete = unknownKeys(await hostText(page));
    const expected = new Map(keys0);
    for (const key of ['x_note="note-btnB"', 'x_l=1', 'x_p="p-btnB"']) expected.set(key, (expected.get(key) ?? 0) - 1);
    expect([...afterDelete].sort()).toEqual([...expected].filter(([, n]) => n > 0).sort());
  });
});

test.describe('a file that cannot be edited safely is never written', () => {
  const conflicted = (text: string): string => {
    const at = text.indexOf('  "datasets"');
    return `${text.slice(0, at)}<<<<<<< HEAD\n  "title": "Ours",\n=======\n  "title": "Theirs",\n>>>>>>> branch\n${text.slice(at)}`;
  };
  const broken = (text: string): string => text.replace('"formatVersion": 1,', '"formatVersion": 1');

  const hammer = async (page: import('@playwright/test').Page): Promise<void> => {
    // Everything a user could try. Each is allowed to do nothing, and none may write.
    const hasCanvas = (await overlay(page).count()) > 0;
    const area = hasCanvas ? await overlay(page).boundingBox() : null;
    if (area) {
      await page.mouse.click(area.x + 60, area.y + 50);
      await page.mouse.move(area.x + 60, area.y + 50);
      await page.mouse.down();
      await page.mouse.move(area.x + 120, area.y + 90, { steps: 6 });
      await page.mouse.up();
    }
    if (hasCanvas) await overlay(page).focus();
    for (const key of ['Delete', 'ArrowRight', 'Shift+ArrowDown', 'Control+ArrowRight', 'Backspace', 'Tab', 'Escape']) await page.keyboard.press(key);
    await showTab(page, 'Components');
    for (const item of await page.locator('.dz-palette__item').all()) await item.click({ force: true, timeout: 500 }).catch(() => undefined);
    await showTab(page, 'Outline');
    for (const row of await page.locator('.dz-tree__row').all()) {
      await row.press('Delete').catch(() => undefined);
      await row.press('Alt+ArrowDown').catch(() => undefined);
      await row.dblclick({ timeout: 500 }).catch(() => undefined);
    }
    await showTab(page, 'Datasets');
    for (const button of await page.locator('.dz-datasets button').all()) await button.click({ force: true, timeout: 500 }).catch(() => undefined);
    await page.keyboard.press('Escape');
    await settled(page);
  };

  test('conflict markers: the banner says why and nothing is written', async ({ page }) => {
    const text = conflicted(await playground(page));
    await openDesigner(page, { text });
    await expect(banner(page)).toContainText('conflict');
    await expect(page.getByTestId('readonly-badge')).toBeVisible();
    await hammer(page);
    expect(await hostText(page)).toBe(text);
    expect(await hostApplied(page)).toEqual([]);
    expect(await page.evaluate(() => window.__host.canUndo)).toBe(false);
  });

  test('invalid JSON: the banner says where and nothing is written', async ({ page }) => {
    const text = broken(await playground(page));
    await openDesigner(page, { text });
    await expect(page.getByTestId('readonly-badge')).toBeVisible();
    await expect(banner(page)).toContainText("can't be edited here");
    await hammer(page);
    expect(await hostText(page)).toBe(text);
    expect(await hostApplied(page)).toEqual([]);
  });

  test('a file that becomes conflicted while open turns read-only, keeps the last good picture, and becomes editable again when fixed', async ({ page }) => {
    const good = await playground(page);
    await openDesigner(page, { text: good });
    await selectOnCanvas(page, 'btnA');
    const bad = conflicted(good);
    await page.evaluate((t) => window.__host.setText(t), bad);
    await expect(banner(page)).toBeVisible();
    await hammer(page);
    expect(await hostText(page)).toBe(bad);
    expect(await hostApplied(page)).toEqual([]);
    // Fixing it in the text editor brings the designer back.
    await page.evaluate((t) => window.__host.setText(t), good);
    await expect(banner(page)).toHaveCount(0);
    await showTab(page, 'Components');
    const box = await selectOnCanvas(page, 'btnA');
    await drag(page, { x: box.x + 4, y: box.y + 4 }, { x: box.x + 28, y: box.y + 4 });
    expect(await hostApplied(page)).toHaveLength(1);
  });

  test('a read-only host (?readOnly=1) writes nothing either', async ({ page }) => {
    const original = demoForm('EmployeeList');
    await openDesigner(page, { form: 'EmployeeList', readOnly: true });
    await expect(page.getByTestId('readonly-badge')).toBeVisible();
    await selectOnCanvas(page, 'addButton');
    await hammer(page);
    expect(await hostText(page)).toBe(original);
    expect(await hostApplied(page)).toEqual([]);
    // The inspector shows the values but can't change them.
    await showTab(page, 'Outline');
    await outlineRow(page, 'addButton').click();
    await expect(inspector(page).getByLabel('text', { exact: true })).toBeDisabled();
    await expect(leftTab(page, 'Outline')).toBeVisible();
  });
});
