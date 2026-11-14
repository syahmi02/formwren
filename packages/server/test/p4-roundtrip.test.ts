/**
 * Proof test P4, server side (FRAMEWORK.md section 8): seeded random values go in through the real server (`inject`) into a real SQLite
 * file, are loaded, and are then updated again and again, always with the loaded values as the originals. No save may report a conflict
 * that did not happen, and every value must come back as exact text. Two tables: one with a version column and one without, which is
 * checked on every column.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, customService, tableService, type ColumnDecl, type TableDecl } from '../src/index.ts';
import { tempDatabase } from './world.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

const baseColumns: ColumnDecl[] = [
  { id: 'id', type: 'int', key: true },
  { id: 'amount', type: 'decimal', precision: 30, scale: 12 },
  { id: 'day', type: 'date' },
  { id: 'stamp', type: 'datetime' },
  { id: 'note', type: 'string', size: 100 },
  { id: 'tag', type: 'string', size: 40 },
  { id: 'n', type: 'int' },
  { id: 'flag', type: 'boolean' },
];
const versionColumn: ColumnDecl = { id: 'ver', type: 'int', version: true };
const plain: TableDecl = { table: 'rt_plain', columns: baseColumns };
const versioned: TableDecl = { table: 'rt_ver', columns: [...baseColumns, versionColumn] };
const out = (table: TableDecl): ColumnDecl[] => table.columns.map(({ key: _key, ...rest }) => rest);

const schema = (name: string, ver: boolean): string =>
  `CREATE TABLE ${name} (id INTEGER PRIMARY KEY, amount TEXT, day TEXT, stamp TEXT, note TEXT, tag TEXT, n INTEGER, flag INTEGER${ver ? ', ver INTEGER NOT NULL DEFAULT 1' : ''});`;

// ---- seeded random values -------------------------------------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Value = string | number | boolean | null;
type Rand = ReturnType<typeof makeRand>;

function makeRand(seed: number) {
  const next = mulberry32(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)] as T;
  const digits = (count: number, noLeadingZero = false): string => {
    let s = '';
    for (let i = 0; i < count; i++) s += String(i === 0 && noLeadingZero ? int(1, 9) : int(0, 9));
    return s;
  };
  return { next, int, pick, digits };
}

/** A decimal of at most 30 digits and 12 places, in every shape a number or a trim could mangle. */
function decimal(r: Rand): string {
  const sign = r.int(0, 3) === 0 ? '-' : '';
  const fraction = r.int(0, 12);
  const whole = r.int(1, Math.min(18, 30 - fraction));
  const point = (digits: string): string => (digits === '' ? '' : `.${digits}`);
  switch (r.int(0, 9)) {
    case 0:
      return `${sign}0${point('0'.repeat(fraction))}`; // zero at every scale, and "-0.000"
    case 1:
      return `${sign}${r.digits(whole, true)}${fraction > 0 ? point(`${r.digits(fraction - 1)}0`) : ''}`; // trailing zero
    case 2:
      return `${sign}0.${'0'.repeat(Math.max(fraction, 1) - 1)}1`; // tiny
    case 3:
      return `${sign}${'9'.repeat(whole)}${point('9'.repeat(fraction))}`; // all nines, at the limit of 30 digits
    case 4:
      return `${sign}${r.digits(whole, true)}`; // no point
    case 5:
      return `${sign}${r.digits(whole, true)}${point('0'.repeat(Math.max(fraction, 1)))}`; // all-zero fraction
    case 6:
      return `${sign}0${point(r.digits(fraction))}`;
    case 7:
      return `${sign}00${r.digits(Math.min(whole, 10), true)}${point(r.digits(fraction))}`; // leading zeros
    default:
      return `${sign}${r.digits(whole, true)}${point(r.digits(fraction))}`;
  }
}

const pad = (n: number, w: number): string => String(n).padStart(w, '0');

function date(r: Rand): string {
  const y = r.pick([1, 999, 1900, 1999, 2000, 2024, 2100, 9999, r.int(1, 9999)]);
  const m = r.int(1, 12);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] as number;
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(r.int(1, days), 2)}`;
}

function datetime(r: Rand): string {
  const fraction = r.pick(['', '', '.0', '.000', '.5', `.${r.digits(3)}`, `.${r.digits(6)}`, `.${r.digits(9)}`]);
  return `${date(r)}T${pad(r.int(0, 23), 2)}:${pad(r.int(0, 59), 2)}:${pad(r.int(0, 59), 2)}${fraction}`;
}

const STRINGS = [
  '', ' ', '  ', ' padded ', '\t', 'a\nb', "it's", 'say "hi"', "'; DROP TABLE rt_plain; --", '\\', '\\n', '%', '_', 'é', 'é',
  'üñî', '日本語', '한국어', 'مرحبا', '😀', '👨‍👩‍👧',
  'NULL', 'null', '0', '-0', '1.50', '[]', '{}',
];

function text(r: Rand, max: number): string {
  if (r.int(0, 2) === 0) return r.pick(STRINGS).slice(0, max);
  const length = r.int(1, Math.min(max, 30));
  let s = '';
  for (let i = 0; i < length; i++) s += r.pick(['a', 'Z', ' ', '"', "'", 'é', '日', '1', '.', '\\']);
  return s;
}

/** A value for a column, null in about one case in six. */
function value(r: Rand, column: ColumnDecl): Value {
  if (r.int(0, 5) === 0) return null;
  switch (column.type) {
    case 'decimal':
      return decimal(r);
    case 'date':
      return date(r);
    case 'datetime':
      return datetime(r);
    case 'int':
      return r.pick([0, 1, -1, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, r.int(-1_000_000, 1_000_000), 2147483647, -2147483648]);
    case 'boolean':
      return r.next() < 0.5;
    default:
      return text(r, column.size ?? 40);
  }
}

/** Some value that is not `current`, for a column that must visibly change. */
function different(r: Rand, column: ColumnDecl, current: Value): Value {
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = value(r, column);
    if (candidate !== current) return candidate;
  }
  return current === null ? (column.type === 'boolean' ? true : '0') : null;
}

// ---- the wire ---------------------------------------------------------------------------------------------------------------------

interface Answer {
  status: number;
  body: {
    status: { ok: boolean; code?: string };
    datasets?: { ds: { rows: Value[][] } };
    applied?: Record<string, Record<string, Record<string, Value>>>;
    errors?: unknown[];
  };
}

function build(table: TableDecl) {
  const t = tempDatabase();
  cleanups.push(t.cleanup);
  t.db.exec(schema(table.table, table.columns.some((c) => c.version)));
  const app = createServer({
    services: [
      tableService({ id: 'rt.save', inputs: { ds: table } }),
      customService({
        id: 'rt.list',
        outputs: { ds: { columns: out(table) } },
        handler: (ctx) => ({ datasets: { ds: ctx.db.prepare(`SELECT ${table.columns.map((c) => c.id).join(', ')} FROM ${table.table} ORDER BY id`).all() } }),
      }),
    ],
    db: t.db,
    logger: { error() {} },
  });
  cleanups.push(() => void app.close());
  const post = async (service: string, datasets?: object): Promise<Answer> => {
    const res = await app.inject({
      method: 'POST',
      url: `/dsx/v1/tx/${service}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ dsx: 1, txId: 'p4', service, datasets }),
    });
    return { status: res.statusCode, body: res.json() as Answer['body'] };
  };
  const columns = table.columns.map((c) => ({ id: c.id, type: c.type, ...(c.version ? { version: true } : {}), ...(c.key ? { key: true } : {}) }));
  const load = async (): Promise<Value[][]> => {
    const res = await post('rt.list');
    expect(res.status).toBe(200);
    return res.body.datasets?.ds.rows ?? [];
  };
  const decl = (id: string): ColumnDecl => table.columns.find((c) => c.id === id) as ColumnDecl;
  const index = (id: string): number => columns.findIndex((c) => c.id === id);
  return { db: t.db, post, load, columns, decl, index };
}

const SEEDS = [20260101, 7, 424242];
const ROWS = 60;
const ROUNDS = 40;

describe.each(SEEDS)('P4 random round trip, seed %i', (seed) => {
  describe.each([
    ['with a version column', versioned],
    ['without a version column (every column is checked)', plain],
  ] as const)('%s', (_name, table) => {
    const dataColumns = table.columns.filter((c) => !c.key && !c.version);
    const hasVer = table.columns.some((c) => c.version);

    it(`inserts ${ROWS} random rows, then updates them ${ROUNDS} times with zero false conflicts and exact values`, async () => {
      const r = makeRand(seed);
      const { post, load, columns, db, decl, index } = build(table);

      // The model is what the database must hold, as the exact values the test put in.
      const model = new Map<number, Value[]>();
      const inserts = [];
      for (let id = 1; id <= ROWS; id++) {
        const row: Value[] = columns.map((c) => (c.key ? id : c.version ? null : value(r, decl(c.id))));
        inserts.push({ s: 'I', id, v: row });
        model.set(id, columns.map((c, i) => (c.version ? 1 : (row[i] as Value))));
      }
      const first = await post('rt.save', { ds: { columns, changes: inserts } });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      // A new row has a version, which is the server's to choose.
      const inserted = await load();
      for (const row of inserted) {
        const id = row[index('id')] as number;
        if (hasVer) {
          expect(typeof row[index('ver')]).toBe('number');
          expect(first.body.applied?.['ds']?.[String(id)]?.['ver']).toBe(row[index('ver')]);
          (model.get(id) as Value[])[index('ver')] = row[index('ver')] as Value;
        }
      }
      expect(inserted).toEqual([...model.values()]);

      let updates = 0;
      for (let round = 1; round <= ROUNDS; round++) {
        const loaded = await load();
        expect(loaded, `round ${round}: loaded rows equal what went in`).toEqual([...model.values()]);

        const changes = [];
        const next = new Map<number, Value[]>();
        for (const row of loaded) {
          const id = row[index('id')] as number;
          if (r.int(0, 2) === 0) continue;
          // Change one to three columns. Every other value is sent as loaded, in `v`.
          const pool = [...dataColumns];
          const chosen: ColumnDecl[] = [];
          for (let k = r.int(1, 3); k > 0; k--) chosen.push(pool.splice(r.int(0, pool.length - 1), 1)[0] as ColumnDecl);
          const v = [...row];
          const o: Record<string, Value> = {};
          for (const column of chosen) {
            const at = index(column.id);
            v[at] = different(r, column, row[at] as Value);
            o[String(at)] = row[at] as Value;
          }
          changes.push({ s: 'U', id, v, o });
          const expected = [...v];
          next.set(id, expected);
        }
        if (changes.length === 0) continue;
        const res = await post('rt.save', { ds: { columns, changes } });
        expect(res.status, `round ${round}: no false conflict (${JSON.stringify(res.body).slice(0, 400)})`).toBe(200);
        expect(res.body.status.ok).toBe(true);
        // Versions are the server's to assign: a saved row's version moved on, the others stayed, and the response named the new one.
        const reloaded = await load();
        for (const row of reloaded) {
          const id = row[index('id')] as number;
          const updated = next.get(id);
          if (hasVer) {
            const was = model.get(id)?.[index('ver')] as number;
            const is = row[index('ver')] as number;
            if (updated) {
              expect(is, `round ${round}: version of ${id} moved`).toBeGreaterThan(was);
              expect(res.body.applied?.['ds']?.[String(id)]?.['ver']).toBe(is);
            } else expect(is).toBe(was);
          }
          if (updated) updated[index('ver')] = row[index('ver')] as Value;
        }
        for (const [id, row] of next) model.set(id, row);
        updates += changes.length;
      }
      expect(updates).toBeGreaterThan(ROUNDS * 10);
      expect(await load()).toEqual([...model.values()]);

      // The file holds text for decimals, dates and strings, and integers for ints, not only the response.
      const stored = db
        .prepare(`SELECT typeof(amount) AS a, typeof(day) AS d, typeof(stamp) AS s, typeof(note) AS t, typeof(n) AS n FROM ${table.table}`)
        .all() as Record<string, string>[];
      for (const row of stored) {
        for (const kind of ['a', 'd', 's', 't']) expect(['text', 'null']).toContain(row[kind]);
        expect(['integer', 'null']).toContain(row['n']);
      }
    });

    it('sends every column as an original in some updates, with the same loaded values, and still no false conflict', async () => {
      const r = makeRand(seed + 2);
      const { post, load, columns, decl, index } = build(table);
      const inserts = [];
      for (let id = 1; id <= 30; id++) inserts.push({ s: 'I', id, v: columns.map((c) => (c.key ? id : c.version ? null : value(r, decl(c.id)))) });
      expect((await post('rt.save', { ds: { columns, changes: inserts } })).status).toBe(200);
      for (let round = 0; round < 10; round++) {
        const loaded = await load();
        const changes = loaded.map((row) => {
          const v = [...row];
          const o: Record<string, Value> = {};
          for (const column of dataColumns) o[String(index(column.id))] = row[index(column.id)] as Value;
          const note = index('note');
          v[note] = `round ${round}`;
          return { s: 'U', id: row[index('id')] as number, v, o };
        });
        const res = await post('rt.save', { ds: { columns, changes } });
        expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(200);
      }
    });

    it('still catches a real conflict: a changed row is refused, nothing is written, and the rest is untouched', async () => {
      const r = makeRand(seed + 1);
      const { post, load, columns, db, decl, index } = build(table);
      const rows = [];
      for (let id = 1; id <= 5; id++) rows.push({ s: 'I', id, v: columns.map((c) => (c.key ? id : c.version ? null : value(r, decl(c.id)))) });
      await post('rt.save', { ds: { columns, changes: rows } });
      const loaded = await load();
      // Someone else changes the note of row 3, and with a version column its version moves on.
      db.prepare(`UPDATE ${table.table} SET note = ?${hasVer ? ', ver = ver + 1' : ''} WHERE id = 3`).run('theirs, and different from any random text');
      const theirs = await load();
      const tag = index('tag');
      const changes = loaded.map((row, i) => {
        const v = [...row];
        v[tag] = `mine ${i}`;
        return { s: 'U', id: i + 1, v, o: { [String(tag)]: row[tag] as Value } };
      });
      const res = await post('rt.save', { ds: { columns, changes } });
      expect(res.status).toBe(409);
      expect(res.body.status.code).toBe('conflict');
      expect(res.body.errors).toEqual([expect.objectContaining({ dataset: 'ds', id: 3, code: 'conflict' })]);
      expect(await load()).toEqual(theirs);
    });
  });
});
