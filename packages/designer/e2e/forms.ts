import type { Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Playwright's own loader can't import `@fw/format` (its schema is a JSON import that Vite handles and plain Node
 * refuses), so the writer, the printer and the checker run in the dev page, which already serves them through Vite.
 */
const ROOT = join(import.meta.dirname, '../../..').replaceAll('\\', '/');
const FORMAT_URL = `/@fs/${ROOT}/packages/format/src/index.ts`;
const METAS_URL = `/@fs/${ROOT}/packages/components/src/meta/index.ts`;

export interface Diag {
  severity: string;
  message: string;
  path?: string;
}

async function inPage<T>(page: Page, fn: (urls: { format: string; metas: string }, arg: unknown) => Promise<T>, arg: unknown): Promise<T> {
  if (page.url() === 'about:blank') await page.goto('/dev/index.html?form=EmployeeList');
  return page.evaluate(`(${fn.toString()})(${JSON.stringify({ format: FORMAT_URL, metas: METAS_URL })}, ${JSON.stringify(arg)})`) as Promise<T>;
}

/** The writer's standard layout of a value. */
export const printStandard = (page: Page, value: unknown): Promise<string> =>
  inPage(page, async (u, v) => (await import(/* @vite-ignore */ u.format)).printForm(v), value);

/** `writeFormText(text, JSON.parse(text))`: saving the unchanged form. */
export const saveUnchanged = (page: Page, text: string): Promise<string> =>
  inPage(page, async (u, t) => (await import(/* @vite-ignore */ u.format)).writeFormText(t as string, JSON.parse(t as string)), text);

/** `fw check` without the TypeScript step: schema and semantic checks with the component descriptions. */
export const check = (page: Page, text: string): Promise<Diag[]> =>
  inPage(
    page,
    async (u, t) => {
      const { validateForm } = await import(/* @vite-ignore */ u.format);
      const { componentMetas } = await import(/* @vite-ignore */ u.metas);
      return validateForm(JSON.parse(t as string), { components: componentMetas });
    },
    text,
  );
export const checkErrors = async (page: Page, text: string): Promise<Diag[]> => (await check(page, text)).filter((d) => d.severity === 'error');

/** The demo's form file, as the dev page loads it. */
export const demoForm = (name: string): string => readFileSync(join(import.meta.dirname, '../../../apps/demo/src/forms', `${name}.form.json`), 'utf8');

/**
 * A small form with known geometry for the gestures. Every edge is on the 8 px grid, so a drag of a multiple of 8
 * lands on a predictable number. `btnB` sits on a sibling edge that is off the grid, to tell the snaps apart.
 */
export function playgroundObject(): Record<string, unknown> {
  return {
    formatVersion: 1,
    id: 'test.Playground',
    title: 'Playground',
    size: { width: 800, height: 560 },
    datasets: [
      {
        id: 'dsA',
        columns: [
          { id: 'name', type: 'string', size: 20 },
          { id: 'qty', type: 'int' },
        ],
        sampleRows: [{ name: 'Apple', qty: 3 }],
      },
    ],
    components: [
      { id: 'btnA', type: 'Button', layout: { left: 40, top: 40, width: 88, height: 32 }, props: { text: 'A' }, events: { click: 'onA' } },
      { id: 'btnB', type: 'Button', layout: { left: 204, top: 48, width: 88, height: 32 }, props: { text: 'B' } },
      {
        id: 'box',
        type: 'Panel',
        layout: { left: 40, top: 120, width: 360, height: 200 },
        props: { title: 'Box' },
        children: [{ id: 'inner', type: 'Button', layout: { left: 16, top: 16, width: 88, height: 32 }, props: { text: 'In' } }],
      },
      { id: 'anchored', type: 'Label', layout: { right: 40, bottom: 40, width: 120, height: 32 }, props: { text: 'Anchored' } },
      { id: 'stretch', type: 'Label', layout: { left: 440, top: 120, right: 40, height: 32 }, props: { text: 'Stretch' } },
      { id: 'nameInput', type: 'TextInput', layout: { left: 440, top: 200, width: 240, height: 56 }, props: { label: 'Name' }, bind: { value: 'dsA.name' } },
      {
        id: 'grid',
        type: 'Grid',
        layout: { left: 40, top: 344, width: 400, height: 120 },
        props: {
          columns: [
            { id: 'name', width: 200 },
            { id: 'qty', width: 100 },
          ],
          headerRows: [{ cells: [{ text: 'Name' }, { text: 'Qty' }] }],
          recordRows: [{ cells: [{ field: 'name', editor: 'text' }, { field: 'qty', editor: 'number' }] }],
        },
        bind: { dataset: 'dsA' },
      },
    ],
  };
}

const cache = new Map<string, string>();
async function cached(page: Page, key: string, make: () => unknown): Promise<string> {
  const known = cache.get(key);
  if (known !== undefined) return known;
  const text = await printStandard(page, make());
  cache.set(key, text);
  return text;
}
export const playground = (page: Page): Promise<string> => cached(page, 'playground', playgroundObject);

/** A text that is a valid, almost empty form, for the journey. */
export const emptyForm = (page: Page): Promise<string> =>
  cached(page, 'empty', () => ({
    formatVersion: 1,
    id: 'test.NewScreen',
    title: 'New screen',
    size: { width: 800, height: 560 },
    components: [],
  }));

/** Unknown keys at every level the designer touches. A tool that rebuilds the file from a model would lose them. */
export const withUnknownKeys = (page: Page): Promise<string> => cached(page, 'unknown', unknownKeysObject);
function unknownKeysObject(): unknown {
  const form = JSON.parse(JSON.stringify(playgroundObject()));
  form.x_owner = 'team-a';
  form.size.x_note = 'keep';
  form.datasets[0].x_ds = { a: 1 };
  form.datasets[0].columns[0].x_col = true;
  const comps: { id: string; layout: Record<string, unknown>; props?: Record<string, unknown>; children: Record<string, unknown>[]; [key: string]: unknown }[] = form.components;
  for (const c of comps) {
    c.x_note = `note-${c.id}`;
    c.layout.x_l = 1;
    if (c.props) c.props.x_p = `p-${c.id}`;
  }
  comps[2].children[0].x_note = 'note-inner';
  return form;
}

/** Null when the text is exactly what the writer's printer makes of it: the standard layout. */
export async function standardLayoutProblem(page: Page, text: string): Promise<string | null> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return 'not JSON';
  }
  return (await printStandard(page, value)) === text ? null : "the text differs from the writer's standard layout";
}

export interface CliResult {
  status: number | null;
  output: string;
}

const PROJECT = join(ROOT, 'apps/demo');

/**
 * Runs `fw <args>` the way the project's scripts do, on a saved copy of the text. The checker only accepts a form that
 * is inside the project (the demo), so the copy goes into a throwaway folder there, and the folder is removed afterwards
 * together with whatever `fw check` generated beside the copy.
 */
function fwOnCopy(command: string[], text: string, name: string, extra: Record<string, string> = {}): CliResult {
  const dir = mkdtempSync(join(PROJECT, '.e2e-tmp-'));
  try {
    const file = join(dir, `${name}.form.json`);
    writeFileSync(file, text);
    for (const [other, body] of Object.entries(extra)) writeFileSync(join(dir, other), body);
    const run = spawnSync('pnpm', ['--filter', 'demo', 'exec', 'fw', ...command, file], { cwd: ROOT, shell: true, encoding: 'utf8', timeout: 60_000 });
    return { status: run.status, output: `${run.stdout}${run.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The same form with every handler reference taken out, for a copy that has no script beside it. */
export function withoutHandlers(text: string): string {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'events').map(([k, v]) => [k, strip(v)]));
    return value;
  };
  return JSON.stringify(strip(JSON.parse(text)), null, 2);
}

/** `pnpm --filter demo exec fw check --no-tsc` on a saved copy, with the files that sit beside it (such as the script). */
export const fwCheck = (text: string, name = 'Saved', extra: Record<string, string> = {}): CliResult => fwOnCopy(['check', '--no-tsc'], text, name, extra);
/** `fw fmt --check` on a saved copy: status 0 when the text is already in the standard layout. */
export const fwFmtCheck = (text: string, name = 'Saved'): CliResult => fwOnCopy(['fmt', '--check'], text, name);
