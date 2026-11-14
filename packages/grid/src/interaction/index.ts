import { readOptions, type ChangeResult, type OptionItem, type PlacedCell, type SortKey } from '@fw/core';
import type { CellRef, GridBehavior, GridOptions, GridSurface } from '../contract.ts';
import { buildEditor, caretToEnd, hasBadInput, placeEditor, readText, setBusy, setInvalid, type EditorDom, type EditorKind } from './editor.ts';

type Maybe<T> = T | Promise<T>;

function chain<T, U>(value: Maybe<T>, next: (value: T) => Maybe<U>): Maybe<U> {
  return value instanceof Promise ? value.then(next) : next(value);
}

interface Editor {
  dom: EditorDom;
  rowId: number;
  track: number;
  column: string;
  kind: EditorKind;
  /** The text the editor opened with. Closing with the same text writes nothing. */
  initialText: string;
  /** A commit is under way, so a second one (from a focus change a handler causes) must not start. */
  pending: boolean;
}

interface EditInfo {
  column: string;
  kind: 'text' | 'number' | 'dropdown' | 'date' | 'checkbox';
}

/**
 * Keys, the active cell, editors, selection and sorting. Focus stays on `surface.root`, and an
 * editor is only ever a child of `surface.overlay`. Rows and cells are never created here.
 */
export function attachBehavior(surface: GridSurface, options: GridOptions): GridBehavior {
  const ds = options.dataset;
  const root = surface.root;
  const doc = root.ownerDocument;
  const cleanups: (() => void)[] = [];
  const hosts: HTMLElement[] = root.contains(surface.overlay) ? [root] : [root, surface.overlay];

  let destroyed = false;
  let active: CellRef | null = null;
  /** The active row's view position when last seen, for choosing a neighbour if the row goes. */
  let activeIndex = -1;
  let editor: Editor | null = null;
  /** Row moves waiting on a handler. Keys are ignored meanwhile, so they can't pile up. */
  let moving = 0;
  /** Writes waiting on a handler. */
  let writing = 0;
  let moveToken = 0;
  let readOnly = options.readOnly === true;
  const reported = new Set<string>();
  const reportOnce = (key: string, error: Error, where: string): void => {
    if (reported.has(key)) return;
    reported.add(key);
    report(error, where);
  };

  const report = (error: unknown, where: string): void => options.reportError?.(error, `grid.${where}`);
  const listen = <E extends Event>(target: EventTarget, type: string, handler: (event: E) => void, capture = false): void => {
    target.addEventListener(type, handler as EventListener, capture);
    cleanups.push(() => target.removeEventListener(type, handler as EventListener, capture));
  };

  // Layout

  const layout = () => surface.layout;
  const placedAt = (track: number): PlacedCell | undefined => layout().recordCells.find((p) => p.column <= track && track < p.column + p.colSpan);
  const anchor = (track: number): number => placedAt(track)?.column ?? track;
  const spanEnd = (track: number): number => {
    const placed = placedAt(track);
    return placed ? placed.column + placed.colSpan - 1 : track;
  };
  const lastTrack = (): number => Math.max(layout().trackCount - 1, 0);
  const columnOf = (track: number): string | null => {
    const field = placedAt(track)?.cell.field;
    return typeof field === 'string' && field !== '' ? field : null;
  };
  const kindOf = (track: number): unknown => placedAt(track)?.cell.kind;

  function editInfo(track: number): EditInfo | null {
    const placed = placedAt(track);
    const column = columnOf(track);
    if (!placed || !column || readOnly) return null;
    const cell = placed.cell;
    if (cell.readOnly === true || cell.kind === 'rowSelect' || cell.kind === 'rowStatus') return null;
    if (!cell.editor || !ds.columns.some((c) => c.id === column)) return null;
    return { column, kind: cell.editor };
  }

  function headerLabel(track: number, column: string): string {
    const covering = layout()
      .headerCells.filter((h) => h.column <= track && track < h.column + h.colSpan && typeof h.cell.text === 'string' && h.cell.text !== '')
      .sort((a, b) => b.row - a.row);
    return (covering[0]?.cell.text as string | undefined) ?? ds.columns.find((c) => c.id === column)?.label ?? column;
  }

  function dropdownOptions(track: number): OptionItem[] {
    const cell = placedAt(track)?.cell;
    const source = cell?.options;
    if (!cell || source === undefined || source === null) return [];
    try {
      if (typeof source === 'string') {
        const target = source === ds.id ? ds : options.resolveDataset?.(source);
        if (!target) throw new Error(`Options Dataset "${source}" was not found`);
        return readOptions(target, cell.optionValue as string | undefined, cell.optionLabel as string | undefined);
      }
      if (Array.isArray(source)) return readOptions(source as { value: unknown; label?: unknown }[]);
    } catch (error) {
      report(error, 'options');
    }
    return [];
  }

  // Active cell and movement

  function setActive(cell: CellRef | null, scroll = true): void {
    active = cell;
    activeIndex = cell ? ds.indexOfRow(cell.rowId) : -1;
    surface.setActiveCell(cell);
    if (cell && scroll) surface.scrollToCell(cell);
  }

  /** Makes the row current, then the cell active. False if a handler refused, or something newer won. */
  function moveTo(index: number, track: number): Maybe<boolean> {
    const count = ds.rowCount;
    if (count === 0) return false;
    const row = Math.min(Math.max(index, 0), count - 1);
    const col = anchor(Math.min(Math.max(track, 0), lastTrack()));
    const rowId = ds.rowIdAt(row);
    const token = ++moveToken;
    const finish = (ok: boolean): boolean => {
      if (destroyed || token !== moveToken || !ok || ds.indexOfRow(rowId) === -1) return false;
      setActive({ rowId, track: col });
      return true;
    };
    if (ds.currentRow === rowId) return finish(true);
    let result: ChangeResult;
    try {
      result = ds.setCurrentIndex(row);
    } catch (error) {
      report(error, 'moveTo');
      return false;
    }
    if (typeof result === 'boolean') return finish(result);
    moving++;
    return result
      .then(finish, (error: unknown) => {
        report(error, 'moveTo');
        return false;
      })
      .finally(() => {
        moving--;
      });
  }

  const go = (target: Maybe<unknown>): void => {
    if (target instanceof Promise) target.catch((error: unknown) => report(error, 'move'));
  };

  function position(): { index: number; track: number } | null {
    if (!active) return null;
    const index = ds.indexOfRow(active.rowId);
    return index < 0 ? null : { index, track: active.track };
  }

  /** Where Tab or Shift+Tab goes from a cell, wrapping across rows. Null means leave the Grid. */
  function tabTarget(index: number, track: number, backwards: boolean): { index: number; track: number } | null {
    if (!backwards) {
      const next = spanEnd(track) + 1;
      if (next <= lastTrack()) return { index, track: next };
      return index < ds.rowCount - 1 ? { index: index + 1, track: 0 } : null;
    }
    const before = (placedAt(track)?.column ?? track) - 1;
    if (before >= 0) return { index, track: anchor(before) };
    return index > 0 ? { index: index - 1, track: anchor(lastTrack()) } : null;
  }

  // Editing

  /** A number editor only opens on a character that can start a number. */
  function printableOk(kind: EditInfo['kind'], char: string): boolean {
    return kind !== 'number' || /^[0-9.+-]$/.test(char);
  }

  function openEditor(typed?: string): boolean {
    if (editor || moving || writing || !active || destroyed) return false;
    const info = editInfo(active.track);
    if (!info || info.kind === 'checkbox') return false;
    if (typed !== undefined && !printableOk(info.kind, typed)) return false;
    if (info.kind === 'date' && ds.columns.find((c) => c.id === info.column)?.type !== 'date') {
      reportOnce(`date|${info.column}`, new Error(`Column "${info.column}" is not a date column, so its cell can't use the date editor`), 'editor');
      return false;
    }
    // A cell scrolled out of view must not be edited unseen.
    surface.scrollToCell(active);
    let current: unknown;
    try {
      current = ds.getValueById(active.rowId, info.column);
    } catch {
      return false;
    }
    const text = current === null || current === undefined ? '' : String(current);
    const spec = {
      kind: info.kind,
      label: headerLabel(active.track, info.column),
      text,
      ...(typed !== undefined ? { typed } : {}),
      ...(info.kind === 'dropdown' ? { options: dropdownOptions(active.track) } : {}),
    };
    const dom = buildEditor(doc, spec);
    const created: Editor = { dom, rowId: active.rowId, track: active.track, column: info.column, kind: info.kind, initialText: dom.initial, pending: false };
    dom.control.addEventListener('input', () => setInvalid(dom, null));
    editor = created;
    surface.overlay.append(dom.el);
    reposition();
    dom.control.focus({ preventScroll: true });
    caretToEnd(dom.control);
    return true;
  }

  function reposition(): void {
    if (!editor) return;
    try {
      placeEditor(editor.dom, surface.cellRect({ rowId: editor.rowId, track: editor.track }));
    } catch (error) {
      report(error, 'reposition');
    }
  }

  function closeEditor(refocus: boolean): void {
    const ed = editor;
    if (!ed) return;
    editor = null;
    if (refocus) root.focus({ preventScroll: true });
    ed.dom.el.remove();
  }

  function invalidMessage(column: string): string {
    const type = ds.columns.find((c) => c.id === column)?.type;
    if (type === 'int' || type === 'float' || type === 'decimal') return 'Not a valid number';
    if (type === 'date' || type === 'datetime') return 'Not a valid date';
    return 'This value is not accepted';
  }

  /** Writes a value and fires `cellChange` if it changed. Waits only if a handler does. */
  function write(rowId: number, column: string, value: unknown): Maybe<void> {
    let before: unknown;
    try {
      before = ds.getValueById(rowId, column);
    } catch {
      return;
    }
    const finish = (ok: boolean): void => {
      if (!ok) return;
      try {
        const after = ds.getValueById(rowId, column);
        if (after !== before) options.fire?.('cellChange', { rowId, column, value: after });
      } catch {
        // The row went while the write was waiting.
      }
    };
    let result: ChangeResult;
    try {
      result = options.writeCell(rowId, column, value);
    } catch (error) {
      report(error, 'write');
      return;
    }
    if (typeof result === 'boolean') return finish(result);
    writing++;
    return result
      .then(finish, (error: unknown) => report(error, 'write'))
      .finally(() => {
        writing--;
      });
  }

  /** True once the editor is closed, whether the value was written or refused. False if it stays open. */
  function commitEditor(refocus: boolean): Maybe<boolean> {
    const ed = editor;
    if (!ed) return true;
    if (ed.pending) return false;
    if (hasBadInput(ed.dom)) {
      setInvalid(ed.dom, invalidMessage(ed.column));
      return false;
    }
    const text = readText(ed.dom);
    if (text === ed.initialText) {
      closeEditor(refocus);
      return true;
    }
    let fits = false;
    try {
      fits = options.acceptsCell(ed.column, text);
    } catch (error) {
      report(error, 'accepts');
    }
    if (!fits) {
      setInvalid(ed.dom, invalidMessage(ed.column));
      return false;
    }
    // Set before writing: a handler can move focus right away, and that must not commit again.
    ed.pending = true;
    const written = write(ed.rowId, ed.column, text);
    if (!(written instanceof Promise)) {
      if (editor === ed) closeEditor(refocus);
      return true;
    }
    setBusy(ed.dom, true);
    return written.then(() => {
      if (editor === ed) closeEditor(refocus);
      return true;
    });
  }

  function toggleCheckbox(rowId: number, track: number): void {
    const info = editInfo(track);
    if (!info || info.kind !== 'checkbox' || writing) return;
    let current: unknown;
    try {
      current = ds.getValueById(rowId, info.column);
    } catch {
      return;
    }
    surface.scrollToCell({ rowId, track });
    const next = current !== true;
    if (!options.acceptsCell(info.column, next)) return;
    go(write(rowId, info.column, next));
  }

  function focusInvalidEditor(): void {
    editor?.dom.control.focus({ preventScroll: true });
  }

  // Selection and sorting

  function toggleRow(rowId: number): void {
    try {
      ds.setRowSelected(rowId, !ds.isRowSelected(rowId));
    } catch (error) {
      report(error, 'select');
    }
  }

  function toggleAll(): void {
    const ids: number[] = [];
    let all = true;
    for (let i = 0; i < ds.rowCount; i++) {
      const id = ds.rowIdAt(i);
      ids.push(id);
      if (!ds.isRowSelected(id)) all = false;
    }
    for (const id of ids) ds.setRowSelected(id, !all);
  }

  const hasHeaderSelect = (): boolean => layout().headerCells.some((h) => h.cell.kind === 'rowSelect');

  /** Ascending, then descending, then none. `add` keeps the other sort keys. */
  function sortBy(column: string, add: boolean): void {
    if (writing) return;
    go(
      chain(commitEditor(true), (closed) => {
        if (!closed) {
          focusInvalidEditor();
          return false;
        }
        const keys = ds.sortKeys;
        const existing = keys.find((k) => k.column === column);
        const next: SortKey | null = !existing ? { column } : !existing.descending ? { column, descending: true } : null;
        let list: SortKey[];
        if (add) {
          list = keys.flatMap((k) => (k.column !== column ? [{ ...k }] : next ? [next] : []));
          if (!existing && next) list.push(next);
        } else {
          list = next ? [next] : [];
        }
        try {
          ds.sort(list);
        } catch (error) {
          report(error, 'sort');
        }
        return true;
      }),
    );
  }

  function headerClick(header: PlacedCell, add: boolean): void {
    if (header.cell.kind === 'rowSelect') {
      toggleAll();
      return;
    }
    if (header.colSpan !== 1) return;
    const column = columnOf(header.column);
    if (column) sortBy(column, add);
  }

  // Events

  function editorKey(e: KeyboardEvent, ed: Editor): void {
    if (ed.pending) {
      e.preventDefault();
      return;
    }
    if (e.ctrlKey && e.shiftKey && (e.key === 'S' || e.key === 's')) {
      e.preventDefault();
      sortBy(ed.column, e.altKey);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeEditor(true);
      return;
    }
    if (e.key !== 'Enter' && e.key !== 'Tab') return;
    const backwards = e.shiftKey;
    // Worked out from the editor's row after the commit, since a handler may have re-sorted meanwhile.
    const targetNow = (): { index: number; track: number } | null => {
      const from = ds.indexOfRow(ed.rowId);
      if (from < 0) return null;
      return e.key === 'Enter' ? { index: from + (backwards ? -1 : 1), track: ed.track } : tabTarget(from, ed.track, backwards);
    };
    const committed = commitEditor(true);
    if (committed === true && e.key === 'Tab' && targetNow() === null) return; // Let Tab leave the Grid.
    e.preventDefault();
    go(
      chain(committed, (closed) => {
        if (!closed) {
          focusInvalidEditor();
          return false;
        }
        const target = targetNow();
        if (!target || destroyed) return false;
        return moveTo(target.index, target.track);
      }),
    );
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (destroyed) return;
    const target = e.target as Node | null;
    if (editor && target && editor.dom.el.contains(target)) {
      editorKey(e, editor);
      return;
    }
    if (target !== root) return;
    if (editor) {
      focusInvalidEditor();
      return;
    }
    const key = e.key;
    if (e.ctrlKey && e.shiftKey && (key === 'S' || key === 's')) {
      e.preventDefault();
      const column = active ? columnOf(active.track) : null;
      if (column && !moving) sortBy(column, e.altKey);
      return;
    }
    if (e.ctrlKey && !e.shiftKey && !e.altKey && (key === 'a' || key === 'A') && hasHeaderSelect()) {
      e.preventDefault();
      toggleAll();
      return;
    }
    if (e.metaKey || e.altKey || (e.ctrlKey && key !== 'Home' && key !== 'End')) return;

    const pos = position();
    const count = ds.rowCount;
    const navKeys = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Tab'];
    if (navKeys.includes(key)) {
      if (count === 0) return;
      if (moving || writing) {
        e.preventDefault();
        return;
      }
      if (!pos) {
        e.preventDefault();
        go(moveTo(Math.max(ds.currentIndex, 0), 0));
        return;
      }
      let next: { index: number; track: number } | null;
      switch (key) {
        case 'ArrowDown':
          next = { index: pos.index + 1, track: pos.track };
          break;
        case 'ArrowUp':
          next = { index: pos.index - 1, track: pos.track };
          break;
        case 'ArrowLeft':
          next = { index: pos.index, track: (placedAt(pos.track)?.column ?? pos.track) - 1 };
          break;
        case 'ArrowRight':
          next = { index: pos.index, track: spanEnd(pos.track) + 1 };
          break;
        case 'Home':
          next = e.ctrlKey ? { index: 0, track: 0 } : { index: pos.index, track: 0 };
          break;
        case 'End':
          next = e.ctrlKey ? { index: count - 1, track: lastTrack() } : { index: pos.index, track: lastTrack() };
          break;
        case 'PageUp':
          next = { index: pos.index - Math.max(surface.pageSize(), 1), track: pos.track };
          break;
        case 'PageDown':
          next = { index: pos.index + Math.max(surface.pageSize(), 1), track: pos.track };
          break;
        default:
          next = tabTarget(pos.index, pos.track, e.shiftKey);
          if (!next) return; // At the very end or start: let Tab leave the Grid.
      }
      e.preventDefault();
      go(moveTo(next.index, next.track));
      return;
    }

    if (!pos || !active) return;
    if (key === 'Enter' || key === 'F2') {
      e.preventDefault();
      // Enter on a cell with no editor (or in a read-only Grid) activates the row, as a double-click does. F2 only edits.
      if (key === 'Enter' && !editor && !editInfo(active.track)) options.fire?.('rowActivate', { rowId: active.rowId });
      else openEditor();
      return;
    }
    if (key === ' ') {
      const kind = kindOf(active.track);
      if (kind === 'rowSelect') {
        e.preventDefault();
        surface.scrollToCell(active);
        toggleRow(active.rowId);
        return;
      }
      if (editInfo(active.track)?.kind === 'checkbox') {
        e.preventDefault();
        toggleCheckbox(active.rowId, active.track);
        return;
      }
    }
    if (key.length === 1 && !e.ctrlKey) {
      if (openEditor(key)) e.preventDefault();
    }
  }

  function afterClick(): void {
    if (!editor && doc.activeElement !== root) root.focus({ preventScroll: true });
  }

  function cellClick(cell: CellRef): void {
    const index = ds.indexOfRow(cell.rowId);
    if (index < 0) return;
    if (kindOf(cell.track) === 'rowSelect') toggleRow(cell.rowId);
    go(
      chain(moveTo(index, cell.track), (ok) => {
        if (ok) toggleCheckbox(cell.rowId, cell.track);
        afterClick();
        return ok;
      }),
    );
  }

  function onClick(e: MouseEvent): void {
    if (destroyed) return;
    const target = e.target as Element | null;
    if (editor && target && editor.dom.el.contains(target)) return;
    if (target?.closest?.('.fw-grid__resize')) return;
    if (writing) return;
    const hit = surface.locate(e.target);
    const add = e.shiftKey;
    const handle = (): void => {
      if (!hit) return;
      if ('header' in hit) headerClick(hit.header, add);
      else cellClick(hit.cell);
    };
    if (!editor) {
      handle();
      return;
    }
    go(
      chain(commitEditor(true), (closed) => {
        if (!closed) {
          focusInvalidEditor();
          return false;
        }
        handle();
        return true;
      }),
    );
  }

  function onDoubleClick(e: MouseEvent): void {
    if (destroyed) return;
    const hit = surface.locate(e.target);
    if (!hit || !('cell' in hit)) return;
    const { cell } = hit;
    options.fire?.('rowDoubleClick', { rowId: cell.rowId });
    if (editor || writing) return;
    if (active && active.rowId === cell.rowId && active.track === cell.track) {
      openEditor();
      return;
    }
    const index = ds.indexOfRow(cell.rowId);
    if (index >= 0) go(chain(moveTo(index, cell.track), (ok) => ok && openEditor()));
  }

  function onFocusIn(e: FocusEvent): void {
    if (destroyed || e.target !== root || active || ds.rowCount === 0) return;
    go(moveTo(Math.max(ds.currentIndex, 0), 0));
  }

  function onFocusOut(e: FocusEvent): void {
    const ed = editor;
    if (destroyed || !ed || ed.pending) return;
    if (!(e.target instanceof Node) || !ed.dom.el.contains(e.target)) return;
    const next = e.relatedTarget;
    if (next instanceof Node && ed.dom.el.contains(next)) return;
    const inside = next instanceof Node && (root.contains(next) || surface.overlay.contains(next));
    // Focus going to the root means the pointer went down on another cell. A drag that ends outside
    // the Grid sends no click, so the draft has to commit here or it would be left behind.
    go(
      chain(commitEditor(false), (closed) => {
        if (!closed && inside && editor === ed) focusInvalidEditor();
        return closed;
      }),
    );
  }

  for (const host of hosts) {
    listen<KeyboardEvent>(host, 'keydown', onKeyDown);
    listen<FocusEvent>(host, 'focusout', onFocusOut);
  }
  listen<MouseEvent>(root, 'click', onClick);
  listen<MouseEvent>(root, 'dblclick', onDoubleClick);
  listen<FocusEvent>(root, 'focusin', onFocusIn);
  listen(root, 'scroll', reposition, true);
  cleanups.push(surface.onRender(reposition));

  cleanups.push(
    ds.onInvalidate((invalidation) => {
      if (destroyed || !invalidation.structural) return;
      if (editor && ds.indexOfRow(editor.rowId) < 0) closeEditor(editor.dom.el.contains(doc.activeElement));
      reposition();
      if (!active) return;
      const index = ds.indexOfRow(active.rowId);
      if (index >= 0) {
        const moved = index !== activeIndex;
        activeIndex = index;
        if (moved) surface.scrollToCell(active);
        return;
      }
      if (ds.rowCount === 0) {
        setActive(null);
        return;
      }
      const near = ds.currentRow ?? ds.rowIdAt(Math.min(Math.max(activeIndex, 0), ds.rowCount - 1));
      setActive({ rowId: near, track: active.track });
    }),
  );
  cleanups.push(
    ds.on('currentRowChanged', (change) => {
      if (destroyed || change.toRow === null || ds.indexOfRow(change.toRow) < 0) return;
      if (editor && editor.rowId !== change.toRow && !editor.pending) {
        // A row that has gone from the view takes its draft with it.
        if (ds.indexOfRow(editor.rowId) < 0) closeEditor(editor.dom.el.contains(doc.activeElement));
        else go(commitEditor(true));
      }
      if (!active || active.rowId !== change.toRow) setActive({ rowId: change.toRow, track: active?.track ?? 0 });
    }),
  );

  if (ds.currentRow !== null && ds.indexOfRow(ds.currentRow) >= 0) setActive({ rowId: ds.currentRow, track: 0 }, false);

  return {
    update() {
      if (destroyed) return;
      if (active) {
        // The definition may have merged cells, so the track must be the anchor of its cell.
        const track = layout().trackCount === 0 ? -1 : anchor(Math.min(active.track, lastTrack()));
        if (track < 0) setActive(null, false);
        else if (track !== active.track) setActive({ rowId: active.rowId, track }, false);
      }
      if (editor) {
        const info = editInfo(editor.track);
        if (!info || info.column !== editor.column || info.kind !== editor.kind) closeEditor(editor.dom.el.contains(doc.activeElement));
        else reposition();
      }
    },
    focus(cell) {
      if (destroyed) return;
      const run = (): void => {
        root.focus({ preventScroll: true });
        if (!cell) return;
        const index = ds.indexOfRow(cell.rowId);
        if (index >= 0) go(moveTo(index, cell.track));
      };
      if (!editor) {
        run();
        return;
      }
      go(
        chain(commitEditor(false), (closed) => {
          if (closed) run();
          else focusInvalidEditor();
          return closed;
        }),
      );
    },
    setReadOnly(next) {
      if (destroyed || next === readOnly) return;
      readOnly = next;
      if (readOnly && editor) closeEditor(editor.dom.el.contains(doc.activeElement));
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      moveToken++;
      for (const cleanup of cleanups.splice(0)) cleanup();
      editor?.dom.el.remove();
      editor = null;
    },
  };
}
