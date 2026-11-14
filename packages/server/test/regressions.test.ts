import { afterEach, describe, expect, it } from 'vitest';
import { createServer, customService, tableService, type Service } from '../src/index.ts';
import { ensureDemoDatabase } from '../../../apps/demo/server/seed.ts';
import { demoServices } from '../../../apps/demo/server/services.ts';
import { empTable, seedWorld, tempDatabase, worldServices } from './world.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

const EMP = [
  { id: 'empNo', type: 'string', key: true },
  { id: 'empName', type: 'string' },
  { id: 'salary', type: 'decimal' },
  { id: 'ver', type: 'int', version: true },
];
const DEPT = [
  { id: 'deptCode', type: 'string', key: true },
  { id: 'deptName', type: 'string' },
];

function world(extra: Service[] = [], hosts?: string[]) {
  const t = tempDatabase();
  cleanups.push(t.cleanup);
  seedWorld(t.db);
  const app = createServer({ services: [...worldServices, ...extra], db: t.db, logger: { error() {} }, ...(hosts ? { hosts } : {}) });
  return { db: t.db, app, call: caller(app) };
}

function caller(app: ReturnType<typeof createServer>) {
  return async (service: string, datasets?: object, headers: Record<string, string> = {}) => {
    const res = await app.inject({
      method: 'POST',
      url: `/dsx/v1/tx/${service}`,
      headers: { 'content-type': 'application/json', ...headers },
      payload: JSON.stringify({ dsx: 1, txId: 't', service, datasets }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read deep into loosely shaped responses
    return { status: res.statusCode, body: res.json() as Record<string, any> };
  };
}

const emp = (...changes: object[]) => ({ dsEmp: { columns: EMP, changes } });
const dept = (...changes: object[]) => ({ dsDept: { columns: DEPT, changes } });

describe('1. a stale client can not overwrite a row created later under a reused key', () => {
  it('a generated key is never issued twice, even when the top row was deleted', async () => {
    const { call } = world();
    const first = await call('hr.emp.save', emp({ s: 'I', id: 1, v: [null, 'A', '1', null] }));
    expect(first.body['applied'].dsEmp['1'].empNo).toBe('E1003');
    expect((await call('hr.emp.save', emp({ s: 'D', id: 1, v: ['E1003', 'A', '1', 1] }))).status).toBe(200);
    const second = await call('hr.emp.save', emp({ s: 'I', id: 1, v: [null, 'B', '1', null] }));
    expect(second.body['applied'].dsEmp['1'].empNo).toBe('E1004');
  });

  it('a typed key that comes back starts above the version its old row had', async () => {
    const { call, db } = world();
    expect((await call('hr.emp.save', emp({ s: 'D', id: 1, v: ['E1002', 'Ara Cho', '4000000', 1] }))).status).toBe(200);
    const again = await call('hr.emp.save', emp({ s: 'I', id: 2, v: ['E1002', 'New Person', '1', null] }));
    expect(again.body['applied'].dsEmp['2'].ver).toBe(2);
    // A client still holding the old row (version 1) must now see a conflict instead of overwriting the new person.
    const stale = await call('hr.emp.save', emp({ s: 'U', id: 3, v: ['E1002', 'Stale Edit', '4000000', 1], o: { '1': 'Ara Cho' } }));
    expect(stale.status).toBe(409);
    expect(db.prepare("SELECT empName FROM emp WHERE empNo = 'E1002'").get()).toEqual({ empName: 'New Person' });
  });

  it('a key that was changed away from can not be taken over at its old version', async () => {
    const typed = tableService({ id: 'x.typed', inputs: { dsEmp: { ...empTable, columns: empTable.columns.map(({ generated: _g, ...c }) => c) } } });
    const { call } = world([typed]);
    const move = await call('x.typed', emp({ s: 'U', id: 1, v: ['E5000', 'Ara Cho', '4000000', 1], o: { '0': 'E1002' } }));
    expect(move.status).toBe(200);
    const back = await call('x.typed', emp({ s: 'I', id: 2, v: ['E1002', 'Someone', '1', null] }));
    expect(back.body['applied'].dsEmp['2'].ver).toBeGreaterThan(1);
  });

  it('a rowid that SQLite hands out again also starts above the old version', async () => {
    const auto = tableService({
      id: 'x.auto',
      inputs: { dsT: { table: 'qa_types', columns: [{ id: 'id', type: 'int', key: true, generated: 'rowid' }, { id: 'count', type: 'int', version: true }] } },
    });
    const { call } = world([auto]);
    const cols = [{ id: 'id', type: 'int' }, { id: 'count', type: 'int' }];
    const one = await call('x.auto', { dsT: { columns: cols, changes: [{ s: 'I', id: 1, v: [null, null] }] } });
    expect(one.body['applied'].dsT['1']).toEqual({ id: 1, count: 1 });
    await call('x.auto', { dsT: { columns: cols, changes: [{ s: 'D', id: 1, v: [1, 1] }] } });
    const two = await call('x.auto', { dsT: { columns: cols, changes: [{ s: 'I', id: 1, v: [null, null] }] } });
    expect(two.body['applied'].dsT['1']).toEqual({ id: 1, count: 2 });
  });

  it('the demo database keeps its sequence after the top employee is deleted, and after a reset', async () => {
    const t = tempDatabase();
    cleanups.push(t.cleanup);
    ensureDemoDatabase(t.db);
    const call = caller(createServer({ services: demoServices, db: t.db, logger: { error() {} } }));
    const cols = [{ id: 'empNo', type: 'string' }, { id: 'empName', type: 'string' }, { id: 'ver', type: 'int', version: true }];
    const gone = await call('hr.emp.save', { emp: { columns: cols, changes: [{ s: 'D', id: 1, v: ['E025', 'Yvonne Fisher', 1] }] } });
    expect(gone.status).toBe(200);
    const next = await call('hr.emp.save', { emp: { columns: cols, changes: [{ s: 'I', id: 2, v: [null, 'N', null] }] } });
    expect(next.body['applied'].emp['2'].empNo).toBe('E026');
    expect(t.db.prepare("SELECT value FROM fw_sequence WHERE name = 'employee'").get()).toEqual({ value: 26 });
  });
});

describe('2. nothing is committed if the response can not be built', () => {
  it('a response that can not be turned into JSON rolls back', async () => {
    const bad = customService({
      id: 'x.bigint',
      handler(ctx) {
        ctx.db.exec("DELETE FROM emp WHERE empNo = 'E1001'");
        return { params: { n: 1n } };
      },
    });
    const { call, db } = world([bad]);
    const res = await call('x.bigint');
    expect(res.status).toBe(500);
    expect(db.prepare('SELECT count(*) AS n FROM emp').get()).toEqual({ n: 3 });
  });
});

describe('3. keys with leading or trailing spaces', () => {
  it('rejects them as a row error that names the row and column', async () => {
    const { call, db } = world();
    for (const key of ['NEW ', ' NEW']) {
      const res = await call('hr.dept.save', dept({ s: 'I', id: 6, v: [key, 'New'] }));
      expect(res.status).toBe(422);
      expect(res.body['errors']).toMatchObject([{ dataset: 'dsDept', id: 6, column: 'deptCode', code: 'pattern' }]);
    }
    const rename = await call('hr.dept.save', dept({ s: 'U', id: 7, v: ['D010 ', 'Sales'], o: { '0': 'D010' } }));
    expect(rename.status).toBe(422);
    expect(db.prepare('SELECT count(*) AS n FROM dept').get()).toEqual({ n: 2 });
  });
});

describe('4. a conflict wins over a constraint failure', () => {
  it('answers 409 with the conflicts when the same save also breaks a constraint', async () => {
    const { call, db } = world();
    db.exec("UPDATE emp SET ver = 5 WHERE empNo = 'E1001'");
    const res = await call(
      'hr.emp.save',
      emp(
        { s: 'U', id: 1, v: ['E1001', 'x', '1', 7], o: { '1': 'Minju Kim' } },
        { s: 'I', id: 2, v: ['E1002', 'duplicate key', '1', null] },
      ),
    );
    expect(res.status).toBe(409);
    expect(res.body['errors']).toEqual([expect.objectContaining({ id: 1, code: 'conflict' })]);
  });

  it('still answers 422 when there is only a constraint failure, and across datasets a conflict later on wins', async () => {
    const { call, db } = world();
    const only = await call('hr.org.save', {
      ...emp({ s: 'I', id: 2, v: ['E1002', 'dup', '1', null] }),
      ...dept({ s: 'I', id: 3, v: [null, 'Fine'] }),
    });
    expect(only.status).toBe(422);
    db.exec("UPDATE dept SET deptName = 'Changed' WHERE deptCode = 'D010'");
    const both = await call('hr.org.save', {
      ...emp({ s: 'I', id: 2, v: ['E1002', 'dup', '1', null] }),
      ...dept({ s: 'D', id: 4, v: ['D010', 'Sales'] }),
    });
    expect(both.status).toBe(409);
  });
});

describe('5. a blank generated key is generated', () => {
  it('treats an empty or whitespace-only value as not given', async () => {
    const { call } = world();
    const res = await call('hr.emp.save', emp({ s: 'I', id: 1, v: ['', 'A', '1', null] }, { s: 'I', id: 2, v: ['   ', 'B', '1', null] }));
    expect(res.status).toBe(200);
    expect(res.body['applied'].dsEmp['1'].empNo).toBe('E1003');
    expect(res.body['applied'].dsEmp['2'].empNo).toBe('E1004');
  });
});

describe('6. Host check', () => {
  it('answers 400 to a foreign host name, and accepts the local ones with any port', async () => {
    const { call } = world();
    for (const host of ['evil.example:5300', 'evil.example', '127.0.0.1.evil.example', 'localhost.evil.example:5300']) {
      expect((await call('hr.dept.save', dept(), { host })).status, host).toBe(400);
    }
    for (const host of ['127.0.0.1:5300', 'localhost:5180', 'LOCALHOST', '[::1]:5300', '127.0.0.1']) {
      expect((await call('hr.dept.save', dept(), { host })).status, host).toBe(200);
    }
  });

  it('also guards unknown paths, and can be configured for another host', async () => {
    const { app } = world();
    expect((await app.inject({ method: 'POST', url: '/nope', headers: { host: 'evil.example' } })).statusCode).toBe(400);
    const { call } = world([], ['demo.test']);
    expect((await call('hr.dept.save', dept(), { host: 'demo.test:80' })).status).toBe(200);
    expect((await call('hr.dept.save', dept(), { host: 'localhost' })).status).toBe(400);
  });
});

describe('7. custom services get conflicts as errors by default', () => {
  const stale = (name: string, mode?: 'return') =>
    customService({
      id: name,
      inputs: { dsEmp: { columns: empTable.columns } },
      handler(ctx) {
        const outcome = ctx.saveChanges('dsEmp', empTable, mode ? { conflicts: mode } : undefined);
        return { params: { conflicts: outcome.conflicts.length } };
      },
    });

  it('a handler that ignores the outcome still answers 409 and rolls back', async () => {
    const { call, db } = world([stale('x.stale')]);
    db.exec("UPDATE emp SET ver = 9 WHERE empNo = 'E1001'");
    const res = await call('x.stale', emp({ s: 'U', id: 1, v: ['E0999', 'Fine', '1', 3], o: { '1': 'Seojun Park' } }, { s: 'U', id: 2, v: ['E1001', 'x', '1', 7], o: { '1': 'Minju Kim' } }));
    expect(res.status).toBe(409);
    expect(res.body['errors']).toEqual([expect.objectContaining({ id: 2 })]);
    expect(db.prepare("SELECT empName FROM emp WHERE empNo = 'E0999'").get()).toEqual({ empName: 'Seojun Park' });
  });

  it("{ conflicts: 'return' } hands them back, and the handler decides", async () => {
    const { call, db } = world([stale('x.collect', 'return')]);
    db.exec("UPDATE emp SET ver = 9 WHERE empNo = 'E1001'");
    const res = await call('x.collect', emp({ s: 'U', id: 2, v: ['E1001', 'x', '1', 7], o: { '1': 'Minju Kim' } }));
    expect(res.status).toBe(200);
    expect(res.body['params']).toEqual({ conflicts: 1 });
  });
});
