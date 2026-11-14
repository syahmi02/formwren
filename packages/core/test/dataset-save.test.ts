import { describe, expect, it } from 'vitest';
import { Dataset, type ColumnDef } from '../src/index.ts';

const columns: ColumnDef[] = [
  { id: 'code', type: 'string' },
  { id: 'name', type: 'string' },
  { id: 'price', type: 'decimal', scale: 2 },
  { id: 'ver', type: 'int' },
];

function makeDataset(): Dataset {
  return new Dataset({
    id: 'ds',
    columns,
    keys: ['code'],
    initialRows: [
      { code: 'A', name: 'Apple', price: '1.50', ver: 1 },
      { code: 'B', name: 'Banana', price: '2.50', ver: 1 },
      { code: 'C', name: 'Cherry', price: '3.50', ver: 1 },
    ],
  });
}

describe('getChanges', () => {
  it('sends only changed rows, with originals only for changed columns', () => {
    const ds = makeDataset();
    const updated = ds.rowIdAt(0);
    const deleted = ds.rowIdAt(1);
    ds.setValue(0, 'name', 'Apricot');
    ds.deleteRow(1);
    const inserted = ds.addRow({ code: 'D', name: 'Date', price: '4' });

    expect(ds.getChanges()).toEqual([
      { status: 'U', rowId: updated, values: ['A', 'Apricot', '1.50', 1], originals: { 1: 'Apple' } },
      { status: 'D', rowId: deleted, values: ['B', 'Banana', '2.50', 1] },
      { status: 'I', rowId: inserted, values: ['D', 'Date', '4', null] },
    ]);
  });

  it('sends the loaded values for a row edited and then deleted', () => {
    const ds = makeDataset();
    const id = ds.rowIdAt(0);
    ds.setValue(0, 'name', 'edited');
    ds.deleteRow(0);
    expect(ds.getChanges()).toEqual([{ status: 'D', rowId: id, values: ['A', 'Apple', '1.50', 1] }]);
  });

  it('keeps sent values independent of later edits', () => {
    const ds = makeDataset();
    ds.setValue(0, 'name', 'first');
    const ticket = ds.beginSave();
    ds.setValue(0, 'name', 'second');
    expect(ticket.changes[0]?.values[1]).toBe('first');
  });
});

describe('after a successful save', () => {
  it('clears status and originals, and forgets deleted rows', () => {
    const ds = makeDataset();
    ds.setValue(0, 'name', 'Apricot');
    ds.deleteRow(1);
    const inserted = ds.addRow({ code: 'D', name: 'Date' });

    ds.acceptSave(ds.beginSave());

    expect(ds.hasChanges()).toBe(false);
    expect(ds.getChanges()).toEqual([]);
    expect(ds.deletedRows()).toEqual([]);
    expect(ds.statusOf(inserted)).toBe('normal');
    expect(ds.getValue(0, 'name')).toBe('Apricot');
    expect(ds.getOriginalValue(ds.rowIdAt(0), 'name')).toBe('Apricot');
    expect(ds.rowCount).toBe(3);
  });

  it('takes in values the server assigned', () => {
    const ds = makeDataset();
    const updated = ds.rowIdAt(0);
    ds.setValue(0, 'name', 'Apricot');
    const inserted = ds.addRow({ name: 'Date' });

    ds.acceptSave(
      ds.beginSave(),
      new Map([
        [updated, { ver: 2 }],
        [inserted, { code: 'GEN-1', ver: 1 }],
      ]),
    );

    expect(ds.getValueById(updated, 'ver')).toBe(2);
    expect(ds.getValueById(inserted, 'code')).toBe('GEN-1');
    expect(ds.hasChanges()).toBe(false);
  });

  it('forgets inserted rows that were removed before the save', () => {
    const ds = makeDataset();
    const gone = ds.addRow({ code: 'X' });
    ds.revertRow(gone);
    ds.setValue(0, 'name', 'y');
    ds.acceptSave(ds.beginSave());
    expect(ds.hasChanges()).toBe(false);
    expect(ds.getChanges()).toEqual([]);
  });
});

describe('after a failed save', () => {
  it('keeps every edit and status for a retry', () => {
    const ds = makeDataset();
    ds.setValue(0, 'name', 'Apricot');
    ds.deleteRow(1);
    ds.addRow({ code: 'D' });
    const before = ds.getChanges();

    ds.beginSave();

    expect(ds.getChanges()).toEqual(before);
    expect(ds.getChanges()).toHaveLength(3);
  });
});

describe('changes made while a save is running', () => {
  it('keeps an edit to a sent row, comparing it against what the server now holds', () => {
    const ds = makeDataset();
    const id = ds.rowIdAt(0);
    ds.setValue(0, 'name', 'sent');
    const ticket = ds.beginSave();
    ds.setValue(0, 'name', 'typed during save');

    ds.acceptSave(ticket, new Map([[id, { ver: 2 }]]));

    expect(ds.getValueById(id, 'name')).toBe('typed during save');
    expect(ds.statusOf(id)).toBe('updated');
    expect(ds.getOriginalValue(id, 'name')).toBe('sent');
    expect(ds.getValueById(id, 'ver')).toBe(2);
    expect(ds.getChanges()).toEqual([
      { status: 'U', rowId: id, values: ['A', 'typed during save', '1.50', 2], originals: { 1: 'sent' } },
    ]);
  });

  it('turns an inserted row edited during the save into an update', () => {
    const ds = makeDataset();
    const id = ds.addRow({ code: 'D', name: 'sent' });
    const ticket = ds.beginSave();
    ds.setValueById(id, 'name', 'typed during save');

    ds.acceptSave(ticket, new Map([[id, { ver: 1 }]]));

    expect(ds.statusOf(id)).toBe('updated');
    expect(ds.getOriginalValue(id, 'name')).toBe('sent');
    expect(ds.getValueById(id, 'name')).toBe('typed during save');
  });

  it('sends a delete next time for a row deleted during its update', () => {
    const ds = makeDataset();
    const id = ds.rowIdAt(0);
    ds.setValue(0, 'name', 'sent');
    const ticket = ds.beginSave();
    ds.deleteRow(0);

    ds.acceptSave(ticket, new Map([[id, { ver: 2 }]]));

    expect(ds.getChanges()).toEqual([{ status: 'D', rowId: id, values: ['A', 'sent', '1.50', 2] }]);
  });

  it('sends a delete next time for an inserted row removed during its insert', () => {
    const ds = makeDataset();
    const id = ds.addRow({ code: 'D', name: 'new' });
    const ticket = ds.beginSave();
    ds.revertRow(id);
    expect(ds.getChanges()).toEqual([]);

    ds.acceptSave(ticket, new Map([[id, { ver: 1 }]]));

    expect(ds.getChanges()).toEqual([{ status: 'D', rowId: id, values: ['D', 'new', null, 1] }]);
    expect(ds.indexOfRow(id)).toBe(-1);
  });

  it('re-inserts a row whose delete was undone during the save', () => {
    const ds = makeDataset();
    const id = ds.rowIdAt(0);
    ds.deleteRow(0);
    const ticket = ds.beginSave();
    ds.revertRow(id);
    expect(ds.statusOf(id)).toBe('normal');

    ds.acceptSave(ticket);

    expect(ds.statusOf(id)).toBe('inserted');
    expect(ds.getChanges()).toEqual([{ status: 'I', rowId: id, values: ['A', 'Apple', '1.50', 1] }]);
  });

  it('re-sends an update that was reverted during the save', () => {
    const ds = makeDataset();
    const id = ds.rowIdAt(0);
    ds.setValue(0, 'name', 'sent');
    const ticket = ds.beginSave();
    ds.revertRow(id);

    ds.acceptSave(ticket);

    expect(ds.getValueById(id, 'name')).toBe('Apple');
    expect(ds.statusOf(id)).toBe('updated');
    expect(ds.getOriginalValue(id, 'name')).toBe('sent');
  });

  it('ignores a save that finishes after the Dataset was reloaded', () => {
    const ds = makeDataset();
    ds.setValue(0, 'name', 'sent');
    const ticket = ds.beginSave();
    ds.load([{ code: 'N', name: 'new', ver: 9 }]);
    ds.setValue(0, 'name', 'edited');

    ds.acceptSave(ticket);

    expect(ds.getValue(0, 'name')).toBe('edited');
    expect(ds.rowStatus(0)).toBe('updated');
    // Row ids restart on a reload, so a stale save must not touch the new row's originals.
    expect(ds.getOriginalValue(ds.rowIdAt(0), 'name')).toBe('new');
    expect(ds.getValue(0, 'code')).toBe('N');
  });

  it("doesn't overwrite a column the user changed with a server-assigned value", () => {
    const ds = makeDataset();
    const id = ds.addRow({ name: 'x' });
    const ticket = ds.beginSave();
    ds.setValueById(id, 'code', 'MINE');

    ds.acceptSave(ticket, new Map([[id, { code: 'GEN-1' }]]));

    expect(ds.getValueById(id, 'code')).toBe('MINE');
    expect(ds.getOriginalValue(id, 'code')).toBe('GEN-1');
    expect(ds.statusOf(id)).toBe('updated');
  });
});

describe('random operations', () => {
  /** Small seeded generator, so a failing run can be repeated. */
  function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function allValues(ds: Dataset): unknown[][] {
    return Array.from({ length: ds.rowCount }, (_, i) => columns.map((column) => ds.getValue(i, column.id)));
  }

  it('always reverts to exactly what was loaded, with statuses consistent throughout', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const next = random(seed);
      const pick = (limit: number) => Math.floor(next() * limit);
      const ds = makeDataset();
      const loaded = allValues(ds);
      const context = `seed ${seed}`;

      for (let step = 0; step < 40; step++) {
        const count = ds.rowCount;
        const op = pick(6);
        if (op === 0 && count > 0) {
          ds.setValue(pick(count), 'name', `name${pick(3)}`);
        } else if (op === 1 && count > 0) {
          ds.setValue(pick(count), 'price', pick(2) ? '1.5' : `${pick(9)}.25`);
        } else if (op === 2) {
          ds.insertRow(pick(count + 1), { code: `N${step}`, name: 'new' });
        } else if (op === 3 && count > 0) {
          ds.deleteRow(pick(count));
        } else if (op === 4) {
          ds.sort(pick(2) ? [{ column: 'name', descending: pick(2) === 1 }] : []);
        } else if (op === 5 && ds.deletedRows().length > 0) {
          const deleted = ds.deletedRows();
          ds.revertRow(deleted[pick(deleted.length)] as number);
        }

        // Row counts add up, and the current row is always valid.
        const changes = ds.getChanges();
        const deletes = changes.filter((change) => change.status === 'D').length;
        const inserts = changes.filter((change) => change.status === 'I').length;
        expect(ds.rowCount, context).toBe(3 - deletes + inserts);
        if (ds.currentRow === null) {
          expect(ds.currentIndex, context).toBe(-1);
        } else {
          expect(ds.rowIdAt(ds.currentIndex), context).toBe(ds.currentRow);
        }
        // An updated row always differs from its originals.
        for (const change of changes) {
          if (change.status === 'U') expect(Object.keys(change.originals ?? {}).length, context).toBeGreaterThan(0);
        }
      }

      ds.sort([]);
      ds.revertAll();
      expect(allValues(ds), context).toEqual(loaded);
      expect(ds.hasChanges(), context).toBe(false);
    }
  });

  it('never loses a change across a save with edits during it', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const next = random(seed);
      const pick = (limit: number) => Math.floor(next() * limit);
      const ds = makeDataset();
      // A stand-in server: code -> values.
      const server = new Map<number, unknown[]>();
      for (let i = 0; i < ds.rowCount; i++) {
        server.set(ds.rowIdAt(i), columns.map((column) => ds.getValue(i, column.id)));
      }

      const edit = () => {
        const count = ds.rowCount;
        const deleted = ds.deletedRows();
        const op = pick(5);
        if (op === 0 && count > 0) ds.setValue(pick(count), 'name', `name${pick(5)}`);
        if (op === 1) ds.addRow({ code: `N${pick(1000)}`, name: 'new' });
        if (op === 2 && count > 0) ds.deleteRow(pick(count));
        if (op === 3 && count > 0) ds.revertRow(ds.rowIdAt(pick(count)));
        if (op === 4 && deleted.length > 0) ds.revertRow(deleted[pick(deleted.length)] as number);
      };

      for (let round = 0; round < 6; round++) {
        for (let i = pick(4); i > 0; i--) edit();
        const ticket = ds.beginSave();
        for (const change of ticket.changes) {
          if (change.status === 'D') server.delete(change.rowId);
          else server.set(change.rowId, change.values.slice());
        }
        for (let i = pick(3); i > 0; i--) edit();
        ds.acceptSave(ticket);
      }

      // One final save brings the server exactly in line with what the user sees.
      const ticket = ds.beginSave();
      for (const change of ticket.changes) {
        if (change.status === 'D') server.delete(change.rowId);
        else server.set(change.rowId, change.values.slice());
      }
      ds.acceptSave(ticket);

      const visible = new Map<number, unknown[]>();
      for (let i = 0; i < ds.rowCount; i++) {
        visible.set(ds.rowIdAt(i), columns.map((column) => ds.getValue(i, column.id)));
      }
      expect(Object.fromEntries(server), `seed ${seed}`).toEqual(Object.fromEntries(visible));
      expect(ds.hasChanges(), `seed ${seed}`).toBe(false);
    }
  });
});
