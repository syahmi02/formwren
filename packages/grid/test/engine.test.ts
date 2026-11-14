// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { signal } from '@preact/signals-core';
import { Dataset } from '@fw/core';
import type { ExpressionScope, GridProps } from '@fw/core';
import { createSurface } from '../src/engine/index.ts';
import type { CellRef, GridOptions, GridSurface } from '../src/contract.ts';

const VIEW_H = 280 + 56 + 28; // Body rows (10), two header rows, one footer row.
const ROW_H = 28;

beforeAll(() => {
  // jsdom has no layout. The scroller reports a fixed size, and nothing else does.
  const size = (el: HTMLElement, h: number, w: number): number => (el.classList.contains('fw-grid__scroller') ? (h > 0 ? VIEW_H : w) : 0);
  for (const [prop, h] of [
    ['offsetHeight', 1],
    ['clientHeight', 1],
    ['offsetWidth', 0],
    ['clientWidth', 0],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get(this: HTMLElement) {
        return h > 0 ? size(this, 1, 0) : this.classList.contains('fw-grid__scroller') ? 500 : 0;
      },
    });
  }
});

const COLUMNS = [
  { id: 'id', type: 'int' as const },
  { id: 'name', type: 'string' as const },
  { id: 'salary', type: 'decimal' as const, scale: 2 },
  { id: 'dept', type: 'string' as const },
];

function makeDataset(n: number): Dataset {
  const ds = new Dataset({ id: 'emp', columns: COLUMNS });
  const rows: unknown[][] = [];
  for (let i = 0; i < n; i++) rows.push([i + 1, `Name ${i + 1}`, `${1000 + i}.50`, i % 2 === 0 ? 'S' : 'F']);
  ds.load(rows);
  return ds;
}

function definition(extra: Partial<GridProps> = {}): GridProps {
  return {
    columns: [
      { id: 'sel', width: 40, frozen: 'left' },
      { id: 'id', width: 60, frozen: 'left' },
      { id: 'name', width: 140 },
      { id: 'salary', width: 100 },
      { id: 'dept', width: 80 },
    ],
    headerRows: [
      { cells: [{ text: '', rowSpan: 2 }, { text: 'Id', rowSpan: 2 }, { text: 'Person', colSpan: 1 }, { text: 'Pay', colSpan: 2 }] },
      { cells: [{ text: 'Name' }, { text: 'Salary' }, { text: 'Dept' }] },
    ],
    recordRows: [
      {
        cells: [
          { kind: 'rowSelect' },
          { field: 'id' },
          { field: 'name' },
          { field: 'salary', format: '#,##0.00' },
          { field: 'dept', options: [{ value: 'S', label: 'Sales' }, { value: 'F', label: 'Finance' }] },
        ],
      },
    ],
    footerRows: [{ cells: [{ text: 'Total', colSpan: 3 }, { value: '=sum(salary)', format: '#,##0.00' }, { value: '=count(id)' }] }],
    ...extra,
  };
}

interface Rig {
  ds: Dataset;
  surface: GridSurface;
  host: HTMLElement;
  scope: ExpressionScope & { aggregate: ReturnType<typeof vi.fn> };
  errors: unknown[];
  scroller: HTMLElement;
}

const rigs: Rig[] = [];

function mount(n = 100, options: Partial<GridOptions> = {}, def: GridProps = definition(), ds: Dataset = makeDataset(n)): Rig {
  const host = document.createElement('div');
  document.body.append(host);
  const errors: unknown[] = [];
  const scope = {
    read: () => undefined,
    aggregate: vi.fn((name: 'sum' | 'avg' | 'min' | 'max' | 'count', path: readonly string[]) => (ds[name] as (c: string) => unknown)(path[path.length - 1] as string)),
  };
  const surface = createSurface(host, {
    dataset: ds,
    definition: def,
    scope,
    writeCell: () => true,
    acceptsCell: () => true,
    reportError: (e) => errors.push(e),
    ...options,
  });
  const scroller = host.querySelector('.fw-grid__scroller') as HTMLElement;
  let top = 0;
  Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => void (top = v) });
  const rig = { ds, surface, host, scope, errors, scroller };
  rigs.push(rig);
  return rig;
}

afterEach(() => {
  for (const rig of rigs.splice(0)) {
    rig.surface.destroy();
    rig.host.remove();
  }
});

const settle = async (rig: Rig): Promise<void> => {
  rig.ds.flushInvalidate();
  await Promise.resolve();
  await Promise.resolve();
};
const rowEls = (host: HTMLElement): HTMLElement[] => Array.from(host.querySelectorAll<HTMLElement>('.fw-grid__row'));
const text = (el: Element | undefined): string | null => el?.textContent ?? null;
const scrollTo = (rig: Rig, top: number): void => {
  rig.scroller.scrollTop = top;
  rig.scroller.dispatchEvent(new Event('scroll'));
};

describe('structure and ARIA', () => {
  it('builds the root, scroller, header, body, overlay and footer', () => {
    const { host, surface, scroller } = mount();
    const root = host.querySelector('.fw-grid') as HTMLElement;
    expect(surface.root).toBe(root);
    expect(root.getAttribute('role')).toBe('grid');
    expect(root.tabIndex).toBe(0);
    expect(root.getAttribute('aria-colcount')).toBe('5');
    expect(root.getAttribute('aria-rowcount')).toBe(String(2 + 100 + 1));
    expect(root.getAttribute('aria-multiselectable')).toBe('true');
    expect(Array.from(root.children)).toEqual([scroller]);
    expect(Array.from(scroller.children).map((c) => c.className)).toEqual(['fw-grid__header', 'fw-grid__body', 'fw-grid__footer']);
    const body = scroller.querySelector('.fw-grid__body') as HTMLElement;
    expect(body.firstElementChild).toBe(surface.overlay);
    expect(surface.overlay.className).toBe('fw-grid__overlay');
    expect(body.style.height).toBe(`${100 * ROW_H}px`);
    for (const part of ['header', 'body', 'footer']) expect(scroller.querySelector(`.fw-grid__${part}`)?.getAttribute('role')).toBe('rowgroup');
  });

  it('gives rows aria-rowindex after the header rows, and cells their column index', () => {
    const { host } = mount();
    const rows = rowEls(host);
    expect(rows[0]?.getAttribute('role')).toBe('row');
    expect(rows[0]?.getAttribute('aria-rowindex')).toBe('3');
    expect(rows[4]?.getAttribute('aria-rowindex')).toBe('7');
    const cells = Array.from((rows[0] as HTMLElement).children);
    expect(cells.map((c) => c.getAttribute('role'))).toEqual(['gridcell', 'gridcell', 'gridcell', 'gridcell', 'gridcell']);
    expect(cells.map((c) => c.getAttribute('aria-colindex'))).toEqual(['1', '2', '3', '4', '5']);
    expect(host.querySelector('.fw-grid__footer .fw-grid__sectionrow')?.getAttribute('aria-rowindex')).toBe('103');
  });

  it('places merged header cells with grid-column and grid-row spans', () => {
    const { host } = mount();
    const cells = Array.from(host.querySelectorAll<HTMLElement>('.fw-grid__header [role="columnheader"]'));
    expect(cells.map((c) => c.textContent)).toEqual(['', 'Id', 'Person', 'Pay', 'Name', 'Salary', 'Dept']);
    const sel = cells[0] as HTMLElement;
    expect(sel.style.gridColumn).toBe('1 / span 1');
    expect(sel.style.gridRow).toBe('1 / span 2');
    expect(sel.getAttribute('aria-rowspan')).toBe('2');
    const pay = cells[3] as HTMLElement;
    expect(pay.style.gridColumn).toBe('4 / span 2');
    expect(pay.getAttribute('aria-colspan')).toBe('2');
    expect(pay.getAttribute('aria-colindex')).toBe('4');
    const name = cells[4] as HTMLElement;
    expect(name.style.gridRow).toBe('2 / span 1');
    expect(name.style.gridColumn).toBe('3 / span 1');
    const rowsInHeader = host.querySelectorAll('.fw-grid__header [role="row"]');
    expect(Array.from(rowsInHeader).map((r) => r.getAttribute('aria-rowindex'))).toEqual(['1', '2']);
    expect((host.querySelector('.fw-grid__header') as HTMLElement).style.gridTemplateRows).toContain('repeat(2');
  });

  it('places the footer cells', () => {
    const { host } = mount();
    const cells = Array.from(host.querySelectorAll<HTMLElement>('.fw-grid__footer .fw-grid__cell'));
    expect(cells.map((c) => c.style.gridColumn)).toEqual(['1 / span 3', '4 / span 1', '5 / span 1']);
  });

  it('derives stable cell ids from row id and track', () => {
    const { host, ds, surface } = mount();
    const cell = surface.cellElement({ rowId: ds.rowIdAt(2), track: 3 }) as HTMLElement;
    expect(cell.id).toMatch(new RegExp(`-${ds.rowIdAt(2)}-3$`));
    expect(surface.locate(cell)).toEqual({ cell: { rowId: ds.rowIdAt(2), track: 3 } });
    const header = host.querySelector('.fw-grid__header [role="columnheader"]') as HTMLElement;
    expect(surface.locate(header.firstChild)).toBeNull();
    expect(surface.locate(header)).toMatchObject({ header: { column: 0, rowSpan: 2 } });
    expect(surface.locate(document.body)).toBeNull();
    expect(surface.locate(null)).toBeNull();
  });
});

describe('virtualization', () => {
  it('renders only the rows in view and a few more, in order', () => {
    const { host } = mount(10_000);
    const indexes = rowEls(host).map((r) => Number(r.dataset.index));
    expect(indexes[0]).toBe(0);
    expect(indexes.length).toBeLessThan(40);
    expect(indexes.length).toBeGreaterThanOrEqual(10);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(rowEls(host)[3]?.style.transform).toBe(`translateY(${3 * ROW_H}px)`);
  });

  it('creates and removes rows as the scroll moves, keeping the DOM in row order', () => {
    const rig = mount(10_000);
    const first = rowEls(rig.host)[0] as HTMLElement;
    scrollTo(rig, 5000 * ROW_H);
    const indexes = rowEls(rig.host).map((r) => Number(r.dataset.index));
    expect(indexes[0]).toBeGreaterThan(4900);
    expect(indexes[0]).toBeLessThan(5000);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(first.isConnected).toBe(false);
    expect(rowEls(rig.host).length).toBeLessThan(40);
    scrollTo(rig, 0);
    expect(Number(rowEls(rig.host)[0]?.dataset.index)).toBe(0);
    expect(rowEls(rig.host).length).toBeLessThan(40);
  });

  it('keeps the active row rendered while scrolled away, and its cell id valid', () => {
    const rig = mount(10_000);
    const cell: CellRef = { rowId: rig.ds.rowIdAt(3), track: 2 };
    rig.surface.setActiveCell(cell);
    scrollTo(rig, 5000 * ROW_H);
    const active = rig.surface.cellElement(cell);
    expect(active).not.toBeNull();
    expect(rig.surface.root.getAttribute('aria-activedescendant')).toBe(active?.id);
    expect(rig.host.querySelectorAll('.fw-grid__row').length).toBeLessThan(45);
    expect(rowEls(rig.host).map((r) => Number(r.dataset.index))).toEqual(rowEls(rig.host).map((r) => Number(r.dataset.index)).sort((a, b) => a - b));
  });

  it('renders the far active row at once, and drops it again when the active cell moves', () => {
    const rig = mount(10_000);
    const far: CellRef = { rowId: rig.ds.rowIdAt(8000), track: 2 };
    rig.surface.setActiveCell(far);
    expect(rig.surface.cellElement(far)).not.toBeNull();
    expect(rig.surface.cellElement(far)?.hasAttribute('data-active')).toBe(true);
    rig.surface.setActiveCell({ rowId: rig.ds.rowIdAt(1), track: 2 });
    expect(rig.surface.cellElement(far)).toBeNull();
  });

  it('answers cellRect for rows that are not rendered', () => {
    const { surface, ds } = mount(10_000);
    const cell = { rowId: ds.rowIdAt(9000), track: 2 };
    expect(surface.cellElement(cell)).toBeNull();
    expect(surface.cellRect(cell)).toEqual({ left: 100, top: 9000 * ROW_H, width: 140, height: ROW_H });
    expect(surface.cellRect({ rowId: ds.rowIdAt(0), track: 0 })).toEqual({ left: 0, top: 0, width: 40, height: ROW_H });
  });

  it('scrolls a cell into view below the header and above the footer', () => {
    const rig = mount(10_000);
    const cell = { rowId: rig.ds.rowIdAt(5000), track: 3 };
    rig.surface.scrollToCell(cell);
    const header = 2 * ROW_H;
    const rowTop = header + 5000 * ROW_H;
    const top = rig.scroller.scrollTop;
    expect(rowTop).toBeGreaterThanOrEqual(top + header);
    expect(rowTop + ROW_H).toBeLessThanOrEqual(top + VIEW_H - ROW_H);
    expect(rig.surface.cellElement(cell)).not.toBeNull();
    expect(rig.surface.pageSize()).toBe(Math.floor((VIEW_H - 2 * ROW_H - ROW_H) / ROW_H));
  });
});

describe('frozen tracks and resize', () => {
  it('marks frozen cells and gives them left offsets from variables', () => {
    const { host, surface } = mount();
    expect(surface.layout.frozenCount).toBe(2);
    const root = host.querySelector('.fw-grid') as HTMLElement;
    expect(root.style.getPropertyValue('--fw-grid-tracks')).toBe('40px 60px 140px 100px 80px');
    expect(root.style.getPropertyValue('--fw-grid-width')).toBe('420px');
    expect(root.style.getPropertyValue('--fw-grid-left-0')).toBe('0px');
    expect(root.style.getPropertyValue('--fw-grid-left-1')).toBe('40px');
    const cells = Array.from((rowEls(host)[0] as HTMLElement).children) as HTMLElement[];
    expect(cells.map((c) => c.hasAttribute('data-frozen'))).toEqual([true, true, false, false, false]);
    expect(cells[1]?.style.left).toBe('var(--fw-grid-left-1)');
    const header = host.querySelector('.fw-grid__header [role="columnheader"]') as HTMLElement;
    expect(header.hasAttribute('data-frozen')).toBe(true);
    expect(header.style.left).toBe('var(--fw-grid-left-0)');
  });

  it('resizes with a few variable writes, never below the minimum, and survives update()', () => {
    const rig = mount();
    const root = rig.surface.root;
    const handles = root.querySelectorAll('.fw-grid__resize');
    expect(handles.length).toBe(7);
    rig.surface.resizeTrack?.(0, 90);
    expect(root.style.getPropertyValue('--fw-grid-tracks')).toBe('90px 60px 140px 100px 80px');
    expect(root.style.getPropertyValue('--fw-grid-left-1')).toBe('90px');
    expect(root.style.getPropertyValue('--fw-grid-width')).toBe('470px');
    rig.surface.resizeTrack?.(2, 3);
    expect(root.style.getPropertyValue('--fw-grid-tracks')).toBe('90px 60px 32px 100px 80px');
    rig.surface.update(definition());
    expect(root.style.getPropertyValue('--fw-grid-tracks')).toBe('90px 60px 32px 100px 80px');
  });

  it('resizes by pointer drag from the handle', () => {
    const rig = mount();
    const handle = rig.host.querySelector('.fw-grid__resize[data-track="2"]') as HTMLElement;
    const fire = (target: Element, type: string, x: number): void => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x });
      Object.defineProperty(event, 'pointerId', { value: 1 });
      target.dispatchEvent(event);
    };
    fire(handle, 'pointerdown', 200);
    expect(rig.surface.root.hasAttribute('data-resizing')).toBe(true);
    fire(handle, 'pointermove', 250);
    expect(rig.surface.root.style.getPropertyValue('--fw-grid-tracks')).toBe('40px 60px 190px 100px 80px');
    fire(handle, 'pointerup', 250);
    expect(rig.surface.root.hasAttribute('data-resizing')).toBe(false);
    fire(handle, 'pointermove', 400);
    expect(rig.surface.root.style.getPropertyValue('--fw-grid-tracks')).toBe('40px 60px 190px 100px 80px');
    // A click ending a drag does not reach a sort handler above the header.
    const clicked = vi.fn();
    rig.surface.root.addEventListener('click', clicked);
    handle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(clicked).not.toHaveBeenCalled();
    // The arrow keys resize a focused handle.
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(rig.surface.root.style.getPropertyValue('--fw-grid-tracks')).toBe('40px 60px 198px 100px 80px');
  });
});

describe('painting', () => {
  it('shows values through formatValue and keeps decimals exact', () => {
    const { host } = mount();
    const cells = Array.from((rowEls(host)[0] as HTMLElement).children);
    expect(text(cells[1])).toBe('1');
    expect(text(cells[2])).toBe('Name 1');
    expect(text(cells[3])).toBe('1,000.50');
    expect(cells[3]?.getAttribute('data-align')).toBe('end');
    expect(text(cells[4])).toBe('Sales');
  });

  it('keeps long decimals exact', () => {
    const ds = new Dataset({ id: 'd', columns: [{ id: 'amount', type: 'decimal', scale: 2 }] });
    ds.load([['12345678901234567890.12']]);
    const def: GridProps = { columns: [{ id: 'amount', width: 200 }], recordRows: [{ cells: [{ field: 'amount', format: '#,##0.00' }] }] };
    const { host } = mount(0, {}, def, ds);
    expect(text(rowEls(host)[0]?.children[0])).toBe('12,345,678,901,234,567,890.12');
  });

  it('shows the row status through data-status and a mark', async () => {
    const def = definition();
    def.recordRows[0]?.cells.splice(0, 1, { kind: 'rowStatus' });
    const rig = mount(10, {}, def);
    const statusCell = (): HTMLElement => rowEls(rig.host)[2]?.children[0] as HTMLElement;
    expect(statusCell().dataset.status).toBe('normal');
    expect(text(statusCell())).toBe('');
    rig.ds.setValue(2, 'name', 'Changed');
    await settle(rig);
    expect(statusCell().dataset.status).toBe('updated');
    expect(text(statusCell())).toBe('U');
    expect(rowEls(rig.host)[2]?.dataset.status).toBe('updated');
    rig.ds.insertRow(0, { id: 99, name: 'New', salary: '1.00', dept: 'S' });
    await settle(rig);
    expect(rowEls(rig.host)[0]?.children[0]?.getAttribute('data-status')).toBe('inserted');
    expect(text(rowEls(rig.host)[0]?.children[0])).toBe('I');
  });

  it('draws the row checkbox from the Dataset selection', async () => {
    const rig = mount(10);
    const box = (i: number): HTMLElement => rowEls(rig.host)[i]?.children[0]?.firstElementChild as HTMLElement;
    expect(box(1).getAttribute('role')).toBe('checkbox');
    expect(box(1).getAttribute('aria-checked')).toBe('false');
    rig.ds.setRowSelected(rig.ds.rowIdAt(1), true);
    await settle(rig);
    expect(box(1).getAttribute('aria-checked')).toBe('true');
    expect(box(1).hasAttribute('data-checked')).toBe(true);
    expect(rowEls(rig.host)[1]?.hasAttribute('data-selected')).toBe(true);
    expect(rowEls(rig.host)[1]?.getAttribute('aria-selected')).toBe('true');
    expect(rowEls(rig.host)[0]?.hasAttribute('data-selected')).toBe(false);
    rig.ds.clearSelection();
    await settle(rig);
    expect(box(1).getAttribute('aria-checked')).toBe('false');
    expect(rowEls(rig.host)[1]?.hasAttribute('data-selected')).toBe(false);
  });

  it('marks invalid cells with data-invalid, aria-invalid and a title, and clears them', async () => {
    const rig = mount(10);
    const cell = (): HTMLElement => rowEls(rig.host)[3]?.children[2] as HTMLElement;
    rig.ds.setIssues([{ rowId: rig.ds.rowIdAt(3), column: 'name', code: 'required', message: 'Name is required' }]);
    await settle(rig);
    expect(cell().hasAttribute('data-invalid')).toBe(true);
    expect(cell().getAttribute('aria-invalid')).toBe('true');
    expect(cell().title).toBe('Name is required');
    expect(rowEls(rig.host)[4]?.children[2]?.hasAttribute('data-invalid')).toBe(false);
    rig.ds.setIssues([]);
    await settle(rig);
    expect(cell().hasAttribute('data-invalid')).toBe(false);
    expect(cell().hasAttribute('aria-invalid')).toBe(false);
    expect(cell().hasAttribute('title')).toBe(false);
  });

  it('marks the current row and the active cell', async () => {
    const rig = mount(10);
    rig.ds.setCurrentIndex(2);
    await settle(rig);
    expect(rowEls(rig.host).map((r) => r.hasAttribute('data-current'))).toEqual([false, false, true, ...new Array(7).fill(false)]);
    rig.ds.setCurrentIndex(4);
    await settle(rig);
    expect(rowEls(rig.host).filter((r) => r.hasAttribute('data-current')).map((r) => r.dataset.index)).toEqual(['4']);
    const cell = { rowId: rig.ds.rowIdAt(4), track: 3 };
    rig.surface.setActiveCell(cell);
    const el = rig.surface.cellElement(cell) as HTMLElement;
    expect(el.hasAttribute('data-active')).toBe(true);
    expect(rig.surface.root.getAttribute('aria-activedescendant')).toBe(el.id);
    expect(rig.host.querySelectorAll('[data-active]').length).toBe(1);
    rig.surface.setActiveCell({ rowId: rig.ds.rowIdAt(5), track: 2 });
    expect(el.hasAttribute('data-active')).toBe(false);
    expect(rig.host.querySelectorAll('[data-active]').length).toBe(1);
    rig.surface.setActiveCell(null);
    expect(rig.host.querySelectorAll('[data-active]').length).toBe(0);
    expect(rig.surface.root.hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('shows aria-sort on sortable header cells from the Dataset sort keys', async () => {
    const rig = mount(10);
    const sorts = (): (string | null)[] => Array.from(rig.host.querySelectorAll('.fw-grid__header [role="columnheader"]')).map((c) => c.getAttribute('aria-sort'));
    // Columns: sel (no field), id, name, salary, dept. Merged cells (Person is 1 wide, Pay 2) take part only if one track wide.
    expect(sorts()).toEqual([null, 'none', 'none', null, 'none', 'none', 'none']);
    rig.ds.sort([{ column: 'name', descending: true }, { column: 'id' }]);
    await settle(rig);
    expect(sorts()).toEqual([null, 'ascending', 'descending', null, 'descending', 'none', 'none']);
  });

  it('repaints rows in place after a sort', async () => {
    const rig = mount(10);
    rig.ds.sort([{ column: 'id', descending: true }]);
    await settle(rig);
    expect(rowEls(rig.host).map((r) => text(r.children[1]))).toEqual(['10', '9', '8', '7', '6', '5', '4', '3', '2', '1']);
    expect(rowEls(rig.host)[0]?.dataset.rowId).toBe(String(rig.ds.rowIdAt(0)));
  });

  it('follows a structural change in the row count', async () => {
    const rig = mount(3);
    expect(rowEls(rig.host).length).toBe(3);
    rig.ds.load(Array.from({ length: 50 }, (_, i) => [i + 1, `N${i}`, '1.00', 'S']));
    await settle(rig);
    expect(rig.surface.root.getAttribute('aria-rowcount')).toBe('53');
    expect((rig.host.querySelector('.fw-grid__body') as HTMLElement).style.height).toBe(`${50 * ROW_H}px`);
    expect(rowEls(rig.host).length).toBeGreaterThan(10);
    rig.ds.load([]);
    await settle(rig);
    expect(rowEls(rig.host).length).toBe(0);
  });

  it('reports a field that is not a column, once', () => {
    const def = definition();
    def.recordRows[0]?.cells.push({ field: 'nope' });
    def.columns.push({ id: 'nope', width: 50 });
    def.headerRows?.[0]?.cells.push({ text: 'x', rowSpan: 2 });
    const rig = mount(2, {}, def);
    expect(rig.errors.map(String).join('|')).toContain('nope');
  });
});

describe('targeted repaint', () => {
  it('touches only the changed row, and not the others, on a cell change', async () => {
    const rig = mount(20);
    const changed: Node[] = [];
    const observer = new MutationObserver((records) => {
      for (const r of records) changed.push(r.target);
    });
    observer.observe(rig.surface.root, { subtree: true, characterData: true, attributes: true, childList: true });
    rig.ds.setValue(5, 'name', 'Edited');
    await settle(rig);
    await new Promise((resolve) => setTimeout(resolve, 0));
    observer.disconnect();
    const rows = rowEls(rig.host);
    const touchedRows = new Set<number>();
    for (const node of changed) {
      const rowEl = (node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest('.fw-grid__row');
      if (rowEl) touchedRows.add(rows.indexOf(rowEl as HTMLElement));
    }
    expect([...touchedRows]).toEqual([5]);
    expect(text(rows[5]?.children[2])).toBe('Edited');
    // Only the name cell's text changes, plus the row status.
    expect(text(rows[4]?.children[2])).toBe('Name 5');
  });

  it('does not repaint rows for a change in another Dataset', async () => {
    const rig = mount(5);
    const other = makeDataset(3);
    const spy = vi.spyOn(rig.ds, 'getValueById');
    other.setValue(0, 'name', 'x');
    other.flushInvalidate();
    await Promise.resolve();
    expect(spy).not.toHaveBeenCalled();
  });

  it('batches many changes into one repaint of each changed row', async () => {
    const rig = mount(10);
    const spy = vi.spyOn(rig.ds, 'getValueById');
    rig.ds.setValue(1, 'name', 'a');
    rig.ds.setValue(1, 'dept', 'F');
    rig.ds.setValue(1, 'name', 'b');
    await settle(rig);
    // One row repainted once: one read per field cell (4), not 3 changes x 4.
    expect(spy.mock.calls.length).toBe(4);
    expect(text(rowEls(rig.host)[1]?.children[2])).toBe('b');
  });
});

describe('footers', () => {
  it('shows exact totals from the scope and formats them', () => {
    const rig = mount(100);
    const cells = Array.from(rig.host.querySelectorAll('.fw-grid__footer .fw-grid__cell'));
    expect(cells.map((c) => c.textContent)).toEqual(['Total', '105,000.00', '100']);
  });

  it('re-evaluates footers once per batch of changes', async () => {
    const rig = mount(100);
    const footer = (): (string | null)[] => Array.from(rig.host.querySelectorAll('.fw-grid__footer .fw-grid__cell')).map((c) => c.textContent);
    rig.scope.aggregate.mockClear();
    rig.ds.setValue(0, 'salary', '2000.50');
    rig.ds.setValue(1, 'salary', '1002.50');
    await settle(rig);
    // Two footer expressions, each evaluated once for the two edits.
    expect(rig.scope.aggregate).toHaveBeenCalledTimes(2);
    expect(footer()[1]).toBe('106,001.00');
    rig.ds.deleteRow(0);
    await settle(rig);
    expect(footer()[2]).toBe('99');
  });

  it('reports a bad footer expression and shows nothing for it', () => {
    const def = definition({ footerRows: [{ cells: [{ text: 'T', colSpan: 4 }, { value: '=sum(' }] }] });
    const rig = mount(3, {}, def);
    expect(rig.errors.length).toBeGreaterThan(0);
  });
});

describe('update, options and design mode', () => {
  it('applies a changed definition without remounting', () => {
    const rig = mount(20);
    const root = rig.surface.root;
    const scroller = rig.scroller;
    const def = definition();
    (def.headerRows?.[1]?.cells[0] as { text: string }).text = 'Full name';
    def.columns[2] = { id: 'name', width: 300 };
    rig.surface.update(def);
    expect(rig.surface.root).toBe(root);
    expect(root.parentElement).toBe(rig.host);
    expect(rig.host.querySelector('.fw-grid__scroller')).toBe(scroller);
    expect(rig.host.querySelector('.fw-grid__header [role="columnheader"]:nth-child(1)')).not.toBeNull();
    expect(Array.from(rig.host.querySelectorAll('.fw-grid__header [role="columnheader"]')).map((c) => c.textContent)).toContain('Full name');
    expect(root.style.getPropertyValue('--fw-grid-tracks')).toBe('40px 60px 300px 100px 80px');
    expect(rig.surface.layout.definition).toBe(def);
    expect(rowEls(rig.host).length).toBeGreaterThan(5);
  });

  it('shows the label for a code from static options and from another Dataset', () => {
    const codes = new Dataset({ id: 'codes', columns: [{ id: 'code', type: 'string' }, { id: 'label', type: 'string' }] });
    codes.load([['S', 'Sales dept'], ['F', 'Finance dept']]);
    const def = definition();
    def.recordRows[0]?.cells.splice(4, 1, { field: 'dept', options: 'codes', optionValue: 'code', optionLabel: 'label' });
    const rig = mount(4, { resolveDataset: (id) => (id === 'codes' ? codes : undefined) }, def);
    expect(rowEls(rig.host).map((r) => text(r.children[4]))).toEqual(['Sales dept', 'Finance dept', 'Sales dept', 'Finance dept']);
  });

  it('draws sample rows in design mode, with no tab stop or resize handles', () => {
    const empty = makeDataset(0);
    const rig = mount(0, { design: true }, definition(), empty);
    expect(rig.surface.root.hasAttribute('tabindex')).toBe(false);
    expect(rig.surface.root.hasAttribute('data-design')).toBe(true);
    expect(rig.host.querySelectorAll('.fw-grid__resize').length).toBe(0);
    expect(rowEls(rig.host).length).toBe(5);
    expect(text(rowEls(rig.host)[0]?.children[2])).toBe('Sample');
    expect(rig.surface.root.getAttribute('aria-rowcount')).toBe('8');
  });

  it('draws the Dataset rows in design mode when it has sample rows', () => {
    const rig = mount(3, { design: true });
    expect(rowEls(rig.host).map((r) => text(r.children[2]))).toEqual(['Name 1', 'Name 2', 'Name 3']);
  });
});

describe('onRender and destroy', () => {
  it('runs render listeners after rows are rendered or repainted, until unsubscribed', async () => {
    const rig = mount(10_000);
    const listener = vi.fn();
    const off = rig.surface.onRender(listener);
    scrollTo(rig, 3000 * ROW_H);
    expect(listener).toHaveBeenCalled();
    listener.mockClear();
    rig.ds.setValue(3000, 'name', 'z');
    await settle(rig);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    listener.mockClear();
    scrollTo(rig, 0);
    expect(listener).not.toHaveBeenCalled();
  });

  it('leaves no Dataset subscriptions, scroll handling or footer work after destroy', async () => {
    const ds = makeDataset(100);
    const invalidate = vi.spyOn(ds, 'onInvalidate');
    const on = vi.spyOn(ds, 'on');
    const rig = mount(100, {}, definition(), ds);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(on).toHaveBeenCalledTimes(1);
    rig.surface.destroy();
    expect(rig.surface.root.isConnected).toBe(false);
    rig.scope.aggregate.mockClear();
    const reads = vi.spyOn(ds, 'getValueById');
    ds.setValue(0, 'salary', '5.00');
    ds.setCurrentIndex(3);
    ds.sort([{ column: 'id', descending: true }]);
    ds.flushInvalidate();
    await Promise.resolve();
    await Promise.resolve();
    expect(rig.scope.aggregate).not.toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
    // A second destroy is harmless.
    expect(() => rig.surface.destroy()).not.toThrow();
  });

  it('really unsubscribes: the Dataset has no listeners of ours left', () => {
    const ds = makeDataset(10);
    const added = new Set<() => void>();
    const realInvalidate = ds.onInvalidate.bind(ds);
    ds.onInvalidate = (listener) => {
      const off = realInvalidate(listener);
      const wrapped = (): void => {
        added.delete(wrapped);
        off();
      };
      added.add(wrapped);
      return wrapped;
    };
    const realOn = ds.on.bind(ds) as (type: string, listener: (event: never) => void) => () => void;
    (ds as unknown as { on: typeof realOn }).on = (type, listener) => {
      const off = realOn(type, listener);
      const wrapped = (): void => {
        added.delete(wrapped);
        off();
      };
      added.add(wrapped);
      return wrapped;
    };
    const rig = mount(10, {}, definition(), ds);
    expect(added.size).toBe(2);
    rig.surface.destroy();
    expect(added.size).toBe(0);
  });
});

describe('review fixes', () => {
  it('1: a frozen cell rect follows scrollLeft, a scrolling cell rect does not', () => {
    const rig = mount(50);
    const horizontal = { value: 0 };
    Object.defineProperty(rig.scroller, 'scrollLeft', { configurable: true, get: () => horizontal.value, set: (v: number) => void (horizontal.value = v) });
    horizontal.value = 400;
    const rowId = rig.ds.rowIdAt(3);
    expect(rig.surface.cellRect({ rowId, track: 1 }).left).toBe(40 + 400);
    expect(rig.surface.cellRect({ rowId, track: 0 }).left).toBe(400);
    expect(rig.surface.cellRect({ rowId, track: 2 }).left).toBe(100);
    horizontal.value = 0;
    expect(rig.surface.cellRect({ rowId, track: 1 }).left).toBe(40);
  });

  it('2: scrollToCell uses the current row count, before the Grid has flushed', () => {
    const rig = mount(100);
    const rowId = rig.ds.addRow({ id: 1000, name: 'New', salary: '1.00', dept: 'S' });
    rig.ds.setCurrentIndex(100);
    const cell = { rowId, track: 2 };
    rig.surface.scrollToCell(cell);
    expect((rig.host.querySelector('.fw-grid__body') as HTMLElement).style.height).toBe(`${101 * ROW_H}px`);
    const rowBottom = 2 * ROW_H + 101 * ROW_H;
    expect(rig.scroller.scrollTop).toBe(rowBottom - (VIEW_H - ROW_H));
    expect(rig.surface.cellElement(cell)).not.toBeNull();
  });

  it('2: a cell far down after a filter is cleared scrolls to its real position', () => {
    const rig = mount(2000);
    rig.ds.setFilter((get) => Number(get('id')) < 10);
    rig.ds.flushInvalidate();
    rig.ds.setFilter(null);
    const cell = { rowId: rig.ds.rowIdAt(1500), track: 2 };
    rig.surface.scrollToCell(cell);
    expect(rig.scroller.scrollTop).toBeGreaterThan(1400 * ROW_H);
    expect(rig.surface.cellElement(cell)).not.toBeNull();
  });

  it('2: scrollToCell keeps the row clear of the sticky header and footer', () => {
    const rig = mount(500);
    const header = 2 * ROW_H;
    for (const index of [0, 1, 7, 250, 251, 499, 3, 0]) {
      rig.surface.scrollToCell({ rowId: rig.ds.rowIdAt(index), track: 2 });
      const top = rig.scroller.scrollTop;
      const rowTop = header + index * ROW_H;
      expect(rowTop).toBeGreaterThanOrEqual(top + header);
      expect(rowTop + ROW_H).toBeLessThanOrEqual(top + VIEW_H - ROW_H);
    }
  });

  it('3: labels follow an options Dataset that loads after the Grid, and it is unsubscribed after', async () => {
    const codes = new Dataset({ id: 'codes', columns: [{ id: 'code', type: 'string' }, { id: 'label', type: 'string' }] });
    const def = definition();
    def.recordRows[0]?.cells.splice(4, 1, { field: 'dept', options: 'codes', optionValue: 'code', optionLabel: 'label' });
    const rig = mount(2, { resolveDataset: (id) => (id === 'codes' ? codes : undefined) }, def);
    expect(rowEls(rig.host).map((r) => text(r.children[4]))).toEqual(['S', 'F']);
    codes.load([['S', 'Sales'], ['F', 'Finance']]);
    await settle({ ...rig, ds: codes });
    expect(rowEls(rig.host).map((r) => text(r.children[4]))).toEqual(['Sales', 'Finance']);
    codes.setValue(0, 'label', 'Sales dept');
    await settle({ ...rig, ds: codes });
    expect(text(rowEls(rig.host)[0]?.children[4])).toBe('Sales dept');
    // A definition without options stops the subscription, and so does destroy.
    const spy = vi.spyOn(rig.ds, 'getValueById');
    rig.surface.update(definition());
    spy.mockClear();
    codes.setValue(0, 'label', 'Changed');
    codes.flushInvalidate();
    await Promise.resolve();
    await Promise.resolve();
    expect(spy).not.toHaveBeenCalled();
    rig.surface.update(def);
    rig.surface.destroy();
    spy.mockClear();
    codes.setValue(0, 'label', 'After destroy');
    codes.flushInvalidate();
    await Promise.resolve();
    await Promise.resolve();
    expect(spy).not.toHaveBeenCalled();
  });

  it('4: a whole-row revert refreshes footers even when issues add other columns', async () => {
    const rig = mount(10);
    const footer = (): string | null => rig.host.querySelectorAll('.fw-grid__footer .fw-grid__cell')[1]?.textContent ?? null;
    const before = footer();
    const rowId = rig.ds.rowIdAt(0);
    rig.ds.setValue(0, 'salary', '9000.00');
    rig.ds.setIssues([{ rowId, column: 'name', code: 'required', message: 'x' }]);
    await settle(rig);
    expect(footer()).not.toBe(before);
    rig.ds.revertRow(rowId);
    await settle(rig);
    expect(footer()).toBe(before);
  });

  it('4: footers rerun through signals when a variable or the current row changes', async () => {
    const ds = makeDataset(5);
    const tag = signal('a');
    const version = signal(0);
    ds.onInvalidate(() => void version.value++);
    ds.on('currentRowChanged', () => void version.value++);
    const read = vi.fn((path: readonly string[]) => {
      if (path[0] === 'vars') return tag.value;
      void version.value;
      const row = ds.currentRow;
      return row === null ? null : ds.getValueById(row, path[2] as string);
    });
    const scope: ExpressionScope = { read, aggregate: (name, path) => (ds[name] as (c: string) => unknown)(path[path.length - 1] as string) };
    const def = definition({ footerRows: [{ cells: [{ value: '=concat("v:", vars.tag)', colSpan: 3 }, { value: '=ds.emp.name' }, { text: '' }] }] });
    const rig = mount(5, { scope }, def, ds);
    const footer = (): (string | null)[] => Array.from(rig.host.querySelectorAll('.fw-grid__footer .fw-grid__cell')).map((c) => c.textContent);
    expect(footer()[0]).toBe('v:a');
    tag.value = 'b';
    await Promise.resolve();
    expect(footer()[0]).toBe('v:b');
    ds.setCurrentIndex(2);
    await Promise.resolve();
    expect(footer()[1]).toBe('Name 3');
    ds.setCurrentIndex(4);
    await Promise.resolve();
    expect(footer()[1]).toBe('Name 5');
    rig.surface.update(def);
    tag.value = 'c';
    await Promise.resolve();
    expect(footer()[0]).toBe('v:c');
    rig.surface.destroy();
    read.mockClear();
    tag.value = 'd';
    ds.setCurrentIndex(0);
    await Promise.resolve();
    expect(read).not.toHaveBeenCalled();
  });

  it('5: the overlay sits above the sticky footer, so an editor message is not hidden by it', () => {
    const css = readFileSync(resolve(process.cwd(), 'packages/components/src/theme/grid.css'), 'utf8');
    const zOf = (selector: string): number => Number(new RegExp(selector + '\\s*\\{[^}]*?z-index:\\s*(\\d+)').exec(css)?.[1]);
    expect(zOf('\\.fw-grid__overlay')).toBeGreaterThan(zOf('\\.fw-grid__header,\\s*\\.fw-grid__footer'));
  });

  it('6: the scroller is not a tab stop', () => {
    const { scroller, surface } = mount();
    expect(scroller.getAttribute('tabindex')).toBe('-1');
    expect(surface.root.getAttribute('tabindex')).toBe('0');
  });
});
