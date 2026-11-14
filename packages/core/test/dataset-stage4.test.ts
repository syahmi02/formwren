import { describe, expect, it, vi } from 'vitest';
import { Dataset, type ColumnDef } from '../src/index.ts';

const columns: ColumnDef[] = [
  { id: 'code', type: 'string' },
  { id: 'name', type: 'string' },
  { id: 'price', type: 'decimal' },
  { id: 'qty', type: 'int' },
];

function make(rows: Record<string, unknown>[] = [{ code: 'A', name: 'Apple', price: '1.5', qty: 1 }, { code: 'B', name: 'Banana', price: '2', qty: 2 }, { code: 'C', name: 'Cherry', price: '3', qty: 3 }]) {
  return new Dataset({ id: 'ds', columns, initialRows: rows });
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('row ids are never reused', () => {
  it('gives a reloaded row a new id and throws RangeError for a stale one', () => {
    const ds = make();
    const old = ds.rowIdAt(0);
    ds.load([{ code: 'X' }]);
    expect(ds.rowIdAt(0)).not.toBe(old);
    expect(() => ds.getValueById(old, 'code')).toThrow(RangeError);
    expect(() => ds.setValueById(old, 'code', 'Z')).toThrow(RangeError);
    expect(() => ds.statusOf(old)).toThrow(RangeError);
    expect(() => ds.revertRow(old)).toThrow(RangeError);
    expect(ds.indexOfRow(old)).toBe(-1);
  });

  it('keeps ids unique across many reloads', () => {
    const ds = make();
    const seen = new Set<number>();
    for (let i = 0; i < 50; i++) {
      ds.load([{ code: 'a' }, { code: 'b' }]);
      for (let r = 0; r < ds.rowCount; r++) {
        const id = ds.rowIdAt(r);
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
    }
  });

  it('reports public ids in events, changes and invalidations', async () => {
    const ds = make();
    ds.load([{ code: 'a', name: 'n' }]);
    const id = ds.rowIdAt(0);
    expect(id).toBeGreaterThan(0);
    const changed = vi.fn();
    const invalidated = vi.fn();
    ds.on('cellChanged', changed);
    ds.onInvalidate(invalidated);
    ds.setValue(0, 'name', 'm');
    await tick();
    expect(changed.mock.calls[0]?.[0].rowId).toBe(id);
    expect([...invalidated.mock.calls[0]![0].rows]).toEqual([id]);
    expect(ds.getChanges()[0]?.rowId).toBe(id);
    expect(ds.currentRow).toBe(id);
  });
});

describe('revert with nothing to undo', () => {
  it('still raises revision and notifies, and leaves status and values alone', async () => {
    const ds = make();
    const invalidated = vi.fn();
    ds.onInvalidate(invalidated);
    const before = ds.revision;
    const id = ds.rowIdAt(0);
    ds.revertAll();
    await tick();
    expect(ds.revision).toBe(before + 1);
    expect(invalidated).toHaveBeenCalledTimes(1);
    ds.revertRow(id);
    await tick();
    expect(ds.revision).toBe(before + 2);
    expect(invalidated).toHaveBeenCalledTimes(2);
    expect(ds.statusOf(id)).toBe('normal');
    expect(ds.getValue(0, 'name')).toBe('Apple');
    expect(ds.getChanges()).toEqual([]);
  });
});

describe('revision, liveRows and settled', () => {
  it('raises revision on a replacing load and on any revert, but not on an edit or append', () => {
    const ds = make();
    const start = ds.revision;
    ds.setValue(0, 'name', 'edit');
    ds.load([{ code: 'z' }], { append: true });
    expect(ds.revision).toBe(start);
    ds.revertRow(ds.rowIdAt(0));
    expect(ds.revision).toBe(start + 1);
    ds.setValue(0, 'name', 'edit');
    ds.revertAll();
    expect(ds.revision).toBe(start + 2);
    ds.load([]);
    expect(ds.revision).toBe(start + 3);
  });

  it('lists live rows in natural order whatever the filter and sort', () => {
    const ds = make();
    ds.sort([{ column: 'name', descending: true }]);
    ds.setFilter((get) => get('code') !== 'A');
    ds.deleteRow(0);
    const { ids, rows } = ds.liveRows();
    expect(rows.map((r) => r[0])).toEqual(['A', 'B']);
    expect(ids).toHaveLength(2);
    expect(ds.getValueById(ids[1]!, 'code')).toBe('B');
  });

  it('settles after deferred writes and moves finish', async () => {
    const ds = make();
    let release!: () => void;
    ds.on('cellChanging', (e) => e.waitUntil(new Promise<void>((resolve) => (release = resolve))));
    const pending = ds.setValue(0, 'name', 'later');
    let done = false;
    void ds.settled().then(() => (done = true));
    await tick();
    expect(done).toBe(false);
    release();
    await expect(pending).resolves.toBe(true);
    await ds.settled();
    expect(done).toBe(true);
    await expect(ds.settled()).resolves.toBeUndefined();
  });

  it('counts a deferred current-row move as pending', async () => {
    const ds = make();
    let release!: () => void;
    ds.on('currentRowChanging', (e) => e.waitUntil(new Promise<void>((resolve) => (release = resolve))));
    const move = ds.setCurrentIndex(2);
    let done = false;
    void ds.settled().then(() => (done = true));
    await tick();
    expect(done).toBe(false);
    release();
    await move;
    await ds.settled();
    expect(ds.currentIndex).toBe(2);
  });
});

describe('a later edit supersedes an earlier deferred one', () => {
  it('resolves the earlier write false and keeps the later value', async () => {
    const ds = make();
    const releases: (() => void)[] = [];
    ds.on('cellChanging', (e) => e.waitUntil(new Promise<void>((resolve) => releases.push(resolve))));
    const first = ds.setValue(0, 'name', 'first');
    const second = ds.setValue(0, 'name', 'second');
    releases.forEach((release) => release());
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);
    expect(ds.getValue(0, 'name')).toBe('second');
  });

  it('also supersedes when the later edit is back to the current value', async () => {
    const ds = make();
    let release!: () => void;
    ds.on('cellChanging', (e) => e.waitUntil(new Promise<void>((resolve) => (release = resolve))));
    const first = ds.setValue(0, 'name', 'first');
    expect(ds.setValue(0, 'name', 'Apple')).toBe(true);
    release();
    await expect(first).resolves.toBe(false);
    expect(ds.getValue(0, 'name')).toBe('Apple');
  });
});

describe('append load and failing filters', () => {
  it('keeps the current row inside the view when appending with a filter', () => {
    const ds = make();
    ds.setCurrentIndex(1);
    ds.setFilter((get) => get('code') !== 'A');
    ds.load([{ code: 'D' }, { code: 'A' }], { append: true });
    expect(ds.currentIndex).toBeGreaterThanOrEqual(0);
    expect(ds.rowIdAt(ds.currentIndex)).toBe(ds.currentRow);
  });

  it('keeps a sorted view consistent with the current row when appending', () => {
    const ds = make();
    ds.sort([{ column: 'code', descending: true }]);
    ds.setCurrentIndex(0);
    const current = ds.currentRow;
    ds.load([{ code: 'Z' }], { append: true });
    expect(ds.rowIdAt(ds.currentIndex)).toBe(ds.currentRow);
    expect(ds.currentRow).toBe(current);
  });

  it('leaves everything as it was when a filter throws during a replacing load', () => {
    const ds = make();
    ds.setValue(0, 'name', 'edited');
    const before = { ids: ds.liveRows(), current: ds.currentRow, revision: ds.revision, changes: ds.getChanges() };
    ds.setFilter((get) => {
      if (get('code') === 'BOOM') throw new Error('filter failed');
      return true;
    });
    expect(() => ds.load([{ code: 'BOOM' }])).toThrow('filter failed');
    expect(ds.liveRows()).toEqual(before.ids);
    expect(ds.currentRow).toBe(before.current);
    expect(ds.revision).toBe(before.revision);
    expect(ds.getChanges()).toEqual(before.changes);
    expect(ds.getValueById(before.ids.ids[0]!, 'name')).toBe('edited');
    expect(ds.rowCount).toBe(3);
  });

  it('leaves everything as it was when a filter throws during an append', () => {
    const ds = make();
    ds.setFilter((get) => {
      if (get('code') === 'BOOM') throw new Error('filter failed');
      return true;
    });
    expect(() => ds.load([{ code: 'BOOM' }], { append: true })).toThrow('filter failed');
    expect(ds.liveRows().ids).toHaveLength(3);
    ds.load([{ code: 'ok' }], { append: true });
    expect(ds.rowCount).toBe(4);
  });

  it('restores the previous filter when setFilter throws', () => {
    const ds = make();
    expect(() =>
      ds.setFilter(() => {
        throw new Error('bad');
      }),
    ).toThrow('bad');
    expect(ds.rowCount).toBe(3);
    ds.load([{ code: 'new' }], { append: true });
    expect(ds.rowCount).toBe(4);
  });
});

describe('small fixes', () => {
  it('stays at no current row through a sort after setCurrentIndex(-1)', () => {
    const ds = make();
    ds.setCurrentIndex(-1);
    ds.sort([{ column: 'name', descending: true }]);
    expect(ds.currentRow).toBeNull();
    expect(ds.currentIndex).toBe(-1);
    ds.setFilter(null);
    expect(ds.currentRow).toBeNull();
  });

  it('does not turn an unsent row into a server delete when its index is listed twice', () => {
    const ds = make();
    ds.addRow({ code: 'N' });
    ds.deleteRows([3, 3]);
    expect(ds.getChanges()).toEqual([]);
    expect(ds.rowCount).toBe(3);
  });

  it('stores the exact original decimal text when typed back while another column is dirty', () => {
    const ds = make([{ code: 'A', name: 'x', price: '1.5' }]);
    ds.setValue(0, 'price', '2');
    ds.setValue(0, 'name', 'y');
    ds.setValue(0, 'price', '1.50');
    expect(ds.getValue(0, 'price')).toBe('1.5');
    const change = ds.getChanges()[0]!;
    expect(change.values[2]).toBe('1.5');
    expect(Object.keys(change.originals ?? {})).toEqual(['1']);
  });

  it('checks column names of aggregates and findValue through the column map', () => {
    const typed = new Dataset<{ a: number; b: string }>({ id: 't', columns: [{ id: 'a', type: 'int' }, { id: 'b', type: 'string' }] });
    expect(typed.sum('a')).toBe(0);
    // @ts-expect-error not a column
    expect(() => typed.sum('nope')).toThrow();
    // @ts-expect-error not a column
    expect(() => typed.count('nope')).toThrow();
    // @ts-expect-error not a column
    expect(() => typed.findValue('nope', 1)).toThrow();
    expect(typed.max('a')).toBeNull();
    expect(typed.avg('a')).toBeNull();
    expect(typed.min('a')).toBeNull();
  });
});
