/**
 * Proof test P4 (FRAMEWORK.md section 8), on the full stack: the real browser client, the real HTTP transport, the real server and the real
 * SQLite file. Long decimals, dates, and the empty string against null all round-trip with zero false conflicts, and a real conflict is
 * caught. The server's own tests and the golden vectors cover the wire. The randomized round trip is in packages/server/test/p4-roundtrip.test.ts.
 *
 * Every database check reads the file itself (p4-support.ts), not what a page shows.
 */
import type { Browser, Locator, Page } from '@playwright/test';
import {
  call,
  department,
  departments,
  dump,
  edit,
  employee,
  employees,
  hasChanges,
  makeDataset,
  openForm,
  openScripted,
  rowIds,
  saveEmployees,
  searchEmployees,
  snapshot,
  type Cell,
  type Outcome,
  type Row,
} from './p4-support.ts';
import { expect, test } from './support.ts';

// ---- values ---------------------------------------------------------------------------------------------------------------------

/** Salaries are decimal(14,6): up to 8 whole digits and 6 places. All are at least 30,000 so the list screen's save accepts them. */
const SALARIES = [
  '30000', '30000.0', '30000.000000', '30000.100000', '30000.10', '99999999.999999', '12345678.123450', '45000.000001', '50000.50', '50000.500000',
  '31234.5', '87654321', '65000.000010', '40000.1', '70000.123456', '33333.333333', '30000.000001', '00040000.50',
];
/** The save without a minimum takes these too: zero at many scales, negatives, the tiniest and the largest. */
const SALARIES_ANY = ['0', '0.0', '0.000000', '-0.000001', '-5.100000', '-99999999.999999', '0.000001', '1', '1.10', '1.100000', '99999999.999999', ...SALARIES];
const DATES = ['2000-02-29', '1999-12-31', '2024-01-01', '1900-01-01', '2012-07-04', '2100-12-31', '0999-01-01', '2023-02-28', '9999-12-31'];
/** `level` is a string of one character: null, the empty string and a space are three different values. */
const LEVELS: (string | null)[] = [null, '', 'A', 'B', 'C', ' ', 'Z'];
const NAMES = ['Åsa Öberg', 'Zoë "Z" O\'Neil', '  spaced  ', '日本語 名前', 'Plain', 'Back\\slash', '😀 Emoji', "'; DROP TABLE employee; --", 'a%b_c'];

const fromDb = (row: Row): Row => ({ ...row, active: row['active'] === null ? null : row['active'] === 1 });
const withoutVer = (row: Row): Row => {
  const rest = { ...row };
  delete rest['ver'];
  return rest;
};
const pickOf = <T,>(items: readonly T[], at: number): T => items[((at % items.length) + items.length) % items.length] as T;

/** True if two decimal texts are the same number. The Dataset treats such an edit as no change and keeps the loaded text. */
function sameNumber(a: string, b: string): boolean {
  const scaled = (text: string, places: number): bigint => {
    const [whole = '0', fraction = ''] = text.replace('-', '').split('.');
    const n = BigInt(whole + fraction.padEnd(places, '0'));
    return text.startsWith('-') ? -n : n;
  };
  return scaled(a, 8) === scaled(b, 8);
}
/** The next salary from the list that is a different number from `current`. */
function otherSalary(items: readonly string[], at: number, current: Cell): string {
  for (let k = 0; k < items.length; k++) {
    const candidate = pickOf(items, at + k);
    if (typeof current !== 'string' || !sameNumber(candidate, current)) return candidate;
  }
  throw new Error('no other salary');
}

/**
 * Versions are the server's business (they come from one counter), so no test names a number. What must hold: the rows that were saved have
 * a larger version than before, and the others have the same one. Everything else in the rows is compared exactly. Returns the new rows.
 */
function acceptRows(model: Row[], after: Row[], key: string, moved: ReadonlySet<string> | 'all', label: string): Row[] {
  expect(after.map(withoutVer), `${label}: values`).toEqual(model.map(withoutVer));
  after.forEach((row, i) => {
    const was = model[i]?.['ver'] as number;
    const is = row['ver'] as number;
    if (moved === 'all' || moved.has(String(row[key]))) expect(is, `${label}: version of ${String(row[key])} moved`).toBeGreaterThan(was);
    else expect(is, `${label}: version of ${String(row[key])} did not move`).toBe(was);
  });
  return after;
}
/** One row of a table changed in these ways; the rest is as it was. */
const sameApartFrom = (before: Row[], after: Row[], key: string, changed: string[]): void => {
  expect(after.filter((r) => !changed.includes(String(r[key])))).toEqual(before.filter((r) => !changed.includes(String(r[key]))));
};

function expectOk(outcome: Outcome, label: string): void {
  expect(outcome.ok ? 'ok' : `${outcome.failure.code}: ${outcome.failure.message} ${JSON.stringify(outcome.failure.rowErrors)}`, label).toBe('ok');
}

// ---- 1. exact values, no false conflict, through form-level scripted calls --------------------------------------------------------

test.describe('P4 scripted: values round trip exactly and no save reports a conflict that did not happen', () => {
  test('D1 form: 18 rounds of edit, save and reload on all 25 rows, changing the long values every third round', async ({ page }) => {
    await openScripted(page);
    await openForm(page, 'list');
    let model = employees().map(fromDb);
    expect(await dump(page, 'list', 'dsEmp')).toEqual(model);

    const seenLevels = new Set<string | null>();
    for (let round = 1; round <= 18; round++) {
      const edits: [number, string, Cell][] = [];
      model = model.map((row, i) => {
        const next: Row = { ...row, empName: `${pickOf(NAMES, i + round)} #${round}` };
        edits.push([i, 'empName', next['empName'] as string]);
        // Every third round the long values change too. In the other rounds they are loaded text that must come back unchanged.
        if (round % 3 === 0) {
          next['salary'] = otherSalary(SALARIES, i * 3 + round, row['salary']);
          next['hiredOn'] = pickOf(DATES, i + round);
          next['level'] = pickOf(LEVELS, i + round * 2);
          edits.push([i, 'salary', next['salary'] as string], [i, 'hiredOn', next['hiredOn'] as string], [i, 'level', next['level'] as string | null]);
          seenLevels.add(next['level'] as string | null);
        }
        return next;
      });
      await edit(page, 'list', 'dsEmp', edits);
      expect(await hasChanges(page, 'list', 'dsEmp')).toBe(true);
      expectOk(await saveEmployees(page), `round ${round}: save`);
      model = acceptRows(model, employees().map(fromDb), 'empNo', 'all', `round ${round}: the database`);
      // The client keeps working on the saved rows, and holds the versions the server returned.
      expect(await dump(page, 'list', 'dsEmp'), `round ${round}: the client after the save`).toEqual(model);
      // Every second round the screen's own search reloads everything.
      if (round % 2 === 0) {
        expectOk(await searchEmployees(page), `round ${round}: reload`);
        expect(await dump(page, 'list', 'dsEmp'), `round ${round}: after the reload`).toEqual(model);
      }
    }
    // The run did cover the empty string and null apart, and they came back as they went in.
    expect(seenLevels.has('')).toBe(true);
    expect(seenLevels.has(null)).toBe(true);
    expect(employees().some((r) => r['level'] === '')).toBe(true);
    expect(employees().some((r) => r['level'] === null)).toBe(true);
  });

  test('without a version column every loaded column is compared: 12 rounds with the empty string, null, trailing zeros and negatives and no false conflict', async ({ page }) => {
    await openScripted(page);
    await openForm(page, 'list');
    await makeDataset(page, 'list', 'noVer', 'dsEmp', ['empNo', 'empName', 'dept', 'level', 'active', 'salary', 'hiredOn'], ['empNo']);
    let model = employees().map(fromDb);

    for (let round = 1; round <= 12; round++) {
      const edits: [number, string, Cell][] = [];
      model = model.map((row, i) => {
        const next: Row = { ...row, empName: `${pickOf(NAMES, i + round)} #${round}` };
        edits.push([i, 'empName', next['empName'] as string]);
        if (round % 3 !== 1) {
          next['salary'] = otherSalary(SALARIES_ANY, i * 5 + round, row['salary']);
          next['hiredOn'] = pickOf(DATES, i * 2 + round);
          next['level'] = pickOf(LEVELS, i + round);
          next['dept'] = pickOf(['ENG', 'SAL', 'HR', 'FIN', 'OPS'], i + round);
          edits.push([i, 'salary', next['salary'] as string], [i, 'hiredOn', next['hiredOn'] as string], [i, 'level', next['level'] as string | null], [i, 'dept', next['dept'] as string]);
        }
        return next;
      });
      await edit(page, 'list', 'extra:noVer', edits);
      const sent: string[] = [];
      page.on('request', (r) => {
        if (r.url().includes('/hr.emp.save')) sent.push(r.postData() ?? '');
      });
      const outcome = await call(page, 'list', { service: 'hr.emp.save', inputs: { emp: { dataset: 'extra:noVer', rows: 'changed' } } });
      expectOk(outcome, `round ${round}: save`);
      // The request really had no version column, so the server checked every column.
      const body = JSON.parse(sent[0] ?? '{}') as { datasets: { emp: { columns: { id: string }[] } } };
      expect(body.datasets.emp.columns.map((c) => c.id)).not.toContain('ver');
      page.removeAllListeners('request');
      model = acceptRows(model, employees().map(fromDb), 'empNo', 'all', `round ${round}: database`);
      expect(await dump(page, 'list', 'extra:noVer'), `round ${round}: client`).toEqual(model.map(withoutVer));
    }
  });

  test('without a version column, a change by someone else to another column is a conflict, and the stale save writes nothing', async ({ page }) => {
    await openScripted(page);
    await openForm(page, 'list');
    await makeDataset(page, 'list', 'noVer', 'dsEmp', ['empNo', 'empName', 'dept', 'level', 'active', 'salary', 'hiredOn'], ['empNo']);
    const before = employees();
    const ids = await rowIds(page, 'list', 'extra:noVer');

    // Someone else changes only the salary of E005, with the screen's own request shape (version checked).
    const salary = '51234.560000';
    const theirs = await page.request.post('/dsx/v1/tx/hr.emp.save', {
      data: {
        dsx: 1,
        txId: 'other',
        service: 'hr.emp.save',
        datasets: {
          emp: {
            columns: [
              { id: 'empNo', type: 'string', key: true },
              { id: 'salary', type: 'decimal' },
              { id: 'ver', type: 'int', version: true },
            ],
            changes: [{ s: 'U', id: 0, v: ['E005', salary, 1], o: { '1': before[4]?.['salary'] ?? null } }],
          },
        },
      },
    });
    expect(theirs.status()).toBe(200);
    expect(employee('E005')).toMatchObject({ salary });
    expect(employee('E005')['ver']).toBeGreaterThan(before[4]?.['ver'] as number);
    const afterTheirs = employees();

    // This client still holds the old salary and edits the name of E004, E005 and E006.
    await edit(page, 'list', 'extra:noVer', [[3, 'empName', 'Mine 4'], [4, 'empName', 'Mine 5'], [5, 'empName', 'Mine 6']]);
    const outcome = await call(page, 'list', { service: 'hr.emp.save', inputs: { emp: { dataset: 'extra:noVer', rows: 'changed' } } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe('conflict');
    expect(outcome.failure.rowErrors.map((e) => ({ dataset: e.dataset, id: e.id, code: e.code }))).toEqual([{ dataset: 'emp', id: ids[4], code: 'conflict' }]);
    // The database has their salary and the rows around it are untouched, though they were valid.
    expect(employees()).toEqual(afterTheirs);
    // The edits are still in the Dataset.
    expect(await hasChanges(page, 'list', 'extra:noVer')).toBe(true);
    expect((await dump(page, 'list', 'extra:noVer')).slice(3, 6).map((r) => r['empName'])).toEqual(['Mine 4', 'Mine 5', 'Mine 6']);
  });

  test('without a version column on the department Dataset, a stale rename is a conflict, and the first rename stays', async ({ page }) => {
    await openScripted(page);
    await openForm(page, 'dept');
    await makeDataset(page, 'dept', 'deptNoVer', 'dsDept', ['code', 'name'], ['code']);
    const before = snapshot();
    const other = await page.request.post('/dsx/v1/tx/hr.dept.saveAll', {
      data: {
        dsx: 1,
        txId: 'other',
        service: 'hr.dept.saveAll',
        datasets: {
          dept: {
            columns: [
              { id: 'code', type: 'string', key: true },
              { id: 'name', type: 'string' },
              { id: 'ver', type: 'int', version: true },
            ],
            changes: [{ s: 'U', id: 0, v: ['SAL', 'Sales (theirs)', 1], o: { '1': 'Sales' } }],
          },
        },
      },
    });
    expect(other.status()).toBe(200);

    // Rows: ENG, SAL, HR, FIN, OPS (the form loads them in code order: ENG, FIN, HR, OPS, SAL).
    const rows = await dump(page, 'dept', 'extra:deptNoVer');
    const sal = rows.findIndex((r) => r['code'] === 'SAL');
    const eng = rows.findIndex((r) => r['code'] === 'ENG');
    await edit(page, 'dept', 'extra:deptNoVer', [[eng, 'name', 'Engineering (mine)'], [sal, 'name', 'Sales (mine)']]);
    const outcome = await call(page, 'dept', { service: 'hr.dept.saveAll', inputs: { dept: { dataset: 'extra:deptNoVer', rows: 'changed' } } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe('conflict');
    const ids = await rowIds(page, 'dept', 'extra:deptNoVer');
    expect(outcome.failure.rowErrors.map((e) => ({ dataset: e.dataset, id: e.id }))).toEqual([{ dataset: 'dept', id: ids[sal] }]);
    expect(department('SAL')).toMatchObject({ name: 'Sales (theirs)' });
    expect(department('SAL')['ver']).toBeGreaterThan(before.departments.find((d) => d['code'] === 'SAL')?.['ver'] as number);
    expect(department('ENG')).toEqual(before.departments.find((d) => d['code'] === 'ENG'));
    expect(snapshot().employees).toEqual(before.employees);
  });

  test('D2 form: edits of the department and of its employees save together, 10 rounds over two departments, and everything else stays exact', async ({ page }) => {
    await openScripted(page);
    await openForm(page, 'dept');
    // The screen's own script reacts to a load of its Datasets (it loads the employees of the current department), so these are plain Datasets with the same columns.
    await makeDataset(page, 'dept', 'd2dept', 'dsDept', ['code', 'name', 'ver'], ['code']);
    await makeDataset(page, 'dept', 'd2emp', 'dsEmp', ['empNo', 'empName', 'dept', 'level', 'active', 'salary', 'hiredOn', 'ver'], ['empNo']);
    let emps = employees().map(fromDb);
    let depts = departments();

    const load = (code: string): Promise<Outcome> =>
      call(page, 'dept', { service: 'hr.dept.withEmployees', params: { deptCode: code }, outputs: { dept: 'extra:d2dept', emp: 'extra:d2emp' } });

    for (let round = 1; round <= 10; round++) {
      const code = round % 2 === 1 ? 'ENG' : 'SAL';
      expectOk(await load(code), `round ${round}: load ${code}`);
      const clientDepts = await dump(page, 'dept', 'extra:d2dept');
      expect(clientDepts, `round ${round}: departments as loaded`).toEqual(depts);
      const clientEmps = await dump(page, 'dept', 'extra:d2emp');
      const inDept = emps.filter((e) => e['dept'] === code);
      expect(clientEmps, `round ${round}: employees as loaded`).toEqual(inDept);

      const deptEdits: [number, string, Cell][] = [];
      const at = clientDepts.findIndex((d) => d['code'] === code);
      const name = `${pickOf(NAMES, round)} dept ${round}`;
      deptEdits.push([at, 'name', name]);
      depts = depts.map((d) => (d['code'] === code ? { ...d, name } : d));

      const empEdits: [number, string, Cell][] = [];
      clientEmps.forEach((e, i) => {
        const next: Row = { ...e, empName: `${pickOf(NAMES, i + round)} #${round}` };
        empEdits.push([i, 'empName', next['empName'] as string]);
        if (round % 2 === 0) {
          next['salary'] = otherSalary(SALARIES_ANY, i + round * 7, e['salary']);
          next['level'] = pickOf(LEVELS, i + round);
          next['hiredOn'] = pickOf(DATES, i + round);
          empEdits.push([i, 'salary', next['salary'] as string], [i, 'level', next['level'] as string | null], [i, 'hiredOn', next['hiredOn'] as string]);
        }
        emps = emps.map((m) => (m['empNo'] === e['empNo'] ? { ...next, ver: m['ver'] } : m));
      });
      await edit(page, 'dept', 'extra:d2dept', deptEdits);
      await edit(page, 'dept', 'extra:d2emp', empEdits);
      const saved = await call(page, 'dept', {
        service: 'hr.dept.saveAll',
        inputs: { dept: { dataset: 'extra:d2dept', rows: 'changed' }, emp: { dataset: 'extra:d2emp', rows: 'changed' } },
      });
      expectOk(saved, `round ${round}: save`);
      emps = acceptRows(emps, employees().map(fromDb), 'empNo', new Set(clientEmps.map((e) => String(e['empNo']))), `round ${round}: employee table`);
      depts = acceptRows(depts, departments(), 'code', new Set([code]), `round ${round}: department table`);
    }
  });
});

// ---- 2. screens, driven like a person ----------------------------------------------------------------------------------------------

const L = { status: 0, select: 1, empNo: 2, name: 3, dept: 4, level: 5, active: 6, salary: 7, hired: 8 } as const;

function listScreen(page: Page) {
  const cell = (no: string, track: number): Locator =>
    page.locator(`.fw-grid__row:has(.fw-grid__cell[data-track="${L.empNo}"]:text-is("${no}")) .fw-grid__cell[data-track="${track}"]`);
  return {
    cell,
    status: page.getByText(/^(Found|Saved|Changes reverted|Nothing to save|Not saved|Save or revert|Failed|Row added|Deleted|No row)/),
    save: page.getByRole('button', { name: 'Save' }),
    revert: page.getByRole('button', { name: 'Revert' }),
    search: page.getByRole('button', { name: 'Search' }),
    del: page.getByRole('button', { name: 'Delete row' }),
    async open(): Promise<void> {
      await page.goto('/#list');
      await expect(this.status).toHaveText('Found 25 employees');
      await expect(cell('E001', L.name)).toBeVisible();
    },
    /** Click a cell, type, Enter: typing replaces the text and Enter commits. */
    async type(no: string, track: number, text: string): Promise<void> {
      await cell(no, track).click();
      await page.keyboard.press('F2');
      await page.keyboard.press('Control+A');
      await page.keyboard.type(text);
      await page.keyboard.press('Enter');
    },
  };
}

const D = { status: 0, select: 1, code: 2, name: 3 } as const;
const E = { status: 0, select: 1, empNo: 2, name: 3, level: 4, active: 5, salary: 6, hired: 7 } as const;

function deptScreen(page: Page) {
  const deptGrid = page.getByRole('grid').nth(0);
  const empGrid = page.getByRole('grid').nth(1);
  const cell = (grid: Locator, text: string, rowTrack: number, track: number): Locator =>
    grid.locator(`.fw-grid__row:has(.fw-grid__cell[data-track="${rowTrack}"]:text-is("${text}")) .fw-grid__cell[data-track="${track}"]`);
  return {
    deptGrid,
    empGrid,
    status: page.getByText(/^(\d+ departments|\d+ employees? in|Saved|Not saved|Failed|Nothing|Changes reverted|Save or revert|Department added|Employee added|Deleted|Delete or move|The code|No )/),
    deptCell: (code: string, track: number): Locator => cell(deptGrid, code, D.code, track),
    empCell: (no: string, track: number): Locator => cell(empGrid, no, E.empNo, track),
    addDept: page.getByRole('button', { name: 'Add department' }),
    addEmp: page.getByRole('button', { name: 'Add employee' }),
    save: page.getByRole('button', { name: 'Save', exact: true }),
    revert: page.getByRole('button', { name: 'Revert' }),
    async open(): Promise<void> {
      await page.goto('/#dept');
      await expect(this.status).toHaveText('5 departments');
      await expect(this.deptCell('ENG', D.name)).toHaveText('Engineering');
      await expect(this.addEmp).toBeEnabled();
    },
    async typeInto(target: Locator, text: string): Promise<void> {
      await target.click();
      await page.keyboard.press('F2');
      await page.keyboard.press('Control+A');
      await page.keyboard.type(text);
      await page.keyboard.press('Enter');
    },
    /** Renames a department and goes back to it, because Enter moves the Grid on to the next row. */
    async renameDept(code: string, name: string): Promise<void> {
      await this.deptCell(code, D.name).click();
      await expect(this.addEmp).toBeEnabled();
      await page.keyboard.type(name);
      await page.keyboard.press('Enter');
      await this.deptCell(code, D.code).click();
      await expect(this.addEmp).toBeEnabled();
      await expect(this.deptCell(code, D.name)).toHaveText(name);
    },
  };
}

/** A second person: another browser context with its own page. */
async function secondUser(browser: Browser, baseURL: string | undefined): Promise<{ page: Page; close(): Promise<void> }> {
  const context = await browser.newContext({ baseURL: baseURL ?? 'http://localhost:5180', viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));
  return { page, close: () => context.close() };
}

test.describe('P4 on the screens: repeated edit, save and reload never reports a conflict and never alters a value', () => {
  test('D1: six rounds on the same rows, with a typed salary, and every untouched value in the database is still the seed text', async ({ page }) => {
    const s = listScreen(page);
    const seed = employees();
    let model = seed.map((r) => ({ ...r }));
    await s.open();
    for (let round = 1; round <= 6; round++) {
      // Edit a different column than the long ones: the names of three rows.
      await s.cell('E001', L.name).click();
      await page.keyboard.type(`Round ${round} one`);
      await page.keyboard.press('Enter');
      await page.keyboard.type(`Round ${round} éè two`);
      await page.keyboard.press('Enter');
      await page.keyboard.type(`Round ${round} "three" it's`);
      await page.keyboard.press('Enter');
      model = model.map((r, i) => (i < 3 ? { ...r, empName: [`Round ${round} one`, `Round ${round} éè two`, `Round ${round} "three" it's`][i] as string } : r));
      await s.save.click();
      await expect(s.status).toHaveText('Saved 3 rows');
      model = acceptRows(model, employees(), 'empNo', new Set(['E001', 'E002', 'E003']), `round ${round}`);
      // Reload the whole page, as a person would, and look at what the Grid shows.
      await page.reload();
      await expect(s.status).toHaveText('Found 25 employees');
      await expect(s.cell('E001', L.name)).toHaveText(`Round ${round} one`);
      await expect(s.cell('E003', L.name)).toHaveText(`Round ${round} "three" it's`);
      await expect(s.cell('E001', L.status)).toHaveText('');
    }
    // The long decimals and the dates of every row are the seed's exact text, six saves later.
    expect(employees().map((r) => [r['empNo'], r['salary'], r['hiredOn'], r['level']])).toEqual(seed.map((r) => [r['empNo'], r['salary'], r['hiredOn'], r['level']]));
    expect(employee('E001')['ver']).toBeGreaterThan(seed[0]?.['ver'] as number);
    expect(employee('E004')['ver']).toBe(seed[3]?.['ver']);
  });

  test('D1: a typed salary with trailing zeros is stored as typed, saves again with no conflict, and the neighbours do not move', async ({ page }) => {
    const s = listScreen(page);
    await s.open();
    const seed = employees();
    let lastVer = employee('E004')['ver'] as number;
    const typed = ['50000.10', '60000.123400', '70000', '31234.5', '12345678.123450'];
    for (let round = 0; round < typed.length; round++) {
      const value = typed[round] as string;
      await s.type('E004', L.salary, value);
      // The same row, a second edit with the first still in the Grid: the original it sends is the saved value.
      await s.save.click();
      await expect(s.status).toHaveText('Saved 1 row');
      expect(employee('E004')['salary'], `round ${round}`).toBe(value);
      expect(employee('E004')['ver']).toBeGreaterThan(lastVer);
      lastVer = employee('E004')['ver'] as number;
      await page.reload();
      await expect(s.status).toHaveText('Found 25 employees');
      await expect(s.cell('E004', L.status)).toHaveText('');
    }
    sameApartFrom(seed, employees(), 'empNo', ['E004']);
  });

  test('D2: six rounds of renaming a department and one of its employees, saved and reloaded, with the other values exact', async ({ page }) => {
    const s = deptScreen(page);
    const seedEmps = employees();
    const seedDepts = departments();
    let lastDeptVer = department('ENG')['ver'] as number;
    let lastEmpVer = employee('E001')['ver'] as number;
    await s.open();
    for (let round = 1; round <= 6; round++) {
      await s.renameDept('ENG', `Engineering r${round} é`);
      await s.typeInto(s.empCell('E001', E.name), `Alice r${round} "q"`);
      await s.save.click();
      await expect(s.status).toHaveText('Saved 2 rows');
      expect(department('ENG'), `round ${round}`).toMatchObject({ code: 'ENG', name: `Engineering r${round} é` });
      expect(employee('E001')).toMatchObject({ empName: `Alice r${round} "q"` });
      expect(department('ENG')['ver']).toBeGreaterThan(lastDeptVer);
      expect(employee('E001')['ver']).toBeGreaterThan(lastEmpVer);
      lastDeptVer = department('ENG')['ver'] as number;
      lastEmpVer = employee('E001')['ver'] as number;
      await page.reload();
      await expect(s.status).toHaveText('5 departments');
      await expect(s.deptCell('ENG', D.name)).toHaveText(`Engineering r${round} é`);
      await expect(s.empCell('E001', E.name)).toHaveText(`Alice r${round} "q"`);
    }
    expect(employees().map((r) => [r['empNo'], r['salary'], r['hiredOn'], r['level']])).toEqual(seedEmps.map((r) => [r['empNo'], r['salary'], r['hiredOn'], r['level']]));
    expect(department('SAL')).toEqual(seedDepts.find((d) => d['code'] === 'SAL'));
    sameApartFrom(seedEmps, employees(), 'empNo', ['E001']);
  });
});

// ---- 3. a real conflict is caught ---------------------------------------------------------------------------------------------------

test.describe('P4: a real conflict is caught, the first value stays and the second user keeps the edits', () => {
  test('D1: two browser contexts load the same row, the first saves, the second is told, and nothing of the second is written', async ({ page, browser, baseURL }) => {
    const a = listScreen(page);
    const other = await secondUser(browser, baseURL);
    try {
      const b = listScreen(other.page);
      await a.open();
      await b.open();

      const seed = employees();
      await a.type('E001', L.name, 'First user wins');
      await a.save.click();
      await expect(a.status).toHaveText('Saved 1 row');
      expect(employee('E001')).toMatchObject({ empName: 'First user wins' });
      expect(employee('E001')['ver']).toBeGreaterThan(seed[0]?.['ver'] as number);
      const afterFirst = employees();

      // The second user edits the same row, and another row that nobody else touched.
      await b.type('E001', L.name, 'Second user loses');
      await b.type('E002', L.name, 'Second user other row');
      await b.save.click();
      await expect(b.status).toHaveText(/^Not saved: someone else changed a marked row/);
      // On their screen: their edits, the marked row.
      await expect(b.cell('E001', L.name)).toHaveText('Second user loses');
      await expect(b.cell('E002', L.name)).toHaveText('Second user other row');
      await expect(b.cell('E001', L.name)).toHaveAttribute('data-invalid', /.*/);
      await expect(b.cell('E001', L.status)).toHaveText('U');
      // In the database: the first user's value, the other row untouched.
      expect(employees()).toEqual(afterFirst);

      // They revert, search again, and see the first user's value.
      await b.revert.click();
      await b.search.click();
      await expect(b.status).toHaveText('Found 25 employees');
      await expect(b.cell('E001', L.name)).toHaveText('First user wins');
      await expect(b.cell('E002', L.name)).toHaveText('Benjamin Hughes');
    } finally {
      await other.close();
    }
  });

  test('D1: one browser and one direct API call, which changed a long salary, so the browser save of that row is refused', async ({ page, request }) => {
    const s = listScreen(page);
    await s.open();
    const before = employee('E003');
    const theirs = await request.post('/dsx/v1/tx/hr.emp.saveList', {
      data: {
        dsx: 1,
        txId: 'api',
        service: 'hr.emp.saveList',
        datasets: {
          emp: {
            columns: [
              { id: 'empNo', type: 'string', key: true },
              { id: 'salary', type: 'decimal' },
              { id: 'ver', type: 'int', version: true },
            ],
            changes: [{ s: 'U', id: 0, v: ['E003', '99999999.999999', before['ver']], o: { '1': before['salary'] } }],
          },
        },
      },
    });
    expect(theirs.status()).toBe(200);

    await s.type('E003', L.name, 'Browser edit');
    await s.type('E004', L.name, 'Browser edit two');
    await s.save.click();
    await expect(s.status).toHaveText(/^Not saved: someone else changed a marked row/);
    await expect(s.cell('E003', L.name)).toHaveText('Browser edit');
    await expect(s.cell('E004', L.name)).toHaveText('Browser edit two');
    await expect(s.cell('E003', L.name)).toHaveAttribute('data-invalid', /.*/);
    expect(employee('E003')).toMatchObject({ empName: before['empName'], salary: '99999999.999999' });
    expect(employee('E003')['ver']).toBeGreaterThan(before['ver'] as number);
    expect(employee('E004')['empName']).toBe('Daniel Foster');
  });

  test('D1: a row that the first user deleted is a conflict for the second user\'s edit, and a row they edited is one for the second user\'s delete', async ({ page, browser, baseURL }) => {
    const a = listScreen(page);
    const other = await secondUser(browser, baseURL);
    try {
      const b = listScreen(other.page);
      await a.open();
      await b.open();
      // A deletes E010 and edits E011.
      await a.cell('E010', L.select).click();
      await a.del.click();
      await a.type('E011', L.name, 'A edited this');
      await a.save.click();
      await expect(a.status).toHaveText('Saved 2 rows');
      expect(employees().find((r) => r['empNo'] === 'E010')).toBeUndefined();

      // B edits E010 (gone) and deletes E011 (changed).
      await b.type('E010', L.name, 'B edits a deleted row');
      await b.cell('E011', L.select).click();
      await b.del.click();
      await b.save.click();
      await expect(b.status).toHaveText(/^Not saved: someone else changed a marked row/);
      expect(employee('E011')).toMatchObject({ empName: 'A edited this' });
      expect(employees()).toHaveLength(24);
      await expect(b.cell('E010', L.name)).toHaveText('B edits a deleted row');
    } finally {
      await other.close();
    }
  });

  test('D2: two browser contexts rename the same department, the second is told, keeps both Grids\' edits, and writes nothing', async ({ page, browser, baseURL }) => {
    const a = deptScreen(page);
    const other = await secondUser(browser, baseURL);
    try {
      const b = deptScreen(other.page);
      await a.open();
      await b.open();

      const seed = snapshot();
      await a.renameDept('ENG', 'Engineering (first)');
      await a.save.click();
      await expect(a.status).toHaveText('Saved 1 row');
      expect(department('ENG')).toMatchObject({ name: 'Engineering (first)' });
      expect(department('ENG')['ver']).toBeGreaterThan(seed.departments.find((d) => d['code'] === 'ENG')?.['ver'] as number);
      const afterFirst = snapshot();

      await b.renameDept('ENG', 'Engineering (second)');
      await b.typeInto(b.empCell('E001', E.name), 'Second user employee edit');
      await b.save.click();
      await expect(b.status).toHaveText(/^Not saved: someone else changed a marked row/);
      await expect(b.deptCell('ENG', D.name)).toHaveText('Engineering (second)');
      await expect(b.empCell('E001', E.name)).toHaveText('Second user employee edit');
      await expect(b.deptCell('ENG', D.name)).toHaveAttribute('data-invalid', /.*/);
      // The employee edit was valid, but it was in the same save, so it is not in the database.
      expect(snapshot()).toEqual(afterFirst);
    } finally {
      await other.close();
    }
  });

  test('D2: an employee changed by someone else is a conflict on the employee row, and the department rename in the same save is not written', async ({ page, request }) => {
    const s = deptScreen(page);
    await s.open();
    // Choosing another department reloads the employees, so this person edits first and the other call lands after their edits.
    await s.renameDept('ENG', 'Engineering (mine)');
    await s.typeInto(s.empCell('E006', E.name), 'Frederick (mine)');
    const before = employee('E006');
    const theirs = await request.post('/dsx/v1/tx/hr.dept.saveAll', {
      data: {
        dsx: 1,
        txId: 'api',
        service: 'hr.dept.saveAll',
        datasets: {
          emp: {
            columns: [
              { id: 'empNo', type: 'string', key: true },
              { id: 'level', type: 'string' },
              { id: 'ver', type: 'int', version: true },
            ],
            // The empty string for a level: it must not look like null to the next save.
            changes: [{ s: 'U', id: 0, v: ['E006', '', before['ver']], o: { '1': before['level'] } }],
          },
        },
      },
    });
    expect(theirs.status()).toBe(200);
    expect(employee('E006')).toMatchObject({ level: '' });
    expect(employee('E006')['ver']).toBeGreaterThan(before['ver'] as number);
    const afterTheirs = snapshot();

    await s.save.click();
    await expect(s.status).toHaveText(/^Not saved: someone else changed a marked row/);
    await expect(s.empCell('E006', E.name)).toHaveAttribute('data-invalid', /.*/);
    await expect(s.empCell('E006', E.name)).toHaveText('Frederick (mine)');
    await expect(s.deptCell('ENG', D.name)).toHaveText('Engineering (mine)');
    expect(snapshot()).toEqual(afterTheirs);
  });
});

// ---- 4. all or nothing (N-2) on the real stack --------------------------------------------------------------------------------------

test.describe('P4: a D2 save that fails on the server writes nothing at all (N-2)', () => {
  test('one employee row fails server validation, so the valid department and employee changes are not written either', async ({ page }) => {
    await openScripted(page);
    await openForm(page, 'dept');
    const before = snapshot();
    const depts = await dump(page, 'dept', 'dsDept');
    const eng = depts.findIndex((d) => d['code'] === 'ENG');
    const sal = depts.findIndex((d) => d['code'] === 'SAL');
    await edit(page, 'dept', 'dsDept', [[eng, 'name', 'Engineering (rolled back)'], [sal, 'name', 'Sales (rolled back)']]);
    const emps = await dump(page, 'dept', 'dsEmp');
    expect(emps.length).toBeGreaterThanOrEqual(3);
    // Rows 0 and 1 are valid. Row 2 has an empty name, which the server's own declaration refuses. The client's checks are not run here.
    await edit(page, 'dept', 'dsEmp', [[0, 'empName', 'Valid change one'], [1, 'empName', 'Valid change two'], [2, 'empName', '']]);
    const outcome = await call(page, 'dept', {
      service: 'hr.dept.saveAll',
      inputs: { dept: { dataset: 'dsDept', rows: 'changed' }, emp: { dataset: 'dsEmp', rows: 'changed' } },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).not.toBe('conflict');
    const ids = await rowIds(page, 'dept', 'dsEmp');
    expect(outcome.failure.rowErrors).toEqual([expect.objectContaining({ dataset: 'emp', id: ids[2], column: 'empName' })]);
    expect(snapshot()).toEqual(before);
    // The edits are still in both Datasets, and fixing the one row lets the very same save through, once.
    expect(await hasChanges(page, 'dept', 'dsDept')).toBe(true);
    expect(await hasChanges(page, 'dept', 'dsEmp')).toBe(true);
    await edit(page, 'dept', 'dsEmp', [[2, 'empName', 'Valid change three']]);
    expectOk(
      await call(page, 'dept', { service: 'hr.dept.saveAll', inputs: { dept: { dataset: 'dsDept', rows: 'changed' }, emp: { dataset: 'dsEmp', rows: 'changed' } } }),
      'the corrected save',
    );
    expect(department('ENG')).toMatchObject({ name: 'Engineering (rolled back)' });
    expect(department('SAL')).toMatchObject({ name: 'Sales (rolled back)' });
    expect(employees().filter((r, i) => r['ver'] !== before.employees[i]?.['ver'])).toHaveLength(3);
  });

  test('a failure only the database sees (an employee in a department that does not exist) rolls back the writes before it', async ({ page }) => {
    await openScripted(page);
    await openForm(page, 'dept');
    const before = snapshot();
    const depts = await dump(page, 'dept', 'dsDept');
    const eng = depts.findIndex((d) => d['code'] === 'ENG');
    await edit(page, 'dept', 'dsDept', [[eng, 'name', 'Engineering (rolled back)']]);
    await edit(page, 'dept', 'dsEmp', [[0, 'empName', 'Valid change one']]);
    // A new employee in department NOPE: it is checked when the transaction commits, after every other row was written.
    await page.evaluate(() => {
      const p4 = (window as unknown as { __p4: { forms: Record<string, { ds: Record<string, { addRow(v: unknown): number }> }> } }).__p4;
      p4.forms['dept']?.ds['dsEmp']?.addRow({ empName: 'Orphan', dept: 'NOPE', active: true });
    });
    const outcome = await call(page, 'dept', {
      service: 'hr.dept.saveAll',
      inputs: { dept: { dataset: 'dsDept', rows: 'changed' }, emp: { dataset: 'dsEmp', rows: 'changed' } },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).not.toBe('conflict');
    expect(outcome.failure.message).not.toMatch(/sqlite|constraint failed|SQLITE/i);
    expect(snapshot()).toEqual(before);
  });

  test('the department screen: a new department with a code that exists is refused with the valid edits kept on screen and none saved', async ({ page }) => {
    const s = deptScreen(page);
    await s.open();
    const before = snapshot();
    await s.renameDept('ENG', 'Engineering (not saved)');
    await s.addDept.click();
    await page.keyboard.type('HR');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Duplicate of HR');
    await page.keyboard.press('Enter');
    // Back to ENG, whose employees load again, and edit one of them.
    await s.deptCell('ENG', D.code).click();
    await expect(s.addEmp).toBeEnabled();
    await s.typeInto(s.empCell('E001', E.name), 'Alice (not saved)');
    await s.save.click();
    await expect(s.status).toHaveText(/^(Failed|Not saved)/);
    expect(snapshot()).toEqual(before);
    // Their work is still on screen.
    await expect(s.deptCell('ENG', D.name)).toHaveText('Engineering (not saved)');
    await expect(s.empCell('E001', E.name)).toHaveText('Alice (not saved)');
  });

  test('the list screen: a salary below the server\'s minimum is refused and none of the other edited rows are written', async ({ page }) => {
    await openScripted(page);
    await openForm(page, 'list');
    const before = snapshot();
    await edit(page, 'list', 'dsEmp', [[0, 'empName', 'Valid one'], [1, 'salary', '29999.999999'], [2, 'empName', 'Valid three']]);
    const outcome = await saveEmployees(page);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.rowErrors).toEqual([expect.objectContaining({ dataset: 'emp', column: 'salary', code: 'range' })]);
    expect(snapshot()).toEqual(before);
    await edit(page, 'list', 'dsEmp', [[1, 'salary', '30000.000000']]);
    expectOk(await saveEmployees(page), 'the corrected save');
    expect(employee('E002')['salary']).toBe('30000.000000');
  });
});
