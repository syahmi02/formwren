import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/index.ts';
import { ensureDemoDatabase, resetDemoDatabase } from '../../../apps/demo/server/seed.ts';
import { demoServices } from '../../../apps/demo/server/services.ts';
import { tempDatabase } from './world.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function demo() {
  const t = tempDatabase();
  cleanups.push(t.cleanup);
  expect(ensureDemoDatabase(t.db)).toBe(true);
  expect(ensureDemoDatabase(t.db)).toBe(false);
  const app = createServer({ services: demoServices, db: t.db, logger: { error() {} } });
  const call = async (service: string, datasets?: object, params?: object) => {
    const res = await app.inject({
      method: 'POST',
      url: `/dsx/v1/tx/${service}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ dsx: 1, txId: 't', service, datasets, params }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read deep into loosely shaped responses
    return { status: res.statusCode, body: res.json() as Record<string, any> };
  };
  return { db: t.db, call };
}

const EMP = [
  { id: 'empNo', type: 'string' },
  { id: 'empName', type: 'string' },
  { id: 'dept', type: 'string' },
  { id: 'salary', type: 'decimal' },
];
const DEPT = [
  { id: 'code', type: 'string' },
  { id: 'name', type: 'string' },
  { id: 'ver', type: 'int', version: true },
];

describe('demo services', () => {
  it('seeds 25 employees with long decimal salaries and 5 departments', async () => {
    const { call } = demo();
    const all = await call('hr.emp.query', { cond: { columns: [{ id: 'empName', type: 'string' }], rows: [[null]] } });
    expect(all.body['datasets'].list.rows).toHaveLength(25);
    expect(all.body['datasets'].list.rows[0]).toEqual(['E001', 'Alice Carter', 'ENG', 'B', true, '48000.104729', '2012-01-01', 1].map((v, i) => (i === 3 ? 'A' : v)));
    const dept = await call('hr.dept.list');
    expect(dept.body['datasets'].list.rows.map((r: unknown[]) => r[0])).toEqual(['ENG', 'SAL', 'HR', 'FIN', 'OPS']);
    const search = await call('hr.emp.search', { cond: { columns: [{ id: 'keyword', type: 'string' }], rows: [['  CARTER ']] } });
    expect(search.body['datasets'].list.rows).toHaveLength(1);
    const filtered = await call('hr.emp.query', {
      cond: { columns: [{ id: 'empName', type: 'string' }, { id: 'dept', type: 'string' }], rows: [['', 'ENG']] },
    });
    expect(filtered.body['datasets'].list.rows).toHaveLength(5);
  });

  it('hr.emp.saveList rejects a salary below 30,000 and saves nothing', async () => {
    const { call, db } = demo();
    const res = await call('hr.emp.saveList', {
      emp: {
        columns: EMP,
        changes: [
          { s: 'U', id: 1, v: ['E001', 'Alice B', 'ENG', '50000'], o: { '1': 'Alice Carter' } },
          { s: 'U', id: 2, v: ['E002', 'Benjamin Hughes', 'SAL', '29999.999999'], o: { '3': '49733.109729' } },
        ],
      },
    });
    expect(res.status).toBe(422);
    expect(res.body['errors']).toEqual([{ dataset: 'emp', id: 2, column: 'salary', code: 'range', message: 'Salary must be at least 30,000' }]);
    expect(db.prepare("SELECT empName FROM employee WHERE empNo = 'E001'").get()).toEqual({ empName: 'Alice Carter' });
  });

  it('saves with generated employee numbers and versions', async () => {
    const { call } = demo();
    const res = await call('hr.emp.saveList', {
      emp: { columns: [...EMP, { id: 'ver', type: 'int', version: true }], changes: [{ s: 'I', id: 7, v: [null, 'New Hire', 'ENG', '45000.000001', null] }] },
    });
    expect(res.status).toBe(200);
    expect(res.body['params']).toEqual({ saved: 1 });
    expect(res.body['applied']).toEqual({ emp: { '7': { empNo: 'E026', ver: 1 } } });
  });

  it('hr.dept.withEmployees returns the departments and the employees of the one in params', async () => {
    const { call } = demo();
    const res = await call('hr.dept.withEmployees', undefined, { deptCode: 'ENG' });
    expect(res.body['datasets'].dept.rows).toHaveLength(5);
    expect(res.body['datasets'].emp.rows).toHaveLength(5);
    expect(res.body['datasets'].emp.rows.every((r: unknown[]) => r[2] === 'ENG')).toBe(true);
    expect((await call('hr.dept.withEmployees')).body['datasets'].emp.rows).toEqual([]);
  });

  it('hr.dept.saveAll saves departments and employees in one transaction, new master first', async () => {
    const { call, db } = demo();
    const ok = await call('hr.dept.saveAll', {
      dept: { columns: DEPT, changes: [{ s: 'I', id: 1, v: ['LEG', 'Legal', null] }] },
      emp: { columns: EMP, changes: [{ s: 'I', id: 2, v: [null, 'Lena Law', 'LEG', '60000'] }] },
    });
    expect(ok.status).toBe(200);
    expect(ok.body['applied']).toEqual({ dept: { '1': { ver: 1 } }, emp: { '2': { empNo: 'E026' } } });

    // A detail that fails after the master was written rolls the master back too.
    const failed = await call('hr.dept.saveAll', {
      dept: { columns: DEPT, changes: [{ s: 'I', id: 1, v: ['TAX', 'Tax', null] }] },
      emp: { columns: EMP, changes: [{ s: 'I', id: 2, v: [null, '', 'TAX', '1'] }] },
    });
    expect(failed.status).toBe(422);
    expect(db.prepare("SELECT count(*) AS n FROM department WHERE code = 'TAX'").get()).toEqual({ n: 0 });

    // A department with employees can't be deleted, and nothing changes.
    const blocked = await call('hr.dept.saveAll', { dept: { columns: DEPT, changes: [{ s: 'D', id: 1, v: ['ENG', 'Engineering', 1] }] } });
    expect(blocked.status).toBe(422);
    expect(db.prepare('SELECT count(*) AS n FROM department').get()).toEqual({ n: 6 });

    // Deleting the employees and their department together works, whatever the order of the Datasets.
    const emps = db.prepare("SELECT empNo, empName, dept, salary FROM employee WHERE dept = 'LEG'").all() as Record<string, string>[];
    const gone = await call('hr.dept.saveAll', {
      emp: { columns: EMP, changes: emps.map((e, i) => ({ s: 'D', id: i, v: [e['empNo'], e['empName'], e['dept'], e['salary']] })) },
      dept: { columns: DEPT, changes: [{ s: 'D', id: 9, v: ['LEG', 'Legal', 1] }] },
    });
    expect(gone.status, JSON.stringify(gone.body)).toBe(200);
  });

  it('reports a conflict on a department changed by someone else', async () => {
    const { call, db } = demo();
    db.exec("UPDATE department SET name = 'Eng', ver = 2 WHERE code = 'ENG'");
    const res = await call('hr.dept.saveAll', { dept: { columns: DEPT, changes: [{ s: 'U', id: 4, v: ['ENG', 'Engineering 2', 1], o: { '1': 'Engineering' } }] } });
    expect(res.status).toBe(409);
    expect(res.body['errors']).toEqual([{ dataset: 'dept', id: 4, code: 'conflict', message: expect.any(String) }]);
  });

  it('resetDemoDatabase restores the seed', () => {
    const { db } = demo();
    db.exec('DELETE FROM employee');
    resetDemoDatabase(db);
    expect(db.prepare('SELECT count(*) AS n FROM employee').get()).toEqual({ n: 25 });
  });
});
