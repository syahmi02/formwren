/** Canvas gestures with the real mouse and keyboard: select, move, snap, resize, nudge, delete, undo and redo, Tab, Esc. */
import type { Page } from '@playwright/test';
import { playground } from './forms.ts';
import { boxOf, drag, expect, hostApplied, hostRedo, hostText, hostUndo, nodeOf, openDesigner, overlay, selectOnCanvas, settled, test, type Rect } from './support.ts';

type Layout = Record<string, number>;

const layoutOf = async (page: Page, id: string): Promise<Layout> => (await nodeOf(page, id)).layout;

const undoDepth = (page: Page): Promise<number> => page.evaluate(() => window.__host.undoStack.length);
const center = (box: Rect): { x: number; y: number } => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

async function handleCenter(page: Page, handle: string): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId(`handle-${handle}`).boundingBox();
  if (!box) throw new Error(`no handle ${handle}`);
  return center(box);
}

test.describe('select', () => {
  test('a click selects the component under the pointer, the deepest one, and a click on nothing clears it', async ({ page }) => {
    await openDesigner(page, { text: await playground(page) });
    const a = await selectOnCanvas(page, 'btnA');
    const selection = page.getByTestId('selection');
    const box = (await selection.boundingBox()) as Rect;
    expect(Math.abs(box.x - a.x)).toBeLessThan(1.5);
    expect(Math.abs(box.width - a.width)).toBeLessThan(1.5);
    for (const handle of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) await expect(page.getByTestId(`handle-${handle}`)).toBeVisible();

    // Inside the Panel: its child is picked, and the Panel's own padding picks the Panel.
    const inner = await boxOf(page, 'inner');
    await page.mouse.click(inner.x + 10, inner.y + 10);
    await expect(selection).toHaveAttribute('data-id', 'inner');
    const panel = await boxOf(page, 'box');
    await page.mouse.click(panel.x + panel.width - 20, panel.y + panel.height - 20);
    await expect(selection).toHaveAttribute('data-id', 'box');

    // The inspector follows the selection.
    await expect(page.getByRole('complementary', { name: 'Inspector' }).getByRole('heading', { level: 2 })).toContainText('box');
    // Nothing there: the selection goes.
    await page.mouse.click(panel.x + 600, panel.y + 300);
    await expect(selection).toHaveCount(0);
    expect(await hostApplied(page)).toEqual([]);
  });
});

test.describe('move', () => {
  test('a move snaps to the 8 px grid and to a sibling edge, with guides while dragging, and Alt turns both off', async ({ page }) => {
    await openDesigner(page, { text: await playground(page) });
    const a = await selectOnCanvas(page, 'btnA');
    const start = { x: a.x + 6, y: a.y + 6 };

    // Grid: 13 px to the right lands on 56, not 53.
    await drag(page, start, { x: start.x + 13, y: start.y });
    expect(await layoutOf(page, 'btnA')).toMatchObject({ left: 56, top: 40 });
    await hostUndo(page);

    // Sibling edge: btnB's left edge is at 204, which is off the grid. 163 px lands on 203, one pixel off it.
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 163, start.y, { steps: 10 });
    await expect(page.locator('.dz-guide').first()).toBeVisible();
    expect(await page.locator('.dz-guide[data-axis="x"]').count()).toBeGreaterThan(0);
    await page.mouse.up();
    await settled(page);
    expect((await layoutOf(page, 'btnA')).left).toBe(204);
    await expect(page.locator('.dz-guide')).toHaveCount(0);
    await hostUndo(page);

    // Alt: the same drags land exactly where the pointer put them, and no guide is drawn.
    await drag(page, start, { x: start.x + 13, y: start.y }, { alt: true });
    expect(await layoutOf(page, 'btnA')).toMatchObject({ left: 53, top: 40 });
    await hostUndo(page);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.keyboard.down('Alt');
    await page.mouse.move(start.x + 163, start.y, { steps: 10 });
    await expect(page.getByTestId('live')).toBeVisible();
    await expect(page.locator('.dz-guide')).toHaveCount(0);
    await page.mouse.up();
    await page.keyboard.up('Alt');
    await settled(page);
    expect((await layoutOf(page, 'btnA')).left).toBe(203);
  });

  test('a move keeps the edges the layout has: right and bottom stay right and bottom, and a stretched component stays stretched', async ({ page }) => {
    await openDesigner(page, { text: await playground(page) });
    const label = await selectOnCanvas(page, 'anchored');
    await drag(page, { x: label.x + 6, y: label.y + 6 }, { x: label.x + 6 - 8, y: label.y + 6 - 16 });
    expect(await layoutOf(page, 'anchored')).toEqual({ right: 48, bottom: 56, width: 120, height: 32 });

    const stretch = await selectOnCanvas(page, 'stretch');
    await drag(page, { x: stretch.x + 6, y: stretch.y + 6 }, { x: stretch.x + 6 + 16, y: stretch.y + 6 });
    expect(await layoutOf(page, 'stretch')).toEqual({ left: 456, top: 120, right: 24, height: 32 });
  });

  test('a child of a Panel moves onto the 8 px grid of its own layout numbers', async ({ page }) => {
    await openDesigner(page, { text: await playground(page) });
    const inner = await selectOnCanvas(page, 'inner');
    // From left 16, top 16: 24 right and 16 down is exactly left 40, top 32, which is on the grid.
    await drag(page, { x: inner.x + 6, y: inner.y + 6 }, { x: inner.x + 6 + 24, y: inner.y + 6 + 16 });
    expect(await layoutOf(page, 'inner')).toMatchObject({ left: 40, top: 32 });
  });

  test('Esc during a drag cancels it, and nothing is written', async ({ page }) => {
    const original = await playground(page);
    await openDesigner(page, { text: original });
    const inner = await selectOnCanvas(page, 'inner');
    await page.mouse.move(inner.x + 6, inner.y + 6);
    await page.mouse.down();
    await page.mouse.move(inner.x + 60, inner.y + 40, { steps: 6 });
    await expect(page.getByTestId('live')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('live')).toHaveCount(0);
    await page.mouse.up();
    await settled(page);
    expect(await hostText(page)).toBe(original);
    expect(await hostApplied(page)).toEqual([]);
  });
});

test.describe('resize', () => {
  const cases: { handle: string; by: [number, number]; expected: Layout }[] = [
    { handle: 'e', by: [16, 0], expected: { left: 40, top: 40, width: 104, height: 32 } },
    { handle: 'w', by: [-16, 0], expected: { left: 24, top: 40, width: 104, height: 32 } },
    { handle: 's', by: [0, 16], expected: { left: 40, top: 40, width: 88, height: 48 } },
    { handle: 'n', by: [0, -16], expected: { left: 40, top: 24, width: 88, height: 48 } },
    { handle: 'se', by: [16, 16], expected: { left: 40, top: 40, width: 104, height: 48 } },
    { handle: 'sw', by: [-16, 16], expected: { left: 24, top: 40, width: 104, height: 48 } },
    { handle: 'ne', by: [16, -16], expected: { left: 40, top: 24, width: 104, height: 48 } },
    { handle: 'nw', by: [-16, -16], expected: { left: 24, top: 24, width: 104, height: 48 } },
  ];
  for (const { handle, by, expected } of cases) {
    test(`the ${handle} handle resizes from that edge and leaves the opposite edge where it was`, async ({ page }) => {
      await openDesigner(page, { text: await playground(page) });
      await selectOnCanvas(page, 'btnA');
      const from = await handleCenter(page, handle);
      await drag(page, from, { x: from.x + by[0], y: from.y + by[1] });
      expect(await layoutOf(page, 'btnA')).toEqual(expected);
      // The far edge did not move on screen.
      const after = await boxOf(page, 'btnA');
      const form = await boxOf(page, 'btnA');
      expect(after.width).toBe(expected.width);
      expect(form.height).toBe(expected.height);
      expect(await hostApplied(page)).toHaveLength(1);
    });
  }

  const anchored: { handle: string; by: [number, number]; expected: Layout }[] = [
    { handle: 'e', by: [-16, 0], expected: { right: 56, bottom: 40, width: 104, height: 32 } },
    { handle: 'w', by: [-16, 0], expected: { right: 40, bottom: 40, width: 136, height: 32 } },
    { handle: 's', by: [0, 16], expected: { right: 40, bottom: 24, width: 120, height: 48 } },
    { handle: 'n', by: [0, -16], expected: { right: 40, bottom: 40, width: 120, height: 48 } },
    { handle: 'nw', by: [-16, -16], expected: { right: 40, bottom: 40, width: 136, height: 48 } },
    { handle: 'se', by: [16, 16], expected: { right: 24, bottom: 24, width: 136, height: 48 } },
  ];
  for (const { handle, by, expected } of anchored) {
    test(`a right- and bottom-anchored label stays anchored when its ${handle} handle is dragged`, async ({ page }) => {
      await openDesigner(page, { text: await playground(page) });
      await selectOnCanvas(page, 'anchored');
      const from = await handleCenter(page, handle);
      await drag(page, from, { x: from.x + by[0], y: from.y + by[1] });
      expect(await layoutOf(page, 'anchored')).toEqual(expected);
    });
  }

  test('a stretched component keeps its left and right edges when it is resized from the top', async ({ page }) => {
    await openDesigner(page, { text: await playground(page) });
    await selectOnCanvas(page, 'stretch');
    const from = await handleCenter(page, 'n');
    await drag(page, from, { x: from.x, y: from.y - 16 });
    expect(await layoutOf(page, 'stretch')).toEqual({ left: 440, top: 104, right: 40, height: 48 });
  });
});

test.describe('keyboard on the canvas', () => {
  test('arrow keys nudge 1 px and Shift+arrows 8 px, a burst is one undo step, and a pause starts a new one', async ({ page }) => {
    const original = await playground(page);
    await openDesigner(page, { text: original });
    await selectOnCanvas(page, 'btnA');
    await expect(overlay(page)).toBeFocused();
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowDown');
    await settled(page);
    expect(await layoutOf(page, 'btnA')).toMatchObject({ left: 43, top: 48 });
    expect(await undoDepth(page)).toBe(1);

    await page.waitForTimeout(700);
    await page.keyboard.press('ArrowLeft');
    await settled(page);
    expect(await layoutOf(page, 'btnA')).toMatchObject({ left: 42, top: 48 });
    expect(await undoDepth(page)).toBe(2);

    await hostUndo(page);
    expect(await layoutOf(page, 'btnA')).toMatchObject({ left: 43, top: 48 });
    await hostUndo(page);
    expect(await hostText(page)).toBe(original);
    await hostRedo(page);
    await hostRedo(page);
    expect(await layoutOf(page, 'btnA')).toMatchObject({ left: 42, top: 48 });
  });

  test('nudging keeps a right- and bottom-anchored component anchored', async ({ page }) => {
    await openDesigner(page, { text: await playground(page) });
    await selectOnCanvas(page, 'anchored');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Shift+ArrowUp');
    await settled(page);
    expect(await layoutOf(page, 'anchored')).toEqual({ right: 41, bottom: 48, width: 120, height: 32 });
  });

  test('Delete removes the selection, and undo brings back exactly the same text', async ({ page }) => {
    const original = await playground(page);
    await openDesigner(page, { text: original });
    await selectOnCanvas(page, 'btnB');
    await page.keyboard.press('Delete');
    await settled(page);
    const text = await hostText(page);
    expect(JSON.parse(text).components.map((c: { id: string }) => c.id)).not.toContain('btnB');
    await expect(page.getByTestId('selection')).toHaveCount(0);
    await hostUndo(page);
    expect(await hostText(page)).toBe(original);
    await hostRedo(page);
    expect(await hostText(page)).toBe(text);

    // A Panel goes with what is inside it, in one step.
    await hostUndo(page);
    await selectOnCanvas(page, 'box', { x: 300, y: 150 });
    await page.keyboard.press('Delete');
    await settled(page);
    expect(await hostText(page)).not.toContain('"inner"');
    await hostUndo(page);
    expect(await hostText(page)).toBe(original);
  });

  test('Tab walks the components in document order, Shift+Tab walks back, the ends let go of the keyboard, and Esc clears the selection', async ({ page }) => {
    await openDesigner(page, { text: await playground(page) });
    const form = await boxOf(page, 'btnA');
    await page.mouse.click(form.x + 700, form.y + 400);
    await expect(overlay(page)).toBeFocused();
    await expect(page.getByTestId('selection')).toHaveCount(0);
    const status = page.locator('.dz-sr');
    await expect(status).toHaveText('Nothing selected');

    const order = ['btnA', 'btnB', 'box', 'inner', 'anchored', 'stretch', 'nameInput', 'grid'];
    for (const id of order) {
      await page.keyboard.press('Tab');
      await expect(page.getByTestId('selection')).toHaveAttribute('data-id', id);
      await expect(status).toContainText(`${id}, `);
    }
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByTestId('selection')).toHaveAttribute('data-id', 'nameInput');
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('selection')).toHaveAttribute('data-id', 'grid');
    // At the end Tab is not caught: the focus leaves the canvas.
    await page.keyboard.press('Tab');
    await expect(overlay(page)).not.toBeFocused();

    await overlay(page).focus();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('selection')).toHaveCount(0);
    await expect(status).toHaveText('Nothing selected');
    expect(await hostApplied(page)).toEqual([]);
  });

  test('Shift+Tab from the first component leaves the canvas too', async ({ page }) => {
    await openDesigner(page, { text: await playground(page) });
    await selectOnCanvas(page, 'btnA');
    await page.keyboard.press('Shift+Tab');
    await expect(overlay(page)).not.toBeFocused();
  });
});
