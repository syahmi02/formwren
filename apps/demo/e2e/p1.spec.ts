/**
 * Proof test P1 (FRAMEWORK.md section 8): the Grid at 100,000 rows x 20 columns. The page is
 * apps/demo/proof/p1.html. Set P1_BASE_URL (and P1_LABEL) to run the same tests against a
 * production build served elsewhere.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { activeCell, activeDescendantIsValid, activePosition, cellAt, gridOf, headerCell, measureWindow, type WindowStats } from './grid-support.ts';
import { expect, test } from './support.ts';

const OUTPUT = join(import.meta.dirname, '.output');
const LABEL = process.env.P1_LABEL ?? 'dev-server';
const PATH = '/proof/p1.html';
if (process.env.P1_BASE_URL) test.use({ baseURL: process.env.P1_BASE_URL });

// N-4 limits. "No visible lag" is taken as: 95% of frames within two 60 Hz frames, and no single task over 100 ms.
const FIRST_PAINT_MS = 1000;
const SORT_MS = 1000;
const FRAME_P95_MS = 34;
const LONG_TASK_MS = 100;

const ROWS = 100_000;
/** Tracks: 0 status, 1 select, then the 20 columns in order (see p1.tsx). */
const TRACK = { id: 2, name: 3, dept: 4, hired: 8, active: 10, qty: 11, score: 12, price: 13, rate: 14, d0: 15, d6: 21 } as const;
const LAST_TRACK = 21;

interface Mismatch {
  where: string;
  expected: string;
  actual: string | null;
}
interface RenderCheck {
  label: string;
  rows: number;
  cells: number;
  first: number;
  last: number;
  mismatches: Mismatch[];
}

/** Calls a method (or reads a property) of the page's `window.p1`. Test plumbing, not product API. */
function p1<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    async ({ method, args }) => {
      const api = (window as unknown as { p1: Record<string, unknown> }).p1;
      const member = api[method];
      return typeof member === 'function' ? await (member as (...a: unknown[]) => unknown).apply(api, args) : member;
    },
    { method, args },
  ) as Promise<T>;
}

async function open(page: Page): Promise<Record<string, number>> {
  await page.goto(PATH);
  return p1<Record<string, number>>(page, 'ready');
}

const metrics: Record<string, unknown> = {};
function record(key: string, value: unknown): void {
  metrics[key] = value;
  mkdirSync(OUTPUT, { recursive: true });
  writeFileSync(join(OUTPUT, `p1-metrics-${LABEL}.json`), JSON.stringify({ label: LABEL, baseURL: process.env.P1_BASE_URL ?? 'dev server', ...metrics }, null, 2));
}

/** Dataset value through the page, as text. */
const valueOf = (page: Page, index: number, column: string): Promise<string | null> =>
  page.evaluate(
    ({ index, column }) => {
      const ds = (window as unknown as { p1: { ds: { getValue(i: number, c: string): unknown } } }).p1.ds;
      const v = ds.getValue(index, column);
      return v === null || v === undefined ? null : String(v);
    },
    { index, column },
  );

const editor = (page: Page) => page.locator('.fw-grid__editor-control');

test.describe('P1: Grid at 100,000 rows x 20 columns', () => {
  test('the form loads 100,000 rows x 20 columns, and the Grid renders only a window of them', async ({ page }) => {
    await open(page);
    expect(await p1<number>(page, 'rows')).toBe(ROWS);
    const columns = await p1<{ id: string }[]>(page, 'columns');
    expect(columns).toHaveLength(20);
    expect(await page.evaluate(() => (window as unknown as { p1: { ds: { rowCount: number } } }).p1.ds.rowCount)).toBe(ROWS);
    await expect(gridOf(page)).toHaveCount(1);
    await expect(gridOf(page)).toHaveAttribute('aria-rowcount', String(ROWS + 2 + 2));
    const rendered = await page.locator('.fw-grid__row').count();
    expect(rendered).toBeGreaterThan(20);
    expect(rendered).toBeLessThan(120);
    const check = await p1<RenderCheck>(page, 'verifyRendered', 'initial');
    expect(check.mismatches).toEqual([]);
    expect(check.cells).toBeGreaterThan(500);
  });

  test('merged multi-row headers span the columns and rows they claim', async ({ page }) => {
    await open(page);
    const rowH = await page.locator('.fw-grid__row').first().evaluate((el) => el.getBoundingClientRect().height);
    const box = async (text: string) => {
      const cell = headerCell(page, text);
      await expect(cell).toHaveCount(1);
      return (await cell.boundingBox()) as { x: number; y: number; width: number; height: number };
    };
    // Group over four columns: Dept 110, City 110, Code 90, Note 200.
    const text = await box('Text');
    expect(text.width).toBeCloseTo(110 + 110 + 90 + 200, 0);
    await expect(headerCell(page, 'Text')).toHaveAttribute('aria-colspan', '4');
    expect(text.height).toBeCloseTo(rowH, 0);
    const dept = await box('Dept');
    expect(dept.x).toBeCloseTo(text.x, 0);
    expect(dept.y).toBeGreaterThan(text.y + rowH - 2);
    // Group over seven 230 px columns.
    const longDecimals = await box('Long decimals');
    expect(longDecimals.width).toBeCloseTo(7 * 230, 0);
    await expect(headerCell(page, 'Long decimals')).toHaveAttribute('aria-colspan', '7');
    // Row span: Id and Name cover both header rows.
    const id = await box('Id');
    expect(id.height).toBeCloseTo(rowH * 2, 0);
    await expect(headerCell(page, 'Id')).toHaveAttribute('aria-rowspan', '2');
    await expect(headerCell(page, 'Name')).toHaveAttribute('aria-rowspan', '2');
    // Merged cells stay merged when scrolled to the far right.
    await page.locator('.fw-grid__scroller').evaluate((el) => (el.scrollLeft = el.scrollWidth));
    await p1(page, 'settle');
    const far = await box('Long decimals');
    expect(far.width).toBeCloseTo(7 * 230, 0);
  });

  test('left-frozen columns stay put through horizontal scroll, and nothing overlaps them', async ({ page }) => {
    await open(page);
    const scroller = page.locator('.fw-grid__scroller');
    const sample = async () =>
      page.evaluate(() => {
        const left = (el: Element | null) => el?.getBoundingClientRect().left ?? Number.NaN;
        const row = document.querySelector('.fw-grid__row[data-index="3"]') as HTMLElement;
        const cellOf = (track: number) => row.querySelector(`.fw-grid__cell[data-track="${track}"]`) as HTMLElement;
        const sc = document.querySelector('.fw-grid__scroller') as HTMLElement;
        const frozenRight = cellOf(3).getBoundingClientRect().right;
        // What is on top at a point just inside the frozen block's right edge, and just outside it.
        const rect = cellOf(3).getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        const inside = document.elementFromPoint(frozenRight - 6, midY)?.closest('.fw-grid__cell') as HTMLElement | null;
        const header = document.querySelector('.fw-grid__header .fw-grid__cell[data-frozen]') as HTMLElement;
        return {
          scrollLeft: sc.scrollLeft,
          rowFrozen: [0, 1, 2, 3].map((t) => left(cellOf(t))),
          header: left(header),
          footer: left(document.querySelector('.fw-grid__footer .fw-grid__cell[data-frozen]')),
          scrolled: left(cellOf(4)),
          insideTrack: inside?.dataset.track ?? null,
          insideIsRow: inside?.closest('.fw-grid__row')?.getAttribute('data-index') ?? null,
          frozenRight,
          dataFlag: [0, 1, 2, 3].map((t) => cellOf(t).hasAttribute('data-frozen')),
        };
      });
    const start = await sample();
    expect(start.dataFlag).toEqual([true, true, true, true]);
    const positions = [200, 777, 1500, 2600];
    for (const x of positions) {
      await scroller.evaluate((el, x) => (el.scrollLeft = x), x);
      await p1(page, 'settle');
      const now = await sample();
      expect(now.scrollLeft).toBeGreaterThan(100);
      expect(now.rowFrozen, `frozen record cells at scrollLeft ${now.scrollLeft}`).toEqual(start.rowFrozen);
      expect(now.header).toBe(start.header);
      expect(now.footer).toBe(start.footer);
      // The scrolling track 4 has moved left, under the frozen block, so it is not the cell on top just inside the edge.
      expect(now.scrolled).toBeLessThan(start.scrolled);
      expect(now.insideTrack, 'topmost cell inside the frozen block').toBe('3');
      expect(now.insideIsRow).toBe('3');
    }
  });

  test('footer count and exact totals match an independent BigInt computation', async ({ page }) => {
    await open(page);
    const footer = await p1<{ checked: number; mismatches: Mismatch[]; expected: Record<string, string> }>(page, 'verifyFooter');
    expect(footer.mismatches).toEqual([]);
    expect(footer.checked).toBe(13);
    // The expected values are 22+ digit numbers: check they really are beyond a double, and that the page shows every digit.
    const longTotal = footer.expected[String(TRACK.d0)] as string;
    expect(longTotal.replace(/[,.]/g, '').length).toBeGreaterThan(22);
    await expect(page.locator(`.fw-grid__footer .fw-grid__cell[aria-colindex="${TRACK.d0 + 1}"]`).first()).toHaveText(longTotal);
    await expect(page.locator('.fw-grid__footer')).toContainText('100,000');
    // Totals are over the whole Dataset, not the rows on screen: they stay the same at the far end.
    await page.locator('.fw-grid__scroller').evaluate((el) => (el.scrollTop = el.scrollHeight));
    await p1(page, 'settle');
    expect((await p1<{ mismatches: Mismatch[] }>(page, 'verifyFooter')).mismatches).toEqual([]);
  });

  test('the keyboard model: arrows, Tab, Home, End, Ctrl+Home, Ctrl+End, Page Up and Page Down', async ({ page }) => {
    await open(page);
    const pos = () => activePosition(page);
    await cellAt(page, 2, TRACK.name).click();
    await expect.poll(pos).toEqual([2, TRACK.name]);
    expect(await activeDescendantIsValid(page)).toBe(true);

    await page.keyboard.press('ArrowDown');
    await expect.poll(pos).toEqual([3, TRACK.name]);
    await page.keyboard.press('ArrowRight');
    await expect.poll(pos).toEqual([3, TRACK.dept]);
    await page.keyboard.press('ArrowUp');
    await expect.poll(pos).toEqual([2, TRACK.dept]);
    await page.keyboard.press('ArrowLeft');
    await expect.poll(pos).toEqual([2, TRACK.name]);

    await page.keyboard.press('Tab');
    await expect.poll(pos).toEqual([2, TRACK.dept]);
    await page.keyboard.press('Shift+Tab');
    await expect.poll(pos).toEqual([2, TRACK.name]);

    await page.keyboard.press('End');
    await expect.poll(pos).toEqual([2, LAST_TRACK]);
    // The last column is scrolled into view, and clear of the frozen block.
    const visible = await cellAt(page, 2, LAST_TRACK).evaluate((el) => {
      const sc = (el.closest('.fw-grid__scroller') as HTMLElement).getBoundingClientRect();
      const frozen = (el.closest('.fw-grid__row')?.querySelector('.fw-grid__cell[data-track="3"]') as HTMLElement).getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return { insideRight: r.right <= sc.right + 1, clearOfFrozen: r.left >= frozen.right - 1 };
    });
    expect(visible).toEqual({ insideRight: true, clearOfFrozen: true });
    await page.keyboard.press('Home');
    await expect.poll(pos).toEqual([2, 0]);
    // Track 0 is frozen, so it is on screen wherever the Grid is scrolled sideways.
    await expect(cellAt(page, 2, 0)).toBeInViewport();

    await page.keyboard.press('Control+End');
    await expect.poll(pos).toEqual([ROWS - 1, LAST_TRACK]);
    await expect(cellAt(page, ROWS - 1, LAST_TRACK)).toBeVisible();
    expect(await activeDescendantIsValid(page)).toBe(true);
    await page.keyboard.press('Control+Home');
    await expect.poll(pos).toEqual([0, 0]);
    expect(await page.locator('.fw-grid__scroller').evaluate((el) => el.scrollTop)).toBe(0);

    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect.poll(pos).toEqual([0, 3]);
    await page.keyboard.press('PageDown');
    const afterDown = (await pos()) as [number, number];
    await expect.poll(async () => (await pos())?.[0]).toBeGreaterThan(10);
    const jump = ((await pos()) as [number, number])[0];
    expect(jump).toBeLessThan(40);
    expect(afterDown[1]).toBe(TRACK.name);
    await page.keyboard.press('PageDown');
    await expect.poll(async () => (await pos())?.[0]).toBe(jump * 2);
    await page.keyboard.press('PageUp');
    await expect.poll(async () => (await pos())?.[0]).toBe(jump);
    await page.keyboard.press('PageUp');
    await expect.poll(pos).toEqual([0, TRACK.name]);
    // PageUp at the top stays at the top.
    await page.keyboard.press('PageUp');
    await expect.poll(pos).toEqual([0, TRACK.name]);
    expect((await p1<RenderCheck>(page, 'verifyRendered', 'after keys')).mismatches).toEqual([]);
  });

  test('Enter, F2 and typing open the editor; Esc cancels; typing replaces the text', async ({ page }) => {
    await open(page);
    const name1 = (await valueOf(page, 1, 'name')) as string;
    await cellAt(page, 1, TRACK.name).click();
    await expect.poll(() => activePosition(page)).toEqual([1, TRACK.name]);
    await expect(editor(page)).toHaveCount(0);

    await page.keyboard.press('Enter');
    await expect(editor(page)).toHaveValue(name1);
    await expect(editor(page)).toBeFocused();
    await expect(editor(page)).toHaveAttribute('aria-label', 'Name');
    await page.keyboard.press('Escape');
    await expect(editor(page)).toHaveCount(0);
    await expect(gridOf(page)).toBeFocused();
    expect(await valueOf(page, 1, 'name')).toBe(name1);
    expect(await activePosition(page)).toEqual([1, TRACK.name]);

    await page.keyboard.press('F2');
    await expect(editor(page)).toHaveValue(name1);
    await page.keyboard.press('Escape');
    await expect(editor(page)).toHaveCount(0);

    // Typing starts editing, and the typed character replaces the value.
    await page.keyboard.press('q');
    await expect(editor(page)).toHaveValue('q');
    await expect(editor(page)).toBeFocused();
    await page.keyboard.press('Escape');
    expect(await valueOf(page, 1, 'name')).toBe(name1);
    expect(await cellAt(page, 1, TRACK.name).textContent()).toBe(name1);

    // A number cell opens on a digit or sign, and not on a letter.
    await page.keyboard.press('Control+End');
    await expect.poll(() => activePosition(page)).toEqual([ROWS - 1, LAST_TRACK]);
    await page.keyboard.press('x');
    await expect(editor(page)).toHaveCount(0);
    await page.keyboard.press('-');
    await expect(editor(page)).toHaveValue('-');
    await page.keyboard.press('Escape');
    await expect(editor(page)).toHaveCount(0);
  });

  test('the text editor commits on Enter and moves down; Tab commits and moves right', async ({ page }) => {
    await open(page);
    await cellAt(page, 5, TRACK.name).click();
    await expect.poll(() => activePosition(page)).toEqual([5, TRACK.name]);
    const rowId = (await activeCell(page))?.rowId as number;
    await page.keyboard.press('F2');
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Zed Zulu');
    await page.keyboard.press('Enter');
    await expect(editor(page)).toHaveCount(0);
    expect(await valueOf(page, 5, 'name')).toBe('Zed Zulu');
    await p1(page, 'shadowSet', rowId, 'name', 'Zed Zulu');
    await expect(cellAt(page, 5, TRACK.name)).toHaveText('Zed Zulu');
    await expect(cellAt(page, 5, 0)).toHaveText('U');
    await expect.poll(() => activePosition(page)).toEqual([6, TRACK.name]);
    expect(await activeDescendantIsValid(page)).toBe(true);

    // Typing a character, then Tab: the character replaced the value, and focus moves right.
    const rowId6 = (await activeCell(page))?.rowId as number;
    await page.keyboard.type('Yankee');
    await expect(editor(page)).toHaveValue('Yankee');
    await page.keyboard.press('Tab');
    await expect.poll(() => activePosition(page)).toEqual([6, TRACK.dept]);
    expect(await valueOf(page, 6, 'name')).toBe('Yankee');
    await p1(page, 'shadowSet', rowId6, 'name', 'Yankee');
    await expect(cellAt(page, 6, TRACK.name)).toHaveText('Yankee');
    expect((await p1<RenderCheck>(page, 'verifyRendered', 'after text edits')).mismatches).toEqual([]);
    expect((await p1<{ mismatches: Mismatch[] }>(page, 'verifyShadow')).mismatches).toEqual([]);
  });

  test('the number editor keeps every digit of a long decimal, refuses text, and the footer follows exactly', async ({ page }) => {
    await open(page);
    const exact = '-123456789012345678.123456789012';
    await cellAt(page, 4, TRACK.d0).click();
    await expect.poll(() => activePosition(page)).toEqual([4, TRACK.d0]);
    const rowId = (await activeCell(page))?.rowId as number;
    await page.keyboard.press('Enter');
    await page.keyboard.press('Control+A');
    await page.keyboard.type(exact);
    await page.keyboard.press('Enter');
    await expect(editor(page)).toHaveCount(0);
    expect(await valueOf(page, 4, 'd0')).toBe(exact);
    await p1(page, 'shadowSet', rowId, 'd0', exact);
    await expect(cellAt(page, 4, TRACK.d0)).toHaveText('-123,456,789,012,345,678.123456789012');
    await expect(cellAt(page, 4, 0)).toHaveText('U');
    // The footer sum and average moved by exactly this much: checked against the independent computation.
    await expect.poll(async () => (await p1<{ mismatches: Mismatch[] }>(page, 'verifyFooter')).mismatches).toEqual([]);

    // Text that is not a number stays in the editor, marked invalid, and writes nothing.
    await cellAt(page, 7, TRACK.price).click();
    await expect.poll(() => activePosition(page)).toEqual([7, TRACK.price]);
    const priceBefore = await valueOf(page, 7, 'price');
    await page.keyboard.press('F2');
    await page.keyboard.press('Control+A');
    await page.keyboard.type('12x');
    await page.keyboard.press('Enter');
    await expect(editor(page)).toHaveAttribute('aria-invalid', 'true');
    expect(await valueOf(page, 7, 'price')).toBe(priceBefore);
    await page.keyboard.press('Escape');
    await expect(editor(page)).toHaveCount(0);
    expect(await valueOf(page, 7, 'price')).toBe(priceBefore);
    // An int column and a two-place decimal column take their values too.
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect.poll(() => activePosition(page)).toEqual([7, TRACK.price + 2]);
    expect((await p1<RenderCheck>(page, 'verifyRendered', 'after number edits')).mismatches).toEqual([]);
    expect((await p1<{ mismatches: Mismatch[] }>(page, 'verifyShadow')).mismatches).toEqual([]);
  });

  test('1,000 scripted edits leave the DOM matching the Dataset at every scroll position', async ({ page }) => {
    test.setTimeout(600_000);
    await open(page);
    const result = await p1<{
      ops: number;
      counts: Record<string, number>;
      totalMs: number;
      checkpoints: { after: number; renderedRows: number; cells: number; renderedMismatches: number; shadowMismatches: number; footerMismatches: number; sample: Mismatch[] }[];
    }>(page, 'runScript', 1000, 20260711, 100);
    record('scriptedEdits', { ops: result.ops, counts: result.counts, totalMs: Math.round(result.totalMs), checkpoints: result.checkpoints.length });
    expect(result.ops).toBe(1000);
    expect(Object.values(result.counts).reduce((a, b) => a + b, 0)).toBe(1000);
    for (const kind of ['setVisible', 'setOffscreen', 'setNull', 'insert', 'remove', 'setCurrent', 'sort', 'scroll']) {
      expect(result.counts[kind] ?? 0, `the script includes ${kind}`).toBeGreaterThan(10);
    }
    expect(result.checkpoints).toHaveLength(10);
    for (const cp of result.checkpoints) {
      expect(cp.renderedMismatches + cp.shadowMismatches + cp.footerMismatches, `checkpoint after ${cp.after}: ${JSON.stringify(cp.sample)}`).toBe(0);
      expect(cp.cells).toBeGreaterThan(500);
    }

    // Final state: the model is what the shadow says, and the footer is exact.
    const shadow = await p1<{ checked: number; mismatches: Mismatch[] }>(page, 'verifyShadow');
    expect(shadow.mismatches).toEqual([]);
    expect(shadow.checked).toBeGreaterThan(1_900_000);
    expect((await p1<{ checked: number; mismatches: Mismatch[] }>(page, 'verifyFooter')).mismatches).toEqual([]);

    // The DOM against the model, at many vertical and horizontal positions: both ends, short steps, odd offsets and the middle.
    const size = await page.locator('.fw-grid__scroller').evaluate((el) => ({ h: el.scrollHeight - el.clientHeight, w: el.scrollWidth - el.clientWidth }));
    const rows = await page.evaluate(() => (window as unknown as { p1: { ds: { rowCount: number } } }).p1.ds.rowCount);
    const tops = [0, 1, 27, 28, 29, 500, 12_345, 99_999, 1_000_000, Math.floor(size.h / 2), size.h - 700, size.h - 1, size.h, 777_777, 2_345_678];
    const positions: [number, number][] = tops.map((top, i) => [Math.min(top, size.h), [0, 0, 640, 1100, size.w, Math.floor(size.w / 3)][i % 6] as number]);
    const checks = await p1<RenderCheck[]>(page, 'verifyAt', positions);
    expect(checks).toHaveLength(positions.length);
    for (const c of checks) expect(c.mismatches, `${c.label}: ${JSON.stringify(c.mismatches.slice(0, 5))}`).toEqual([]);
    expect(Math.min(...checks.map((c) => c.rows))).toBeGreaterThan(20);
    record('scriptedEditsFinal', { rowsInDataset: rows, positionsChecked: checks.length, renderedCellsChecked: checks.reduce((n, c) => n + c.cells, 0) });
    // The rows at the very end exist: the last row is reachable and correct.
    const end = await p1<RenderCheck[]>(page, 'verifyAt', [[size.h, 0]]);
    expect(end[0]?.last).toBe(rows - 1);
    expect(end[0]?.mismatches).toEqual([]);
  });

  test('N-4 measurements: first paint, scrolling, moving between cells, sort', async ({ page }) => {
    test.setTimeout(300_000);
    const timings = await open(page);
    const longTaskSupported = await p1<boolean>(page, 'longTaskSupported');
    expect(longTaskSupported).toBe(true);
    const out: Record<string, unknown> = {
      browser: test.info().project.use.channel ?? 'chromium (bundled)',
      userAgent: await page.evaluate(() => navigator.userAgent),
      timings,
    };
    const initialTasks = await p1<{ start: number; duration: number }[]>(page, 'longTasks');
    out.longTasksDuringLoad = initialTasks.map((t) => Math.round(t.duration));

    // Scrolling, in the page, one step per frame.
    const scroll: Record<string, unknown> = {};
    for (const kind of ['scrollSteady', 'scrollPages', 'scrollDragAll'] as const) {
      const r = await p1<{ frameMs: { p95: number; p99: number; max: number }; framesOver34ms: number; longTasks: number; longestTaskMs: number; mismatchesAfter: number; sample: unknown[] }>(page, kind);
      scroll[kind] = r;
      expect(r.mismatchesAfter, `${kind} leaves the DOM matching the Dataset: ${JSON.stringify(r.sample)}`).toBe(0);
    }
    out.scroll = scroll;

    // Moving between cells with real key presses, with the page recording frames and long tasks meanwhile.
    await cellAt(page, 0, TRACK.name).click();
    await expect.poll(() => activePosition(page)).toEqual([0, TRACK.name]);
    const keys: Record<string, WindowStats> = {};
    keys.arrowDown150 = await measureWindow(page, async () => {
      for (let i = 0; i < 150; i++) await page.keyboard.press('ArrowDown');
    });
    await expect.poll(() => activePosition(page)).toEqual([150, TRACK.name]);
    keys.arrowRightLeft = await measureWindow(page, async () => {
      for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowRight');
      for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowLeft');
    });
    keys.tabWrap100 = await measureWindow(page, async () => {
      for (let i = 0; i < 100; i++) await page.keyboard.press('Tab');
    });
    keys.pageDown60 = await measureWindow(page, async () => {
      for (let i = 0; i < 60; i++) await page.keyboard.press('PageDown');
    });
    keys.ctrlEndHome = await measureWindow(page, async () => {
      await page.keyboard.press('Control+End');
      await expect.poll(() => activePosition(page)).toEqual([ROWS - 1, LAST_TRACK]);
      await page.keyboard.press('Control+Home');
      await expect.poll(() => activePosition(page)).toEqual([0, 0]);
    });
    out.keyboardRealKeys = keys;
    // The same moves with the driver out of the loop: key event, then the frame after it.
    await cellAt(page, 0, TRACK.name).click();
    const latency = await p1<{ p50: number; p95: number; max: number }>(page, 'keyLatency', 'ArrowDown', 300);
    out.keyToPaintMsSynthetic = latency;
    expect(await activeDescendantIsValid(page)).toBe(true);

    // Sort: click a header, time until the rows are painted. Click again for descending, once more for none.
    const sorts: Record<string, { clickToPaintMs: number; ariaSort: string | null }> = {};
    const sortRuns: [string, string, string, 'order' | 'plain'][] = [
      ['Qty', 'qty', 'int', 'order'],
      ['Dec 0', 'd0', 'decimal', 'order'],
      ['Name', 'name', 'string', 'plain'],
      ['Hired', 'hired', 'date', 'plain'],
      ['Created', 'created', 'datetime', 'plain'],
      ['Score', 'score', 'float', 'plain'],
    ];
    for (const [label, column, type, kind] of sortRuns) {
      const asc = await p1<{ clickToPaintMs: number; ariaSort: string | null; sortKeys: string }>(page, 'sortClick', label);
      expect(asc.ariaSort).toBe('ascending');
      if (kind === 'order') expect(await p1<{ ok: boolean }>(page, 'orderCheck', column, false)).toMatchObject({ ok: true });
      const desc = await p1<{ clickToPaintMs: number; ariaSort: string | null }>(page, 'sortClick', label);
      expect(desc.ariaSort).toBe('descending');
      if (kind === 'order') expect(await p1<{ ok: boolean }>(page, 'orderCheck', column, true)).toMatchObject({ ok: true });
      const none = await p1<{ clickToPaintMs: number; ariaSort: string | null }>(page, 'sortClick', label);
      expect(none.ariaSort).toBe('none');
      sorts[`${label} (${type})`] = { clickToPaintMs: Math.max(asc.clickToPaintMs, desc.clickToPaintMs, none.clickToPaintMs), ariaSort: 'asc, desc, none' };
      sorts[`${label} (${type}) ascending`] = asc;
      sorts[`${label} (${type}) descending`] = desc;
      sorts[`${label} (${type}) none`] = none;
    }
    // Two keys: Dept, then Shift+Qty.
    await p1(page, 'sortClick', 'Dept');
    const two = await p1<{ clickToPaintMs: number; sortKeys: string }>(page, 'sortClick', 'Qty', true);
    sorts['Dept then Shift+Qty'] = { clickToPaintMs: two.clickToPaintMs, ariaSort: two.sortKeys };
    out.sortClickToPaint = sorts;
    // A real mouse click through the driver, wall clock, as an upper bound that includes protocol overhead.
    await p1(page, 'sortClick', 'Dept'); // to descending
    await p1(page, 'sortClick', 'Dept'); // to none
    await headerCell(page, 'Name').click(); // reset focus path
    const t0 = Date.now();
    await headerCell(page, 'Dec 3').click();
    await expect(headerCell(page, 'Dec 3')).toHaveAttribute('aria-sort', 'ascending');
    await p1(page, 'afterPaint');
    out.realMouseSortWallMs = Date.now() - t0;
    const finalCheck = await p1<RenderCheck>(page, 'verifyRendered', 'after sorts');
    expect(finalCheck.mismatches).toEqual([]);

    record('n4', out);
    console.log(`P1 N-4 (${LABEL}) ${JSON.stringify(out)}`);

    expect(timings.firstPaintMs, 'first paint, from createForm to the painted frame with rows').toBeLessThanOrEqual(FIRST_PAINT_MS);
    for (const [kind, r] of Object.entries(scroll)) {
      const s = r as { frameMs: { p95: number }; longestTaskMs: number };
      expect.soft(s.frameMs.p95, `${kind} p95 frame time`).toBeLessThanOrEqual(FRAME_P95_MS);
      expect.soft(s.longestTaskMs, `${kind} longest task`).toBeLessThanOrEqual(LONG_TASK_MS);
    }
    for (const [kind, w] of Object.entries(keys)) {
      expect.soft(w.frames.p95, `${kind} p95 frame time`).toBeLessThanOrEqual(FRAME_P95_MS);
      expect.soft(w.longestTaskMs, `${kind} longest task`).toBeLessThanOrEqual(LONG_TASK_MS);
    }
    expect.soft(latency.p95, 'key to paint p95').toBeLessThanOrEqual(FRAME_P95_MS * 2);
    for (const [name, s] of Object.entries(sorts)) expect.soft(s.clickToPaintMs, `sort ${name}`).toBeLessThanOrEqual(SORT_MS);
  });
});
