import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './support.ts';

const OUTPUT = join(import.meta.dirname, '.output');
/** Tells the report which build the numbers came from. Set P3_LABEL=build when baseURL points at a build. */
const LABEL = process.env.P3_LABEL ?? 'dev-server';
const PATH = '/proof/p3.html';

interface Mismatch {
  id: string;
  type: string;
  expected: string | boolean;
  actual: string | boolean | null;
}
interface Verification {
  checked: number;
  mismatches: Mismatch[];
}
interface RunResult {
  count: number;
  counts: Record<string, number>;
  window: { start: number; end: number };
  totalMs: number;
  wallMsIncludingChecks: number;
  maxSingleChangeMs: number;
  meanChangeMs: number;
  checkpoints: { after: number; checked: number; mismatches: Mismatch[] }[];
  final: Verification;
}
interface Entry {
  id: string;
  type: string;
  page: string;
  expect: { kind: string; column?: string };
}

/** Calls a method (or reads a property) of the page's `window.p3`. Test plumbing, not product API. */
function p3<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    async ({ method, args }) => {
      const api = (window as unknown as { p3: Record<string, unknown> }).p3;
      const member = api[method];
      return typeof member === 'function' ? await (member as (...a: unknown[]) => unknown).apply(api, args) : member;
    },
    { method, args },
  ) as Promise<T>;
}

async function open(page: Page): Promise<void> {
  await page.goto(PATH);
  await p3(page, 'ready');
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

test.describe('P3: 300 components, 1,000 changes, hidden tab', () => {
  test('300 components render from JSON with no console errors', async ({ page }) => {
    await open(page);
    expect(await p3(page, 'definitionComponentCount')).toBe(300);
    expect(await p3(page, 'hostCount')).toBe(300);
    await expect(page.locator('.fw-host')).toHaveCount(300);
    // Nothing fell back to the placeholder or the error box.
    await expect(page.locator('.fw-host__placeholder, .fw-host__error')).toHaveCount(0);

    const types = await p3<Record<string, number>>(page, 'typeCounts');
    const main = (types.TextInput ?? 0) + (types.NumberInput ?? 0) + (types.Checkbox ?? 0) + (types.Label ?? 0);
    expect(main).toBeGreaterThan(200);
    for (const type of ['TextInput', 'NumberInput', 'Checkbox', 'Label', 'Panel', 'Tabs', 'ComboBox', 'RadioGroup', 'TextArea', 'Button']) {
      expect(types[type] ?? 0, `has ${type}`).toBeGreaterThan(0);
    }
    test.info().annotations.push({ type: 'types', description: JSON.stringify(types) });

    const result = await p3<Verification>(page, 'verify');
    expect(result.checked).toBeGreaterThan(250);
    expect(result.mismatches).toEqual([]);
  });

  test('1,000 scripted changes leave every bound input and label matching the Dataset', async ({ page }) => {
    await open(page);
    const run = await p3<RunResult>(page, 'runChanges', 1000, 20260707, 100);
    expect(run.count).toBe(1000);
    // A real mix: all four kinds were used.
    for (const kind of ['cell', 'otherRow', 'current', 'variable']) expect(run.counts[kind], kind).toBeGreaterThan(50);
    expect(run.checkpoints).toHaveLength(10);
    for (const checkpoint of run.checkpoints) {
      expect(checkpoint.mismatches, `after change ${checkpoint.after}`).toEqual([]);
      expect(checkpoint.checked).toBeGreaterThan(250);
    }
    expect(run.final.checked).toBeGreaterThan(250);
    expect(run.final.mismatches).toEqual([]);

    // Independent of the in-page check: read inputs on the visible page by role and name.
    const entries = await p3<Entry[]>(page, 'entries');
    const visible = entries.filter((e) => e.page === 'pageOne' && (e.type === 'TextInput' || e.type === 'NumberInput')).slice(0, 12);
    expect(visible.length).toBe(12);
    for (const e of visible) {
      const name = `${e.type === 'NumberInput' ? 'Number' : 'Text'} ${e.id}`;
      await expect(page.getByRole('textbox', { name, exact: true })).toHaveValue(String(await p3(page, 'expected', e.id)));
    }
    test.info().annotations.push({ type: 'run', description: JSON.stringify({ counts: run.counts, totalMs: run.totalMs }) });
  });

  test('exact long decimals show in full', async ({ page }) => {
    await open(page);
    // 18 integer digits and 12 places: more than a double can hold.
    const value = '123456789012345678.123456789012';
    const entries = await p3<Entry[]>(page, 'entries');
    const column = entries.find((e) => e.expect.kind === 'number' && e.page === 'pageOne')?.expect.column ?? '';
    expect(column).not.toBe('');
    await p3(page, 'setCurrent', 3);
    await p3(page, 'setValue', 3, column, value);
    await p3(page, 'settle');
    const numbers = entries.filter((e) => e.expect.kind === 'number' && e.expect.column === column && e.page === 'pageOne');
    expect(numbers.length).toBeGreaterThan(0);
    for (const e of numbers) await expect(page.locator(`.fw-host[data-id="${e.id}"] input`)).toHaveValue(value);
    const bound = entries.filter((e) => e.expect.kind === 'labelColumn' && e.expect.column === column);
    for (const e of bound) await expect(page.locator(`.fw-host[data-id="${e.id}"] .fw-label`)).toHaveText(value);
    // The sum label is exact too (its expected text is summed with BigInt in the page).
    const sums = entries.filter((e) => e.expect.kind === 'labelSum');
    expect(sums.length).toBeGreaterThan(0);
    expect((await p3<Verification>(page, 'verify')).mismatches).toEqual([]);
  });

  test('a hidden tab shows the latest values when it is revealed', async ({ page }) => {
    await open(page);
    const tabs = page.getByRole('tablist', { name: 'Pages' });
    await expect(tabs.getByRole('tab', { name: 'First' })).toHaveAttribute('aria-selected', 'true');
    // Hidden pages are not exposed as tabpanels (they have no role), so the page's own host is used.
    const secondPanel = page.locator('.fw-host[data-id="pageTwo"]');
    await expect(secondPanel).toBeHidden();
    expect((await p3<Verification>(page, 'verify', 'pageTwo')).mismatches).toEqual([]);

    // Change values bound on the hidden pages: cells of the current row, then another current row,
    // and variables.
    await page.evaluate(async () => {
      const p3 = (window as unknown as { p3: Record<string, (...a: unknown[]) => unknown> }).p3;
      const call = (name: string, ...args: unknown[]) => (p3[name] as (...a: unknown[]) => unknown)(...args);
      for (let c = 0; c < 10; c++) {
        call('setValue', 0, `t${c}`, `hidden edit ${c}`);
        call('setValue', 0, `n${c}`, `99999999999999999${c}.00000000000${c}`);
      }
      for (let b = 0; b < 5; b++) call('setValue', 0, `b${b}`, true);
      call('setVar', 'v0', 'changed while hidden');
      call('setVar', 'v1', 'also hidden');
      call('setVar', 'v2', 4242);
      await call('settle');
      call('setCurrent', 7);
      call('setValue', 7, 't2', 'row seven text');
      call('setValue', 7, 'n2', '1.000000000001');
      await call('settle');
    });
    await expect(secondPanel).toBeHidden();

    await tabs.getByRole('tab', { name: 'Second' }).click();
    await expect(secondPanel).toBeVisible();
    await expect(tabs.getByRole('tab', { name: 'Second' })).toHaveAttribute('aria-selected', 'true');
    const revealed = await p3<Verification>(page, 'verify', 'pageTwo');
    expect(revealed.checked).toBeGreaterThan(60);
    expect(revealed.mismatches).toEqual([]);
    expect((await p3<Verification>(page, 'verify', 'pageThree')).mismatches).toEqual([]);

    // What a user sees on the revealed page, found by accessible name.
    const entries = await p3<Entry[]>(page, 'entries');
    const firstText = entries.find((e) => e.page === 'pageTwo' && e.type === 'TextInput');
    expect(firstText).toBeDefined();
    const shown = page.getByRole('textbox', { name: `Text ${firstText?.id}`, exact: true });
    await expect(shown).toBeVisible();
    await expect(shown).toHaveValue(String(await p3(page, 'expected', firstText?.id)));

    // Hide it again, change more, and come back.
    await tabs.getByRole('tab', { name: 'Third' }).click();
    await p3(page, 'setValue', 7, 't3', 'after reveal');
    await p3(page, 'setCurrent', 12);
    await p3(page, 'settle');
    await tabs.getByRole('tab', { name: 'Second' }).click();
    expect((await p3<Verification>(page, 'verify')).mismatches).toEqual([]);
  });

  test('measurements (3 loads, each with 1,000 changes)', async ({ page }) => {
    test.setTimeout(180_000);
    const rows: Record<string, number>[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      await open(page);
      const timings = await p3<Record<string, number>>(page, 'timings');
      const run = await p3<RunResult>(page, 'runChanges', 1000, 20260708, 0);
      expect(run.final.mismatches).toEqual([]);
      const tasks = await p3<{ start: number; duration: number }[]>(page, 'longTasks');
      const renderWindow = await p3<{ start: number; end: number }>(page, 'renderWindow');
      expect(await p3<boolean>(page, 'longTaskSupported')).toBe(true);
      const inRender = tasks.filter((t) => t.start + t.duration >= renderWindow.start && t.start <= renderWindow.end + 50);
      const inChanges = tasks.filter((t) => t.start >= run.window.start && t.start <= run.window.end);
      const longest = (list: { duration: number }[]): number => (list.length ? Math.max(...list.map((t) => t.duration)) : 0);
      rows.push({
        createFormMs: timings.createFormMs ?? NaN,
        renderCommitMs: timings.renderCommitMs ?? NaN,
        createToNextFrameMs: timings.createToNextFrameMs ?? NaN,
        changes1000Ms: run.totalMs,
        meanChangeMs: run.meanChangeMs,
        maxSingleChangeMs: run.maxSingleChangeMs,
        longTasksDuringRender: inRender.length,
        longestLongTaskDuringRenderMs: longest(inRender),
        longTasksDuringChanges: inChanges.length,
        longestLongTaskDuringChangesMs: longest(inChanges),
      });
    }
    const summary = {
      label: LABEL,
      browser: test.info().project.use.channel ?? 'chromium (bundled)',
      runs: rows,
      median: Object.fromEntries(Object.keys(rows[0] ?? {}).map((k) => [k, median(rows.map((r) => r[k] as number))])),
    };
    mkdirSync(OUTPUT, { recursive: true });
    writeFileSync(join(OUTPUT, `p3-metrics-${LABEL}.json`), JSON.stringify(summary, null, 2));
    console.log(`P3 METRICS ${JSON.stringify(summary)}`);
  });
});
