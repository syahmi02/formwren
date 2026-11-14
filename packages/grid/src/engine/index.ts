import { Virtualizer, elementScroll, observeElementOffset, observeElementRect, type VirtualizerOptions } from '@tanstack/virtual-core';
import { effect } from '@preact/signals-core';
import { formatValue } from '@fw/core';
import type { GridProps, PlacedCell } from '@fw/core';
import type { CellRef, GridLayout, GridOptions, GridSurface } from '../contract.ts';
import { buildModel, footerText, OptionsCache, type FooterCell, type GridModel, type RecordCell } from './model.ts';

const DEFAULT_ROW_HEIGHT = 28;
const MIN_TRACK_WIDTH = 32;
const OVERSCAN = 8;
const SAMPLE_ROWS = 5;
const STATUS_MARK: Record<string, string> = { normal: '', inserted: 'I', updated: 'U', deleted: 'D' };
const SAMPLE_TEXT: Record<string, string> = {
  string: 'Sample',
  int: '123',
  float: '12.5',
  decimal: '1,234.50',
  boolean: 'Yes',
  date: '2000-01-31',
  datetime: '2000-01-31 09:30',
};

let nextGridId = 0;

interface RowEntry {
  index: number;
  rowId: number;
  el: HTMLElement;
  cells: HTMLElement[];
  texts: string[];
  invalid: (string | null)[];
  status: string;
  current: boolean;
  selected: boolean;
  /** Cell currently marked active, if any. */
  activeCell: HTMLElement | null;
}

/** Makes one cell element. Every header, record and footer cell comes from here. */
function makeCell(role: string, part: 'header' | 'record' | 'footer', colIndex: number, frozenTrack: number | null): HTMLElement {
  const el = document.createElement('div');
  el.className = `fw-grid__cell fw-grid__cell--${part}`;
  el.setAttribute('role', role);
  el.setAttribute('aria-colindex', String(colIndex));
  el.dataset.part = part;
  if (frozenTrack !== null) {
    el.dataset.frozen = '';
    el.style.left = `var(--fw-grid-left-${frozenTrack})`;
  }
  return el;
}

function parseLength(text: string): number | null {
  const value = parseFloat(text);
  if (!Number.isFinite(value) || value <= 0) return null;
  return text.trim().endsWith('rem') ? value * 16 : value;
}

export function createSurface(container: HTMLElement, options: GridOptions): GridSurface {
  const dataset = options.dataset;
  const design = options.design === true;
  const gridId = `fwg${++nextGridId}`;
  const report = (error: unknown, where: string): void => {
    if (options.reportError) options.reportError(error, where);
    else console.error(`[grid ${where}]`, error);
  };
  const reported = new Set<string>();
  const reportOnce = (error: unknown, where: string): void => {
    const key = `${where}|${String(error)}`;
    if (reported.has(key)) return;
    reported.add(key);
    report(error, where);
  };

  let model: GridModel = buildModel(options.definition, dataset, reportOnce);
  const optionLabels = new OptionsCache(options, reportOnce);
  const widthOverrides = new Map<string, number>();
  let widths: number[] = [];
  let lefts: number[] = [];
  let rowHeight = DEFAULT_ROW_HEIGHT;
  let destroyed = false;

  // Structure
  const root = document.createElement('div');
  root.className = 'fw-grid';
  root.setAttribute('role', 'grid');
  if (design) root.dataset.design = '';
  else root.tabIndex = 0;
  const scroller = document.createElement('div');
  scroller.className = 'fw-grid__scroller';
  // Browsers can make a scroller a tab stop. The Grid root is the only one.
  scroller.tabIndex = -1;
  const header = document.createElement('div');
  header.className = 'fw-grid__header';
  header.setAttribute('role', 'rowgroup');
  const body = document.createElement('div');
  body.className = 'fw-grid__body';
  body.setAttribute('role', 'rowgroup');
  const overlay = document.createElement('div');
  overlay.className = 'fw-grid__overlay';
  overlay.setAttribute('role', 'presentation');
  body.append(overlay);
  const footer = document.createElement('div');
  footer.className = 'fw-grid__footer';
  footer.setAttribute('role', 'rowgroup');
  scroller.append(header, body, footer);
  root.append(scroller);
  container.append(root);

  const rows = new Map<number, RowEntry>();
  let template: HTMLElement | null = null;
  let active: CellRef | null = null;
  let activeIndex = -1;
  let lastIndexes: number[] | null = null;
  let rendering = false;
  const renderListeners = new Set<() => void>();

  const sampleMode = (): boolean => design && dataset.rowCount === 0;
  const rowCount = (): number => (sampleMode() ? SAMPLE_ROWS : dataset.rowCount);
  const cellId = (rowId: number, track: number): string => `${gridId}-${rowId}-${track}`;

  function readRowHeight(): void {
    const parsed = parseLength(getComputedStyle(root).getPropertyValue('--fw-grid-row-height'));
    rowHeight = parsed ?? DEFAULT_ROW_HEIGHT;
  }

  function computeWidths(): void {
    widths = model.definition.columns.map((track) => widthOverrides.get(track.id) ?? track.width);
    lefts = new Array<number>(widths.length + 1).fill(0);
    for (let i = 0; i < widths.length; i++) lefts[i + 1] = (lefts[i] as number) + (widths[i] as number);
  }

  /** Writes the track sizes as CSS variables, so a resize is a few style writes however many cells there are. */
  function applyTrackVars(): void {
    const style = root.style;
    style.setProperty('--fw-grid-tracks', widths.map((w) => `${w}px`).join(' '));
    style.setProperty('--fw-grid-width', `${lefts[widths.length]}px`);
    for (let i = 0; i < model.frozenCount; i++) style.setProperty(`--fw-grid-left-${i}`, `${lefts[i]}px`);
  }

  const headerHeight = (): number => model.headerRowCount * rowHeight;
  const footerHeight = (): number => model.footerRowCount * rowHeight;

  // Header and footer
  function buildSection(section: HTMLElement, part: 'header' | 'footer', placed: PlacedCell[], rowCountInSection: number): HTMLElement[] {
    section.replaceChildren();
    section.hidden = rowCountInSection === 0;
    section.style.gridTemplateRows = `repeat(${rowCountInSection}, var(--fw-grid-row-height))`;
    const rowElements: HTMLElement[] = [];
    for (let r = 0; r < rowCountInSection; r++) {
      const rowEl = document.createElement('div');
      rowEl.className = `fw-grid__sectionrow`;
      rowEl.setAttribute('role', 'row');
      rowElements.push(rowEl);
      section.append(rowEl);
    }
    const cells: HTMLElement[] = [];
    placed.forEach((p, i) => {
      const frozen = p.column + p.colSpan <= model.frozenCount ? p.column : null;
      const el = makeCell(part === 'header' ? 'columnheader' : 'gridcell', part, p.column + 1, frozen);
      el.style.gridColumn = `${p.column + 1} / span ${p.colSpan}`;
      el.style.gridRow = `${p.row + 1} / span ${p.rowSpan}`;
      if (p.colSpan > 1) el.setAttribute('aria-colspan', String(p.colSpan));
      if (p.rowSpan > 1) el.setAttribute('aria-rowspan', String(p.rowSpan));
      el.dataset.h = String(i);
      el.append(document.createTextNode(''));
      (rowElements[p.row] as HTMLElement).append(el);
      cells.push(el);
    });
    return cells;
  }

  let headerCells: HTMLElement[] = [];
  let footerCells: HTMLElement[] = [];

  function buildHeader(): void {
    headerCells = buildSection(header, 'header', model.headerPlaced, model.headerRowCount);
    header.querySelectorAll('.fw-grid__sectionrow').forEach((rowEl, r) => rowEl.setAttribute('aria-rowindex', String(r + 1)));
    model.headerPlaced.forEach((p, i) => {
      const el = headerCells[i] as HTMLElement;
      (el.firstChild as Text).data = typeof p.cell.text === 'string' ? p.cell.text : '';
      if (!design) {
        const handle = document.createElement('span');
        handle.className = 'fw-grid__resize';
        handle.setAttribute('role', 'separator');
        handle.setAttribute('aria-orientation', 'vertical');
        handle.setAttribute('aria-label', 'Resize column');
        handle.tabIndex = -1;
        const track = p.column + p.colSpan - 1;
        handle.dataset.track = String(track);
        handle.setAttribute('aria-valuenow', String(widths[track]));
        handle.setAttribute('aria-valuemin', String(MIN_TRACK_WIDTH));
        el.append(handle);
      }
    });
    paintSortMarks();
  }

  function buildFooter(): void {
    footerCells = buildSection(footer, 'footer', model.footerPlaced, model.footerRowCount);
    setupFooterEffects();
  }

  // Footers: each expression runs inside an effect, so whatever it reads through the scope (variables,
  // the current row, Dataset versions) reruns it. The effect only stores text. A microtask writes the DOM.
  let footerTexts: string[] = [];
  let footerRan: boolean[] = [];
  let footerDisposers: (() => void)[] = [];
  let footerDomDirty = false;

  function evalFooter(i: number): string {
    const f = model.footer[i] as FooterCell;
    if (!f.expression) return f.text;
    try {
      return footerText(f.expression.evaluate(options.scope), f.format);
    } catch (error) {
      reportOnce(error, 'grid.footer');
      return '';
    }
  }

  function disposeFooterEffects(): void {
    for (const dispose of footerDisposers) dispose();
    footerDisposers = [];
  }

  function setupFooterEffects(): void {
    disposeFooterEffects();
    footerTexts = model.footer.map((f) => f.text);
    footerRan = model.footer.map(() => false);
    model.footer.forEach((f, i) => {
      if (!f.expression) return;
      let first = true;
      footerDisposers.push(
        effect(() => {
          const text = evalFooter(i);
          footerTexts[i] = text;
          if (first) {
            first = false;
            return;
          }
          footerRan[i] = true;
          footerDomDirty = true;
          schedule();
        }),
      );
    });
    writeFooter();
  }

  function writeFooter(): void {
    footerDomDirty = false;
    footerTexts.forEach((text, i) => {
      const node = footerCells[i]?.firstChild as Text | undefined;
      if (node && node.data !== text) node.data = text;
    });
  }

  function paintSortMarks(): void {
    const keys = dataset.sortKeys;
    model.headerPlaced.forEach((p, i) => {
      const el = headerCells[i] as HTMLElement | undefined;
      if (!el) return;
      const field = p.colSpan === 1 ? model.fieldAtTrack[p.column] : null;
      if (!field) {
        el.removeAttribute('aria-sort');
        return;
      }
      const key = keys.find((k) => k.column === field);
      el.setAttribute('aria-sort', key ? (key.descending ? 'descending' : 'ascending') : 'none');
    });
  }

  // Rows
  function buildTemplate(): HTMLElement {
    const rowEl = document.createElement('div');
    rowEl.className = 'fw-grid__row';
    rowEl.setAttribute('role', 'row');
    for (const cell of model.record) {
      const el = makeCell('gridcell', 'record', cell.track + 1, cell.frozen ? cell.track : null);
      if (cell.span > 1) {
        el.style.gridColumn = `${cell.track + 1} / span ${cell.span}`;
        el.setAttribute('aria-colspan', String(cell.span));
      }
      if (cell.align === 'end') el.dataset.align = 'end';
      el.dataset.track = String(cell.track);
      if (cell.kind === 'rowSelect') {
        const box = document.createElement('span');
        box.className = 'fw-grid__check';
        box.setAttribute('role', 'checkbox');
        box.setAttribute('aria-checked', 'false');
        box.setAttribute('aria-label', 'Select row');
        el.append(box);
      } else {
        el.append(document.createTextNode(''));
      }
      rowEl.append(el);
    }
    return rowEl;
  }

  function createRow(index: number): RowEntry {
    const el = (template as HTMLElement).cloneNode(true) as HTMLElement;
    el.style.transform = `translateY(${index * rowHeight}px)`;
    el.setAttribute('aria-rowindex', String(model.headerRowCount + index + 1));
    const cells = Array.from(el.children) as HTMLElement[];
    const entry: RowEntry = {
      index,
      rowId: Number.NaN,
      el,
      cells,
      texts: new Array<string>(cells.length).fill(''),
      invalid: new Array<string | null>(cells.length).fill(null),
      status: '',
      current: false,
      selected: false,
      activeCell: null,
    };
    paintRow(entry);
    return entry;
  }

  function setActiveMark(entry: RowEntry): void {
    let next: HTMLElement | null = null;
    if (active && active.rowId === entry.rowId) {
      const at = model.recordAtTrack[active.track];
      if (at !== undefined && at >= 0) next = entry.cells[at] ?? null;
    }
    if (entry.activeCell === next) return;
    entry.activeCell?.removeAttribute('data-active');
    next?.setAttribute('data-active', '');
    entry.activeCell = next;
  }

  /** Brings a rendered row up to date with the Dataset. Cells whose text hasn't changed aren't touched. */
  function paintRow(entry: RowEntry): void {
    const sample = sampleMode();
    const { el, cells, texts, invalid } = entry;
    let rowId: number;
    if (sample) rowId = -(entry.index + 1);
    else {
      if (entry.index >= dataset.rowCount) return;
      rowId = dataset.rowIdAt(entry.index);
    }
    if (rowId !== entry.rowId) {
      entry.rowId = rowId;
      el.dataset.rowId = String(rowId);
      el.dataset.index = String(entry.index);
      for (let i = 0; i < cells.length; i++) (cells[i] as HTMLElement).id = cellId(rowId, (model.record[i] as RecordCell).track);
    }

    const status = sample ? 'normal' : dataset.statusOf(rowId);
    if (status !== entry.status) {
      entry.status = status;
      el.dataset.status = status;
    }
    const current = !sample && dataset.currentRow === rowId;
    if (current !== entry.current) {
      entry.current = current;
      if (current) el.dataset.current = '';
      else delete el.dataset.current;
    }
    const selected = !sample && dataset.isRowSelected(rowId);
    if (selected !== entry.selected) {
      entry.selected = selected;
      if (selected) {
        el.dataset.selected = '';
        el.setAttribute('aria-selected', 'true');
      } else {
        delete el.dataset.selected;
        el.removeAttribute('aria-selected');
      }
    }

    for (let i = 0; i < cells.length; i++) {
      const m = model.record[i] as RecordCell;
      const cell = cells[i] as HTMLElement;
      if (m.kind === 'rowSelect') {
        const box = cell.firstChild as HTMLElement;
        const value = selected ? 'true' : 'false';
        if (texts[i] !== value) {
          texts[i] = value;
          box.setAttribute('aria-checked', value);
          if (selected) box.dataset.checked = '';
          else delete box.dataset.checked;
        }
        continue;
      }
      let text: string;
      let message: string | null = null;
      if (m.kind === 'rowStatus') {
        if (texts[i] !== status) {
          texts[i] = status;
          cell.dataset.status = status;
          (cell.firstChild as Text).data = STATUS_MARK[status] ?? '';
        }
        continue;
      } else if (m.field === null) {
        text = '';
      } else if (sample) {
        text = SAMPLE_TEXT[m.type] ?? '';
      } else {
        const value = dataset.getValueById(rowId, m.field);
        const label = m.options ? optionLabels.label(m, value) : undefined;
        text = label !== undefined ? label : formatValue(value, m.type, m.format);
        const issue = dataset.issueAt(rowId, m.field);
        if (issue) message = issue.message;
      }
      if (texts[i] !== text) {
        texts[i] = text;
        (cell.firstChild as Text).data = text;
      }
      if (invalid[i] !== message) {
        invalid[i] = message;
        if (message === null) {
          cell.removeAttribute('data-invalid');
          cell.removeAttribute('aria-invalid');
          cell.removeAttribute('title');
        } else {
          cell.setAttribute('data-invalid', '');
          cell.setAttribute('aria-invalid', 'true');
          cell.title = message;
        }
      }
    }
    setActiveMark(entry);
  }

  function makeExtractor(activeAt: number): (range: { startIndex: number; endIndex: number; overscan: number; count: number }) => number[] {
    return (range) => {
      const start = Math.max(range.startIndex - range.overscan, 0);
      const end = Math.min(range.endIndex + range.overscan, range.count - 1);
      const out: number[] = [];
      let placed = activeAt < 0 || activeAt >= range.count || (activeAt >= start && activeAt <= end);
      if (!placed && activeAt < start) {
        out.push(activeAt);
        placed = true;
      }
      for (let i = start; i <= end; i++) out.push(i);
      if (!placed) out.push(activeAt);
      return out;
    };
  }

  let pushOffset: ((offset: number, isScrolling: boolean) => void) | null = null;

  function virtualOptions(): VirtualizerOptions<HTMLElement, HTMLElement> {
    return {
      count: rowCount(),
      getScrollElement: () => scroller,
      estimateSize: () => rowHeight,
      overscan: OVERSCAN,
      scrollMargin: headerHeight(),
      rangeExtractor: makeExtractor(activeIndex),
      observeElementRect,
      scrollToFn: elementScroll,
      observeElementOffset: (instance, cb) => {
        pushOffset = cb;
        return observeElementOffset(instance, cb);
      },
      onChange: () => render(),
    };
  }

  const virtualizer = new Virtualizer<HTMLElement, HTMLElement>(virtualOptions());
  let unmountVirtualizer: (() => void) | null = null;

  function syncCounts(): void {
    const n = rowCount();
    root.setAttribute('aria-rowcount', String(model.headerRowCount + n + model.footerRowCount));
    body.style.height = `${n * rowHeight}px`;
    footer.querySelectorAll('.fw-grid__sectionrow').forEach((rowEl, r) => {
      rowEl.setAttribute('aria-rowindex', String(model.headerRowCount + n + r + 1));
    });
  }

  function refreshVirtualizer(): void {
    virtualizer.setOptions(virtualOptions());
    syncCounts();
    virtualizer._willUpdate();
  }

  function updateActiveIndex(): void {
    activeIndex = active ? (sampleMode() ? -1 : dataset.indexOfRow(active.rowId)) : -1;
  }

  /** Creates and removes row elements to match the virtualizer's range. */
  function render(forceSync = false): void {
    if (rendering || destroyed) return;
    rendering = true;
    try {
      const indexes = virtualizer.getVirtualIndexes();
      if (indexes === lastIndexes && !forceSync) return;
      lastIndexes = indexes;
      const n = rowCount();
      const wanted = new Set<number>();
      for (const i of indexes) if (i < n) wanted.add(i);
      for (const [i, entry] of rows) {
        if (!wanted.has(i)) {
          entry.el.remove();
          rows.delete(i);
        }
      }
      // Insert in index order so the DOM order matches the row order for assistive technology.
      let ref: Node | null = overlay.nextSibling;
      for (const i of indexes) {
        if (i >= n) continue;
        let entry = rows.get(i);
        if (!entry) {
          entry = createRow(i);
          rows.set(i, entry);
        }
        if (entry.el === ref) ref = ref.nextSibling;
        else body.insertBefore(entry.el, ref);
      }
      if (active) {
        const el = elementFor(active);
        if (el) root.setAttribute('aria-activedescendant', el.id);
        else root.removeAttribute('aria-activedescendant');
      }
    } finally {
      rendering = false;
    }
    notifyRender();
  }

  function notifyRender(): void {
    for (const listener of [...renderListeners]) {
      try {
        listener();
      } catch (error) {
        reportOnce(error, 'grid.onRender');
      }
    }
  }

  function elementFor(cell: CellRef): HTMLElement | null {
    const at = model.recordAtTrack[cell.track];
    if (at === undefined || at < 0) return null;
    const index = dataset.indexOfRow(cell.rowId);
    const entry = index >= 0 ? rows.get(index) : undefined;
    return entry && entry.rowId === cell.rowId ? (entry.cells[at] ?? null) : null;
  }

  // Dataset changes, batched into one microtask
  let scheduled = false;
  let allDirty = false;
  let structural = false;
  let footerStale = false;
  let flushing = false;
  const dirtyRows = new Set<number>();

  function schedule(): void {
    if (scheduled || destroyed) return;
    scheduled = true;
    queueMicrotask(flush);
  }

  /** Applies Dataset changes that haven't been delivered yet, so counts and positions are current. */
  function syncPending(): void {
    if (flushing || destroyed) return;
    dataset.flushInvalidate();
    if (scheduled) flush();
  }

  function flush(): void {
    scheduled = false;
    if (destroyed || flushing) return;
    flushing = true;
    const wasStructural = structural;
    const wasAll = allDirty;
    structural = false;
    allDirty = false;
    try {
      if (wasStructural) {
        updateActiveIndex();
        refreshVirtualizer();
        lastIndexes = null;
        paintSortMarks();
      }
      if (wasStructural || wasAll) {
        for (const entry of rows.values()) paintRow(entry);
      } else if (dirtyRows.size > 0) {
        for (const entry of rows.values()) if (dirtyRows.has(entry.rowId)) paintRow(entry);
      }
      dirtyRows.clear();
      if (wasStructural) render(true);
      else notifyRender();
      // An effect that already ran this batch has the new text. Others (a scope without signals) are
      // evaluated here. Any invalidation can be a whole-row change, so none is skipped by column.
      if (footerStale || wasStructural) {
        model.footer.forEach((f, i) => {
          if (f.expression && !footerRan[i]) {
            footerTexts[i] = evalFooter(i);
            footerDomDirty = true;
          }
        });
      }
      footerStale = false;
      footerRan.fill(false);
      if (footerDomDirty) writeFooter();
    } catch (error) {
      reportOnce(error, 'grid.update');
    } finally {
      flushing = false;
    }
  }

  const unsubscribers: (() => void)[] = [];
  unsubscribers.push(
    dataset.onInvalidate((invalidation) => {
      if (invalidation.structural) structural = true;
      else if (invalidation.rows.size === 0) allDirty = true;
      else for (const id of invalidation.rows) dirtyRows.add(id);
      footerStale = true;
      schedule();
    }),
  );
  unsubscribers.push(
    dataset.on('currentRowChanged', (change) => {
      if (change.fromRow !== null) dirtyRows.add(change.fromRow);
      if (change.toRow !== null) dirtyRows.add(change.toRow);
      schedule();
    }),
  );

  // Options Datasets: a code-to-name label changes when its options Dataset does.
  let optionUnsubscribers: (() => void)[] = [];
  function subscribeOptionDatasets(): void {
    for (const unsubscribe of optionUnsubscribers) unsubscribe();
    optionUnsubscribers = [];
    const seen = new Set<unknown>();
    for (const cell of model.record) {
      const source = cell.options?.source;
      if (typeof source !== 'string' || seen.has(source)) continue;
      seen.add(source);
      const target = source === dataset.id ? dataset : options.resolveDataset?.(source);
      if (!target) continue;
      optionUnsubscribers.push(
        target.onInvalidate(() => {
          allDirty = true;
          schedule();
        }),
      );
    }
  }

  // Column resize
  function setTrackWidth(track: number, width: number): void {
    const column = model.definition.columns[track];
    if (!column) return;
    const next = Math.max(MIN_TRACK_WIDTH, Math.round(width));
    if (widths[track] === next) return;
    widthOverrides.set(column.id, next);
    computeWidths();
    applyTrackVars();
    const handle = header.querySelector(`.fw-grid__resize[data-track="${track}"]`);
    handle?.setAttribute('aria-valuenow', String(next));
  }

  let drag: { track: number; startX: number; startWidth: number; pointerId: number } | null = null;
  const handleOf = (target: EventTarget | null): HTMLElement | null =>
    target && typeof (target as Element).closest === 'function' ? ((target as Element).closest('.fw-grid__resize') as HTMLElement | null) : null;

  const onHeaderPointerDown = (event: PointerEvent): void => {
    const handle = handleOf(event.target);
    if (!handle || event.button !== 0) return;
    const track = Number(handle.dataset.track);
    drag = { track, startX: event.clientX, startWidth: widths[track] as number, pointerId: event.pointerId };
    handle.setPointerCapture?.(event.pointerId);
    root.dataset.resizing = '';
    event.preventDefault();
    event.stopPropagation();
  };
  const onHeaderPointerMove = (event: PointerEvent): void => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    setTrackWidth(drag.track, drag.startWidth + event.clientX - drag.startX);
  };
  const onHeaderPointerEnd = (event: PointerEvent): void => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag = null;
    delete root.dataset.resizing;
  };
  // A drag ends over the handle, so the click that follows must not reach the sort handler.
  const swallowHandleEvent = (event: Event): void => {
    if (handleOf(event.target)) event.stopPropagation();
  };
  const onHeaderKeyDown = (event: KeyboardEvent): void => {
    const handle = handleOf(event.target);
    if (!handle || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    const track = Number(handle.dataset.track);
    setTrackWidth(track, (widths[track] as number) + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 40 : 8));
    event.preventDefault();
    event.stopPropagation();
  };
  if (!design) {
    header.addEventListener('pointerdown', onHeaderPointerDown);
    header.addEventListener('pointermove', onHeaderPointerMove);
    header.addEventListener('pointerup', onHeaderPointerEnd);
    header.addEventListener('pointercancel', onHeaderPointerEnd);
    header.addEventListener('click', swallowHandleEvent);
    header.addEventListener('dblclick', swallowHandleEvent);
    header.addEventListener('keydown', onHeaderKeyDown);
  }

  // Applying a definition
  function applyStructure(): void {
    root.setAttribute('aria-colcount', String(model.trackCount));
    if (model.record.some((cell) => cell.kind === 'rowSelect')) root.setAttribute('aria-multiselectable', 'true');
    else root.removeAttribute('aria-multiselectable');
    computeWidths();
    applyTrackVars();
    buildHeader();
    buildFooter();
    template = buildTemplate();
    syncCounts();
    subscribeOptionDatasets();
  }

  const layout: GridLayout = {
    get definition() {
      return model.definition;
    },
    get trackCount() {
      return model.trackCount;
    },
    get frozenCount() {
      return model.frozenCount;
    },
    get recordCells() {
      return model.recordPlaced;
    },
    get headerCells() {
      return model.headerPlaced;
    },
  };

  readRowHeight();
  applyStructure();
  updateActiveIndex();
  virtualizer.setOptions(virtualOptions());
  unmountVirtualizer = virtualizer._didMount();
  virtualizer._willUpdate();
  render(true);

  const surface: GridSurface = {
    root,
    overlay,
    layout,
    cellElement: elementFor,
    cellRect(cell) {
      const at = model.recordAtTrack[cell.track];
      const m = at !== undefined && at >= 0 ? (model.record[at] as RecordCell) : undefined;
      const first = m ? m.track : cell.track;
      const last = m ? m.track + m.span : cell.track + 1;
      syncPending();
      const index = dataset.indexOfRow(cell.rowId);
      // A frozen cell is sticky, so it sits at its offset from the left edge of the view, not of the content.
      const stuck = m?.frozen ? scroller.scrollLeft : 0;
      return {
        left: (lefts[first] ?? 0) + stuck,
        top: Math.max(index, 0) * rowHeight,
        width: (lefts[last] ?? 0) - (lefts[first] ?? 0),
        height: rowHeight,
      };
    },
    locate(target) {
      if (!target || typeof (target as Element).closest !== 'function') return null;
      const el = (target as Element).closest('.fw-grid__cell') as HTMLElement | null;
      if (!el || !root.contains(el)) return null;
      if (el.dataset.part === 'header') {
        const placed = model.headerPlaced[Number(el.dataset.h)];
        return placed ? { header: placed } : null;
      }
      if (el.dataset.part === 'record') {
        const rowEl = el.parentElement;
        if (!rowEl || rowEl.dataset.rowId === undefined) return null;
        return { cell: { rowId: Number(rowEl.dataset.rowId), track: Number(el.dataset.track) } };
      }
      return null;
    },
    scrollToCell(cell) {
      syncPending();
      const index = dataset.indexOfRow(cell.rowId);
      if (index < 0) return;
      const viewH = scroller.clientHeight;
      const viewW = scroller.clientWidth;
      let top = scroller.scrollTop;
      let left = scroller.scrollLeft;
      const rowTop = headerHeight() + index * rowHeight;
      const rowBottom = rowTop + rowHeight;
      if (rowTop < top + headerHeight()) top = rowTop - headerHeight();
      else if (rowBottom > top + viewH - footerHeight()) top = rowBottom - (viewH - footerHeight());
      const at = model.recordAtTrack[cell.track];
      const m = at !== undefined && at >= 0 ? (model.record[at] as RecordCell) : undefined;
      if (m && !m.frozen) {
        const frozenWidth = lefts[model.frozenCount] ?? 0;
        const cellLeft = lefts[m.track] as number;
        const cellRight = lefts[m.track + m.span] as number;
        if (cellLeft < left + frozenWidth) left = cellLeft - frozenWidth;
        else if (cellRight > left + viewW) left = cellRight - viewW;
      }
      top = Math.max(top, 0);
      left = Math.max(left, 0);
      if (top !== scroller.scrollTop) scroller.scrollTop = top;
      if (left !== scroller.scrollLeft) scroller.scrollLeft = left;
      pushOffset?.(scroller.scrollTop, false);
      render();
    },
    pageSize() {
      return Math.max(1, Math.floor((scroller.clientHeight - headerHeight() - footerHeight()) / rowHeight));
    },
    setActiveCell(cell) {
      syncPending();
      const previous = active;
      active = cell ? { rowId: cell.rowId, track: cell.track } : null;
      const before = activeIndex;
      updateActiveIndex();
      if (active === null) root.removeAttribute('aria-activedescendant');
      else root.setAttribute('aria-activedescendant', cellId(active.rowId, active.track));
      if (previous) {
        const old = rows.get(dataset.indexOfRow(previous.rowId));
        if (old) setActiveMark(old);
      }
      if (activeIndex !== before || (active && !elementFor(active))) {
        virtualizer.setOptions(virtualOptions());
        render(true);
      }
      const entry = active ? rows.get(activeIndex) : undefined;
      if (entry) setActiveMark(entry);
    },
    onRender(listener) {
      renderListeners.add(listener);
      return () => renderListeners.delete(listener);
    },
    update(definition: GridProps) {
      if (destroyed) return;
      model = buildModel(definition, dataset, reportOnce);
      optionLabels.clear();
      disposeFooterEffects();
      for (const entry of rows.values()) entry.el.remove();
      rows.clear();
      readRowHeight();
      applyStructure();
      updateActiveIndex();
      refreshVirtualizer();
      lastIndexes = null;
      render(true);
    },
    resizeTrack(track, width) {
      setTrackWidth(track, width);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const unsubscribe of unsubscribers) unsubscribe();
      unsubscribers.length = 0;
      for (const unsubscribe of optionUnsubscribers) unsubscribe();
      optionUnsubscribers = [];
      disposeFooterEffects();
      unmountVirtualizer?.();
      renderListeners.clear();
      rows.clear();
      root.remove();
    },
  };
  return surface;
}
