// @vitest-environment jsdom
// createGrid belongs to another work package and may not be finished, so this file replaces it with a
// small fake that follows packages/grid/src/contract.ts. It checks the React host, not the Grid.
import { createForm, type AnyDataset, type FormDefinition, type FormInstance, type FormMode, type GridProps } from '@fw/core';
import type { GridHandle, GridOptions } from '@fw/grid';
import { act, cleanup, render } from '@testing-library/react';
import { Profiler, StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FormView } from '../src/host/index.tsx';
import { defaultRegistry } from '../src/index.ts';

interface FakeGrid {
  container: HTMLElement;
  options: GridOptions;
  updates: GridProps[];
  focusCalls: unknown[];
  readOnlyCalls: boolean[];
  destroyed: boolean;
  /** Dataset listeners this fake still holds. */
  listeners: number;
}

const created: FakeGrid[] = [];

vi.mock('@fw/grid', () => ({
  createGrid(container: HTMLElement, options: GridOptions): GridHandle {
    const element = document.createElement('div');
    element.className = 'fake-grid';
    container.append(element);
    // Paints straight from the Dataset, the way the real Grid does, with no React.
    const paint = (): void => {
      element.textContent = String(options.dataset.rowCount);
    };
    const stop = options.dataset.onInvalidate(paint);
    paint();
    const fake: FakeGrid = { container, options, updates: [], focusCalls: [], readOnlyCalls: [], destroyed: false, listeners: 1 };
    created.push(fake);
    return {
      update: (next) => void fake.updates.push(next),
      focus: (cell) => void fake.focusCalls.push(cell),
      setReadOnly: (readOnly) => void fake.readOnlyCalls.push(readOnly),
      destroy() {
        fake.destroyed = true;
        element.remove();
        stop();
        fake.listeners--;
      },
    };
  },
}));

afterEach(cleanup);
beforeEach(() => {
  created.length = 0;
});

const columns = [
  { id: 'name', width: 120 },
  { id: 'age', width: 60 },
];
const gridProps = {
  columns,
  headerRows: [{ cells: [{ text: 'Name' }, { text: 'Age' }] }],
  recordRows: [{ cells: [{ field: 'name' }, { field: 'age' }] }],
};

const definition: FormDefinition = {
  formatVersion: 1,
  id: 'f',
  datasets: [
    { id: 'dsA', columns: [{ id: 'name', type: 'string' }, { id: 'age', type: 'int' }], initialRows: [{ name: 'Ann', age: 30 }] },
    { id: 'dsB', columns: [{ id: 'name', type: 'string' }, { id: 'age', type: 'int' }] },
  ],
  components: [
    {
      id: 'g',
      type: 'Grid',
      layout: { left: 0, top: 0, width: 300, height: 200 },
      props: gridProps,
      bind: { dataset: 'dsA' },
      events: { cellChange: 'onCellChange' },
    },
  ],
};

const rethrow = (error: unknown): never => {
  throw error;
};

function open(mode: FormMode = 'run', module?: unknown): FormInstance {
  return createForm(definition, { mode, onError: rethrow, ...(module ? { module: module as never } : {}) });
}

const ds = (form: FormInstance, id: string): AnyDataset => form.getDataset(id)!;
type Focusable = { focus(cell?: unknown): void };

describe('Grid host', () => {
  it('creates the Grid in one host div, wired to the bound Dataset and the model', () => {
    const form = open();
    const { container } = render(<FormView form={form} registry={defaultRegistry} />);
    expect(created).toHaveLength(1);
    const grid = created[0]!;
    expect(grid.container).toBe(container.querySelector('.fw-gridhost'));
    expect(grid.options.dataset).toBe(ds(form, 'dsA'));
    expect(grid.options.definition.columns).toEqual(columns);
    expect(grid.options.design).toBe(false);
    expect(container.querySelector('.fake-grid')?.textContent).toBe('1');
  });

  it('lets the Grid find other Datasets by id, for dropdown options', () => {
    const form = open();
    render(<FormView form={form} registry={defaultRegistry} />);
    expect(created[0]!.options.resolveDataset?.('dsB')).toBe(ds(form, 'dsB'));
    expect(created[0]!.options.resolveDataset?.('nope')).toBeUndefined();
  });

  it('writes and checks cells through the model', () => {
    const form = open();
    render(<FormView form={form} registry={defaultRegistry} />);
    const { writeCell, acceptsCell } = created[0]!.options;
    const dataset = ds(form, 'dsA');
    expect(acceptsCell('age', 'abc')).toBe(false);
    expect(acceptsCell('age', '41')).toBe(true);
    expect(writeCell(dataset.rowIdAt(0), 'age', '41')).toBe(true);
    expect(dataset.getValue(0, 'age')).toBe(41);
  });

  it('does not re-render React when the data changes', () => {
    const form = open();
    let commits = 0;
    const { container } = render(
      <Profiler id="form" onRender={() => commits++}>
        <FormView form={form} registry={defaultRegistry} />
      </Profiler>,
    );
    const before = commits;
    const dataset = ds(form, 'dsA');
    act(() => {
      dataset.addRow({ name: 'Bob', age: 20 });
      dataset.flushInvalidate();
    });
    act(() => {
      dataset.setValue(0, 'name', 'Anna');
      dataset.flushInvalidate();
    });
    act(() => {
      dataset.load([{ name: 'X', age: 1 }, { name: 'Y', age: 2 }, { name: 'Z', age: 3 }]);
      dataset.flushInvalidate();
    });
    expect(container.querySelector('.fake-grid')?.textContent).toBe('3');
    expect(commits).toBe(before);
  });

  it('applies a changed definition with update, without remounting', () => {
    const form = open('design');
    const { container } = render(<FormView form={form} registry={defaultRegistry} />);
    const host = container.querySelector('.fw-gridhost');
    act(() => form.applyPatch('g', { props: { ...gridProps, columns: [{ id: 'name', width: 200 }, { id: 'age', width: 60 }] } }));
    expect(created).toHaveLength(1);
    expect(created[0]!.destroyed).toBe(false);
    expect(created[0]!.updates).toHaveLength(1);
    expect(created[0]!.updates[0]!.columns[0]!.width).toBe(200);
    expect(container.querySelector('.fw-gridhost')).toBe(host);
    expect(created[0]!.options.design).toBe(true);
  });

  it('recreates the Grid when the bound Dataset changes', () => {
    const form = open('design');
    render(<FormView form={form} registry={defaultRegistry} />);
    act(() => form.applyPatch('g', { bind: { dataset: 'dsB' } }));
    expect(created).toHaveLength(2);
    expect(created[0]!.destroyed).toBe(true);
    expect(created[1]!.options.dataset).toBe(ds(form, 'dsB'));
  });

  it('cleans up under StrictMode double effects, and on unmount', () => {
    const form = open();
    const { unmount, container } = render(
      <StrictMode>
        <FormView form={form} registry={defaultRegistry} />
      </StrictMode>,
    );
    const live = created.filter((g) => !g.destroyed);
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(live).toHaveLength(1);
    expect(container.querySelectorAll('.fake-grid')).toHaveLength(1);
    unmount();
    expect(created.every((g) => g.destroyed)).toBe(true);
    expect(created.every((g) => g.listeners === 0)).toBe(true);
  });

  it('forwards form.c.<id>.focus(cell) to the Grid handle, even before the Grid exists', () => {
    const form = open();
    const cell = { rowId: 0, track: 1 };
    // Called before React has committed, so the call is queued until the handle is set.
    (form.context.c.g as Focusable).focus(cell);
    render(<FormView form={form} registry={defaultRegistry} />);
    expect(created[0]!.focusCalls).toEqual([cell]);
    (form.context.c.g as Focusable).focus({ rowId: 0, track: 0 });
    expect(created[0]!.focusCalls).toHaveLength(2);
  });

  it('maps Grid events to form events through the model', async () => {
    const calls: unknown[] = [];
    const form = open('run', { setup: () => ({ onCellChange: (event: unknown) => void calls.push(event) }) });
    await form.init();
    render(<FormView form={form} registry={defaultRegistry} />);
    created[0]!.options.fire?.('cellChange', { rowId: 0, column: 'age', value: 5 });
    expect(calls).toEqual([{ source: 'g', detail: { rowId: 0, column: 'age', value: 5 } }]);
  });
});
