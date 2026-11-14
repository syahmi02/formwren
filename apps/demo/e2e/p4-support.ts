/**
 * Helpers for proof test P4 (FRAMEWORK.md section 8): the real browser client, the real HTTP transport, the real server and the real
 * database file. Two ways in:
 *  - the demo screens, driven like a person would (the specs use their own locators), and
 *  - "scripted" calls: the demo's own form files are opened in a blank page with `openForm` and `httpTransport`, and Datasets are edited
 *    and saved through `form.tx.call`, for values the screens cannot type (an empty string, a salary with trailing zeros) and for a
 *    Dataset without a version column.
 * The database is read directly with node:sqlite, so the tests see what is on disk and not what a page says.
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

/** The parts of a Dataset these helpers use, as seen from inside the page. */
interface DatasetLike {
  rowCount: number;
  columns: { id: string }[];
  getValue(index: number, column: string): unknown;
  setValue(index: number, column: string, value: unknown): unknown;
  rowIdAt(index: number): number;
  settled(): Promise<void>;
  hasChanges(): boolean;
  load(rows: unknown[]): void;
}

export type Cell = string | number | boolean | null;
export type Row = Record<string, Cell>;

const ROOT = join(import.meta.dirname, '..', '..', '..').replace(/\\/g, '/');
const DB_FILE = join(import.meta.dirname, '..', '.data', 'e2e.db');

/** Rows of a read-only query on the test database. A fresh connection each time, so nothing is cached. */
export function sql(query: string, ...args: (string | number | null)[]): Row[] {
  const db = new DatabaseSync(DB_FILE, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return db.prepare(query).all(...args) as Row[];
  } finally {
    db.close();
  }
}

export const employees = (): Row[] => sql('SELECT empNo, empName, dept, level, active, salary, hiredOn, ver FROM employee ORDER BY empNo');
export const departments = (): Row[] => sql('SELECT code, name, ver FROM department ORDER BY code');
export const employee = (empNo: string): Row => {
  const row = employees().find((r) => r['empNo'] === empNo);
  if (!row) throw new Error(`No employee ${empNo}`);
  return row;
};
export const department = (code: string): Row => {
  const row = departments().find((r) => r['code'] === code);
  if (!row) throw new Error(`No department ${code}`);
  return row;
};

/** Everything in both tables, so a test can prove that a failed save wrote nothing at all. */
export const snapshot = (): { employees: Row[]; departments: Row[]; sequences: Row[] } => ({
  employees: employees(),
  departments: departments(),
  sequences: sql("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fw_sequence'").length > 0 ? sql('SELECT name, value FROM fw_sequence ORDER BY name') : [],
});

export interface Failure {
  code: string;
  message: string;
  committed: boolean;
  rowErrors: { dataset?: string; id?: number; column?: string; code: string }[];
}
export type Outcome = { ok: true; params: Record<string, unknown> } | { ok: false; failure: Failure };

export interface InputSpec {
  /** A Dataset of the form (`dsEmp`) or one made by `makeDataset` (`extra:name`). */
  dataset: string;
  rows: 'changed' | 'all';
}
export interface CallSpec {
  service: string;
  params?: Record<string, unknown>;
  inputs?: Record<string, InputSpec>;
  outputs?: Record<string, string>;
}

interface Harness {
  forms: Record<string, { ds: Record<string, unknown>; tx: unknown }>;
  extra: Record<string, unknown>;
}

/** Opens a blank page on the dev server and loads the demo's form files into it. Nothing of the screens is rendered. */
export async function openScripted(page: Page): Promise<void> {
  await page.route('**/p4-blank.html', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
  await page.goto('/p4-blank.html');
  await page.evaluate(async (root) => {
    const core = await import(/* @vite-ignore */ `/@fs/${root}/packages/core/src/index.ts`);
    const entries = {
      list: (await import(/* @vite-ignore */ String('/src/forms/EmployeeList.form.json'))).default,
      dept: (await import(/* @vite-ignore */ String('/src/forms/DepartmentEmployees.form.json'))).default,
    };
    (window as unknown as { __p4: unknown }).__p4 = { core, entries, forms: {}, extra: {} };
  }, ROOT);
}

/** Opens one of the demo's forms for real: its init script runs and loads its data through the real transport. */
export async function openForm(page: Page, which: 'list' | 'dept'): Promise<void> {
  await page.evaluate(async (which) => {
    const p4 = (window as unknown as { __p4: { core: { openForm(e: unknown, o: unknown): Promise<{ context: unknown }>; httpTransport(base: string): unknown }; entries: Record<string, unknown>; forms: Record<string, unknown> } }).__p4;
    const form = await p4.core.openForm(p4.entries[which], { transport: p4.core.httpTransport('') });
    p4.forms[which] = form.context;
  }, which);
}

/** Every row of a Dataset as an object by column id, exactly as the client holds it. */
export function dump(page: Page, form: 'list' | 'dept', dataset: string): Promise<Row[]> {
  return page.evaluate(
    ({ form, dataset }) => {
      const p4 = (window as unknown as { __p4: { forms: Record<string, { ds: Record<string, DatasetLike> }>; extra: Record<string, DatasetLike> } }).__p4;
      const ds = dataset.startsWith('extra:') ? p4.extra[dataset.slice(6)] : p4.forms[form]?.ds[dataset];
      const out: Record<string, unknown>[] = [];
      for (let i = 0; i < ds.rowCount; i++) {
        const row: Record<string, unknown> = {};
        for (const column of ds.columns) row[column.id] = ds.getValue(i, column.id);
        out.push(row);
      }
      return out;
    },
    { form, dataset },
  ) as Promise<Row[]>;
}

/** The client row ids of a Dataset in view order, which a row error names. */
export function rowIds(page: Page, form: 'list' | 'dept', dataset: string): Promise<number[]> {
  return page.evaluate(
    ({ form, dataset }) => {
      const p4 = (window as unknown as { __p4: { forms: Record<string, { ds: Record<string, DatasetLike> }>; extra: Record<string, DatasetLike> } }).__p4;
      const ds = dataset.startsWith('extra:') ? p4.extra[dataset.slice(6)] : p4.forms[form]?.ds[dataset];
      const ids: number[] = [];
      for (let i = 0; i < ds.rowCount; i++) ids.push(ds.rowIdAt(i));
      return ids;
    },
    { form, dataset },
  );
}

/** Sets cells of a Dataset the way a screen's editor would: `[row index, column, value]`. A refused edit throws. */
export function edit(page: Page, form: 'list' | 'dept', dataset: string, edits: [number, string, Cell][]): Promise<void> {
  return page.evaluate(
    async ({ form, dataset, edits }) => {
      const p4 = (window as unknown as { __p4: { forms: Record<string, { ds: Record<string, DatasetLike> }>; extra: Record<string, DatasetLike> } }).__p4;
      const ds = dataset.startsWith('extra:') ? p4.extra[dataset.slice(6)] : p4.forms[form]?.ds[dataset];
      for (const [index, column, value] of edits) {
        const result = ds.setValue(index, column, value);
        if (result === false) throw new Error(`The edit of ${column} was refused`);
      }
      await ds.settled();
    },
    { form, dataset, edits },
  );
}

export const hasChanges = (page: Page, form: 'list' | 'dept', dataset: string): Promise<boolean> =>
  page.evaluate(
    ({ form, dataset }) => {
      const p4 = (window as unknown as { __p4: { forms: Record<string, { ds: Record<string, DatasetLike> }>; extra: Record<string, DatasetLike> } }).__p4;
      const ds = dataset.startsWith('extra:') ? p4.extra[dataset.slice(6)] : p4.forms[form]?.ds[dataset];
      return ds.hasChanges() as boolean;
    },
    { form, dataset },
  );

/** Runs `form.tx.call` and returns the outcome instead of throwing, so a test can assert on a conflict. */
export function call(page: Page, form: 'list' | 'dept', spec: CallSpec): Promise<Outcome> {
  return page.evaluate(
    async ({ form, spec }) => {
      const p4 = (window as unknown as { __p4: { forms: Record<string, { ds: Record<string, DatasetLike>; tx: { call(o: unknown): Promise<{ params: Record<string, unknown> }> } }>; extra: Record<string, DatasetLike> } }).__p4;
      const context = p4.forms[form];
      if (!context) throw new Error(`Form ${form} is not open`);
      const pick = (name: string): unknown => (name.startsWith('extra:') ? p4.extra[name.slice(6)] : context.ds[name]);
      const inputs: Record<string, unknown> = {};
      for (const [name, input] of Object.entries(spec.inputs ?? {})) inputs[name] = { dataset: pick(input.dataset), rows: input.rows };
      const outputs: Record<string, unknown> = {};
      for (const [name, target] of Object.entries(spec.outputs ?? {})) outputs[name] = pick(target);
      try {
        const result = await context.tx.call({ service: spec.service, params: spec.params, inputs, outputs });
        return { ok: true as const, params: result.params };
      } catch (error) {
        const e = error as { code?: string; message?: string; committed?: boolean; rowErrors?: unknown[] };
        return {
          ok: false as const,
          failure: { code: String(e.code), message: String(e.message), committed: e.committed === true, rowErrors: (e.rowErrors ?? []) as Failure['rowErrors'] },
        };
      }
    },
    { form, spec },
  ) as Promise<Outcome>;
}

/** The list screen's search, into `dsEmp`, as the screen does it. */
export const searchEmployees = (page: Page): Promise<Outcome> =>
  call(page, 'list', { service: 'hr.emp.query', inputs: { cond: { dataset: 'dsCond', rows: 'all' } }, outputs: { list: 'dsEmp' } });

/** The list screen's save. */
export const saveEmployees = (page: Page): Promise<Outcome> =>
  call(page, 'list', { service: 'hr.emp.saveList', inputs: { emp: { dataset: 'dsEmp', rows: 'changed' } } });

/**
 * Makes a Dataset from rows already loaded in a form's Dataset but without some of its columns, such as the version. A save of it sends
 * no version, so the server checks every sent column (decision 7).
 */
export function makeDataset(page: Page, form: 'list' | 'dept', name: string, from: string, columns: string[], keys: string[]): Promise<void> {
  return page.evaluate(
    ({ form, name, from, columns, keys }) => {
      const p4 = (window as unknown as { __p4: { core: { Dataset: new (o: unknown) => DatasetLike }; forms: Record<string, { ds: Record<string, DatasetLike> }>; extra: Record<string, DatasetLike> } }).__p4;
      const source = p4.forms[form]?.ds[from];
      const defs = source.columns.filter((c: { id: string }) => columns.includes(c.id));
      const ds = new p4.core.Dataset({ id: name, columns: defs, keys });
      const rows: Record<string, unknown>[] = [];
      for (let i = 0; i < source.rowCount; i++) {
        const row: Record<string, unknown> = {};
        for (const c of defs) row[c.id] = source.getValue(i, c.id);
        rows.push(row);
      }
      ds.load(rows);
      p4.extra[name] = ds;
    },
    { form, name, from, columns, keys },
  );
}

export type { Harness };
