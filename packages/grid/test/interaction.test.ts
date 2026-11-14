// @vitest-environment jsdom
// Runs against a fake GridSurface (test/support/fake-surface.ts), not the real engine.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { coerceValue, Dataset, type ColumnDef, type GridProps } from '@fw/core';
import type { GridBehavior, GridOptions } from '../src/contract.ts';
import { attachBehavior } from '../src/interaction/index.ts';
import { createFakeSurface, type FakeSurface } from './support/fake-surface.ts';

const COLUMNS: ColumnDef[] = [
  { id: 'name', type: 'string' },
  { id: 'amount', type: 'decimal', precision: 24, scale: 2 },
  { id: 'active', type: 'boolean' },
  { id: 'kind', type: 'string' },
  { id: 'day', type: 'date' },
  { id: 'note', type: 'string' },
  { id: 'stamp', type: 'datetime' },
];

const DEFINITION: GridProps = {
  columns: Array.from({ length: 7 }, (_, i) => ({ id: `t${i}`, width: 100 })),
  headerRows: [
    {
      cells: [
        { kind: 'rowSelect' },
        { text: 'Name' },
        { text: 'Amount' },
        { text: 'Active' },
        { text: 'Kind' },
        { text: 'Day' },
        { text: 'Note' },
      ],
    },
  ],
  recordRows: [
    {
      cells: [
        { kind: 'rowSelect' },
        { field: 'name', editor: 'text' },
        { field: 'amount', editor: 'number' },
        { field: 'active', editor: 'checkbox' },
        {
          field: 'kind',
          editor: 'dropdown',
          options: [
            { value: 'a', label: 'Apple' },
            { value: 'b', label: 'Banana' },
          ],
        },
        { field: 'day', editor: 'date' },
        { field: 'note', editor: 'text', readOnly: true },
      ],
    },
  ],
};

const NAMES = ['Eve', 'Bob', 'Dan', 'Amy', 'Cat'];
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface Env {
  ds: Dataset;
  surface: FakeSurface;
  behavior: GridBehavior;
  fired: { event: string; detail: unknown }[];
  errors: unknown[];
  writes: { rowId: number; column: string; value: unknown }[];
  /** Replace to make writes refuse or wait. */
  writeImpl: { current: (rowId: number, column: string, value: unknown) => boolean | Promise<boolean> };
  id(index: number): number;
  cell(index: number, track: number): HTMLElement;
}

const envs: Env[] = [];

function setup(extra: Partial<GridOptions> = {}, definition: GridProps = DEFINITION, count = NAMES.length): Env {
  const ds = new Dataset({
    id: 'ds',
    columns: COLUMNS,
    initialRows: NAMES.slice(0, count).map((name, i) => ({ name, amount: `${i}.50`, active: false, kind: 'a', day: '2026-01-01', note: 'n', stamp: '2026-01-01T10:00:00' })),
  });
  const surface = createFakeSurface(definition, () => Array.from({ length: ds.rowCount }, (_, i) => ds.rowIdAt(i)));
  const writes: Env['writes'] = [];
  const writeImpl: Env['writeImpl'] = { current: (rowId, column, value) => ds.setValueById(rowId, column, value as never) };
  const fired: Env['fired'] = [];
  const errors: unknown[] = [];
  const behavior = attachBehavior(surface, {
    dataset: ds,
    definition,
    writeCell: (rowId, column, value) => {
      writes.push({ rowId, column, value });
      return writeImpl.current(rowId, column, value);
    },
    acceptsCell(column, value) {
      try {
        coerceValue(COLUMNS.find((c) => c.id === column) as ColumnDef, value as never);
        return true;
      } catch {
        return false;
      }
    },
    scope: {} as never,
    fire: (event, detail) => fired.push({ event, detail }),
    reportError: (error) => errors.push(error),
    ...extra,
  });
  const env: Env = {
    ds,
    surface,
    behavior,
    fired,
    errors,
    writes,
    writeImpl,
    id: (index) => ds.rowIdAt(index),
    cell: (index, track) => {
      surface.render();
      return surface.cellElement({ rowId: ds.rowIdAt(index), track }) as HTMLElement;
    },
  };
  envs.push(env);
  return env;
}

afterEach(() => {
  for (const env of envs.splice(0)) {
    env.behavior.destroy();
    env.surface.destroy();
  }
});

function press(key: string, init: KeyboardEventInit = {}, target?: Element): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  (target ?? document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

function click(el: Element, init: MouseEventInit = {}): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
}

const editorEl = (env: Env) => env.surface.overlay.querySelector<HTMLElement>('.fw-grid__editor');
const control = (env: Env) => env.surface.overlay.querySelector<HTMLInputElement | HTMLSelectElement>('.fw-grid__editor-control');
const headerEl = (env: Env, i: number) => env.surface.container.querySelector<HTMLElement>(`[data-header="${i}"]`)!;

/** Clicks a cell, so it is active, with focus on the root. */
async function activate(env: Env, index: number, track: number): Promise<void> {
  click(env.cell(index, track));
  await flush();
  expect(env.surface.active).toEqual({ rowId: env.id(index), track });
}

/** Activates a cell, opens its editor and sets the text. */
async function edit(env: Env, index: number, track: number, text: string): Promise<void> {
  await activate(env, index, track);
  press('Enter');
  (control(env) as HTMLInputElement).value = text;
}

describe('active cell and movement', () => {
  it('activates a cell by click, makes its row current, and focuses the root', async () => {
    const env = setup();
    await activate(env, 2, 1);
    expect(env.ds.currentIndex).toBe(2);
    expect(document.activeElement).toBe(env.surface.root);
    expect(env.surface.scrolled.at(-1)).toEqual({ rowId: env.id(2), track: 1 });
  });

  it('activates a merged cell and moves past its span', async () => {
    const merged: GridProps = {
      columns: [{ id: 'a', width: 50 }, { id: 'b', width: 50 }, { id: 'c', width: 50 }],
      recordRows: [{ cells: [{ field: 'name', colSpan: 2 }, { field: 'note' }] }],
    };
    const env = setup({}, merged);
    await activate(env, 0, 0);
    press('ArrowRight');
    await flush();
    expect(env.surface.active?.track).toBe(2);
    press('ArrowLeft');
    await flush();
    expect(env.surface.active?.track).toBe(0);
  });

  it('activates a non-editable cell', async () => {
    const env = setup();
    await activate(env, 1, 6);
  });

  it('moves with arrows, Home, End, Ctrl+Home, Ctrl+End, PageUp and PageDown', async () => {
    const env = setup();
    env.surface.pageRows = 2;
    await activate(env, 1, 2);
    const at = () => [env.ds.indexOfRow(env.surface.active!.rowId), env.surface.active!.track];
    const keyAndCheck = async (key: string, init: KeyboardEventInit, expected: number[]) => {
      const event = press(key, init);
      await flush();
      expect(event.defaultPrevented).toBe(true);
      expect(at(), key).toEqual(expected);
    };
    await keyAndCheck('ArrowDown', {}, [2, 2]);
    await keyAndCheck('ArrowUp', {}, [1, 2]);
    await keyAndCheck('ArrowRight', {}, [1, 3]);
    await keyAndCheck('ArrowLeft', {}, [1, 2]);
    await keyAndCheck('End', {}, [1, 6]);
    await keyAndCheck('Home', {}, [1, 0]);
    await keyAndCheck('PageDown', {}, [3, 0]);
    await keyAndCheck('PageDown', {}, [4, 0]);
    await keyAndCheck('PageUp', {}, [2, 0]);
    await keyAndCheck('End', { ctrlKey: true }, [4, 6]);
    await keyAndCheck('Home', { ctrlKey: true }, [0, 0]);
    await keyAndCheck('ArrowUp', {}, [0, 0]);
    await keyAndCheck('ArrowLeft', {}, [0, 0]);
    expect(env.ds.currentIndex).toBe(0);
  });

  it('wraps Tab across rows and lets Tab leave at the very end and start', async () => {
    const env = setup();
    await activate(env, 0, 6);
    let event = press('Tab');
    await flush();
    expect(event.defaultPrevented).toBe(true);
    expect(env.surface.active).toEqual({ rowId: env.id(1), track: 0 });
    press('Tab', { shiftKey: true });
    await flush();
    expect(env.surface.active).toEqual({ rowId: env.id(0), track: 6 });

    await activate(env, 4, 6);
    event = press('Tab');
    expect(event.defaultPrevented).toBe(false);
    expect(env.surface.active).toEqual({ rowId: env.id(4), track: 6 });

    await activate(env, 0, 0);
    event = press('Tab', { shiftKey: true });
    expect(event.defaultPrevented).toBe(false);
  });

  it('keeps the active cell when a handler refuses the row move', async () => {
    const env = setup();
    await activate(env, 0, 1);
    env.ds.on('currentRowChanging', (e) => e.preventDefault());
    press('ArrowDown');
    await flush();
    expect(env.surface.active).toEqual({ rowId: env.id(0), track: 1 });
    expect(env.ds.currentIndex).toBe(0);
  });

  it('ignores keys while a row move waits on a handler, then makes one move', async () => {
    const env = setup();
    await activate(env, 0, 1);
    let release!: () => void;
    env.ds.on('currentRowChanging', (e) => e.waitUntil(new Promise<void>((r) => (release = r))));
    press('ArrowDown');
    const second = press('ArrowDown');
    press('ArrowRight');
    expect(second.defaultPrevented).toBe(true);
    expect(env.surface.active).toEqual({ rowId: env.id(0), track: 1 });
    release();
    await flush();
    expect(env.surface.active).toEqual({ rowId: env.id(1), track: 1 });
    expect(env.ds.currentIndex).toBe(1);
  });

  it('follows its row through a sort and a filter', async () => {
    const env = setup();
    await activate(env, 0, 1); // Eve
    env.ds.sort([{ column: 'name' }]);
    await flush();
    expect(env.ds.getValueById(env.surface.active!.rowId, 'name')).toBe('Eve');
    expect(env.ds.indexOfRow(env.surface.active!.rowId)).toBe(4);
    const scrolls = env.surface.scrolled.length;
    env.ds.setFilter((get) => get('name') !== 'Bob');
    await flush();
    expect(env.ds.getValueById(env.surface.active!.rowId, 'name')).toBe('Eve');
    expect(env.surface.scrolled.length).toBeGreaterThan(scrolls);
  });

  it('moves to a neighbour when the active row is filtered out, and clears when no rows are left', async () => {
    const env = setup();
    await activate(env, 2, 1); // Dan
    env.ds.setFilter((get) => get('name') !== 'Dan');
    await flush();
    expect(['Bob', 'Amy']).toContain(env.ds.getValueById(env.surface.active!.rowId, 'name'));
    expect(env.surface.active?.track).toBe(1);
    env.ds.setFilter(() => false);
    await flush();
    expect(env.surface.active).toBeNull();
  });

  it('focus(cell) focuses the root and moves to the cell', async () => {
    const env = setup();
    env.behavior.focus({ rowId: env.id(3), track: 2 });
    await flush();
    expect(document.activeElement).toBe(env.surface.root);
    expect(env.surface.active).toEqual({ rowId: env.id(3), track: 2 });
    env.behavior.focus();
    expect(document.activeElement).toBe(env.surface.root);
  });

  it('activates the first row when the root gets focus with no active cell', async () => {
    const env = setup();
    env.ds.setCurrentIndex(-1);
    env.surface.root.focus();
    await flush();
    expect(env.surface.active).toEqual({ rowId: env.id(0), track: 0 });
  });
});

describe('opening editors', () => {
  it('opens with a typed character, in the overlay, with an accessible name', async () => {
    const env = setup();
    await activate(env, 1, 1);
    const event = press('x');
    expect(event.defaultPrevented).toBe(true);
    const input = control(env) as HTMLInputElement;
    expect(input.value).toBe('x');
    expect(input.getAttribute('aria-label')).toBe('Name');
    expect(document.activeElement).toBe(input);
    expect(editorEl(env)?.parentElement).toBe(env.surface.overlay);
    expect(env.cell(1, 1).contains(editorEl(env))).toBe(false);
    expect(editorEl(env)?.style.left).toBe('100px');
    expect(editorEl(env)?.style.top).toBe('20px');
  });

  it('opens with the current value on Enter and F2, and on double-click', async () => {
    const env = setup();
    await activate(env, 1, 1);
    press('Enter');
    expect((control(env) as HTMLInputElement).value).toBe('Bob');
    press('Escape');
    expect(editorEl(env)).toBeNull();
    press('F2');
    expect((control(env) as HTMLInputElement).value).toBe('Bob');
    press('Escape');
    env.cell(2, 1).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await flush();
    expect(env.surface.active).toEqual({ rowId: env.id(2), track: 1 });
    expect((control(env) as HTMLInputElement).value).toBe('Dan');
  });

  it('does not open on a single click of the active cell', async () => {
    const env = setup();
    await activate(env, 1, 1);
    click(env.cell(1, 1));
    await flush();
    expect(editorEl(env)).toBeNull();
  });

  it('does not open for a read-only cell, a cell with no editor, or a read-only grid', async () => {
    const env = setup();
    await activate(env, 1, 6);
    press('Enter');
    press('x');
    expect(editorEl(env)).toBeNull();
    await activate(env, 1, 0);
    press('Enter');
    expect(editorEl(env)).toBeNull();

    const readOnly = setup({ readOnly: true });
    await activate(readOnly, 1, 1);
    press('Enter');
    expect(editorEl(readOnly)).toBeNull();
  });

  it('builds number, dropdown and date editors', async () => {
    const env = setup();
    await activate(env, 1, 2);
    press('Enter');
    let input = control(env) as HTMLInputElement;
    expect(input.type).toBe('text');
    expect(input.getAttribute('inputmode')).toBe('decimal');
    expect(input.value).toBe('1.50');
    press('Escape');
    press('x'); // can't start a number
    expect(editorEl(env)).toBeNull();
    press('7');
    expect((control(env) as HTMLInputElement).value).toBe('7');
    press('Escape');

    await activate(env, 1, 4);
    press('Enter');
    const select = control(env) as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(select.value).toBe('a');
    expect([...select.options].map((o) => o.textContent)).toEqual(['', 'Apple', 'Banana']);
    press('Escape');
    press('b'); // type-ahead
    expect((control(env) as HTMLSelectElement).value).toBe('b');
    press('Escape');

    await activate(env, 1, 5);
    press('Enter');
    input = control(env) as HTMLInputElement;
    expect(input.type).toBe('date');
    expect(input.value).toBe('2026-01-01');
  });

  it('reads dropdown options from another Dataset', async () => {
    const lookup = new Dataset({
      id: 'kinds',
      columns: [{ id: 'code', type: 'string' }, { id: 'title', type: 'string' }],
      initialRows: [{ code: 'x', title: 'Ex' }, { code: 'y', title: 'Why' }],
    });
    const definition: GridProps = {
      columns: [{ id: 'a', width: 50 }],
      recordRows: [{ cells: [{ field: 'kind', editor: 'dropdown', options: 'kinds', optionValue: 'code', optionLabel: 'title' }] }],
    };
    const env = setup({ resolveDataset: (id) => (id === 'kinds' ? lookup : undefined) }, definition);
    await activate(env, 0, 0);
    press('Enter');
    // The stored value 'a' isn't among the options, so it is kept as an extra entry rather than lost.
    expect([...(control(env) as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(['', 'Ex', 'Why', 'a']);
  });
});

describe('committing and cancelling', () => {
  it('Enter commits and moves down, Shift+Enter moves up', async () => {
    const env = setup();
    await edit(env, 1, 1, 'Zed');
    press('Enter');
    await flush();
    expect(env.ds.getValueById(env.id(1), 'name')).toBe('Zed');
    expect(editorEl(env)).toBeNull();
    expect(env.surface.active).toEqual({ rowId: env.id(2), track: 1 });
    expect(document.activeElement).toBe(env.surface.root);
    expect(env.fired).toEqual([{ event: 'cellChange', detail: { rowId: env.id(1), column: 'name', value: 'Zed' } }]);

    press('Enter');
    (control(env) as HTMLInputElement).value = 'Yan';
    press('Enter', { shiftKey: true });
    await flush();
    expect(env.surface.active).toEqual({ rowId: env.id(1), track: 1 });
    expect(env.ds.getValueById(env.id(2), 'name')).toBe('Yan');
  });

  it('Tab commits and moves right, Shift+Tab moves left, and wraps to the next row', async () => {
    const env = setup();
    await edit(env, 1, 1, 'Zed');
    const event = press('Tab');
    await flush();
    expect(event.defaultPrevented).toBe(true);
    expect(env.surface.active).toEqual({ rowId: env.id(1), track: 2 });
    expect(env.ds.getValueById(env.id(1), 'name')).toBe('Zed');
    press('Enter');
    press('Tab', { shiftKey: true });
    await flush();
    expect(env.surface.active).toEqual({ rowId: env.id(1), track: 1 });

    await activate(env, 0, 5);
    press('Enter');
    press('Tab'); // to the read-only last cell, which has no editor
    await flush();
    expect(env.surface.active).toEqual({ rowId: env.id(0), track: 6 });
    press('Enter'); // nothing opens
    press('Tab');
    await flush();
    expect(env.surface.active).toEqual({ rowId: env.id(1), track: 0 });
  });

  it('lets Tab leave the Grid from an editor on the last cell, after committing', async () => {
    const definition: GridProps = { columns: [{ id: 'a', width: 50 }], recordRows: [{ cells: [{ field: 'name', editor: 'text' }] }] };
    const env = setup({}, definition, 1);
    await edit(env, 0, 0, 'Last');
    const event = press('Tab');
    expect(event.defaultPrevented).toBe(false);
    expect(env.ds.getValueById(env.id(0), 'name')).toBe('Last');
    expect(editorEl(env)).toBeNull();
    expect(document.activeElement).toBe(env.surface.root);
  });

  it('Escape cancels and refocuses the root', async () => {
    const env = setup();
    await edit(env, 1, 1, 'Zed');
    const event = press('Escape');
    expect(event.defaultPrevented).toBe(true);
    expect(editorEl(env)).toBeNull();
    expect(document.activeElement).toBe(env.surface.root);
    expect(env.ds.getValueById(env.id(1), 'name')).toBe('Bob');
    expect(env.writes).toEqual([]);
  });

  it('writes nothing for unchanged text, and fires no cellChange for an equal value', async () => {
    const env = setup();
    await activate(env, 1, 1);
    press('Enter');
    press('Enter');
    await flush();
    expect(env.writes).toEqual([]);
    await edit(env, 1, 2, '1.5'); // 1.50 is stored: the same number
    press('Enter');
    await flush();
    expect(env.writes.length).toBe(1);
    expect(env.fired).toEqual([]);
  });

  it('commits when another cell is clicked', async () => {
    const env = setup();
    await edit(env, 1, 1, 'Zed');
    click(env.cell(3, 1));
    await flush();
    expect(env.ds.getValueById(env.id(1), 'name')).toBe('Zed');
    expect(env.surface.active).toEqual({ rowId: env.id(3), track: 1 });
    expect(editorEl(env)).toBeNull();
  });

  it('commits when focus leaves the Grid, without taking focus back', async () => {
    const env = setup();
    const outside = document.createElement('button');
    document.body.append(outside);
    await edit(env, 1, 1, 'Zed');
    outside.focus();
    await flush();
    expect(env.ds.getValueById(env.id(1), 'name')).toBe('Zed');
    expect(editorEl(env)).toBeNull();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('keeps the editor open and marked invalid when the text does not fit', async () => {
    const env = setup();
    await edit(env, 1, 2, 'abc');
    press('Enter');
    await flush();
    const input = control(env) as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(editorEl(env)?.dataset.invalid).toBe('true');
    const message = env.surface.overlay.querySelector<HTMLElement>('.fw-grid__editor-message');
    expect(message?.hidden).toBe(false);
    expect(message?.textContent).toBe('Not a valid number');
    expect(input.getAttribute('aria-describedby')).toBe(message?.id);
    expect(env.writes).toEqual([]);
    expect(env.surface.active).toEqual({ rowId: env.id(1), track: 2 });
    // A click elsewhere can't leave it behind either.
    click(env.cell(3, 1));
    await flush();
    expect(control(env)).not.toBeNull();
    expect(env.surface.active).toEqual({ rowId: env.id(1), track: 2 });
    // Editing clears the marker, and a valid value goes through.
    input.value = '9.99';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(editorEl(env)?.dataset.invalid).toBeUndefined();
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    press('Enter');
    await flush();
    expect(env.ds.getValueById(env.id(1), 'amount')).toBe('9.99');
  });

  it('keeps decimals exact, as text', async () => {
    const env = setup();
    await edit(env, 1, 2, '12345678901234567.89');
    press('Enter');
    await flush();
    expect(env.writes.at(-1)?.value).toBe('12345678901234567.89');
    expect(env.ds.getValueById(env.id(1), 'amount')).toBe('12345678901234567.89');
    expect(env.fired.at(-1)?.detail).toMatchObject({ value: '12345678901234567.89' });
  });

  it('closes and shows the stored value when a write is refused (sync)', async () => {
    const env = setup();
    env.writeImpl.current = () => false;
    await edit(env, 1, 1, 'Zed');
    press('Enter');
    await flush();
    expect(editorEl(env)).toBeNull();
    expect(env.ds.getValueById(env.id(1), 'name')).toBe('Bob');
    expect(env.fired).toEqual([]);
    expect(env.surface.active).toEqual({ rowId: env.id(2), track: 1 });
  });

  it('closes when an async write is refused, and holds the place meanwhile', async () => {
    const env = setup();
    let settle!: (ok: boolean) => void;
    env.writeImpl.current = () => new Promise<boolean>((r) => (settle = r));
    const bob = env.id(1);
    await edit(env, 1, 1, 'Zed');
    press('Enter');
    await Promise.resolve();
    expect(editorEl(env)?.getAttribute('aria-busy')).toBe('true');
    expect((control(env) as HTMLInputElement).readOnly).toBe(true);
    const down = press('ArrowDown');
    press('Enter');
    press('Escape');
    expect(down.defaultPrevented).toBe(true);
    expect(editorEl(env)).not.toBeNull();
    expect(env.surface.active).toEqual({ rowId: env.id(1), track: 1 });
    // The editor stays over its own row while pending, even after a sort moves it.
    env.ds.sort([{ column: 'name' }]);
    await Promise.resolve();
    env.surface.fireRender();
    expect(editorEl(env)?.style.top).toBe(`${env.ds.indexOfRow(bob) * 20}px`);
    settle(false);
    await flush();
    expect(editorEl(env)).toBeNull();
    expect(env.ds.getValueById(bob, 'name')).toBe('Bob');
    expect(env.fired).toEqual([]);
    // It moves down from its own row in the re-sorted view, not from where the row used to be.
    expect(env.surface.active?.rowId).toBe(env.ds.rowIdAt(env.ds.indexOfRow(bob) + 1));
  });

  it('moves on after an async write that succeeds, firing cellChange once', async () => {
    const env = setup();
    env.writeImpl.current = async (rowId, column, value) => env.ds.setValueById(rowId, column, value as never);
    await edit(env, 1, 1, 'Zed');
    press('Enter');
    await flush();
    expect(env.fired.length).toBe(1);
    expect(env.surface.active).toEqual({ rowId: env.id(2), track: 1 });
    expect(editorEl(env)).toBeNull();
  });

  it('reports a write that throws, and closes', async () => {
    const env = setup();
    env.writeImpl.current = () => {
      throw new RangeError('stale');
    };
    await edit(env, 1, 1, 'Zed');
    press('Enter');
    await flush();
    expect(env.errors.length).toBe(1);
    expect(editorEl(env)).toBeNull();
  });
});

describe('the editor and its row', () => {
  it('follows its row when the view is sorted, on render and on scroll', async () => {
    const env = setup();
    await activate(env, 0, 1); // Eve
    press('Enter');
    expect(editorEl(env)?.style.top).toBe('0px');
    env.ds.sort([{ column: 'name' }]); // Eve goes last
    await flush();
    expect(editorEl(env)?.style.top).toBe('80px');

    env.surface.rect.top = -500; // scrolled far out of view
    env.surface.fireRender();
    expect(editorEl(env)?.style.top).toBe('-420px');
    env.surface.rect.top = 7;
    env.surface.root.dispatchEvent(new Event('scroll'));
    expect(editorEl(env)?.style.top).toBe('87px');
    const inner = document.createElement('div');
    env.surface.root.append(inner);
    env.surface.rect.top = 9;
    inner.dispatchEvent(new Event('scroll')); // doesn't bubble: caught in the capture phase
    expect(editorEl(env)?.style.top).toBe('89px');
  });

  it('discards the draft when its row disappears', async () => {
    const env = setup();
    await edit(env, 1, 1, 'Zed');
    env.ds.setFilter((get) => get('name') !== 'Bob');
    await flush();
    expect(editorEl(env)).toBeNull();
    expect(env.writes).toEqual([]);
    expect(document.activeElement).toBe(env.surface.root);
  });

  it('commits an open editor before sorting from the header', async () => {
    const env = setup();
    const bob = env.id(1);
    await edit(env, 1, 1, 'Zed');
    click(headerEl(env, 1));
    await flush();
    expect(env.ds.getValueById(bob, 'name')).toBe('Zed');
    expect(env.ds.sortKeys).toEqual([{ column: 'name' }]);
  });

  it('does not sort while the open editor is invalid', async () => {
    const env = setup();
    await edit(env, 1, 2, 'abc');
    click(headerEl(env, 1));
    await flush();
    expect(env.ds.sortKeys).toEqual([]);
    expect(control(env)).not.toBeNull();
  });

  it('commits first when the current row changes under an open editor', async () => {
    const env = setup();
    await edit(env, 1, 1, 'Zed');
    env.ds.setCurrentIndex(3);
    await flush();
    expect(env.ds.getValueById(env.id(1), 'name')).toBe('Zed');
    expect(env.surface.active?.rowId).toBe(env.id(3));
  });
});

describe('checkbox, selection and sorting', () => {
  it('toggles a checkbox cell on Space and on click, writing at once', async () => {
    const env = setup();
    await activate(env, 1, 2);
    press('ArrowRight');
    await flush();
    press(' ');
    await flush();
    expect(env.ds.getValueById(env.id(1), 'active')).toBe(true);
    expect(env.writes.at(-1)?.value).toBe(true);
    expect(editorEl(env)).toBeNull();
    click(env.cell(2, 3)); // activates and toggles
    await flush();
    expect(env.ds.getValueById(env.id(2), 'active')).toBe(true);
    click(env.cell(2, 3));
    await flush();
    expect(env.ds.getValueById(env.id(2), 'active')).toBe(false);
    expect(env.fired.length).toBe(3);
    press('Enter');
    expect(editorEl(env)).toBeNull();
  });

  it('toggles row selection on click and Space, and the header selects all or none', async () => {
    const env = setup();
    click(env.cell(1, 0));
    await flush();
    expect(env.ds.isRowSelected(env.id(1))).toBe(true);
    expect(env.ds.currentIndex).toBe(1);
    press(' ');
    expect(env.ds.isRowSelected(env.id(1))).toBe(false);
    const header = headerEl(env, 0);
    click(header);
    expect(env.ds.selectedRows().length).toBe(5);
    click(header);
    expect(env.ds.selectedRows().length).toBe(0);
    env.ds.setFilter((get) => get('name') !== 'Bob');
    click(header);
    expect(env.ds.selectedRows().length).toBe(4);
  });

  it('clicking a row makes it current without selecting it', async () => {
    const env = setup();
    await activate(env, 3, 1);
    expect(env.ds.currentIndex).toBe(3);
    expect(env.ds.selectedRows().length).toBe(0);
  });

  it('cycles a header click through ascending, descending and none', () => {
    const env = setup();
    const header = headerEl(env, 1);
    click(header);
    expect(env.ds.sortKeys).toEqual([{ column: 'name' }]);
    click(header);
    expect(env.ds.sortKeys).toEqual([{ column: 'name', descending: true }]);
    click(header);
    expect(env.ds.sortKeys).toEqual([]);
  });

  it('adds a key on Shift-click and replaces keys on a plain click', () => {
    const env = setup();
    click(headerEl(env, 1));
    click(headerEl(env, 2), { shiftKey: true });
    expect(env.ds.sortKeys).toEqual([{ column: 'name' }, { column: 'amount' }]);
    click(headerEl(env, 1), { shiftKey: true });
    expect(env.ds.sortKeys).toEqual([{ column: 'name', descending: true }, { column: 'amount' }]);
    click(headerEl(env, 1), { shiftKey: true });
    expect(env.ds.sortKeys).toEqual([{ column: 'amount' }]);
    click(headerEl(env, 1));
    expect(env.ds.sortKeys).toEqual([{ column: 'name' }]);
  });

  it('does not sort on a resize handle or on the rowSelect header', () => {
    const env = setup();
    click(headerEl(env, 1).querySelector('.fw-grid__resize')!);
    click(headerEl(env, 0));
    expect(env.ds.sortKeys).toEqual([]);
  });

  it('sorts by the active cell on Ctrl+Shift+S, cycling the same way, and adds with Alt', async () => {
    const env = setup();
    await activate(env, 0, 2);
    const event = press('S', { ctrlKey: true, shiftKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(env.ds.sortKeys).toEqual([{ column: 'amount' }]);
    press('S', { ctrlKey: true, shiftKey: true });
    expect(env.ds.sortKeys).toEqual([{ column: 'amount', descending: true }]);
    press('S', { ctrlKey: true, shiftKey: true });
    expect(env.ds.sortKeys).toEqual([]);
    press('S', { ctrlKey: true, shiftKey: true });
    await activate(env, 0, 1);
    press('S', { ctrlKey: true, shiftKey: true, altKey: true });
    expect(env.ds.sortKeys).toEqual([{ column: 'amount' }, { column: 'name' }]);
  });
});

describe('destroy and update', () => {
  it('leaves no listeners behind', async () => {
    const live = new Map<string, number>();
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    const key = (target: EventTarget, type: string, capture: unknown) => `${(target as { tagName?: string }).tagName ?? 'x'}|${type}|${capture ? 1 : 0}`;
    const seen = new WeakMap<EventTarget, number>();
    let nextId = 0;
    const idOf = (t: EventTarget) => {
      if (!seen.has(t)) seen.set(t, nextId++);
      return seen.get(t);
    };
    vi.spyOn(EventTarget.prototype, 'addEventListener').mockImplementation(function (this: EventTarget, type: string, listener: unknown, opts?: unknown) {
      const k = `${idOf(this)}|${key(this, type, typeof opts === 'object' ? (opts as { capture?: boolean }).capture : opts)}`;
      live.set(k, (live.get(k) ?? 0) + 1);
      return (add as (...a: unknown[]) => void).call(this, type, listener, opts);
    } as never);
    vi.spyOn(EventTarget.prototype, 'removeEventListener').mockImplementation(function (this: EventTarget, type: string, listener: unknown, opts?: unknown) {
      const k = `${idOf(this)}|${key(this, type, typeof opts === 'object' ? (opts as { capture?: boolean }).capture : opts)}`;
      live.set(k, (live.get(k) ?? 0) - 1);
      return (remove as (...a: unknown[]) => void).call(this, type, listener, opts);
    } as never);
    try {
      const env = setup();
      await activate(env, 1, 1);
      press('Enter');
      env.behavior.destroy();
      expect(editorEl(env)).toBeNull();
      expect(env.surface.listenerCount()).toBe(0);
      // Listeners on the editor go with its element. Everything on the root must be balanced.
      const rootId = String(idOf(env.surface.root));
      const leftover = [...live].filter(([k, n]) => k.startsWith(`${rootId}|`) && n > 0);
      expect(leftover).toEqual([]);
      const scrolls = env.surface.scrolled.length;
      press('ArrowDown', {}, env.surface.root);
      click(env.cell(2, 1));
      env.ds.sort([{ column: 'name' }]);
      await flush();
      expect(env.surface.scrolled.length).toBe(scrolls);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('closes an editor whose column is no longer editable after update', async () => {
    const env = setup();
    await activate(env, 1, 1);
    press('Enter');
    const next: GridProps = { ...DEFINITION, recordRows: [{ cells: DEFINITION.recordRows[0]!.cells.map((c, i) => (i === 1 ? { field: 'name' } : c)) }] };
    env.surface.update(next);
    env.behavior.update();
    expect(editorEl(env)).toBeNull();
  });
});

describe('regressions from the browser review', () => {
  const single = (cell: Record<string, unknown>): GridProps => ({ columns: [{ id: 'a', width: 50 }], recordRows: [{ cells: [cell as never] }] });

  it('writes nothing back when the text is unchanged but the browser cleaned it up', async () => {
    const env = setup({}, single({ field: 'name', editor: 'text' }), 2);
    env.ds.setValueById(env.id(0), 'name', 'a\nb');
    await activate(env, 0, 0);
    press('F2');
    press('Enter');
    await flush();
    expect(env.writes).toEqual([]);
    expect(env.ds.getValueById(env.id(0), 'name')).toBe('a\nb');
    expect(env.fired).toEqual([]);
  });

  it('refuses a date editor on a column that is not a date, and reports once', async () => {
    const env = setup({}, single({ field: 'stamp', editor: 'date' }), 2);
    await activate(env, 0, 0);
    press('F2');
    press('F2');
    expect(editorEl(env)).toBeNull();
    expect(env.errors.length).toBe(1);
    expect(env.writes).toEqual([]);
  });

  it('keeps a half-cleared date open and invalid instead of saving null (badInput is stubbed: jsdom never sets it)', async () => {
    const env = setup();
    await activate(env, 1, 5);
    press('Enter');
    const input = control(env) as HTMLInputElement;
    input.value = '';
    Object.defineProperty(input, 'validity', { value: { badInput: true } });
    press('Enter');
    await flush();
    expect(editorEl(env)?.dataset.invalid).toBe('true');
    expect(env.writes).toEqual([]);
    expect(env.ds.getValueById(env.id(1), 'day')).toBe('2026-01-01');
  });

  it('commits when focus goes from the editor to the root (a drag that ends outside sends no click)', async () => {
    const env = setup();
    await edit(env, 1, 1, 'Zed');
    env.surface.root.focus();
    await flush();
    expect(env.ds.getValueById(env.id(1), 'name')).toBe('Zed');
    expect(editorEl(env)).toBeNull();
    expect(document.activeElement).toBe(env.surface.root);
  });

  it('scrolls the active cell into view before opening an editor or toggling', async () => {
    const env = setup();
    await activate(env, 1, 1);
    env.surface.scrolled.length = 0;
    press('x');
    expect(env.surface.scrolled.length).toBeGreaterThan(0);
    press('Escape');
    await activate(env, 1, 2);
    press('ArrowRight');
    await flush();
    env.surface.scrolled.length = 0;
    press(' ');
    await flush();
    expect(env.surface.scrolled.length).toBeGreaterThan(0);
    await activate(env, 2, 0);
    env.surface.scrolled.length = 0;
    press(' ');
    expect(env.surface.scrolled.length).toBeGreaterThan(0);
  });

  it('keeps focus on the root when the current row moves under an open editor', async () => {
    const env = setup();
    await edit(env, 1, 1, 'Zed');
    env.ds.setCurrentIndex(3);
    await flush();
    expect(env.ds.getValueById(env.id(1), 'name')).toBe('Zed');
    expect(document.activeElement).toBe(env.surface.root);
  });

  it('runs a cellChanging handler once when it moves focus and then waits', async () => {
    const env = setup();
    const outside = document.createElement('button');
    document.body.append(outside);
    let calls = 0;
    let release!: () => void;
    env.ds.on('cellChanging', (e) => {
      calls++;
      outside.focus();
      e.waitUntil(new Promise<void>((r) => (release = r)));
    });
    await edit(env, 1, 1, 'Zed');
    press('Enter');
    await flush();
    expect(calls).toBe(1);
    release();
    await flush();
    expect(calls).toBe(1);
    expect(env.ds.getValueById(env.id(1), 'name')).toBe('Zed');
    outside.remove();
  });

  it('fires rowDoubleClick with the row id, and still opens an editable cell', async () => {
    const env = setup();
    env.cell(2, 6).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await flush();
    expect(env.fired).toEqual([{ event: 'rowDoubleClick', detail: { rowId: env.id(2) } }]);
    expect(editorEl(env)).toBeNull();
    env.cell(3, 1).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await flush();
    expect(env.fired.at(-1)).toEqual({ event: 'rowDoubleClick', detail: { rowId: env.id(3) } });
    expect(editorEl(env)).not.toBeNull();
  });

  it('fires rowActivate on Enter for a cell with no editor or in a read-only Grid, and Enter still edits an editable cell', async () => {
    const env = setup();
    await activate(env, 2, 6); // a cell marked readOnly
    press('Enter');
    await flush();
    expect(env.fired).toEqual([{ event: 'rowActivate', detail: { rowId: env.id(2) } }]);
    expect(editorEl(env)).toBeNull();
    await activate(env, 3, 1); // an editable cell
    press('Enter');
    await flush();
    expect(editorEl(env)).not.toBeNull();
    expect(env.fired).toHaveLength(1);

    const readOnly = setup({ readOnly: true });
    await activate(readOnly, 1, 1);
    press('Enter');
    await flush();
    expect(readOnly.fired).toEqual([{ event: 'rowActivate', detail: { rowId: readOnly.id(1) } }]);
    expect(editorEl(readOnly)).toBeNull();
  });

  it('re-anchors the active cell when update merges cells', async () => {
    const plain: GridProps = { columns: [{ id: 'a', width: 50 }, { id: 'b', width: 50 }], recordRows: [{ cells: [{ field: 'name' }, { field: 'note' }] }] };
    const env = setup({}, plain);
    await activate(env, 0, 1);
    env.surface.update({ ...plain, recordRows: [{ cells: [{ field: 'name', colSpan: 2 }] }] });
    env.behavior.update();
    expect(env.surface.active).toEqual({ rowId: env.id(0), track: 0 });
  });

  it('setReadOnly cancels an open draft and blocks editing until unlocked', async () => {
    const env = setup();
    await edit(env, 1, 1, 'Zed');
    env.behavior.setReadOnly(true);
    expect(editorEl(env)).toBeNull();
    expect(document.activeElement).toBe(env.surface.root);
    expect(env.writes).toEqual([]);
    press('Enter');
    expect(editorEl(env)).toBeNull();
    env.behavior.setReadOnly(false);
    press('Enter');
    expect(editorEl(env)).not.toBeNull();
  });
});
