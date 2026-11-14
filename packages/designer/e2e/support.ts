import { test as base, expect, type Locator, type Page } from '@playwright/test';

/** What the tests use of the development page's `window.__host` (packages/designer/dev/memory-host.ts). */
interface DevHost {
  readText(): string;
  setText(text: string): void;
  undo(): void;
  redo(): void;
  canUndo: boolean;
  canRedo: boolean;
  applied: string[];
  openedTextEditor: number;
  undoStack: unknown[];
  redoStack: unknown[];
}
declare global {
  interface Window {
    __host: DevHost;
  }
}

/**
 * Every test fails on a page error or a console error. The dev server has no favicon, so that one request is answered
 * with an empty response.
 */
export const test = base.extend<{ problems: string[] }>({
  problems: [
    async ({ page }, use) => {
      const problems: string[] = [];
      await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));
      page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
      page.on('console', (message) => {
        if (message.type() === 'error') problems.push(`console.error: ${message.text()}`);
      });
      await use(problems);
      expect(problems, 'no page errors or console errors').toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

export interface OpenOptions {
  form?: string;
  readOnly?: boolean;
  /** The text the host starts with, instead of the demo form's. */
  text?: string;
}

/** Opens the development page and waits until the canvas has drawn the form. */
export async function openDesigner(page: Page, options: OpenOptions = {}): Promise<void> {
  const query = new URLSearchParams();
  if (options.form) query.set('form', options.form);
  if (options.readOnly) query.set('readOnly', '1');
  if (options.text !== undefined) {
    // The page's module for that form's text is answered with this text, so the host starts with it, as opening a file would.
    const text = options.text;
    const name = options.form ?? 'EmployeeEdit';
    await page.route(new RegExp(String.raw`${name}\.form\.json\?.*raw`), (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: `export default ${JSON.stringify(text)};` }));
  }
  await page.goto(`/dev/index.html${query.size ? `?${query}` : ''}`);
  await expect(page.getByTestId('designer')).toBeVisible();
  await settled(page);
}

/** Replaces the host's text and forgets the undo history, as opening a new file would. */
export async function setHostText(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    window.__host.setText(t);
    window.__host.undoStack.length = 0;
    window.__host.redoStack.length = 0;
    window.__host.applied.length = 0;
  }, text);
}

/** The canvas frame has drawn the form, and a couple of frames have passed so the boxes message has arrived. */
export async function settled(page: Page): Promise<void> {
  // A form that can't be read has no canvas at all, only a message.
  await expect
    .poll(async () => (await page.locator('.dz-canvasarea .dz-empty').count()) + (await page.frameLocator('iframe[title="Form canvas"]').locator('.fw-form').count()), { message: 'the canvas drew the form' })
    .toBe(1);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForTimeout(80);
}

export const hostText = (page: Page): Promise<string> => page.evaluate(() => window.__host.readText());
export const hostApplied = (page: Page): Promise<string[]> => page.evaluate(() => [...window.__host.applied]);
export const hostUndo = async (page: Page): Promise<void> => {
  await page.evaluate(() => window.__host.undo());
  await settled(page);
};
export const hostRedo = async (page: Page): Promise<void> => {
  await page.evaluate(() => window.__host.redo());
  await settled(page);
};
/** The parts of a form file the tests read. Anything else stays unknown. */
export interface FormNode {
  id: string;
  type: string;
  layout: Record<string, number>;
  /** Tests read these only where the form has them, so they are not typed as optional. */
  props: {
    text?: string;
    variant?: string;
    disabled?: unknown;
    maxLength?: unknown;
    options: { value: unknown; label: unknown }[];
    columns: { id: string; width: number }[];
    headerRows: { cells: { text: string }[] }[];
    recordRows: { cells: { field: string; editor?: string }[] }[];
  };
  bind: Record<string, string>;
  events: Record<string, string>;
  children?: FormNode[];
}
export interface FormDoc {
  components: FormNode[];
  datasets: { id: string; columns: { id: string; [key: string]: unknown }[]; sampleRows: Record<string, unknown>[]; keys?: string[]; confirmUnsaved?: boolean }[];
  [key: string]: unknown;
}
export const hostParsed = async (page: Page): Promise<FormDoc> => JSON.parse(await hostText(page)) as FormDoc;

/** A component anywhere in the form, by id. */
export function findNode(list: readonly FormNode[], id: string): FormNode | undefined {
  for (const c of list) {
    if (c.id === id) return c;
    const inner = c.children ? findNode(c.children, id) : undefined;
    if (inner) return inner;
  }
  return undefined;
}
export async function nodeOf(page: Page, id: string): Promise<FormNode> {
  const found = findNode((await hostParsed(page)).components, id);
  if (!found) throw new Error(`no component ${id} in the text`);
  return found;
}

export const canvas = (page: Page) => page.frameLocator('iframe[title="Form canvas"]');
export const overlay = (page: Page): Locator => page.getByTestId('overlay');

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A component's box in page coordinates, from the canvas DOM. */
export async function boxOf(page: Page, id: string): Promise<Rect> {
  const box = await canvas(page).locator(`.fw-host[data-id="${id}"]`).boundingBox();
  if (!box) throw new Error(`no visible box for ${id}`);
  return box;
}

/** The form's own top-left, in page coordinates. */
export async function formOrigin(page: Page): Promise<{ x: number; y: number }> {
  const box = await canvas(page).locator('.fw-form').boundingBox();
  if (!box) throw new Error('no form');
  return { x: box.x, y: box.y };
}

/** Clicks a spot on a component (its top-left corner plus an inset) and checks it became the selection. */
export async function selectOnCanvas(page: Page, id: string, inset = { x: 4, y: 4 }): Promise<Rect> {
  const box = await boxOf(page, id);
  await page.mouse.click(box.x + inset.x, box.y + inset.y);
  await expect(page.getByTestId('selection')).toHaveAttribute('data-id', id);
  return box;
}

/** Drags with the real mouse in a few steps. */
export async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, options: { alt?: boolean; steps?: number } = {}): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  if (options.alt) await page.keyboard.down('Alt');
  await page.mouse.move(to.x, to.y, { steps: options.steps ?? 8 });
  await page.mouse.up();
  if (options.alt) await page.keyboard.up('Alt');
  await settled(page);
}

// ---- text comparison --------------------------------------------------------------------------

export interface LineDiff {
  removed: string[];
  added: string[];
}

/** A line diff by longest common subsequence: which lines were removed and which added. */
export function lineDiff(before: string, after: string): LineDiff {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  const table: number[][] = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) table[i]![j] = x[i] === y[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  }
  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      i++;
      j++;
    } else if (j >= y.length || (i < x.length && table[i + 1]![j]! >= table[i]![j + 1]!)) removed.push(x[i++]!);
    else added.push(y[j++]!);
  }
  return { removed, added };
}

/** A diff shown in a failure message. */
export const showDiff = (d: LineDiff): string => [...d.removed.map((l) => `- ${l}`), ...d.added.map((l) => `+ ${l}`)].join('\n');

// ---- panels ------------------------------------------------------------------------------------

export const inspector = (page: Page): Locator => page.getByRole('complementary', { name: 'Inspector' });
export const leftTab = (page: Page, name: 'Components' | 'Outline' | 'Datasets'): Locator => page.getByRole('tab', { name, exact: true });
export const outlineRow = (page: Page, id: string): Locator => page.locator(`.dz-tree__row[data-id="${id}"]`);
export const banner = (page: Page): Locator => page.getByTestId('readonly-banner');

export async function showTab(page: Page, name: 'Components' | 'Outline' | 'Datasets'): Promise<void> {
  await leftTab(page, name).click();
  await expect(leftTab(page, name)).toHaveAttribute('aria-selected', 'true');
}

/** Types into an inspector field and commits with Enter. */
export async function setField(page: Page, label: string, value: string): Promise<void> {
  const field = inspector(page).getByLabel(label, { exact: true });
  await field.fill(value);
  await field.press('Enter');
  await settled(page);
}

/** The "key=value" strings of every unknown (x_) key in a form text, counted. Gestures must never lose one. */
export function unknownKeys(text: string): Map<string, number> {
  const found = new Map<string, number>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        if (key.startsWith('x_')) {
          const entry = `${key}=${JSON.stringify(inner)}`;
          found.set(entry, (found.get(entry) ?? 0) + 1);
        }
        walk(inner);
      }
    }
  };
  walk(JSON.parse(text));
  return found;
}

/** The unknown keys that `before` had and `after` lacks. */
export function lostKeys(before: Map<string, number>, after: Map<string, number>): string[] {
  return [...before].filter(([key, count]) => (after.get(key) ?? 0) < count).map(([key]) => key);
}
