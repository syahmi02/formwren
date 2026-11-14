/** A small stand-in for the engine's GridSurface, used until the real one is wired into these tests. */
import { placeGridCells, type GridProps } from '@fw/core';
import type { CellRef, GridLayout, GridSurface } from '../../src/contract.ts';

export interface FakeSurface extends GridSurface {
  readonly container: HTMLElement;
  active: CellRef | null;
  scrolled: CellRef[];
  pageRows: number;
  /** Row ids the fake treats as scrolled out of view. */
  rect: { left: number; top: number };
  render(): void;
  fireRender(): void;
  listenerCount(): number;
}

export function buildLayout(definition: GridProps): GridLayout {
  const trackCount = definition.columns.length;
  const record = placeGridCells(definition.recordRows, trackCount).cells;
  const header = placeGridCells(definition.headerRows ?? [], trackCount).cells;
  return {
    definition,
    trackCount,
    frozenCount: definition.columns.filter((c) => c.frozen === 'left').length,
    recordCells: record,
    headerCells: header,
  };
}

export function createFakeSurface(definition: GridProps, rowIds: () => number[]): FakeSurface {
  const container = document.createElement('div');
  document.body.append(container);
  const root = document.createElement('div');
  root.setAttribute('role', 'grid');
  root.tabIndex = 0;
  const header = document.createElement('div');
  const body = document.createElement('div');
  const overlay = document.createElement('div');
  root.append(header, body, overlay);
  container.append(root);
  const renderListeners = new Set<() => void>();
  let layout = buildLayout(definition);

  const surface: FakeSurface = {
    container,
    root,
    overlay,
    get layout() {
      return layout;
    },
    active: null,
    scrolled: [],
    pageRows: 5,
    rect: { left: 0, top: 0 },
    cellElement(cell) {
      return body.querySelector<HTMLElement>(`[data-row="${cell.rowId}"] [data-track="${cell.track}"]`);
    },
    cellRect(cell) {
      const index = rowIds().indexOf(cell.rowId);
      if (index < 0) return { left: 0, top: 0, width: 0, height: 0 };
      return { left: cell.track * 100 + surface.rect.left, top: index * 20 + surface.rect.top, width: 100, height: 20 };
    },
    locate(target) {
      const el = target instanceof Element ? target : null;
      const h = el?.closest<HTMLElement>('[data-header]');
      if (h) return { header: layout.headerCells[Number(h.dataset.header)] as never };
      const c = el?.closest<HTMLElement>('[data-track]');
      const r = c?.closest<HTMLElement>('[data-row]');
      if (c && r) return { cell: { rowId: Number(r.dataset.row), track: Number(c.dataset.track) } };
      return null;
    },
    scrollToCell(cell) {
      surface.scrolled.push(cell);
    },
    pageSize() {
      return surface.pageRows;
    },
    setActiveCell(cell) {
      surface.active = cell;
    },
    onRender(listener) {
      renderListeners.add(listener);
      return () => renderListeners.delete(listener);
    },
    update(next) {
      layout = buildLayout(next);
      surface.render();
    },
    destroy() {
      container.remove();
    },
    render() {
      header.replaceChildren();
      layout.headerCells.forEach((h, i) => {
        const el = document.createElement('div');
        el.dataset.header = String(i);
        el.textContent = String(h.cell.text ?? '');
        const handle = document.createElement('span');
        handle.className = 'fw-grid__resize';
        el.append(handle);
        header.append(el);
      });
      body.replaceChildren();
      for (const id of rowIds()) {
        const row = document.createElement('div');
        row.dataset.row = String(id);
        layout.recordCells.forEach((p) => {
          const cell = document.createElement('div');
          cell.dataset.track = String(p.column);
          row.append(cell);
        });
        body.append(row);
      }
    },
    fireRender() {
      for (const l of [...renderListeners]) l();
    },
    listenerCount() {
      return renderListeners.size;
    },
  };
  surface.render();
  return surface;
}
