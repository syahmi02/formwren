import { describe, expect, it } from 'vitest';
import { Dataset, decDiv, decSum, type CellValue, type ColumnDef } from '../src/index.ts';
import { compareValues } from '../src/values.ts';

const columns: ColumnDef[] = [
  { id: 'dec', type: 'decimal' },
  { id: 'dec2', type: 'decimal', scale: 2 },
  { id: 'int', type: 'int' },
  { id: 'flt', type: 'float' },
  { id: 'dt', type: 'date' },
  { id: 'str', type: 'string' },
];

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGen(random: () => number) {
  const int = (n: number) => Math.floor(random() * n);
  const pick = <T>(list: readonly T[]): T => list[int(list.length)] as T;
  const decimal = (): string => {
    const sign = random() < 0.3 ? '-' : '';
    if (random() < 0.1) return `${sign}12345678901234567890${random() < 0.5 ? '.123456789' : ''}`;
    const scale = int(5);
    const whole = String(int(100000));
    return scale === 0 ? `${sign}${whole}` : `${sign}${whole}.${String(int(10 ** scale)).padStart(scale, '0')}`;
  };
  const nullable = <T>(make: () => T): T | null => (random() < 0.15 ? null : make());
  const row = (): Record<string, unknown> => ({
    dec: nullable(decimal),
    dec2: nullable(() => `${int(1000)}.${String(int(100)).padStart(2, '0')}`),
    int: nullable(() => int(2000001) - 1000000),
    flt: nullable(() => (int(2000) - 1000) / 10 + int(3) * 0.1),
    dt: nullable(() => `20${String(int(30)).padStart(2, '0')}-${String(int(12) + 1).padStart(2, '0')}-${String(int(28) + 1).padStart(2, '0')}`),
    str: nullable(() => pick(['alpha', 'Bravo', 'charlie', 'delta', 'echo'])),
  });
  const valueFor = (column: string): CellValue => (row() as Record<string, CellValue>)[column] as CellValue;
  return { int, pick, row, valueFor };
}

/** What a full recount over the visible rows gives, written independently of the cache. */
function fresh(ds: Dataset, column: ColumnDef) {
  const values: CellValue[] = [];
  for (let i = 0; i < ds.rowCount; i++) values.push(ds.getValue(i, column.id));
  const present = values.filter((v) => v !== null);
  const out: Record<string, unknown> = { count: present.length };
  const extreme = (direction: number): CellValue => {
    let best: CellValue = null;
    for (const value of values) {
      if (value === null) continue;
      if (best === null || compareValues(column.type, value, best) * direction > 0) best = value;
    }
    return best;
  };
  out.min = extreme(-1);
  out.max = extreme(1);
  if (column.type === 'decimal') {
    out.sum = decSum(values as (string | null)[]);
    out.avg = present.length === 0 ? null : decDiv(out.sum as string, String(present.length), (column.scale ?? 0) + 2);
  } else if (column.type === 'int' || column.type === 'float') {
    let total = 0;
    for (const value of values) total += (value as number | null) ?? 0;
    out.sum = total;
    out.avg = present.length === 0 ? null : total / present.length;
  }
  return out;
}

function cached(ds: Dataset, column: ColumnDef) {
  const out: Record<string, unknown> = { count: ds.count(column.id), min: ds.min(column.id), max: ds.max(column.id) };
  if (column.type === 'decimal' || column.type === 'int' || column.type === 'float') {
    out.sum = ds.sum(column.id);
    out.avg = ds.avg(column.id);
  }
  return out;
}

function expectSame(ds: Dataset, where: string): void {
  for (const column of columns) {
    const expected = fresh(ds, column);
    // Ask twice, so a cached answer and a repeated one are both checked.
    expect(cached(ds, column), `${where}, column ${column.id}`).toEqual(expected);
    expect(cached(ds, column), `${where}, column ${column.id}, again`).toEqual(expected);
  }
}

describe('cached aggregates equal a fresh computation', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('after every step of a random series, seed %i', (seed) => {
    const random = rng(seed);
    const gen = makeGen(random);
    const ds = new Dataset({ id: 'agg', columns, initialRows: Array.from({ length: 40 }, () => gen.row()) });
    expectSame(ds, 'load');

    for (let step = 0; step < 300; step++) {
      const action = gen.int(100);
      let label = '';
      if (action < 40 && ds.rowCount > 0) {
        const column = gen.pick(columns);
        const index = gen.int(ds.rowCount);
        // Sometimes write the same text again, or the same number in another scale.
        const old = ds.getValue(index, column.id);
        const next = random() < 0.1 && old !== null ? old : gen.valueFor(column.id);
        label = `edit ${column.id}`;
        ds.setValue(index, column.id, next as never);
      } else if (action < 50) {
        label = 'insert';
        ds.insertRow(gen.int(ds.rowCount + 1), gen.row());
      } else if (action < 58 && ds.rowCount > 0) {
        label = 'delete';
        ds.deleteRows([gen.int(ds.rowCount)]);
      } else if (action < 64) {
        label = 'filter';
        if (random() < 0.3) ds.setFilter(null);
        else {
          const threshold = gen.int(20) - 10;
          ds.setFilter((get) => ((get('int') as number | null) ?? 0) / 100000 > threshold / 2);
        }
      } else if (action < 72) {
        label = 'sort';
        ds.sort(random() < 0.2 ? [] : [{ column: gen.pick(columns).id, descending: random() < 0.5 }]);
      } else if (action < 76) {
        label = 'load';
        const rows = Array.from({ length: gen.int(30) }, () => gen.row());
        ds.load(rows, { append: random() < 0.5 });
      } else if (action < 82) {
        label = 'revertRow';
        const all = [...ds.deletedRows()];
        const live = ds.liveRows().ids;
        const id = all.length > 0 && random() < 0.5 ? gen.pick(all) : live.length > 0 ? gen.pick(live) : undefined;
        if (id !== undefined) ds.revertRow(id);
      } else if (action < 85) {
        label = 'revertAll';
        ds.revertAll();
      } else {
        label = 'save';
        const ticket = ds.beginSave();
        if (random() < 0.5 && ds.rowCount > 0) ds.setValue(gen.int(ds.rowCount), 'dec', gen.valueFor('dec') as never);
        const first = ticket.changes.find((change) => change.status !== 'D');
        const applied = first && random() < 0.7 ? new Map([[first.rowId, { dec: gen.valueFor('dec'), int: gen.valueFor('int') }]]) : undefined;
        ds.acceptSave(ticket, applied);
      }
      expectSame(ds, `seed ${seed}, step ${step} (${label})`);
    }
  });

  it('keeps the exact scale of a decimal sum when the only long value is edited away', () => {
    const ds = new Dataset({ id: 'd', columns: [{ id: 'dec', type: 'decimal' }], initialRows: [{ dec: '1.5' }, { dec: '2.25' }, { dec: '3' }] });
    expect(ds.sum('dec')).toBe('6.75');
    ds.setValue(1, 'dec', '2');
    expect(ds.sum('dec')).toBe('6.5');
    ds.setValue(0, 'dec', '1');
    expect(ds.sum('dec')).toBe('6');
    ds.setValue(2, 'dec', null);
    ds.setValue(0, 'dec', null);
    ds.setValue(1, 'dec', null);
    expect(ds.sum('dec')).toBe('0');
    ds.setValue(1, 'dec', '0.001');
    expect(ds.sum('dec')).toBe('0.001');
  });

  it('keeps the int overflow error, and recovers once the sum is safe again', () => {
    const big = Number.MAX_SAFE_INTEGER;
    const ds = new Dataset({ id: 'i', columns: [{ id: 'int', type: 'int' }], initialRows: [{ int: 1 }, { int: 2 }] });
    expect(ds.sum('int')).toBe(3);
    ds.setValue(0, 'int', big);
    ds.setValue(1, 'int', big);
    expect(() => ds.sum('int')).toThrow(RangeError);
    ds.setValue(0, 'int', 3);
    ds.setValue(1, 'int', 5);
    expect(ds.sum('int')).toBe(8);
  });
});
