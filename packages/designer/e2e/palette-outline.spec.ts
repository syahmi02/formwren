/** The palette (drag, Enter) and the outline (re-parent, reorder, rename, reveal), with the real mouse and keyboard. */
import type { Page } from '@playwright/test';
import { demoForm, playground } from './forms.ts';
import { boxOf, canvas, expect, formOrigin, hostApplied, hostParsed, hostText, hostUndo, inspector, openDesigner, outlineRow, overlay, selectOnCanvas, settled, showTab, test, drag, type Rect } from './support.ts';

const paletteItem = (page: Page, type: string) => page.locator(`.dz-palette__item[data-type="${type}"]`);

interface Node {
  id: string;
  type: string;
  layout: Record<string, number>;
  children?: Node[];
}
const find = (list: Node[], id: string): Node | undefined => {
  for (const c of list) {
    if (c.id === id) return c;
    const inner = c.children ? find(c.children, id) : undefined;
    if (inner) return inner;
  }
  return undefined;
};
const parentOf = (list: Node[], id: string, parent: Node | null = null): Node | null | undefined => {
  for (const c of list) {
    if (c.id === id) return parent;
    const inner = c.children ? parentOf(c.children, id, c) : undefined;
    if (inner !== undefined) return inner;
  }
  return undefined;
};
const components = async (page: Page): Promise<Node[]> => (await hostParsed(page)).components;
const topIds = async (page: Page): Promise<string[]> => (await components(page)).map((c) => c.id);

async function dragBetween(page: Page, from: Rect, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
  await settled(page);
}

/** The screen rectangle of a component, rounded, so before and after can be compared. */
const screenBox = async (page: Page, id: string): Promise<Rect> => {
  const b = await boxOf(page, id);
  return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
};

test.describe('palette', () => {
  test('lists the components in groups, and the items can be reached by Tab', async ({ page }) => {
    await openDesigner(page, { text: await playground(page) });
    const region = page.getByRole('region', { name: 'Component palette' });
    for (const group of ['Inputs', 'Actions', 'Display', 'Containers']) await expect(region.getByRole('region', { name: group })).toBeVisible();
    await expect(paletteItem(page, 'Button')).toBeVisible();
    await expect(paletteItem(page, 'Panel')).toBeVisible();
  });

  test('dragging an item onto empty canvas adds it at the top level, at the drop point on the grid, with a preview while dragging', async ({ page }) => {
    await openDesigner(page, { text: await playground(page) });
    const item = (await paletteItem(page, 'Button').boundingBox()) as Rect;
    const form = await formOrigin(page);
    const drop = { x: form.x + 600, y: form.y + 410 };
    await page.mouse.move(item.x + 10, item.y + 10);
    await page.mouse.down();
    await page.mouse.move(drop.x, drop.y, { steps: 10 });
    await expect(page.getByTestId('drop-indicator')).toBeVisible();
    await expect(page.getByTestId('drop-indicator')).toContainText('the form');
    await expect(page.getByTestId('drop-parent')).toHaveCount(0);
    await page.mouse.up();
    await settled(page);
    const list = await components(page);
    const added = list.at(-1) as Node;
    expect(added.type).toBe('Button');
    expect(list.length).toBe(8);
    expect(added.layout.left! % 8).toBe(0);
    expect(added.layout.top! % 8).toBe(0);
    expect(Math.abs(added.layout.left! - 600)).toBeLessThanOrEqual(8);
    expect(Math.abs(added.layout.top! - 410)).toBeLessThanOrEqual(8);
    // It is selected, one undo step, and the canvas draws it.
    await expect(page.getByTestId('selection')).toHaveAttribute('data-id', added.id);
    expect(await hostApplied(page)).toHaveLength(1);
    await expect(canvas(page).locator(`.fw-host[data-id="${added.id}"]`)).toBeVisible();
  });

  test('dragging onto a Panel adds into that Panel, highlights it while dragging, and the new component lands under the pointer', async ({ page }) => {
    await openDesigner(page, { text: await playground(page) });
    const item = (await paletteItem(page, 'TextInput').boundingBox()) as Rect;
    const panel = await boxOf(page, 'box');
    const drop = { x: panel.x + 200, y: panel.y + 120 };
    await page.mouse.move(item.x + 10, item.y + 10);
    await page.mouse.down();
    await page.mouse.move(drop.x, drop.y, { steps: 10 });
    await expect(page.getByTestId('drop-parent')).toBeVisible();
    await expect(page.getByTestId('drop-indicator')).toContainText('in box');
    await page.mouse.up();
    await settled(page);
    const list = await components(page);
    const panelNode = find(list, 'box') as Node;
    const added = panelNode.children!.at(-1) as Node;
    expect(added.type).toBe('TextInput');
    expect(list.length).toBe(7);
    const at = await boxOf(page, added.id);
    expect(Math.abs(at.x - drop.x), `the new component is at x ${at.x}, the pointer was at ${drop.x}`).toBeLessThanOrEqual(12);
    expect(Math.abs(at.y - drop.y), `the new component is at y ${at.y}, the pointer was at ${drop.y}`).toBeLessThanOrEqual(12);
  });

  test('a component dropped into a Panel has layout numbers on the 8 px grid', async ({ page }) => {
    await openDesigner(page, { text: await playground(page) });
    const item = (await paletteItem(page, 'Label').boundingBox()) as Rect;
    const panel = await boxOf(page, 'box');
    await dragBetween(page, item, { x: panel.x + 200, y: panel.y + 120 });
    const added = find(await components(page), 'box')!.children!.at(-1) as Node;
    expect(added.layout.left! % 8, `left ${added.layout.left}`).toBe(0);
    expect(added.layout.top! % 8, `top ${added.layout.top}`).toBe(0);
  });

  test('Esc during a palette drag, and a drop outside the canvas, add nothing', async ({ page }) => {
    const original = await playground(page);
    await openDesigner(page, { text: original });
    const item = (await paletteItem(page, 'Button').boundingBox()) as Rect;
    const form = await formOrigin(page);
    await page.mouse.move(item.x + 10, item.y + 10);
    await page.mouse.down();
    await page.mouse.move(form.x + 500, form.y + 400, { steps: 6 });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('drop-indicator')).toHaveCount(0);
    await page.mouse.up();
    await settled(page);
    expect(await hostText(page)).toBe(original);

    // Dropped on the inspector.
    const side = (await inspector(page).boundingBox()) as Rect;
    await dragBetween(page, item, { x: side.x + 40, y: side.y + 200 });
    expect(await hostText(page)).toBe(original);
    expect(await hostApplied(page)).toEqual([]);
  });

  test('Enter on a focused item adds it at the top level, below what is there, and selects it', async ({ page }) => {
    await openDesigner(page, { text: await playground(page) });
    await paletteItem(page, 'Label').focus();
    await page.keyboard.press('Enter');
    await settled(page);
    const list = await components(page);
    const added = list.at(-1) as Node;
    expect(added.type).toBe('Label');
    expect(added.layout.left).toBe(16);
    expect(added.layout.top! % 8).toBe(0);
    await expect(page.getByTestId('selection')).toHaveAttribute('data-id', added.id);
    expect(await hostApplied(page)).toHaveLength(1);
    await hostUndo(page);
    expect((await components(page)).length).toBe(list.length - 1);
  });

  test('Enter with a container selected adds into it', async ({ page }) => {
    await openDesigner(page, { text: await playground(page) });
    await selectOnCanvas(page, 'box', { x: 300, y: 150 });
    await expect(page.getByText('press Enter to add into box')).toBeVisible();
    await paletteItem(page, 'Checkbox').focus();
    await page.keyboard.press('Enter');
    await settled(page);
    const panel = find(await components(page), 'box') as Node;
    expect(panel.children!.map((c) => c.type)).toEqual(['Button', 'Checkbox']);
    // Not on top of the button that was there.
    const [a, b] = await Promise.all([boxOf(page, 'inner'), boxOf(page, panel.children![1]!.id)]);
    expect(b.y).toBeGreaterThanOrEqual(a.y + a.height);
  });
});

test.describe('outline', () => {
  test('shows the components as a tree with levels, and selecting a row selects it on the canvas', async ({ page }) => {
    await openDesigner(page, { text: await playground(page) });
    await showTab(page, 'Outline');
    const tree = page.getByRole('tree', { name: 'Components' });
    await expect(tree.getByRole('treeitem')).toHaveCount(8);
    await expect(outlineRow(page, 'inner')).toHaveAttribute('aria-level', '2');
    await expect(outlineRow(page, 'box')).toHaveAttribute('aria-level', '1');
    await outlineRow(page, 'inner').click();
    await expect(page.getByTestId('selection')).toHaveAttribute('data-id', 'inner');
    await expect(outlineRow(page, 'inner')).toHaveAttribute('aria-selected', 'true');
    // And the other way: a click on the canvas moves the outline's selection.
    await selectOnCanvas(page, 'btnB');
    await expect(outlineRow(page, 'btnB')).toHaveAttribute('aria-selected', 'true');
  });

  test('dragging a row into a container re-parents it and the component stays where it was on screen', async ({ page }) => {
    await openDesigner(page, { text: await playground(page) });
    await showTab(page, 'Outline');
    const before = await screenBox(page, 'btnB');
    const from = (await outlineRow(page, 'btnB').boundingBox()) as Rect;
    const target = (await outlineRow(page, 'box').boundingBox()) as Rect;
    await page.mouse.move(from.x + 20, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + 40, target.y + target.height / 2, { steps: 10 });
    await expect(outlineRow(page, 'box')).toHaveAttribute('data-drop', 'into');
    await page.mouse.up();
    await settled(page);
    const list = await components(page);
    expect(parentOf(list, 'btnB')?.id).toBe('box');
    expect(await screenBox(page, 'btnB')).toEqual(before);
    expect(await hostApplied(page)).toHaveLength(1);
  });

  test('dragging a row to the edge of another puts it before or after, at the same level', async ({ page }) => {
    await openDesigner(page, { text: await playground(page) });
    await showTab(page, 'Outline');
    const target = (await outlineRow(page, 'btnA').boundingBox()) as Rect;
    const from = (await outlineRow(page, 'anchored').boundingBox()) as Rect;
    await page.mouse.move(from.x + 20, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + 40, target.y + 2, { steps: 10 });
    await expect(outlineRow(page, 'btnA')).toHaveAttribute('data-drop', 'before');
    await page.mouse.up();
    await settled(page);
    expect((await topIds(page)).slice(0, 3)).toEqual(['anchored', 'btnA', 'btnB']);
  });

  test('Alt+Right moves into the container above, keeping the position on screen, and the row keeps the focus', async ({ page }) => {
    await openDesigner(page, { text: await playground(page) });
    await showTab(page, 'Outline');
    const before = await screenBox(page, 'anchored');
    await outlineRow(page, 'anchored').click();
    await outlineRow(page, 'anchored').press('Alt+ArrowRight');
    await settled(page);
    expect(parentOf(await components(page), 'anchored')?.id).toBe('box');
    await expect(outlineRow(page, 'anchored')).toBeFocused();
    await expect(outlineRow(page, 'anchored')).toHaveAttribute('aria-level', '2');
    expect(await screenBox(page, 'anchored')).toEqual(before);
  });

  test('Alt+Left moves out of a container to just after it, keeping the position on screen', async ({ page }) => {
    await openDesigner(page, { text: await playground(page) });
    await showTab(page, 'Outline');
    const before = await screenBox(page, 'inner');
    await outlineRow(page, 'inner').click();
    await outlineRow(page, 'inner').press('Alt+ArrowLeft');
    await settled(page);
    expect(parentOf(await components(page), 'inner')).toBeNull();
    expect((await topIds(page)).slice(2, 4)).toEqual(['box', 'inner']);
    expect(await screenBox(page, 'inner')).toEqual(before);
  });

  test('Alt+Left at the top level is refused and writes nothing', async ({ page }) => {
    const original = await playground(page);
    await openDesigner(page, { text: original });
    await showTab(page, 'Outline');
    await outlineRow(page, 'btnA').click();
    await outlineRow(page, 'btnA').press('Alt+ArrowLeft');
    await expect(page.getByRole('alert')).toContainText('top level');
    expect(await hostText(page)).toBe(original);
  });

  test('Alt+Right on a component with no container above is refused with a message', async ({ page }) => {
    const original = await playground(page);
    await openDesigner(page, { text: original });
    await showTab(page, 'Outline');
    await outlineRow(page, 'btnB').click();
    await outlineRow(page, 'btnB').press('Alt+ArrowRight');
    await expect(page.getByRole('alert')).toContainText('not a container');
    expect(await hostText(page)).toBe(original);
  });

  test('Alt+Up and Alt+Down reorder among siblings, and the ends do nothing', async ({ page }) => {
    const original = await playground(page);
    await openDesigner(page, { text: original });
    await showTab(page, 'Outline');
    await outlineRow(page, 'btnB').click();
    await outlineRow(page, 'btnB').press('Alt+ArrowUp');
    await settled(page);
    expect((await topIds(page)).slice(0, 2)).toEqual(['btnB', 'btnA']);
    await expect(outlineRow(page, 'btnB')).toBeFocused();
    await outlineRow(page, 'btnB').press('Alt+ArrowUp');
    await settled(page);
    expect(await hostApplied(page)).toHaveLength(1);
    await outlineRow(page, 'btnB').press('Alt+ArrowDown');
    await settled(page);
    expect(await hostText(page)).toBe(original);
    // The buttons do the same as the keys.
    await page.getByRole('button', { name: 'Down', exact: true }).click();
    await settled(page);
    expect((await topIds(page)).slice(0, 3)).toEqual(['btnA', 'box', 'btnB']);
  });

  test('arrow keys walk the tree, Right enters a container and Left leaves it', async ({ page }) => {
    await openDesigner(page, { text: await playground(page) });
    await showTab(page, 'Outline');
    await outlineRow(page, 'btnA').click();
    await outlineRow(page, 'btnA').focus();
    await page.keyboard.press('ArrowDown');
    await expect(outlineRow(page, 'btnB')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(outlineRow(page, 'box')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(outlineRow(page, 'inner')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(outlineRow(page, 'box')).toBeFocused();
    await page.keyboard.press('End');
    await expect(outlineRow(page, 'grid')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(outlineRow(page, 'btnA')).toBeFocused();
    await expect(page.getByTestId('selection')).toHaveAttribute('data-id', 'btnA');
  });

  test('renaming inline: Enter commits, the selection follows, Esc cancels, and a duplicate or invalid id is refused with a message', async ({ page }) => {
    const original = await playground(page);
    await openDesigner(page, { text: original });
    await showTab(page, 'Outline');
    const input = page.getByLabel('New id for btnA');

    await outlineRow(page, 'btnA').dblclick();
    await expect(input).toBeFocused();
    await input.fill('btnB');
    await input.press('Enter');
    await expect(page.getByRole('alert').filter({ hasText: 'already uses the id "btnB"' })).toBeVisible();
    expect(await hostText(page)).toBe(original);
    await input.fill('9bad');
    await input.press('Enter');
    await expect(page.getByRole('alert').filter({ hasText: 'letters, digits and underscores' })).toBeVisible();
    expect(await hostText(page)).toBe(original);
    await input.press('Escape');
    await expect(input).toHaveCount(0);
    expect(await hostText(page)).toBe(original);

    await outlineRow(page, 'btnA').focus();
    await page.keyboard.press('F2');
    await input.fill('btnFirst');
    await input.press('Enter');
    await settled(page);
    expect((await topIds(page))[0]).toBe('btnFirst');
    await expect(page.getByTestId('selection')).toHaveAttribute('data-id', 'btnFirst');
    await expect(outlineRow(page, 'btnFirst')).toBeFocused();
    expect(await hostApplied(page)).toHaveLength(1);
    expect((await hostText(page)).split('\n').length).toBe(original.split('\n').length);
    await hostUndo(page);
    expect(await hostText(page)).toBe(original);
  });

  test('the inspector id field also refuses a duplicate', async ({ page }) => {
    const original = await playground(page);
    await openDesigner(page, { text: original });
    await selectOnCanvas(page, 'btnA');
    const field = inspector(page).getByLabel('id', { exact: true });
    await field.fill('btnB');
    await field.press('Enter');
    await expect(inspector(page).getByRole('alert')).toContainText('already uses the id "btnB"');
    expect(await hostText(page)).toBe(original);
  });

  test('selecting a component on a hidden Tabs page reveals it on the canvas, and selecting one on the first page brings that page back', async ({ page }) => {
    await openDesigner(page, { form: 'EmployeeEdit' });
    await showTab(page, 'Outline');
    const hiddenRow = outlineRow(page, 'totalLabel');
    await expect(hiddenRow).toHaveAttribute('data-hidden', 'true');
    await expect(hiddenRow).toHaveAttribute('aria-label', /not shown on the canvas/);
    await expect(canvas(page).locator('.fw-host[data-id="totalLabel"]')).toBeHidden();

    await hiddenRow.click();
    await expect(page.getByTestId('selection')).toHaveAttribute('data-id', 'totalLabel');
    await expect(canvas(page).locator('.fw-host[data-id="totalLabel"]')).toBeVisible();
    await expect(outlineRow(page, 'totalLabel')).not.toHaveAttribute('data-hidden', 'true');
    await expect(outlineRow(page, 'nameInput')).toHaveAttribute('data-hidden', 'true');

    await outlineRow(page, 'nameInput').click();
    await expect(page.getByTestId('selection')).toHaveAttribute('data-id', 'nameInput');
    await expect(canvas(page).locator('.fw-host[data-id="nameInput"]')).toBeVisible();
    expect(await hostApplied(page)).toEqual([]);
    expect(await hostText(page)).toBe(demoForm('EmployeeEdit'));
  });

  test('Delete on an outline row removes that component', async ({ page }) => {
    const original = await playground(page);
    await openDesigner(page, { text: original });
    await showTab(page, 'Outline');
    await outlineRow(page, 'btnB').click();
    await outlineRow(page, 'btnB').press('Delete');
    await settled(page);
    expect(await topIds(page)).not.toContain('btnB');
    await hostUndo(page);
    expect(await hostText(page)).toBe(original);
    await expect(overlay(page)).toBeVisible();
    void drag;
  });
});
