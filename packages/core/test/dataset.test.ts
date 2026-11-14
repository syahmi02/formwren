import { describe, expect, it, vi } from 'vitest';
import { Dataset, type ColumnDef } from '../src/index.ts';

const columns: ColumnDef[] = [
  { id: 'code', type: 'string', size: 10 },
  { id: 'name', type: 'string', size: 20 },
  { id: 'qty', type: 'int' },
  { id: 'price', type: 'decimal', precision: 12, scale: 2 },
  { id: 'rate', type: 'float' },
  { id: 'active', type: 'boolean' },
  { id: 'startOn', type: 'date' },
  { id: 'seenAt', type: 'datetime' },
];

function makeDataset(): Dataset {
  return new Dataset({
    id: 'ds',
    columns,
    keys: ['code'],
    initialRows: [
      { code: 'A', name: 'Apple', qty: 3, price: '1.50', active: true, startOn: '2026-01-15' },
      { code: 'B', name: 'banana', qty: 1, price: '10.00', active: false, startOn: '2025-12-31' },
      { code: 'C', name: 'Cherry', qty: 2, price: '2.25', active: true },
    ],
  });
}

function codes(ds: Dataset): unknown[] {
  return Array.from({ length: ds.rowCount }, (_, i) => ds.getValue(i, 'code'));
}

describe('column types', () => {
  it('accepts each type', () => {
    const ds = new Dataset({ id: 'ds', columns });
    ds.addRow({
      code: 'X',
      name: 'x',
      qty: 7,
      price: '12345.67',
      rate: 0.5,
      active: true,
      startOn: '2024-02-29',
      seenAt: '2026-11-07T10:30:00.123',
    });
    expect(ds.getValue(0, 'qty')).toBe(7);
    expect(ds.getValue(0, 'price')).toBe('12345.67');
    expect(ds.getValue(0, 'seenAt')).toBe('2026-11-07T10:30:00.123');
  });

  it.each<[string, unknown]>([
    ['code', 5],
    ['qty', 1.5],
    ['qty', '3'],
    ['qty', Number.MAX_SAFE_INTEGER + 1],
    ['price', 1.5],
    ['price', '1e5'],
    ['price', 'abc'],
    ['rate', Number.NaN],
    ['rate', Number.POSITIVE_INFINITY],
    ['active', 'true'],
    ['startOn', '2026-02-30'],
    ['startOn', '2026-13-01'],
    ['startOn', '2025-02-29'],
    ['startOn', '01/15/2026'],
    ['seenAt', '2026-11-07'],
    ['seenAt', '2026-11-07T25:00:00'],
    ['seenAt', '2026-11-07T10:30:00Z'],
  ])('rejects a bad value for %s: %s', (column, value) => {
    const ds = makeDataset();
    expect(() => ds.setValue(0, column, value as never)).toThrow(TypeError);
    expect(ds.rowStatus(0)).toBe('normal');
  });

  it('turns a whole number into a decimal, which loses nothing', () => {
    const ds = makeDataset();
    ds.setValue(0, 'price', 100);
    expect(ds.getValue(0, 'price')).toBe('100');
  });

  it('never rounds or normalizes on load', () => {
    const ds = new Dataset({
      id: 'ds',
      columns: [{ id: 'd', type: 'decimal' }],
      initialRows: [{ d: '00012345678901234567890.1200' }],
    });
    expect(ds.getValue(0, 'd')).toBe('00012345678901234567890.1200');
  });
});

describe('row status', () => {
  it('starts normal after a load', () => {
    const ds = makeDataset();
    expect(ds.rowStatus(0)).toBe('normal');
    expect(ds.hasChanges()).toBe(false);
    expect(ds.getChanges()).toEqual([]);
  });

  it('tracks an update and its original value', () => {
    const ds = makeDataset();
    ds.setValue(0, 'name', 'Apricot');
    const id = ds.rowIdAt(0);
    expect(ds.rowStatus(0)).toBe('updated');
    expect(ds.getOriginalValue(id, 'name')).toBe('Apple');
    expect(ds.getValue(0, 'name')).toBe('Apricot');
    expect(ds.hasChanges()).toBe(true);
  });

  it('ignores a write of the same value', () => {
    const ds = makeDataset();
    const listener = vi.fn();
    ds.on('cellChanged', listener);
    ds.setValue(0, 'name', 'Apple');
    expect(ds.rowStatus(0)).toBe('normal');
    expect(listener).not.toHaveBeenCalled();
  });

  it('treats the same decimal in different text as no change', () => {
    const ds = makeDataset();
    ds.setValue(0, 'price', '1.5');
    expect(ds.rowStatus(0)).toBe('normal');
    expect(ds.getValue(0, 'price')).toBe('1.50');
  });

  it('returns to normal, with the exact loaded text, when edits are undone by hand', () => {
    const ds = makeDataset();
    ds.setValue(0, 'price', '9');
    expect(ds.rowStatus(0)).toBe('updated');
    ds.setValue(0, 'price', '1.5');
    expect(ds.rowStatus(0)).toBe('normal');
    expect(ds.getValue(0, 'price')).toBe('1.50');
  });

  it('marks added rows as inserted, and keeps them inserted when edited', () => {
    const ds = makeDataset();
    const id = ds.addRow({ code: 'D' });
    expect(ds.statusOf(id)).toBe('inserted');
    ds.setValueById(id, 'name', 'Date');
    expect(ds.statusOf(id)).toBe('inserted');
  });

  it('moves deleted rows out of the view but keeps them for the save', () => {
    const ds = makeDataset();
    const id = ds.rowIdAt(1);
    ds.deleteRow(1);
    expect(codes(ds)).toEqual(['A', 'C']);
    expect(ds.statusOf(id)).toBe('deleted');
    expect(ds.deletedRows()).toEqual([id]);
    expect(ds.getChanges().map((change) => change.status)).toEqual(['D']);
    expect(() => ds.setValueById(id, 'name', 'x')).toThrow(/deleted/);
  });

  it('forgets an inserted row that is deleted again', () => {
    const ds = makeDataset();
    ds.addRow({ code: 'D' });
    ds.deleteRow(3);
    expect(ds.rowCount).toBe(3);
    expect(ds.hasChanges()).toBe(false);
    expect(ds.getChanges()).toEqual([]);
  });

  it('keeps row ids stable when rows move', () => {
    const ds = makeDataset();
    const id = ds.rowIdAt(2);
    ds.insertRow(0, { code: 'Z' });
    ds.deleteRow(1);
    ds.sort([{ column: 'code', descending: true }]);
    expect(ds.getValueById(id, 'code')).toBe('C');
    expect(ds.getValue(ds.indexOfRow(id), 'code')).toBe('C');
  });
});

describe('revert', () => {
  it('reverts an updated row', () => {
    const ds = makeDataset();
    ds.setValue(0, 'name', 'x');
    ds.setValue(0, 'price', '99');
    ds.revertRow(ds.rowIdAt(0));
    expect(ds.getValue(0, 'name')).toBe('Apple');
    expect(ds.getValue(0, 'price')).toBe('1.50');
    expect(ds.rowStatus(0)).toBe('normal');
  });

  it('puts a deleted row back in its original place, without its edits', () => {
    const ds = makeDataset();
    const id = ds.rowIdAt(1);
    ds.setValue(1, 'name', 'edited');
    ds.deleteRow(1);
    ds.revertRow(id);
    expect(codes(ds)).toEqual(['A', 'B', 'C']);
    expect(ds.getValue(1, 'name')).toBe('banana');
    expect(ds.rowStatus(1)).toBe('normal');
  });

  it('removes an inserted row', () => {
    const ds = makeDataset();
    const id = ds.insertRow(1, { code: 'X' });
    ds.revertRow(id);
    expect(codes(ds)).toEqual(['A', 'B', 'C']);
    expect(ds.hasChanges()).toBe(false);
  });

  it('reverts everything at once', () => {
    const ds = makeDataset();
    ds.setValue(0, 'name', 'x');
    ds.deleteRow(1);
    ds.insertRow(0, { code: 'Y' });
    ds.addRow({ code: 'Z' });
    ds.revertAll();
    expect(codes(ds)).toEqual(['A', 'B', 'C']);
    expect(ds.getValue(0, 'name')).toBe('Apple');
    expect(ds.hasChanges()).toBe(false);
  });
});

describe('add, insert, find', () => {
  it('inserts at a view position', () => {
    const ds = makeDataset();
    ds.insertRow(1, { code: 'X' });
    expect(codes(ds)).toEqual(['A', 'X', 'B', 'C']);
    ds.insertRow(4, { code: 'Y' });
    expect(codes(ds)).toEqual(['A', 'X', 'B', 'C', 'Y']);
    expect(() => ds.insertRow(9)).toThrow(RangeError);
  });

  it('accepts positional rows, and rejects the wrong length', () => {
    const ds = new Dataset({ id: 'ds', columns: [{ id: 'a', type: 'int' }, { id: 'b', type: 'string' }] });
    ds.load([[1, 'x']]);
    expect(ds.getValue(0, 'b')).toBe('x');
    expect(() => ds.load([[1]])).toThrow(/has 2 columns/);
  });

  it('rejects unknown columns', () => {
    const ds = makeDataset();
    expect(() => ds.addRow({ nope: 1 })).toThrow(/no column "nope"/);
    expect(() => ds.getValue(0, 'nope')).toThrow(/no column "nope"/);
  });

  it('finds rows in view order', () => {
    const ds = makeDataset();
    expect(ds.findValue('code', 'B')).toBe(1);
    expect(ds.findValue('code', 'Q')).toBe(-1);
    expect(ds.findValue('price', '2.250')).toBe(2);
    expect(ds.find((get) => (get('qty') as number) < 3)).toBe(1);
    expect(ds.find((get) => (get('qty') as number) < 3, 2)).toBe(2);
  });

  it('gives a clear error for a bad index', () => {
    const ds = new Dataset({ id: 'ds', columns });
    expect(() => ds.setValue(0, 'code', 'x')).toThrow(/no row at index 0/);
  });
});

describe('load', () => {
  it('keeps existing rows and edits when appending', () => {
    const ds = makeDataset();
    ds.setValue(0, 'name', 'edited');
    ds.load([{ code: 'D' }], { append: true });
    expect(codes(ds)).toEqual(['A', 'B', 'C', 'D']);
    expect(ds.rowStatus(0)).toBe('updated');
    expect(ds.rowStatus(3)).toBe('normal');
  });

  it.each([false, true])('changes nothing when a bad row stops a load (append: %s)', (append) => {
    const ds = makeDataset();
    ds.setValue(0, 'name', 'edited');
    expect(() => ds.load([{ code: 'D' }, { qty: 'bad' }], { append })).toThrow(TypeError);
    expect(codes(ds)).toEqual(['A', 'B', 'C']);
    expect(ds.rowStatus(0)).toBe('updated');
  });

  it('announces the new current row after a reload', () => {
    const ds = makeDataset();
    const changed = vi.fn();
    ds.on('currentRowChanged', changed);
    ds.load([{ code: 'N' }]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(ds.currentRow).toBe(3);
    ds.load([]);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(ds.currentRow).toBeNull();
  });

  it('replaces everything, including pending changes', () => {
    const ds = makeDataset();
    ds.setValue(0, 'name', 'edited');
    ds.deleteRow(1);
    ds.load([{ code: 'N' }]);
    expect(codes(ds)).toEqual(['N']);
    expect(ds.hasChanges()).toBe(false);
    expect(ds.currentIndex).toBe(0);
  });

  it('applies the active sort and filter to loaded rows', () => {
    const ds = makeDataset();
    ds.sort([{ column: 'code', descending: true }]);
    ds.setFilter((get) => get('code') !== 'B');
    expect(codes(ds)).toEqual(['C', 'A']);
    ds.load([{ code: 'P' }, { code: 'B' }, { code: 'Q' }]);
    expect(codes(ds)).toEqual(['Q', 'P']);
  });
});

describe('sort and filter', () => {
  it('sorts text the way a person reads it', () => {
    const ds = makeDataset();
    ds.sort([{ column: 'name' }]);
    expect(codes(ds)).toEqual(['A', 'B', 'C']);
  });

  it('sorts decimals numerically, not as text', () => {
    const ds = makeDataset();
    ds.sort([{ column: 'price' }]);
    expect(codes(ds)).toEqual(['A', 'C', 'B']);
    ds.sort([{ column: 'price', descending: true }]);
    expect(codes(ds)).toEqual(['B', 'C', 'A']);
  });

  it('puts empty values last in both directions', () => {
    const ds = makeDataset();
    ds.sort([{ column: 'startOn' }]);
    expect(codes(ds)).toEqual(['B', 'A', 'C']);
    ds.sort([{ column: 'startOn', descending: true }]);
    expect(codes(ds)).toEqual(['A', 'B', 'C']);
  });

  it('sorts by several keys and stays stable', () => {
    const ds = new Dataset({
      id: 'ds',
      columns: [{ id: 'g', type: 'int' }, { id: 'n', type: 'int' }, { id: 'tag', type: 'string' }],
      initialRows: [
        { g: 2, n: 1, tag: 'a' },
        { g: 1, n: 2, tag: 'b' },
        { g: 1, n: 1, tag: 'c' },
        { g: 1, n: 1, tag: 'd' },
      ],
    });
    ds.sort([{ column: 'g' }, { column: 'n' }]);
    expect(Array.from({ length: 4 }, (_, i) => ds.getValue(i, 'tag'))).toEqual(['c', 'd', 'b', 'a']);
  });

  it('filters without losing hidden edits', () => {
    const ds = makeDataset();
    ds.setValue(1, 'name', 'edited');
    ds.setFilter((get) => get('active') === true);
    expect(codes(ds)).toEqual(['A', 'C']);
    expect(ds.getChanges()).toHaveLength(1);
    ds.setFilter(null);
    expect(ds.getValue(1, 'name')).toBe('edited');
  });

  it('leaves an edited row in place until the next sort', () => {
    const ds = makeDataset();
    ds.sort([{ column: 'qty' }]);
    expect(codes(ds)).toEqual(['B', 'C', 'A']);
    ds.setValue(0, 'qty', 100);
    expect(codes(ds)).toEqual(['B', 'C', 'A']);
    ds.sort(ds.sortKeys);
    expect(codes(ds)).toEqual(['C', 'A', 'B']);
  });

  it('keeps the current row through a sort', () => {
    const ds = makeDataset();
    ds.setCurrentIndex(0);
    const id = ds.currentRow;
    const listener = vi.fn();
    ds.on('currentRowChanged', listener);
    ds.sort([{ column: 'code', descending: true }]);
    expect(ds.currentRow).toBe(id);
    expect(ds.currentIndex).toBe(2);
    expect(listener).not.toHaveBeenCalled();
  });

  it('moves the current row when a filter hides it', () => {
    const ds = makeDataset();
    ds.setCurrentIndex(1);
    ds.setFilter((get) => get('code') !== 'B');
    expect(ds.getValueById(ds.currentRow as number, 'code')).toBe('C');
    expect(ds.currentIndex).toBe(1);
  });
});

describe('aggregates', () => {
  it('sums decimals exactly', () => {
    const ds = new Dataset({ id: 'ds', columns: [{ id: 'd', type: 'decimal', scale: 2 }] });
    ds.load(Array.from({ length: 10 }, () => ({ d: '0.10' })));
    expect(ds.sum('d')).toBe('1.00');
    expect(Array.from({ length: 10 }, () => 0.1).reduce((a, b) => a + b)).not.toBe(1);
  });

  it('covers count, sum, avg, min and max, skipping empty values', () => {
    const ds = makeDataset();
    expect(ds.count()).toBe(3);
    expect(ds.count('startOn')).toBe(2);
    expect(ds.sum('qty')).toBe(6);
    expect(ds.sum('price')).toBe('13.75');
    expect(ds.avg('qty')).toBe(2);
    expect(ds.avg('price')).toBe('4.5833');
    expect(ds.min('price')).toBe('1.50');
    expect(ds.max('price')).toBe('10.00');
    expect(ds.min('startOn')).toBe('2025-12-31');
    expect(ds.avg('rate')).toBeNull();
    expect(ds.max('rate')).toBeNull();
  });

  it('only counts visible rows', () => {
    const ds = makeDataset();
    ds.setFilter((get) => get('active') === true);
    expect(ds.sum('qty')).toBe(5);
    ds.deleteRow(0);
    expect(ds.sum('qty')).toBe(2);
  });

  it('refuses an int sum it cannot hold exactly', () => {
    const ds = new Dataset({
      id: 'ds',
      columns: [{ id: 'n', type: 'int' }],
      initialRows: [{ n: Number.MAX_SAFE_INTEGER }, { n: 2 }],
    });
    expect(() => ds.sum('n')).toThrow(/too large/);
  });

  it('refuses to sum text', () => {
    expect(() => makeDataset().sum('name')).toThrow(TypeError);
  });
});

describe('cancellable events', () => {
  it('cancels a cell change synchronously', () => {
    const ds = makeDataset();
    ds.on('cellChanging', (event) => event.preventDefault());
    expect(ds.setValue(0, 'name', 'x')).toBe(false);
    expect(ds.getValue(0, 'name')).toBe('Apple');
    expect(ds.rowStatus(0)).toBe('normal');
  });

  it('reports old and new values', () => {
    const ds = makeDataset();
    const changing = vi.fn();
    const changed = vi.fn();
    ds.on('cellChanging', (event) => changing(event.detail));
    ds.on('cellChanged', changed);
    ds.setValue(0, 'name', 'x');
    const expected = { rowId: ds.rowIdAt(0), column: 'name', oldValue: 'Apple', newValue: 'x' };
    expect(changing).toHaveBeenCalledWith(expected);
    expect(changed).toHaveBeenCalledWith(expected);
  });

  it('waits for an async answer before applying', async () => {
    const ds = makeDataset();
    let answer!: (value: boolean) => void;
    ds.on('cellChanging', (event) => {
      event.waitUntil(new Promise((resolve) => (answer = resolve)));
    });
    const result = ds.setValue(0, 'name', 'x');
    expect(result).toBeInstanceOf(Promise);
    expect(ds.getValue(0, 'name')).toBe('Apple');
    answer(true);
    expect(await result).toBe(true);
    expect(ds.getValue(0, 'name')).toBe('x');
  });

  it('drops the change on an async no', async () => {
    const ds = makeDataset();
    ds.on('cellChanging', (event) => event.waitUntil(Promise.resolve(false)));
    expect(await ds.setValue(0, 'name', 'x')).toBe(false);
    expect(ds.getValue(0, 'name')).toBe('Apple');
  });

  it('leaves the row alone if the async answer fails', async () => {
    const ds = makeDataset();
    ds.on('cellChanging', (event) => event.waitUntil(Promise.reject(new Error('dialog failed'))));
    await expect(ds.setValue(0, 'name', 'x')).rejects.toThrow('dialog failed');
    expect(ds.rowStatus(0)).toBe('normal');
  });

  it('drops a deferred edit if its row was deleted while waiting', async () => {
    const ds = makeDataset();
    const release: Array<() => void> = [];
    ds.on('cellChanging', (event) => event.waitUntil(new Promise<void>((resolve) => release.push(resolve))));
    const id = ds.rowIdAt(0);
    const result = ds.setValue(0, 'name', 'x');
    ds.deleteRow(0);
    release.forEach((resolve) => resolve());
    expect(await result).toBe(false);
    expect(ds.statusOf(id)).toBe('deleted');
    expect(ds.getValueById(id, 'name')).toBe('Apple');
  });

  it('drops a deferred edit if the Dataset was reloaded while waiting', async () => {
    const ds = makeDataset();
    const release: Array<() => void> = [];
    ds.on('cellChanging', (event) => event.waitUntil(new Promise<void>((resolve) => release.push(resolve))));
    const result = ds.setValue(0, 'name', 'x');
    ds.load([{ code: 'N', name: 'new' }]);
    release.forEach((resolve) => resolve());
    expect(await result).toBe(false);
    expect(ds.getValue(0, 'name')).toBe('new');
    expect(ds.hasChanges()).toBe(false);
  });

  it('runs the other listeners when one throws, and applies nothing if a before-change listener throws', () => {
    const ds = makeDataset();
    const second = vi.fn();
    ds.on('cellChanging', () => {
      throw new Error('boom');
    });
    ds.on('cellChanging', second);
    expect(() => ds.setValue(0, 'name', 'x')).toThrow('boom');
    expect(second).toHaveBeenCalled();
    expect(ds.getValue(0, 'name')).toBe('Apple');
  });
});

describe('current row', () => {
  it('starts on the first row, and on no row when empty', () => {
    expect(makeDataset().currentIndex).toBe(0);
    const empty = new Dataset({ id: 'ds', columns });
    expect(empty.currentIndex).toBe(-1);
    expect(empty.currentRow).toBeNull();
  });

  it('fires events only when the row changes', () => {
    const ds = makeDataset();
    const changing = vi.fn();
    const changed = vi.fn();
    ds.on('currentRowChanging', changing);
    ds.on('currentRowChanged', changed);
    ds.setCurrentIndex(0);
    expect(changed).not.toHaveBeenCalled();
    ds.setCurrentIndex(2);
    expect(changing).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(ds.currentIndex).toBe(2);
  });

  it('can be cancelled', () => {
    const ds = makeDataset();
    ds.on('currentRowChanging', (event) => event.preventDefault());
    expect(ds.setCurrentIndex(1)).toBe(false);
    expect(ds.currentIndex).toBe(0);
  });

  it('lets a newer move override one still waiting', async () => {
    const ds = makeDataset();
    const release: Array<() => void> = [];
    const unsubscribe = ds.on('currentRowChanging', (event) =>
      event.waitUntil(new Promise<void>((resolve) => release.push(resolve))),
    );
    const first = ds.setCurrentIndex(1);
    unsubscribe();
    expect(ds.setCurrentIndex(2)).toBe(true);
    release.forEach((resolve) => resolve());
    expect(await first).toBe(false);
    expect(ds.currentIndex).toBe(2);
  });

  it('moves to a neighbour when the current row is deleted', () => {
    const ds = makeDataset();
    ds.setCurrentIndex(1);
    ds.deleteRow(1);
    expect(ds.getValueById(ds.currentRow as number, 'code')).toBe('C');
    expect(ds.currentIndex).toBe(1);
    ds.deleteRow(1);
    expect(ds.getValueById(ds.currentRow as number, 'code')).toBe('A');
    ds.deleteRow(0);
    expect(ds.currentRow).toBeNull();
    expect(ds.currentIndex).toBe(-1);
  });

  it('follows its row when another row is inserted or deleted above it', () => {
    const ds = makeDataset();
    ds.setCurrentIndex(1);
    ds.insertRow(0, { code: 'X' });
    expect(ds.currentIndex).toBe(2);
    ds.deleteRow(0);
    expect(ds.currentIndex).toBe(1);
  });

  it('adopts the first row added to an empty Dataset', () => {
    const ds = new Dataset({ id: 'ds', columns });
    const id = ds.addRow({ code: 'X' });
    expect(ds.currentRow).toBe(id);
  });
});

describe('invalidation', () => {
  it('coalesces a burst of changes into one notice', async () => {
    const ds = makeDataset();
    const listener = vi.fn();
    ds.onInvalidate(listener);
    ds.setValue(0, 'name', 'x');
    ds.setValue(1, 'name', 'y');
    ds.setValue(1, 'qty', 9);
    expect(listener).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
    const invalidation = listener.mock.calls[0]?.[0];
    expect([...invalidation.rows].sort()).toEqual([ds.rowIdAt(0), ds.rowIdAt(1)]);
    expect([...invalidation.columns].sort()).toEqual(['name', 'qty']);
    expect(invalidation.structural).toBe(false);
  });

  it('marks changes to the rows themselves as structural', () => {
    const ds = makeDataset();
    const listener = vi.fn();
    ds.onInvalidate(listener);
    ds.deleteRow(0);
    ds.flushInvalidate();
    expect(listener.mock.calls[0]?.[0].structural).toBe(true);
  });

  it('raises the version on every change', () => {
    const ds = makeDataset();
    const before = ds.version;
    ds.setValue(0, 'name', 'x');
    expect(ds.version).toBeGreaterThan(before);
  });
});

describe('validation', () => {
  const rules: ColumnDef[] = [
    { id: 'code', type: 'string', label: 'Code', required: true, size: 3, pattern: '^[A-Z]+$' },
    { id: 'qty', type: 'int', min: 1, max: 10 },
    { id: 'price', type: 'decimal', precision: 5, scale: 2, min: '0.50' },
    { id: 'startOn', type: 'date', min: '2026-01-01' },
  ];

  function issuesFor(values: Record<string, unknown>): string[] {
    const ds = new Dataset({ id: 'ds', columns: rules });
    const id = ds.addRow(values);
    return ds.validateRow(id).map((issue) => `${issue.column}:${issue.code}`);
  }

  it('passes a valid row', () => {
    expect(issuesFor({ code: 'ABC', qty: 5, price: '1.50', startOn: '2026-06-01' })).toEqual([]);
  });

  it('checks each rule', () => {
    expect(issuesFor({})).toEqual(['code:required']);
    expect(issuesFor({ code: '' })).toEqual(['code:required']);
    expect(issuesFor({ code: 'ABCD' })).toEqual(['code:length']);
    expect(issuesFor({ code: 'abc' })).toEqual(['code:pattern']);
    expect(issuesFor({ code: 'A', qty: 0 })).toEqual(['qty:range']);
    expect(issuesFor({ code: 'A', qty: 11 })).toEqual(['qty:range']);
    expect(issuesFor({ code: 'A', price: '0.49' })).toEqual(['price:range']);
    expect(issuesFor({ code: 'A', price: '1.234' })).toEqual(['price:precision']);
    expect(issuesFor({ code: 'A', price: '1234.00' })).toEqual(['price:precision']);
    expect(issuesFor({ code: 'A', startOn: '2025-12-31' })).toEqual(['startOn:range']);
  });

  it('writes messages using the label', () => {
    const ds = new Dataset({ id: 'ds', columns: rules });
    const id = ds.addRow({});
    expect(ds.validateRow(id)[0]?.message).toBe('Code is required');
  });

  it('runs custom rules, which can read other columns', () => {
    const ds = new Dataset({ id: 'ds', columns: rules });
    ds.setValidator('qty', (value, get) => (get('code') === 'BIG' && (value as number) < 5 ? 'Too few' : null));
    const id = ds.addRow({ code: 'BIG', qty: 2 });
    expect(ds.validateRow(id)).toMatchObject([{ column: 'qty', code: 'custom', message: 'Too few' }]);
    ds.setValidator('qty', null);
    expect(ds.validateRow(id)).toEqual([]);
  });

  it('only checks rows that will be saved', () => {
    const ds = new Dataset({
      id: 'ds',
      columns: rules,
      initialRows: [{ code: null }, { code: null }, { code: 'OK' }],
    });
    expect(ds.validate()).toEqual([]);
    ds.setValue(2, 'code', 'bad');
    ds.deleteRow(0);
    const issues = ds.validate();
    expect(issues.map((issue) => issue.code)).toEqual(['pattern']);
  });

  it('fails fast on a bad pattern', () => {
    expect(() => new Dataset({ id: 'ds', columns: [{ id: 'a', type: 'string', pattern: '(' }] })).toThrow();
  });
});

describe('construction', () => {
  it('rejects duplicate columns and unknown keys', () => {
    expect(() => new Dataset({ id: 'ds', columns: [{ id: 'a', type: 'int' }, { id: 'a', type: 'int' }] })).toThrow(/two columns/);
    expect(() => new Dataset({ id: 'ds', columns: [{ id: 'a', type: 'int' }], keys: ['b'] })).toThrow(/no column "b"/);
  });

  it('treats an empty initial row as a blank, unchanged row', () => {
    const ds = new Dataset({ id: 'ds', columns, initialRows: [{}] });
    expect(ds.rowCount).toBe(1);
    expect(ds.getValue(0, 'code')).toBeNull();
    expect(ds.hasChanges()).toBe(false);
  });
});
