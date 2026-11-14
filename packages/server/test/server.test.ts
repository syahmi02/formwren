import { afterEach, describe, expect, it } from 'vitest';
import {
  ConflictError,
  ValidationError,
  createServer,
  customService,
  tableService,
  type Authorize,
  type Limits,
  type Service,
} from '../src/index.ts';
import { deptTable, empTable, seedWorld, tempDatabase, worldServices } from './world.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

const EMP_COLUMNS = [
  { id: 'empNo', type: 'string', size: 10, key: true },
  { id: 'empName', type: 'string', size: 50 },
  { id: 'salary', type: 'decimal', precision: 12, scale: 0 },
  { id: 'ver', type: 'int', version: true },
];
const DEPT_COLUMNS = [
  { id: 'deptCode', type: 'string', size: 4, key: true },
  { id: 'deptName', type: 'string', size: 30 },
];
const T_COLUMNS = [
  { id: 'id', type: 'int', key: true },
  { id: 'amount', type: 'decimal', precision: 30, scale: 10 },
  { id: 'day', type: 'date' },
  { id: 'stamp', type: 'datetime' },
  { id: 'note', type: 'string', size: 40 },
  { id: 'count', type: 'int' },
];

interface Setup {
  app: ReturnType<typeof createServer>;
  db: ReturnType<typeof tempDatabase>['db'];
  logged: Record<string, unknown>[];
}

function setup(extra: { services?: Service[]; authorize?: Authorize; limits?: Partial<Limits> } = {}): Setup {
  const t = tempDatabase();
  cleanups.push(t.cleanup);
  seedWorld(t.db);
  const logged: Record<string, unknown>[] = [];
  const app = createServer({
    services: [...worldServices, ...(extra.services ?? [])],
    db: t.db,
    logger: { error: (details, message) => logged.push({ message, ...details }) },
    ...(extra.authorize ? { authorize: extra.authorize } : {}),
    ...(extra.limits ? { limits: extra.limits } : {}),
  });
  cleanups.push(() => void app.close());
  return { app, db: t.db, logged };
}

interface Reply {
  status: number;
  body: {
    status: { ok: boolean; code?: string; message?: string };
    params?: Record<string, unknown>;
    datasets?: Record<string, { columns: { id: string }[]; rows: unknown[][] }>;
    applied?: Record<string, Record<string, Record<string, unknown>>>;
    errors?: { dataset?: string; id?: number; column?: string; code: string }[];
  };
  raw: string;
}

async function post(s: Setup, service: string, body: unknown): Promise<Reply> {
  const res = await s.app.inject({
    method: 'POST',
    url: `/dsx/v1/tx/${service}`,
    headers: { 'content-type': 'application/json' },
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });
  let parsed = {} as Reply['body'];
  try {
    parsed = res.json();
  } catch {
    // A body that isn't JSON fails the test through the status check.
  }
  return { status: res.statusCode, body: parsed, raw: res.body };
}

const request = (service: string, datasets?: Record<string, unknown>, params?: Record<string, unknown>) => ({
  dsx: 1,
  txId: 'T1',
  service,
  ...(params ? { params } : {}),
  ...(datasets ? { datasets } : {}),
});

const empSave = (changes: unknown[], columns: unknown[] = EMP_COLUMNS) => request('hr.emp.save', { dsEmp: { columns, changes } });
const empRows = (db: Setup['db']) => db.prepare('SELECT * FROM emp ORDER BY empNo').all().map((r) => Object.values(r));

describe('N-2: all or nothing', () => {
  it('a save whose last row fails leaves the database unchanged', async () => {
    const s = setup();
    const before = empRows(s.db);
    const res = await post(
      s,
      'hr.emp.save',
      empSave([
        { s: 'U', id: 0, v: ['E1001', 'Changed', '5200000', 7], o: { '1': 'Minju Kim' } },
        { s: 'D', id: 1, v: ['E0999', 'Seojun Park', '3900000', 3] },
        { s: 'I', id: 2, v: [null, 'New One', '1', null] },
        { s: 'I', id: 3, v: ['E1002', 'Duplicate key', '1', null] },
      ]),
    );
    expect(res.status).toBe(422);
    expect(res.body.status.code).toBe('constraint');
    expect(res.body.errors).toMatchObject([{ dataset: 'dsEmp', id: 3, code: 'constraint' }]);
    expect(empRows(s.db)).toEqual(before);
  });

  it('rolls back when a handler throws after writing', async () => {
    const boom = customService({
      id: 'x.boom',
      handler(ctx) {
        ctx.db.exec("DELETE FROM emp WHERE empNo = 'E1001'");
        throw new Error('SQLITE_BUSY: secret internal detail');
      },
    });
    const s = setup({ services: [boom] });
    const before = empRows(s.db);
    const res = await post(s, 'x.boom', request('x.boom'));
    expect(res.status).toBe(500);
    expect(empRows(s.db)).toEqual(before);
    expect(s.db.isTransaction).toBe(false);
  });

  it('a failed save wastes no generated number', async () => {
    const s = setup();
    const failed = await post(s, 'hr.emp.save', empSave([{ s: 'I', id: 1, v: [null, 'A', '1', null] }, { s: 'I', id: 2, v: ['E1002', 'dup', '1', null] }]));
    expect(failed.status).toBe(422);
    const ok = await post(s, 'hr.emp.save', empSave([{ s: 'I', id: 1, v: [null, 'A', '1', null] }]));
    expect(ok.body.applied?.['dsEmp']?.['1']?.['empNo']).toBe('E1003');
  });
});

describe('N-3: conflicts', () => {
  it('a stale version is a conflict, with a row error naming the row and no column', async () => {
    const s = setup();
    s.db.exec("UPDATE emp SET ver = 8, empName = 'Other' WHERE empNo = 'E1001'");
    const res = await post(s, 'hr.emp.save', empSave([{ s: 'U', id: 5, v: ['E1001', 'Mine', '5200000', 7], o: { '1': 'Minju Kim' } }]));
    expect(res.status).toBe(409);
    expect(res.body.status.code).toBe('conflict');
    expect(res.body.errors).toEqual([expect.objectContaining({ dataset: 'dsEmp', id: 5, code: 'conflict' })]);
    expect(res.body.errors?.[0]).not.toHaveProperty('column');
    expect(empRows(s.db)[1]).toEqual(['E1001', 'Other', '5200000', 8]);
  });

  it('reports every conflicting row, and rolls back the rows that were fine', async () => {
    const s = setup();
    s.db.exec("UPDATE emp SET ver = 9 WHERE empNo IN ('E1001', 'E1002')");
    const before = empRows(s.db);
    const res = await post(
      s,
      'hr.emp.save',
      empSave([
        { s: 'U', id: 0, v: ['E0999', 'Fine', '3900000', 3], o: { '1': 'Seojun Park' } },
        { s: 'U', id: 1, v: ['E1001', 'x', '5200000', 7], o: { '1': 'Minju Kim' } },
        { s: 'D', id: 2, v: ['E1002', 'Ara Cho', '4000000', 1] },
      ]),
    );
    expect(res.status).toBe(409);
    expect(res.body.errors?.map((e) => e.id).sort()).toEqual([1, 2]);
    expect(empRows(s.db)).toEqual(before);
  });

  it('a row deleted by someone else is a conflict', async () => {
    const s = setup();
    s.db.exec("DELETE FROM emp WHERE empNo = 'E1002'");
    const res = await post(s, 'hr.emp.save', empSave([{ s: 'D', id: 4, v: ['E1002', 'Ara Cho', '4000000', 1] }]));
    expect(res.status).toBe(409);
    expect(res.body.errors).toMatchObject([{ id: 4, code: 'conflict' }]);
  });

  it('without a version column, a changed column anywhere in the row is a conflict', async () => {
    const s = setup();
    s.db.exec("UPDATE dept SET deptName = 'Sales North' WHERE deptCode = 'D010'");
    const res = await post(s, 'hr.dept.save', request('hr.dept.save', { dsDept: { columns: DEPT_COLUMNS, changes: [{ s: 'D', id: 0, v: ['D010', 'Sales'] }] } }));
    expect(res.status).toBe(409);
    expect(s.db.prepare('SELECT count(*) AS n FROM dept').get()).toEqual({ n: 2 });
  });

  it('without a version column, an unchanged row is never a false conflict', async () => {
    const s = setup();
    const res = await post(s, 'hr.dept.save', request('hr.dept.save', { dsDept: { columns: DEPT_COLUMNS, changes: [{ s: 'U', id: 0, v: ['D010', 'Sales EU'], o: { '1': 'Sales' } }] } }));
    expect(res.status).toBe(200);
    expect(s.db.prepare("SELECT deptName FROM dept WHERE deptCode = 'D010'").get()).toEqual({ deptName: 'Sales EU' });
  });

  it('a client that does not send the version column falls back to comparing every column', async () => {
    const s = setup();
    const noVer = EMP_COLUMNS.slice(0, 3);
    s.db.exec("UPDATE emp SET salary = '1' WHERE empNo = 'E1001'");
    const stale = await post(s, 'hr.emp.save', empSave([{ s: 'U', id: 0, v: ['E1001', 'New', '5200000'], o: { '1': 'Minju Kim' } }], noVer));
    expect(stale.status).toBe(409);
    const fresh = await post(s, 'hr.emp.save', empSave([{ s: 'U', id: 0, v: ['E1001', 'New', '1'], o: { '1': 'Minju Kim' } }], noVer));
    expect(fresh.status).toBe(200);
    // The server still counts the version, though this client does not hold it.
    expect(s.db.prepare("SELECT ver FROM emp WHERE empNo = 'E1001'").get()).toEqual({ ver: 8 });
    expect(fresh.body.applied).toBeUndefined();
  });

  it('an update sets only the columns in o', async () => {
    const s = setup();
    s.db.exec("UPDATE emp SET salary = '777' WHERE empNo = 'E1001'");
    // The client's salary is stale, but it did not change it, so it must not be written back.
    const res = await post(s, 'hr.emp.save', empSave([{ s: 'U', id: 0, v: ['E1001', 'Renamed', '5200000', 7], o: { '1': 'Minju Kim' } }]));
    expect(res.status).toBe(200);
    expect(s.db.prepare("SELECT empName, salary FROM emp WHERE empNo = 'E1001'").get()).toEqual({ empName: 'Renamed', salary: '777' });
  });
});

describe('validation, before any write', () => {
  async function untouched(s: Setup, body: unknown, status: number): Promise<Reply> {
    const before = empRows(s.db);
    const res = await post(s, 'hr.emp.save', body);
    expect(res.status).toBe(status);
    expect(empRows(s.db)).toEqual(before);
    return res;
  }
  const good = { s: 'U', id: 0, v: ['E1001', 'Valid change', '5200000', 7], o: { '1': 'Minju Kim' } };

  it('rejects an unknown column and an unknown dataset with 400', async () => {
    const s = setup();
    await untouched(s, empSave([good], [...EMP_COLUMNS, { id: 'bonus', type: 'int' }]), 400);
    await untouched(s, request('hr.emp.save', { dsNope: { columns: EMP_COLUMNS, changes: [] } }), 400);
  });

  it('rejects a column that has another type on the server', async () => {
    const s = setup();
    await untouched(s, empSave([good], EMP_COLUMNS.map((c) => (c.id === 'salary' ? { ...c, type: 'int' } : c))), 400);
  });

  it('rejects wrong types, size, precision and scale with row errors, and applies nothing', async () => {
    const s = setup();
    const res = await untouched(
      s,
      empSave([
        good,
        { s: 'I', id: 1, v: [null, 'x'.repeat(51), '1', null] },
        { s: 'I', id: 2, v: [null, 'n', 12345.5, null] },
        { s: 'I', id: 3, v: [null, 'n', '1234567890123', null] },
        { s: 'I', id: 4, v: [null, 'n', '1.5', null] },
        { s: 'I', id: 5, v: [null, 5, '1', null] },
      ]),
      422,
    );
    expect(res.body.status.code).toBe('invalid');
    const codes = Object.fromEntries((res.body.errors ?? []).map((e) => [e.id, `${e.column}:${e.code}`]));
    expect(codes).toEqual({ 1: 'empName:length', 2: 'salary:type', 3: 'salary:precision', 4: 'salary:scale', 5: 'empName:type' });
  });

  it('rejects a missing required value, with null and with an empty string', async () => {
    const s = setup();
    const res = await untouched(s, empSave([good, { s: 'I', id: 1, v: [null, null, '1', null] }, { s: 'I', id: 2, v: [null, '', '1', null] }]), 422);
    expect(res.body.errors).toMatchObject([
      { id: 1, column: 'empName', code: 'required' },
      { id: 2, column: 'empName', code: 'required' },
    ]);
  });

  it('requires the key of a table whose key is not generated', async () => {
    const s = setup();
    const res = await post(s, 'qa.types.save', request('qa.types.save', { dsT: { columns: T_COLUMNS, changes: [{ s: 'I', id: 0, v: [null, null, null, null, null, null] }] } }));
    expect(res.status).toBe(422);
    expect(res.body.errors).toMatchObject([{ column: 'id', code: 'required' }]);
  });

  it('checks the declared minimum', async () => {
    const checked = tableService({
      id: 'x.min',
      inputs: { dsEmp: { ...empTable, columns: empTable.columns.map((c) => (c.id === 'salary' ? { ...c, min: { value: '30000', message: 'Too low' } } : c)) } },
    });
    const s = setup({ services: [checked] });
    const low = await post(s, 'x.min', request('x.min', { dsEmp: { columns: EMP_COLUMNS, changes: [{ s: 'I', id: 0, v: [null, 'n', '29999', null] }] } }));
    expect(low.status).toBe(422);
    expect(low.body.errors).toMatchObject([{ id: 0, column: 'salary', code: 'range', message: 'Too low' }]);
    const ok = await post(s, 'x.min', request('x.min', { dsEmp: { columns: EMP_COLUMNS, changes: [{ s: 'I', id: 0, v: [null, 'n', '30000', null] }] } }));
    expect(ok.status).toBe(200);
  });

  it('rejects malformed structure with 400', async () => {
    const s = setup();
    await untouched(s, empSave([{ s: 'X', id: 0, v: ['E1001', 'a', '1', 7] }]), 400);
    await untouched(s, empSave([{ s: 'U', id: 0, v: ['E1001', 'a'] }]), 400);
    await untouched(s, empSave([{ s: 'U', id: 0, v: ['E1001', 'a', '1', 7] }]), 400);
    await untouched(s, empSave([{ s: 'U', id: 0, v: ['E1001', 'a', '1', 7], o: { '9': 'x' } }]), 400);
    await untouched(s, empSave([{ s: 'I', id: 0.5, v: [null, 'a', '1', null] }]), 400);
    await untouched(s, empSave([{ s: 'I', id: 0, v: [{}, 'a', '1', null] }]), 400);
    await untouched(s, empSave([{ s: 'D', id: 0, v: ['E1001', 'a', '1', 7], o: { '1': 'x' } }]), 400);
  });

  it('does not let a client choose table or column names', async () => {
    const s = setup();
    await untouched(s, empSave([good], [...EMP_COLUMNS, { id: 'empNo" FROM emp; --', type: 'string' }]), 400);
  });
});

describe('limits', () => {
  const small = { datasets: 1, columns: 4, rows: 2, bodyBytes: 2000 };

  it('rejects too many datasets, columns and rows before any work', async () => {
    let ran = 0;
    const one = { columns: [{ id: 'c', type: 'string' }], rows: [['x']] };
    const counted = customService({
      id: 'x.count',
      inputs: { a: { columns: [{ id: 'c', type: 'string' }] }, b: { columns: [{ id: 'c', type: 'string' }] } },
      handler: () => void (ran += 1),
    });
    const s = setup({ limits: small, services: [counted] });
    expect((await post(s, 'x.count', request('x.count', { a: one, b: one }))).status).toBe(400);
    expect((await post(s, 'hr.emp.save', empSave([], [...EMP_COLUMNS, { id: 'extra', type: 'string' }]))).status).toBe(400);
    const rows = await post(s, 'hr.emp.save', empSave([0, 1, 2].map((i) => ({ s: 'I', id: i, v: [null, 'n', '1', null] }))));
    expect(rows.status).toBe(400);
    expect(rows.body.status.code).toBe('limit');
    expect(ran).toBe(0);
    expect(s.db.prepare('SELECT count(*) AS n FROM emp').get()).toEqual({ n: 3 });
  });

  it('accepts a request exactly at the limits', async () => {
    const s = setup({ limits: small });
    const res = await post(s, 'hr.emp.save', empSave([0, 1].map((i) => ({ s: 'I', id: i, v: [null, 'n', '1', null] }))));
    expect(res.status).toBe(200);
  });

  it('rejects a body over the size limit', async () => {
    const s = setup({ limits: small });
    const res = await post(s, 'hr.emp.save', empSave([{ s: 'I', id: 0, v: [null, 'x'.repeat(3000), '1', null] }]));
    expect(res.status).toBe(400);
    expect(res.body.status.code).toBe('limit');
  });

  it('defaults: 20 datasets, 100 columns, 100000 rows, 5 MB', async () => {
    const s = setup();
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`d${i}`, { columns: [] }]));
    expect((await post(s, 'hr.emp.save', request('hr.emp.save', many))).status).toBe(400);
    const wide = Array.from({ length: 101 }, (_, i) => ({ id: `c${i}`, type: 'string' }));
    expect((await post(s, 'hr.emp.save', empSave([], wide))).status).toBe(400);
    expect((await post(s, 'hr.emp.save', empSave(Array.from({ length: 100_001 }, () => 0)))).status).toBe(400);
    expect((await post(s, 'hr.emp.save', { ...empSave([]), pad: 'x'.repeat(5 * 1024 * 1024 + 1) })).status).toBe(400);
  });
});

describe('generated keys and versions', () => {
  it('returns generated keys in id order, and the version after each update', async () => {
    const s = setup();
    const res = await post(
      s,
      'hr.emp.save',
      empSave([
        { s: 'I', id: 9, v: [null, 'Nine', '1', null] },
        { s: 'I', id: 4, v: [null, 'Four', '1', null] },
        { s: 'U', id: 1, v: ['E1002', 'Ara', '4000000', 1], o: { '1': 'Ara Cho' } },
      ]),
    );
    expect(res.status).toBe(200);
    expect(res.body.applied).toEqual({ dsEmp: { '4': { empNo: 'E1003', ver: 1 }, '9': { empNo: 'E1004', ver: 1 }, '1': { ver: 2 } } });
    expect(res.body.params).toEqual({ saved: 3 });
  });

  it('keeps a key the client chose, and skips a generated key that is already taken', async () => {
    const s = setup();
    await post(s, 'hr.emp.save', empSave([{ s: 'I', id: 0, v: ['E1003', 'Chosen', '1', null] }]));
    const res = await post(s, 'hr.emp.save', empSave([{ s: 'I', id: 1, v: [null, 'Next', '1', null] }]));
    expect(res.body.applied?.['dsEmp']?.['1']?.['empNo']).toBe('E1004');
  });

  it('assigns a rowid key', async () => {
    const auto = tableService({
      id: 'x.auto',
      inputs: { dsT: { table: 'qa_types', columns: [{ id: 'id', type: 'int', key: true, generated: 'rowid' }, { id: 'note', type: 'string' }] } },
    });
    const s = setup({ services: [auto] });
    const columns = [{ id: 'id', type: 'int' }, { id: 'note', type: 'string' }];
    const res = await post(s, 'x.auto', request('x.auto', { dsT: { columns, changes: [{ s: 'I', id: 3, v: [null, 'a'] }, { s: 'I', id: 4, v: [null, 'b'] }] } }));
    expect(res.body.applied).toEqual({ dsT: { '3': { id: 1 }, '4': { id: 2 } } });
  });

  it('counts versions up across saves', async () => {
    const s = setup();
    let ver = 7;
    for (let i = 0; i < 3; i++) {
      const res = await post(s, 'hr.emp.save', empSave([{ s: 'U', id: 0, v: ['E1001', `n${i}`, '5200000', ver], o: { '1': i === 0 ? 'Minju Kim' : `n${i - 1}` } }]));
      expect(res.status).toBe(200);
      ver = res.body.applied?.['dsEmp']?.['0']?.['ver'] as number;
    }
    expect(ver).toBe(10);
  });
});

describe('exact values', () => {
  const save = (s: Setup, changes: unknown[]) => post(s, 'qa.types.save', request('qa.types.save', { dsT: { columns: T_COLUMNS, changes } }));
  const list = async (s: Setup) => (await post(s, 'qa.types.list', request('qa.types.list'))).body.datasets?.['dsT']?.rows ?? [];

  it('round-trips long decimals, dates, datetimes with fractions and padded text as the same text', async () => {
    const s = setup();
    const row = [1, '12345678901234567890.1234567890', '2024-02-29', '2024-02-29T23:59:59.123456', '  padded  ', 9007199254740991];
    expect((await save(s, [{ s: 'I', id: 0, v: row }])).status).toBe(200);
    expect(await list(s)).toEqual([row]);
  });

  it('keeps an empty string and null apart', async () => {
    const s = setup();
    await save(s, [{ s: 'I', id: 0, v: [1, null, null, null, '', 0] }, { s: 'I', id: 1, v: [2, null, null, null, null, 0] }]);
    expect((await list(s)).map((r) => r[4])).toEqual(['', null]);
    // Moving from one to the other is a real change, and the check sees the difference.
    const wrong = await save(s, [{ s: 'U', id: 0, v: [1, null, null, null, 'x', 0], o: { '4': null } }]);
    expect(wrong.status).toBe(409);
    const right = await save(s, [{ s: 'U', id: 0, v: [1, null, null, null, null, 0], o: { '4': '' } }]);
    expect(right.status).toBe(200);
    expect((await list(s)).map((r) => r[4])).toEqual([null, null]);
  });

  it('compares decimal text exactly: unchanged text matches, other spellings of the same number do not', async () => {
    const s = setup();
    await save(s, [{ s: 'I', id: 0, v: [1, '0.1000000000', '1999-12-31', '2000-01-01T00:00:00.000', 'a', 5] }]);
    const res = await save(s, [{ s: 'U', id: 0, v: [1, '0.1000000000', '1999-12-31', '2000-01-01T00:00:00.000', 'b', 5], o: { '4': 'a' } }]);
    expect(res.status).toBe(200);
    const other = await save(s, [{ s: 'D', id: 1, v: [1, '0.10', '1999-12-31', '2000-01-01T00:00:00.000', 'b', 5] }]);
    expect(other.status).toBe(409);
  });

  it('accepts ints at both safe limits and rejects what a double cannot hold exactly', async () => {
    const s = setup();
    const ok = await save(s, [{ s: 'I', id: 0, v: [1, null, null, null, null, 9007199254740991] }, { s: 'I', id: 1, v: [2, null, null, null, null, -9007199254740991] }]);
    expect(ok.status).toBe(200);
    expect((await list(s)).map((r) => r[5])).toEqual([9007199254740991, -9007199254740991]);
    const raw = (n: string) =>
      `{"dsx":1,"txId":"t","service":"qa.types.save","datasets":{"dsT":{"columns":${JSON.stringify(T_COLUMNS)},"changes":[{"s":"I","id":0,"v":[3,null,null,null,null,${n}]}]}}}`;
    for (const n of ['9007199254740992', '9007199254740993', '1.5', '1e30']) {
      expect((await post(s, 'qa.types.save', raw(n))).status, n).toBe(422);
    }
  });

  it('refuses to send an int it cannot represent exactly', async () => {
    const s = setup();
    s.db.exec('INSERT INTO qa_types (id, count) VALUES (1, 9007199254740993)');
    const res = await post(s, 'qa.types.list', request('qa.types.list'));
    expect(res.status).toBe(500);
  });

  it('rejects a decimal sent as a JSON number, and bad dates', async () => {
    const s = setup();
    const bad = [
      [1, 5, null, null, null, null],
      [1, null, '2023-02-29', null, null, null],
      [1, null, null, '2024-01-01 10:00:00', null, null],
      [1, 'abc', null, null, null, null],
    ];
    for (const v of bad) expect((await save(s, [{ s: 'I', id: 0, v }])).status).toBe(422);
  });

  it('returns booleans as booleans', async () => {
    const flags = customService({
      id: 'x.flags',
      outputs: { f: { columns: [{ id: 'on', type: 'boolean' }, { id: 'off', type: 'boolean' }, { id: 'none', type: 'boolean' }] } },
      handler: (ctx) => ({ datasets: { f: ctx.db.prepare('SELECT 1 AS "on", 0 AS "off", NULL AS "none"').all() } }),
    });
    const s = setup({ services: [flags] });
    expect((await post(s, 'x.flags', request('x.flags'))).body.datasets?.['f']?.rows).toEqual([[true, false, null]]);
  });
});

describe('rows and ids', () => {
  const echo = customService({
    id: 'x.rows',
    inputs: { r: { columns: [{ id: 'empNo', type: 'string', key: true }, { id: 'ver', type: 'int', version: true }], mode: 'rows' } },
    handler(ctx) {
      const rows = ctx.input('r').rows;
      const stale = rows.filter((row) => !ctx.isUnchanged(empTable, row.values));
      if (stale.length) throw new ConflictError(stale.map((row) => ({ dataset: 'r', id: row.id, code: 'conflict', message: 'Changed' })));
      const bad = rows.filter((row) => row.values['empNo'] === 'E0999');
      if (bad.length) throw new ValidationError(bad.map((row) => ({ dataset: 'r', id: row.id, column: 'empNo', code: 'custom', message: 'Not allowed' })));
      return { params: { n: rows.length, ids: rows.map((row) => row.id) } };
    },
  });
  const cols = [{ id: 'empNo', type: 'string' }, { id: 'ver', type: 'int' }];

  it('gives a service its rows with their client ids, and maps its errors back to them', async () => {
    const s = setup({ services: [echo] });
    const ok = await post(s, 'x.rows', request('x.rows', { r: { columns: cols, rows: [['E1001', 7], ['E1002', 1]], ids: [41, 17] } }));
    expect(ok.body.params).toEqual({ n: 2, ids: [41, 17] });
    const stale = await post(s, 'x.rows', request('x.rows', { r: { columns: cols, rows: [['E1001', 7], ['E1002', 5]], ids: [41, 17] } }));
    expect(stale.status).toBe(409);
    expect(stale.body.errors).toMatchObject([{ id: 17 }]);
    const bad = await post(s, 'x.rows', request('x.rows', { r: { columns: cols, rows: [['E1001', 7], ['E0999', 3]], ids: [41, 17] } }));
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toMatchObject([{ id: 17, column: 'empNo' }]);
  });

  it('rejects ids that do not match the rows, and rows sent to a service that takes changes', async () => {
    const s = setup({ services: [echo] });
    expect((await post(s, 'x.rows', request('x.rows', { r: { columns: cols, rows: [['E1001', 7]], ids: [1, 2] } }))).status).toBe(400);
    expect((await post(s, 'hr.emp.save', request('hr.emp.save', { dsEmp: { columns: EMP_COLUMNS, rows: [] } }))).status).toBe(400);
  });
});

describe('errors', () => {
  it('404 for an unknown service', async () => {
    const s = setup();
    const res = await post(s, 'hr.nope.save', request('hr.nope.save'));
    expect(res.status).toBe(404);
    expect(res.body.status).toMatchObject({ ok: false, code: 'unknown-service' });
  });

  it('404 for another path or method', async () => {
    const s = setup();
    expect((await s.app.inject({ method: 'POST', url: '/elsewhere' })).statusCode).toBe(404);
    expect((await s.app.inject({ method: 'GET', url: '/dsx/v1/tx/hr.emp.save' })).statusCode).toBe(404);
  });

  it('400 for a bad body', async () => {
    const s = setup();
    const bodies = [
      'not json',
      '[]',
      '"x"',
      'null',
      '{}',
      JSON.stringify({ ...request('hr.emp.save'), dsx: 2 }),
      JSON.stringify({ ...request('hr.emp.save'), txId: 5 }),
      JSON.stringify(request('hr.other.save')),
      JSON.stringify({ ...request('hr.emp.save'), datasets: [] }),
      JSON.stringify({ ...request('hr.emp.save'), params: [] }),
      '',
    ];
    for (const body of bodies) {
      const res = await post(s, 'hr.emp.save', body);
      expect(res.status, body).toBe(400);
      expect(res.body.status).toMatchObject({ ok: false });
    }
  });

  it('400 for a content type that is not JSON', async () => {
    const s = setup();
    const res = await s.app.inject({ method: 'POST', url: '/dsx/v1/tx/hr.emp.save', headers: { 'content-type': 'text/plain' }, payload: JSON.stringify(request('hr.emp.save')) });
    expect(res.statusCode).toBe(400);
  });

  it('400 for a __proto__ key', async () => {
    const s = setup();
    const res = await post(s, 'hr.emp.save', '{"dsx":1,"txId":"t","service":"hr.emp.save","params":{"__proto__":{"x":1}}}');
    expect(res.status).toBe(400);
  });
});

describe('authorize', () => {
  it('allows everything by default', async () => {
    const s = setup();
    expect((await post(s, 'hr.emp.save', empSave([]))).status).toBe(200);
  });

  it('refuses with 403 before any work, and is given the request and the service', async () => {
    const seen: string[] = [];
    const s = setup({
      authorize: (req, service) => {
        seen.push(`${service.id}:${String(req.headers['x-user'] ?? '')}`);
        return req.headers['x-user'] === 'ann';
      },
    });
    const body = empSave([{ s: 'D', id: 0, v: ['E1002', 'Ara Cho', '4000000', 1] }]);
    const denied = await post(s, 'hr.emp.save', body);
    expect(denied.status).toBe(403);
    expect(denied.body.status).toMatchObject({ ok: false, code: 'forbidden' });
    expect(empRows(s.db)).toHaveLength(3);
    const allowed = await s.app.inject({ method: 'POST', url: '/dsx/v1/tx/hr.emp.save', headers: { 'content-type': 'application/json', 'x-user': 'ann' }, payload: JSON.stringify(body) });
    expect(allowed.statusCode).toBe(200);
    expect(seen).toEqual(['hr.emp.save:', 'hr.emp.save:ann']);
  });

  it('supports an async hook, and a throwing hook is a 500 with nothing leaked', async () => {
    const s = setup({ authorize: async () => false });
    expect((await post(s, 'hr.emp.save', empSave([]))).status).toBe(403);
    const t = setup({
      authorize: () => {
        throw new Error('token store at /secret/path is down');
      },
    });
    const res = await post(t, 'hr.emp.save', empSave([]));
    expect(res.status).toBe(500);
    expect(res.raw).not.toContain('secret');
    expect(t.logged).toHaveLength(1);
  });

  it('does not run for an unknown service', async () => {
    let called = 0;
    const s = setup({ authorize: () => ++called > 0 });
    await post(s, 'hr.nope.save', request('hr.nope.save'));
    expect(called).toBe(0);
  });
});

describe('no database text in responses', () => {
  const leaks = /sqlite|constraint failed|unique|foreign key|no such|syntax|SELECT |INSERT |UPDATE |DELETE |qa_types|node_modules|\.ts:|\bat \w/i;

  it('a unique violation, a failing query and a throw give generic answers, and the details go to the logger', async () => {
    const broken = customService({ id: 'x.broken', handler: (ctx) => void ctx.db.prepare('SELECT * FROM missing_table').all() });
    const thrown = customService({
      id: 'x.thrown',
      handler() {
        throw new Error('password=hunter2 at C:\\secret\\file.ts');
      },
    });
    const s = setup({ services: [broken, thrown] });
    const dup = await post(s, 'hr.emp.save', empSave([{ s: 'I', id: 0, v: ['E1002', 'Dup', '1', null] }]));
    const bad = await post(s, 'x.broken', request('x.broken'));
    const boom = await post(s, 'x.thrown', request('x.thrown'));
    for (const res of [dup, bad, boom]) expect(res.raw).not.toMatch(leaks);
    expect(bad.status).toBe(500);
    expect(boom.status).toBe(500);
    expect(bad.body.status.message).toBe(boom.body.status.message);
    expect(JSON.stringify(s.logged)).toContain('missing_table');
    expect(JSON.stringify(s.logged)).toContain('hunter2');
    expect(boom.raw).not.toContain('hunter2');
  });

  it('a deferred constraint that fails at commit is a 422 with no detail, and rolls back', async () => {
    const t = tempDatabase();
    cleanups.push(t.cleanup);
    t.db.exec('CREATE TABLE parent (id TEXT PRIMARY KEY); CREATE TABLE child (id TEXT PRIMARY KEY, parent TEXT REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)');
    t.db.exec("INSERT INTO parent VALUES ('p'); INSERT INTO child VALUES ('c', 'p')");
    const svc = tableService({ id: 'x.parent', inputs: { p: { table: 'parent', columns: [{ id: 'id', type: 'string', key: true }] } } });
    const app = createServer({ services: [svc], db: t.db, logger: { error() {} } });
    const res = await app.inject({
      method: 'POST',
      url: '/dsx/v1/tx/x.parent',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(request('x.parent', { p: { columns: [{ id: 'id', type: 'string' }], changes: [{ s: 'D', id: 1, v: ['p'] }] } })),
    });
    expect(res.statusCode).toBe(422);
    expect(res.body).not.toMatch(/foreign|sqlite/i);
    expect(t.db.prepare('SELECT count(*) AS n FROM parent').get()).toEqual({ n: 1 });
    expect(t.db.isTransaction).toBe(false);
    await app.close();
  });
});

describe('order of writes', () => {
  it('writes deletes, then updates, then inserts', async () => {
    // A unique name freed by a delete and a rename, then reused by an insert, only works in that order.
    const t = tempDatabase();
    cleanups.push(t.cleanup);
    t.db.exec('CREATE TABLE dept (deptCode TEXT PRIMARY KEY, deptName TEXT NOT NULL UNIQUE)');
    t.db.exec("INSERT INTO dept VALUES ('A', 'one'), ('B', 'two')");
    const svc = tableService({ id: 'x.order', inputs: { dsDept: { ...deptTable, columns: deptTable.columns.map(({ generated: _g, ...c }) => c) } } });
    const app = createServer({ services: [svc], db: t.db, logger: { error() {} } });
    const res = await app.inject({
      method: 'POST',
      url: '/dsx/v1/tx/x.order',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(
        request('x.order', {
          dsDept: {
            columns: DEPT_COLUMNS,
            changes: [
              { s: 'I', id: 3, v: ['C', 'one'] },
              { s: 'U', id: 2, v: ['B', 'three'], o: { '1': 'two' } },
              { s: 'D', id: 1, v: ['A', 'one'] },
            ],
          },
        }),
      ),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(t.db.prepare('SELECT * FROM dept ORDER BY deptCode').all().map((r) => Object.values(r))).toEqual([['B', 'three'], ['C', 'one']]);
    await app.close();
  });

  it('applies datasets in the service declaration order, whatever the request order', async () => {
    const s = setup();
    const res = await post(
      s,
      'hr.org.save',
      request('hr.org.save', {
        dsDept: { columns: DEPT_COLUMNS, changes: [{ s: 'I', id: 1, v: [null, 'HR'] }] },
        dsEmp: { columns: EMP_COLUMNS, changes: [{ s: 'I', id: 2, v: [null, 'Zed', '1', null] }] },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body.applied).toEqual({ dsDept: { '1': { deptCode: 'D030' } }, dsEmp: { '2': { empNo: 'E1003', ver: 1 } } });
  });
});

describe('definitions', () => {
  it('refuses unsafe or inconsistent declarations', () => {
    const table = (name: string, columns: object[]) => ({ a: { table: name, columns } as never });
    expect(() => tableService({ id: 'x.y', inputs: table('a; DROP TABLE b', [{ id: 'k', type: 'string', key: true }]) })).toThrow(/table name/);
    expect(() => tableService({ id: 'x.y', inputs: table('a', [{ id: 'k"', type: 'string', key: true }]) })).toThrow(/identifiers/);
    expect(() => tableService({ id: 'x.y', inputs: table('a', [{ id: 'k', type: 'string' }]) })).toThrow(/key/);
    expect(() => tableService({ id: 'no spaces', inputs: {} })).toThrow(/service id/);
    expect(() => customService({ id: 'x.y', inputs: { a: { columns: [{ id: 'k', type: 'string', generated: 'rowid' }] } }, handler: () => undefined })).toThrow(/key/);
  });

  it('refuses two services with one id', () => {
    const t = tempDatabase();
    cleanups.push(t.cleanup);
    const a = customService({ id: 'x.a', handler: () => undefined });
    expect(() => createServer({ services: [a, a], db: t.db })).toThrow(/twice/);
  });
});
