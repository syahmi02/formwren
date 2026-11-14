import { computed, effect } from '@preact/signals-core';
import { describe, expect, it, vi } from 'vitest';
import {
  createForm,
  createTxClient,
  Dataset,
  encodeInput,
  formatValue,
  readOptions,
  type ColumnDef,
  type FormDefinition,
  type Invalidation,
  type Transport,
} from '../src/index.ts';

const columns: ColumnDef[] = [
  { id: 'code', type: 'string' },
  { id: 'name', type: 'string' },
  { id: 'qty', type: 'int' },
];

function make() {
  return new Dataset({
    id: 'ds',
    columns,
    initialRows: [
      { code: 'A', name: 'Apple', qty: 1 },
      { code: 'B', name: 'Banana', qty: 2 },
      { code: 'C', name: 'Cherry', qty: 3 },
    ],
  });
}

function collect(ds: Dataset): Invalidation[] {
  const seen: Invalidation[] = [];
  ds.onInvalidate((i) => seen.push(i));
  return seen;
}

describe('Dataset issues', () => {
  it('sets, reads and lists issues, and accepts a server code', () => {
    const ds = make();
    const [a, b] = [ds.rowIdAt(0), ds.rowIdAt(1)];
    ds.setIssues([
      { rowId: b, column: 'qty', code: 'server-conflict', message: 'Changed by someone else' },
      { rowId: a, column: 'name', code: 'required', message: 'Name is required' },
    ]);
    expect(ds.issueAt(a, 'name')?.message).toBe('Name is required');
    expect(ds.issueAt(b, 'qty')?.code).toBe('server-conflict');
    expect(ds.issueAt(a, 'qty')).toBeUndefined();
    expect(ds.issues().map((i) => `${i.rowId}.${i.column}`)).toEqual([`${a}.name`, `${b}.qty`]);
  });

  it('notifies through invalidation with the affected rows and columns', async () => {
    const ds = make();
    const seen = collect(ds);
    const a = ds.rowIdAt(0);
    ds.setIssues([{ rowId: a, column: 'name', code: 'x', message: 'm' }]);
    await Promise.resolve();
    expect(seen).toHaveLength(1);
    expect([...seen[0]!.rows]).toEqual([a]);
    expect([...seen[0]!.columns]).toEqual(['name']);
    ds.setIssues([]);
    await Promise.resolve();
    expect([...seen[1]!.rows]).toEqual([a]);
  });

  it('clears an issue when its cell is written, and only that one', () => {
    const ds = make();
    const a = ds.rowIdAt(0);
    ds.setIssues([
      { rowId: a, column: 'name', code: 'x', message: 'm' },
      { rowId: a, column: 'qty', code: 'x', message: 'q' },
    ]);
    ds.setValueById(a, 'name', 'Apricot');
    expect(ds.issueAt(a, 'name')).toBeUndefined();
    expect(ds.issueAt(a, 'qty')).toBeDefined();
  });

  it('clears everything on a replacing load and on any revert, but not on an append', () => {
    const ds = make();
    const a = ds.rowIdAt(0);
    const issue = { rowId: a, column: 'name', code: 'x', message: 'm' };
    ds.setIssues([issue]);
    ds.load([{ code: 'Z' }], { append: true });
    expect(ds.issues()).toHaveLength(1);
    ds.revertRow(a);
    expect(ds.issues()).toEqual([]);
    ds.setIssues([issue]);
    ds.revertAll();
    expect(ds.issues()).toEqual([]);
    ds.setIssues([{ ...issue, rowId: ds.rowIdAt(0) }]);
    ds.load([{ code: 'Y' }]);
    expect(ds.issues()).toEqual([]);
  });

  it('ignores stale row ids instead of throwing', () => {
    const ds = make();
    const old = ds.rowIdAt(0);
    ds.load([{ code: 'Y' }]);
    expect(() => ds.setIssues([{ rowId: old, column: 'name', code: 'x', message: 'm' }])).not.toThrow();
    expect(ds.issues()).toEqual([]);
    expect(ds.issueAt(old, 'name')).toBeUndefined();
    expect(() => ds.setIssues([{ rowId: 9999, column: 'name', code: 'x', message: 'm' }])).not.toThrow();
  });
});

describe('Dataset selection', () => {
  it('selects rows without touching status or hasChanges', () => {
    const ds = make();
    ds.setRowSelected(ds.rowIdAt(1), true);
    expect(ds.isRowSelected(ds.rowIdAt(1))).toBe(true);
    expect(ds.isRowSelected(ds.rowIdAt(0))).toBe(false);
    expect(ds.statusOf(ds.rowIdAt(1))).toBe('normal');
    expect(ds.hasChanges()).toBe(false);
  });

  it('lists selected rows in natural order, whatever the sort', () => {
    const ds = make();
    const ids = [0, 1, 2].map((i) => ds.rowIdAt(i));
    ds.setRowSelected(ids[2]!, true);
    ds.setRowSelected(ids[0]!, true);
    ds.sort([{ column: 'name', descending: true }]);
    expect(ds.selectedRows()).toEqual([ids[0], ids[2]]);
  });

  it('notifies through invalidation for that row only', async () => {
    const ds = make();
    const seen = collect(ds);
    const id = ds.rowIdAt(1);
    ds.setRowSelected(id, true);
    await Promise.resolve();
    expect([...seen[0]!.rows]).toEqual([id]);
    ds.setRowSelected(id, true);
    await Promise.resolve();
    expect(seen).toHaveLength(1);
  });

  it('drops a row that is deleted or removed, and clears on a replacing load', () => {
    const ds = make();
    const ids = [0, 1, 2].map((i) => ds.rowIdAt(i));
    ids.forEach((id) => ds.setRowSelected(id, true));
    ds.deleteRow(0);
    expect(ds.selectedRows()).toEqual([ids[1], ids[2]]);
    const added = ds.addRow({ code: 'N' });
    ds.setRowSelected(added, true);
    ds.revertRow(added);
    expect(ds.isRowSelected(added)).toBe(false);
    ds.revertAll(); // brings back the deleted row, which is not selected again
    expect(ds.isRowSelected(ids[0]!)).toBe(false);
    ds.load([{ code: 'Q' }]);
    expect(ds.selectedRows()).toEqual([]);
  });

  it('clears the selection and ignores stale ids', () => {
    const ds = make();
    const old = ds.rowIdAt(0);
    ds.setRowSelected(old, true);
    ds.setRowSelected(ds.rowIdAt(1), true);
    ds.clearSelection();
    expect(ds.selectedRows()).toEqual([]);
    ds.load([{ code: 'Y' }]);
    expect(() => ds.setRowSelected(old, true)).not.toThrow();
    expect(ds.isRowSelected(old)).toBe(false);
  });
});

function formDef(): FormDefinition {
  return {
    formatVersion: 1,
    id: 'f',
    datasets: [
      {
        id: 'dsEmp',
        columns: [
          { id: 'name', type: 'string' },
          { id: 'salary', type: 'decimal' },
        ],
        initialRows: [
          { name: 'Ann', salary: '100.50' },
          { name: 'Bob', salary: '250' },
        ],
      },
    ],
    variables: { rate: { type: 'int', default: 2 } },
    components: [
      { id: 'grid', type: 'Grid', layout: {}, bind: { dataset: 'dsEmp' } },
      { id: 'nameInput', type: 'TextInput', layout: {}, bind: { value: 'dsEmp.name' } },
      { id: 'own', type: 'TextInput', layout: {}, props: { errorMessage: 'Mine' }, bind: { value: 'dsEmp.name' } },
    ],
  };
}

describe('ComponentModel.cellScope', () => {
  it('reads like the form and aggregates one-segment paths on the bound Dataset', () => {
    const form = createForm(formDef(), { onError: () => {} });
    const scope = form.getComponent('grid')!.cellScope();
    expect(scope.aggregate('sum', ['salary'])).toBe('350.50');
    expect(scope.aggregate('count', ['name'])).toBe(2);
    expect(scope.read(['vars', 'rate'])).toBe(2);
    expect(scope.aggregate('sum', ['ds', 'dsEmp', 'salary'])).toBe('350.50');
    expect(() => scope.aggregate('sum', ['nope'])).toThrow(/no column/);
  });

  it('follows the Dataset inside a computed', () => {
    const form = createForm(formDef(), { onError: () => {} });
    const ds = form.context.ds.dsEmp!;
    const scope = form.getComponent('grid')!.cellScope();
    const total = computed(() => scope.aggregate('sum', ['salary']));
    const seen: unknown[] = [];
    const stop = effect(() => {
      seen.push(total.value);
    });
    ds.setValueById(ds.rowIdAt(0), 'salary', '200');
    ds.flushInvalidate();
    stop();
    expect(seen).toEqual(['350.50', '450']);
  });

  it('throws a clear error for a component with no bound Dataset', () => {
    const form = createForm(formDef(), { onError: () => {} });
    expect(() => form.getComponent('nameInput')!.cellScope().aggregate('sum', ['salary'])).toThrow(/no Dataset bound/);
  });
});

describe('column-bound props take errorMessage from issues', () => {
  it('shows the issue, keeps a component-set message, and leaves props alone when nothing changed', () => {
    const form = createForm(formDef(), { onError: () => {} });
    const ds = form.context.ds.dsEmp!;
    const input = form.getComponent('nameInput')!;
    const own = form.getComponent('own')!;
    expect(input.props.value.errorMessage).toBeUndefined();

    ds.setIssues([{ rowId: ds.currentRow!, column: 'name', code: 'server', message: 'Duplicate' }]);
    ds.flushInvalidate();
    expect(input.props.value.errorMessage).toBe('Duplicate');
    expect(own.props.value.errorMessage).toBe('Mine');

    const stable = input.props.value;
    ds.setValueById(ds.rowIdAt(1), 'salary', '1'); // unrelated cell
    ds.flushInvalidate();
    expect(input.props.value).toBe(stable);

    ds.setValueById(ds.currentRow!, 'name', 'Anna');
    ds.flushInvalidate();
    expect(input.props.value.errorMessage).toBeUndefined();
  });
});

describe('ComponentHandle.focus(cell)', () => {
  it('forwards the argument now, and queued before React has committed', () => {
    const form = createForm(formDef(), { onError: () => {} });
    const grid = form.getComponent('grid')!;
    const calls: unknown[] = [];
    form.context.c.grid!.focus({ rowId: 3, track: 1 });
    form.context.c.grid!.focus();
    grid.setHandle({ focus: (cell) => calls.push(cell) });
    expect(calls).toEqual([{ rowId: 3, track: 1 }, undefined]);
    form.context.c.grid!.focus({ rowId: 4, track: 0 });
    expect(calls[2]).toEqual({ rowId: 4, track: 0 });
  });
});

describe('readOptions', () => {
  it('reads a Dataset, with the label defaulting to the value column', () => {
    const ds = make();
    expect(readOptions(ds, 'code', 'name')).toEqual([
      { value: 'A', label: 'Apple' },
      { value: 'B', label: 'Banana' },
      { value: 'C', label: 'Cherry' },
    ]);
    expect(readOptions(ds, 'code')[0]).toEqual({ value: 'A', label: 'A' });
  });

  it('normalises a static list and throws for bad Dataset columns', () => {
    expect(readOptions([{ value: 1, label: 'One' }, { value: null, label: '' }])).toEqual([
      { value: 1, label: 'One' },
      { value: null, label: '' },
    ]);
    expect(() => readOptions(make(), 'nope')).toThrow(/optionValue/);
    expect(() => readOptions(make())).toThrow(/optionValue/);
  });
});

describe('TxRowSelection selected', () => {
  it('sends only the selected rows with ids, in natural order', () => {
    const ds = make();
    const ids = [0, 1, 2].map((i) => ds.rowIdAt(i));
    ds.setRowSelected(ids[2]!, true);
    ds.setRowSelected(ids[0]!, true);
    ds.sort([{ column: 'name', descending: true }]);
    const encoded = encodeInput('d', { dataset: ds, rows: 'selected' });
    expect(encoded.ids).toEqual([ids[0], ids[2]]);
    expect(encoded.rows).toEqual([
      ['A', 'Apple', 1],
      ['C', 'Cherry', 3],
    ]);
    expect(encoded.changes).toBeUndefined();
  });

  it('works through the client, and sends no rows when nothing is selected', async () => {
    const ds = make();
    ds.setRowSelected(ds.rowIdAt(1), true);
    const sent: unknown[] = [];
    const transport: Transport = {
      send: async (request) => {
        sent.push(request.datasets?.['d']);
        return { status: { ok: true } };
      },
    };
    const controller = new AbortController();
    await createTxClient(transport, { signal: controller.signal }).call({
      service: 's.a',
      inputs: { d: { dataset: ds, rows: 'selected' } },
    });
    expect((sent[0] as { rows: unknown[] }).rows).toEqual([['B', 'Banana', 2]]);
    ds.clearSelection();
    expect(encodeInput('d', { dataset: ds, rows: 'selected' }).rows).toEqual([]);
  });
});

describe('formatValue caching', () => {
  it('builds one Intl.NumberFormat per type and pattern', () => {
    const spy = vi.spyOn(Intl, 'NumberFormat');
    try {
      for (let i = 0; i < 50; i++) {
        formatValue(i + 0.5, 'float', '#,##0.000#'); // a pattern no other test uses
      }
      expect(spy.mock.calls.length).toBe(1);
      expect(formatValue(1234.5, 'float', '#,##0.0#')).toBe('1,234.5');
      expect(formatValue(-0.001, 'float', '0.00')).toBe('0.00');
      expect(formatValue(1234, 'int')).toBe('1,234');
    } finally {
      spy.mockRestore();
    }
  });
});
