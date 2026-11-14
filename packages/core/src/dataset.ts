import { decDiv, decCompare, decFits, DecimalSum } from './decimal.ts';
import { ChangingEvent, Emitter, type ChangeResult } from './events.ts';
import { coerceValue, compareValues, valuesEqual, type CellValue, type ColumnDef } from './values.ts';

export type RowStatus = 'normal' | 'inserted' | 'updated' | 'deleted';

const NORMAL = 0;
const INSERTED = 1;
const UPDATED = 2;
const DELETED = 3;
/** An inserted row that was deleted again. The server never knew about it, so it isn't sent. */
const REMOVED = 4;

/** Cached totals of one column over the visible rows. A missing field is not computed yet. */
interface ColumnAggregates {
  count?: number;
  /** Exact running total of a decimal column. */
  decimalSum?: DecimalSum;
  /** Total of an int column. Float sums are never cached across edits, because float addition is order dependent. */
  numberSum?: number;
  min?: { value: CellValue };
  max?: { value: CellValue };
}

const STATUS_NAMES: readonly RowStatus[] = ['normal', 'inserted', 'updated', 'deleted', 'deleted'];

export interface DatasetOptions {
  id: string;
  columns: readonly ColumnDef[];
  keys?: readonly string[];
  /** Warn before a form closes if this Dataset has unsaved changes. */
  confirmUnsaved?: boolean;
  initialRows?: readonly RowInput[];
}

/** A row by column name, or by position in column order. */
export type RowInput = Readonly<Record<string, unknown>> | readonly unknown[];

export interface SortKey {
  column: string;
  descending?: boolean;
}

/** Reads a column of the row being tested by a filter. */
export type RowGetter = (column: string) => CellValue;

export interface CellChange {
  rowId: number;
  column: string;
  oldValue: CellValue;
  newValue: CellValue;
}

export interface CurrentRowChange {
  fromRow: number | null;
  toRow: number | null;
}

export interface DatasetEvents {
  cellChanging: ChangingEvent<CellChange>;
  cellChanged: CellChange;
  currentRowChanging: ChangingEvent<CurrentRowChange>;
  currentRowChanged: CurrentRowChange;
}

/**
 * Sent once per burst of changes, so a view repaints once however many cells changed.
 * A row in `rows` with an empty `columns` set means the whole row.
 */
export interface Invalidation {
  rows: ReadonlySet<number>;
  columns: ReadonlySet<string>;
  /** Rows were added, removed or reordered, so positions may have changed. */
  structural: boolean;
}

export interface RowChange {
  status: 'I' | 'U' | 'D';
  rowId: number;
  /** All column values, in column order. A deleted row sends the values it was loaded with. */
  values: CellValue[];
  /** For updated rows: the original value of each changed column, by column position. */
  originals?: Record<number, CellValue>;
}

/** What was sent in one save. Pass it to `acceptSave` when the server confirms the save. */
export interface SaveTicket {
  readonly generation: number;
  readonly changes: readonly RowChange[];
}

/** Codes the Dataset itself produces. Servers may send other codes, so `ValidationIssue.code` is a string. */
export type ValidationCode = 'required' | 'length' | 'range' | 'pattern' | 'precision' | 'custom';

export interface ValidationIssue {
  rowId: number;
  column: string;
  /** Usually a `ValidationCode`, but a server may send its own. */
  code: ValidationCode | (string & {});
  message: string;
}

/** Returns an error message, or nothing if the value is valid. */
export type Validator = (value: CellValue, get: RowGetter) => string | null | undefined;

function compareBound(column: ColumnDef, value: CellValue, bound: number | string): number {
  if (column.type === 'decimal') return decCompare(value as string, String(bound));
  if (typeof value === 'number') return value - Number(bound);
  return String(value) < String(bound) ? -1 : String(value) > String(bound) ? 1 : 0;
}

/**
 * Rows of typed values held in memory, tracking every change since they were loaded.
 *
 * Row ids are stable: they never change when rows are sorted, filtered, added or removed.
 * "Index" always means a position in the current view, which is the rows left after filtering,
 * in sort order. Deleted rows have no index, so anything that must reach them takes a row id.
 *
 * `C` maps column names to value types. Generated form types fill it in, so scripts get checked names.
 */
export class Dataset<C extends Record<string, unknown> = Record<string, CellValue>> {
  readonly id: string;
  readonly columns: readonly ColumnDef[];
  readonly keys: readonly string[];
  readonly confirmUnsaved: boolean;

  /** Goes up on every change. */
  version = 0;
  /** Goes up on a load that replaces the rows and on any revert, which put back values a view may hold. */
  revision = 0;

  readonly #events = new Emitter<DatasetEvents>();
  readonly #columnIndex = new Map<string, number>();
  readonly #patterns: (RegExp | null)[];
  readonly #validators = new Map<number, Validator>();
  /** Cached aggregates by column position. Cleared whenever the visible set may have changed. */
  #aggregates: (ColumnAggregates | undefined)[] = [];
  /** Issues shown on cells, keyed by slot * columns + column. */
  #issues = new Map<number, ValidationIssue>();
  /** Selected row slots. Selection is view state, so it never touches status. */
  #selected = new Set<number>();

  /** One array per column, indexed by row id. */
  #data: CellValue[][];
  #status: number[] = [];
  /** Row values as loaded. Copied on a row's first edit, so unedited rows cost nothing. */
  #originals = new Map<number, CellValue[]>();
  /** All rows in their natural order, including deleted ones so an undo restores their position. */
  #base: number[] = [];
  /** Row ids of the visible rows, in display order. */
  #view: Int32Array = new Int32Array(0);
  #viewPositions: Int32Array | null = null;

  #sortKeys: readonly SortKey[] = [];
  #filter: ((get: RowGetter) => boolean) | null = null;

  /**
   * Internally rows are slots that restart at 0 on a replacing load, which keeps storage compact.
   * The public row id is `#idBase + slot`, and `#idBase` only grows, so an id is never reused.
   */
  #idBase = 0;
  #currentRow: number | null = null;
  #currentIndex = -1;
  /** True after the current row was set to none on purpose, so a sort or filter doesn't pick one. */
  #noCurrent = false;
  /** Latest write per cell, so a later edit supersedes an earlier one still waiting on a handler. */
  readonly #cellToken = new Map<number, number>();
  #tokenCounter = 0;
  #deferred = 0;
  #settleWaiters: (() => void)[] = [];
  /** Lets a newer current-row request override one still waiting on a dialog. */
  #currentRequest = 0;
  /** Goes up on a full reload, so anything still holding old row ids can tell they're stale. */
  #generation = 0;

  readonly #invalidateListeners = new Set<(invalidation: Invalidation) => void>();
  #pendingRows = new Set<number>();
  #pendingColumns = new Set<string>();
  #pendingStructural = false;
  #flushQueued = false;

  constructor(options: DatasetOptions) {
    this.id = options.id;
    this.columns = options.columns.map((column) => ({ ...column }));
    this.keys = [...(options.keys ?? [])];
    this.confirmUnsaved = options.confirmUnsaved ?? false;
    this.columns.forEach((column, index) => {
      if (this.#columnIndex.has(column.id)) {
        throw new Error(`Dataset "${this.id}" has two columns named "${column.id}"`);
      }
      this.#columnIndex.set(column.id, index);
    });
    for (const key of this.keys) this.#col(key);
    this.#patterns = this.columns.map((column) => (column.pattern ? new RegExp(column.pattern, 'u') : null));
    this.#data = this.columns.map(() => []);
    if (options.initialRows) this.load(options.initialRows);
  }

  // Events

  on<K extends keyof DatasetEvents>(type: K, listener: (event: DatasetEvents[K]) => void): () => void {
    return this.#events.on(type, listener);
  }

  onInvalidate(listener: (invalidation: Invalidation) => void): () => void {
    this.#invalidateListeners.add(listener);
    return () => this.#invalidateListeners.delete(listener);
  }

  /** Delivers any queued invalidation now, instead of at the end of the current task. */
  flushInvalidate(): void {
    this.#flushQueued = false;
    if (this.#pendingRows.size === 0 && this.#pendingColumns.size === 0 && !this.#pendingStructural) return;
    const invalidation: Invalidation = {
      rows: this.#pendingRows,
      columns: this.#pendingColumns,
      structural: this.#pendingStructural,
    };
    this.#pendingRows = new Set();
    this.#pendingColumns = new Set();
    this.#pendingStructural = false;
    for (const listener of [...this.#invalidateListeners]) listener(invalidation);
  }

  #touch(structural: boolean, rowId?: number, column?: string): void {
    this.version++;
    if (this.#invalidateListeners.size === 0) return;
    if (structural) this.#pendingStructural = true;
    if (rowId !== undefined) this.#pendingRows.add(this.#idBase + rowId);
    if (column !== undefined) this.#pendingColumns.add(column);
    if (!this.#flushQueued) {
      this.#flushQueued = true;
      queueMicrotask(() => {
        if (this.#flushQueued) this.flushInvalidate();
      });
    }
  }

  // Reading

  get rowCount(): number {
    return this.#view.length;
  }

  get currentRow(): number | null {
    return this.#currentRow === null ? null : this.#idBase + this.#currentRow;
  }

  get currentIndex(): number {
    return this.#currentIndex;
  }

  #checkedIndex(index: number): number {
    if (!Number.isInteger(index) || index < 0 || index >= this.#view.length) {
      throw new RangeError(`Dataset "${this.id}" has no row at index ${index} (it has ${this.#view.length})`);
    }
    return index;
  }

  rowIdAt(index: number): number {
    this.#checkedIndex(index);
    return this.#idBase + (this.#view[index] as number);
  }

  /** The row's position in the current view, or -1 if it isn't visible or the id is stale. */
  indexOfRow(rowId: number): number {
    const slot = rowId - this.#idBase;
    return Number.isInteger(slot) ? this.#indexOfSlot(slot) : -1;
  }

  #indexOfSlot(rowId: number): number {
    let positions = this.#viewPositions;
    if (!positions) {
      positions = new Int32Array(this.#status.length).fill(-1);
      for (let i = 0; i < this.#view.length; i++) positions[this.#view[i] as number] = i;
      this.#viewPositions = positions;
    }
    return rowId >= 0 && rowId < positions.length ? (positions[rowId] as number) : -1;
  }

  getValue<K extends keyof C & string>(index: number, column: K): C[K] | null {
    return this.getValueById(this.rowIdAt(index), column);
  }

  getValueById<K extends keyof C & string>(rowId: number, column: K): C[K] | null {
    const slot = this.#slot(rowId);
    return (this.#data[this.#col(column)] as CellValue[])[slot] as C[K] | null;
  }

  /** The row's status. A row whose insert was undone reads as deleted. */
  statusOf(rowId: number): RowStatus {
    const slot = this.#slot(rowId);
    return STATUS_NAMES[this.#status[slot] as number] as RowStatus;
  }

  rowStatus(index: number): RowStatus {
    return this.statusOf(this.rowIdAt(index));
  }

  /** The value the row was loaded with. */
  getOriginalValue<K extends keyof C & string>(rowId: number, column: K): C[K] | null {
    const slot = this.#slot(rowId);
    const c = this.#col(column);
    const originals = this.#originals.get(slot);
    return (originals ? originals[c] : (this.#data[c] as CellValue[])[slot]) as C[K] | null;
  }

  deletedRows(): number[] {
    return this.#base.filter((slot) => this.#status[slot] === DELETED).map((slot) => this.#idBase + slot);
  }

  /** Every row that isn't deleted, in natural order, whatever the filter and sort. */
  liveRows(): { ids: number[]; rows: CellValue[][] } {
    const ids: number[] = [];
    const rows: CellValue[][] = [];
    for (const slot of this.#base) {
      const status = this.#status[slot];
      if (status === DELETED || status === REMOVED) continue;
      ids.push(this.#idBase + slot);
      rows.push(this.#snapshot(slot));
    }
    return { ids, rows };
  }

  /** Resolves when no write or current-row move is still waiting on a handler. */
  settled(): Promise<void> {
    if (this.#deferred === 0) return Promise.resolve();
    return new Promise((resolve) => this.#settleWaiters.push(resolve));
  }

  #defer<R>(result: Promise<R>): Promise<R> {
    this.#deferred++;
    const done = (): void => {
      if (--this.#deferred === 0) {
        const waiters = this.#settleWaiters;
        this.#settleWaiters = [];
        for (const resolve of waiters) resolve();
      }
    };
    result.then(done, done);
    return result;
  }

  hasChanges(): boolean {
    return this.#base.some((rowId) => {
      const status = this.#status[rowId];
      return status === INSERTED || status === UPDATED || status === DELETED;
    });
  }

  /** The index of the first visible row the predicate accepts, or -1. */
  find(predicate: (get: RowGetter, index: number) => boolean, from = 0): number {
    const reader = this.#reader();
    for (let i = Math.max(from, 0); i < this.#view.length; i++) {
      reader.rowId = this.#view[i] as number;
      if (predicate(reader.get, i)) return i;
    }
    return -1;
  }

  findValue<K extends keyof C & string>(column: K, value: CellValue, from = 0): number {
    const c = this.#col(column);
    const def = this.columns[c] as ColumnDef;
    const target = coerceValue(def, value);
    const data = this.#data[c] as CellValue[];
    for (let i = Math.max(from, 0); i < this.#view.length; i++) {
      if (valuesEqual(def.type, data[this.#view[i] as number] as CellValue, target)) return i;
    }
    return -1;
  }

  // Editing

  setValue<K extends keyof C & string>(index: number, column: K, value: C[K] | null): ChangeResult {
    return this.setValueById(this.rowIdAt(index), column, value);
  }

  setValueById<K extends keyof C & string>(rowId: number, column: K, raw: C[K] | null): ChangeResult {
    const slot = this.#slot(rowId);
    this.#assertEditable(slot);
    const c = this.#col(column);
    const def = this.columns[c] as ColumnDef;
    const value = coerceValue(def, raw);
    const oldValue = (this.#data[c] as CellValue[])[slot] as CellValue;
    const key = slot * this.columns.length + c;
    // "1.50" over "1.5" is no change, so the row doesn't go dirty and the loaded text stays.
    if (valuesEqual(def.type, oldValue, value)) {
      this.#cellToken.delete(key);
      return true;
    }

    const token = ++this.#tokenCounter;
    this.#cellToken.set(key, token);
    const finish = (): void => {
      if (this.#cellToken.get(key) === token) this.#cellToken.delete(key);
    };
    const generation = this.#generation;
    const event = new ChangingEvent<CellChange>({ rowId, column, oldValue, newValue: value });
    let result: ChangeResult;
    try {
      this.#events.emit('cellChanging', event);
      result = event.settle(() => {
        if (generation !== this.#generation || !this.#isEditable(slot) || this.#cellToken.get(key) !== token) return false;
        this.#write(slot, c, value);
        return true;
      });
    } catch (error) {
      finish();
      throw error;
    }
    if (typeof result === 'boolean') {
      finish();
      return result;
    }
    const tracked = this.#defer(result);
    tracked.then(finish, finish);
    return tracked;
  }

  #write(rowId: number, c: number, value: CellValue): void {
    const def = this.columns[c] as ColumnDef;
    const data = this.#data[c] as CellValue[];
    const oldValue = data[rowId] as CellValue;
    if (valuesEqual(def.type, oldValue, value)) return;

    if (this.#status[rowId] === NORMAL) {
      this.#originals.set(rowId, this.#snapshot(rowId));
      this.#status[rowId] = UPDATED;
    }
    data[rowId] = value;
    const originals = this.#originals.get(rowId);
    // Typed back to the original number: keep the original text, so a later text comparison still matches.
    if (originals && valuesEqual(def.type, value, originals[c] as CellValue)) data[rowId] = originals[c] as CellValue;
    if (this.#status[rowId] === UPDATED && this.#matchesOriginals(rowId)) this.#restore(rowId);

    this.#updateAggregates(rowId, c, oldValue, data[rowId] as CellValue);
    this.#issues.delete(rowId * this.columns.length + (this.#columnIndex.get(def.id) as number));
    this.#touch(false, rowId, def.id);
    this.#events.emit('cellChanged', { rowId: this.#idBase + rowId, column: def.id, oldValue, newValue: data[rowId] as CellValue });
  }

  #snapshot(rowId: number): CellValue[] {
    return this.#data.map((column) => column[rowId] as CellValue);
  }

  #matchesOriginals(rowId: number): boolean {
    const originals = this.#originals.get(rowId) as CellValue[];
    return this.columns.every((column, c) =>
      valuesEqual(column.type, (this.#data[c] as CellValue[])[rowId] as CellValue, originals[c] as CellValue),
    );
  }

  /** Puts back the exact loaded values, including their exact text, and marks the row normal. */
  #restore(rowId: number): void {
    const originals = this.#originals.get(rowId);
    if (originals) {
      originals.forEach((value, c) => {
        (this.#data[c] as CellValue[])[rowId] = value;
      });
      this.#originals.delete(rowId);
    }
    this.#status[rowId] = NORMAL;
  }

  addRow(values?: RowInput): number {
    return this.insertRow(this.#view.length, values);
  }

  /** Inserts a row at this view position and returns its row id. */
  insertRow(index: number, values?: RowInput): number {
    if (!Number.isInteger(index) || index < 0 || index > this.#view.length) {
      throw new RangeError(`Dataset "${this.id}" can't insert at index ${index} (it has ${this.#view.length})`);
    }
    const rowValues = this.#toRowValues(values);
    const rowId = this.#allocate(rowValues, INSERTED);

    if (index < this.#view.length) {
      this.#base.splice(this.#base.indexOf(this.#view[index] as number), 0, rowId);
    } else {
      this.#base.push(rowId);
    }
    const view = new Int32Array(this.#view.length + 1);
    view.set(this.#view.subarray(0, index), 0);
    view[index] = rowId;
    view.set(this.#view.subarray(index), index + 1);
    this.#setView(view);
    this.#aggregates = [];

    this.#touch(true, rowId);
    if (this.#currentRow === null) this.#moveCurrent(rowId);
    return this.#idBase + rowId;
  }

  deleteRow(index: number): void {
    this.deleteRows([index]);
  }

  /**
   * Deleted rows leave the view but stay in memory to be sent on save. An inserted row the server
   * never saw simply goes away.
   */
  deleteRows(indexes: readonly number[]): void {
    const rowIds = [...new Set(indexes.map((index) => this.#view[this.#checkedIndex(index)] as number))];
    if (rowIds.length === 0) return;
    for (const rowId of rowIds) {
      this.#status[rowId] = this.#status[rowId] === INSERTED ? REMOVED : DELETED;
    }
    const gone = new Set(rowIds);
    this.#aggregates = [];
    for (const rowId of rowIds) {
      if (this.#selected.delete(rowId)) this.#touch(false, rowId);
    }
    const previousIndex = this.#currentIndex;
    this.#setView(this.#view.filter((rowId) => !gone.has(rowId)));
    this.#touch(true);
    if (this.#currentRow !== null && gone.has(this.#currentRow)) {
      this.#moveCurrent(this.#rowNear(previousIndex));
    }
  }

  /** Takes a row back to how it was loaded. Takes a row id, because deleted rows have no index. */
  revertRow(publicId: number): void {
    const rowId = this.#slot(publicId);
    const status = this.#status[rowId];
    this.#aggregates = [];
    this.#clearIssues();
    if (status === NORMAL || status === REMOVED) {
      // Nothing to undo, but a view may hold text that never reached the Dataset, so it still counts.
      this.revision++;
      this.#touch(false, rowId);
      return;
    }
    if (status === INSERTED) {
      this.#status[rowId] = REMOVED;
      this.#selected.delete(rowId);
    } else {
      this.#restore(rowId);
    }
    this.revision++;
    this.#afterRevert(status === UPDATED, rowId);
  }

  revertAll(): void {
    let reverted = false;
    this.#aggregates = [];
    this.#clearIssues();
    for (const rowId of this.#base) {
      const status = this.#status[rowId];
      if (status === INSERTED) {
        this.#status[rowId] = REMOVED;
        this.#selected.delete(rowId);
        reverted = true;
      } else if (status === UPDATED || status === DELETED) {
        this.#restore(rowId);
        reverted = true;
      }
    }
    this.revision++;
    if (reverted) this.#afterRevert(false);
    else this.#touch(true);
  }

  #afterRevert(onlyValuesChanged: boolean, rowId?: number): void {
    if (onlyValuesChanged) {
      this.#touch(false, rowId);
      return;
    }
    const previousIndex = this.#currentIndex;
    this.#rebuildView(previousIndex);
    this.#touch(true, rowId);
  }

  // Loading

  /** Replaces every row, or adds to the end with `append`. Loaded rows are unchanged, so they have status normal. */
  load(rows: readonly RowInput[], options: { append?: boolean } = {}): void {
    // Check everything before touching the store, so a bad row can't leave half a load behind.
    const prepared = rows.map((row) => this.#toRowValues(row));
    const previousCurrent = this.currentRow;
    const append = options.append === true;

    const saved = {
      data: this.#data,
      status: this.#status,
      originals: this.#originals,
      base: this.#base,
      currentRow: this.#currentRow,
      currentIndex: this.#currentIndex,
      noCurrent: this.#noCurrent,
      slots: this.#status.length,
      baseLength: this.#base.length,
    };
    try {
      if (!append) {
        this.#data = this.columns.map(() => []);
        this.#status = [];
        this.#originals = new Map();
        this.#base = [];
        this.#currentRow = null;
        this.#currentIndex = -1;
        this.#noCurrent = false;
      }
      for (const rowValues of prepared) {
        this.#base.push(this.#allocate(rowValues, NORMAL));
      }
      this.#computeView();
    } catch (error) {
      // A filter that throws leaves the Dataset exactly as it was.
      if (append) {
        for (const column of this.#data) column.length = saved.slots;
        this.#status.length = saved.slots;
        this.#base.length = saved.baseLength;
      } else {
        this.#data = saved.data;
        this.#status = saved.status;
        this.#originals = saved.originals;
        this.#base = saved.base;
        this.#currentRow = saved.currentRow;
        this.#currentIndex = saved.currentIndex;
        this.#noCurrent = saved.noCurrent;
        this.#viewPositions = null;
      }
      throw error;
    }
    this.#aggregates = [];
    if (!append) {
      this.#generation++;
      this.revision++;
      this.#issues = new Map();
      this.#selected = new Set();
      this.#idBase += saved.slots;
      this.#cellToken.clear();
    }
    this.#touch(true);
    if (append) {
      this.#rebuildView(this.#currentIndex);
    } else if (this.#view.length > 0) {
      this.#moveCurrent(this.#view[0] as number);
    } else if (previousCurrent !== null) {
      this.#events.emit('currentRowChanged', { fromRow: previousCurrent, toRow: null });
    }
  }

  #toRowValues(row: RowInput | undefined): CellValue[] {
    if (row === undefined) return this.columns.map(() => null);
    if (Array.isArray(row)) {
      const positional = row as readonly unknown[];
      if (positional.length !== this.columns.length) {
        throw new TypeError(
          `Dataset "${this.id}" has ${this.columns.length} columns, but a row has ${positional.length} values`,
        );
      }
      return this.columns.map((column, c) => coerceValue(column, positional[c]));
    }
    const named = row as Readonly<Record<string, unknown>>;
    for (const key of Object.keys(named)) this.#col(key);
    return this.columns.map((column) => coerceValue(column, named[column.id]));
  }

  #allocate(values: readonly CellValue[], status: number): number {
    const rowId = this.#status.length;
    this.#status.push(status);
    values.forEach((value, c) => {
      (this.#data[c] as CellValue[])[rowId] = value;
    });
    return rowId;
  }

  // Current row

  /** Moves the current row. -1 means no current row. Handlers can cancel or defer the move. */
  setCurrentIndex(index: number): ChangeResult {
    const next = index === -1 ? null : (this.#view[this.#checkedIndex(index)] as number);
    const request = ++this.#currentRequest;
    if (next === this.#currentRow) return true;
    const generation = this.#generation;
    const event = new ChangingEvent<CurrentRowChange>({ fromRow: this.currentRow, toRow: next === null ? null : this.#idBase + next });
    this.#events.emit('currentRowChanging', event);
    const result = event.settle(() => {
      if (request !== this.#currentRequest || generation !== this.#generation) return false;
      if (next !== null && this.#indexOfSlot(next) === -1) return false;
      this.#moveCurrent(next);
      this.#noCurrent = next === null;
      return true;
    });
    return typeof result === 'boolean' ? result : this.#defer(result);
  }

  /** Moves without asking, for when the row has already gone. */
  #moveCurrent(rowId: number | null): void {
    const fromRow = this.#currentRow;
    this.#currentRow = rowId;
    this.#noCurrent = false;
    this.#currentIndex = rowId === null ? -1 : this.#indexOfSlot(rowId);
    this.#touch(false);
    if (fromRow !== rowId) {
      this.#events.emit('currentRowChanged', {
        fromRow: fromRow === null ? null : this.#idBase + fromRow,
        toRow: rowId === null ? null : this.#idBase + rowId,
      });
    }
  }

  #rowNear(index: number): number | null {
    if (this.#view.length === 0) return null;
    return this.#view[Math.min(Math.max(index, 0), this.#view.length - 1)] as number;
  }

  // Sort and filter

  /** Sorts the view. Edited rows keep their place until the next sort. Empty values always go last. */
  sort(keys: readonly SortKey[]): void {
    for (const key of keys) this.#col(key.column);
    this.#sortKeys = keys.map((key) => ({ ...key }));
    this.#rebuildView(this.#currentIndex);
    // A sort filters again, and edits made since the filter last ran can change which rows pass.
    if (this.#filter) this.#aggregates = [];
    else this.#dropOrderDependentAggregates();
    this.#touch(true);
  }

  get sortKeys(): readonly SortKey[] {
    return this.#sortKeys;
  }

  /** Filters the view, or removes the filter with null. */
  setFilter(filter: ((get: RowGetter) => boolean) | null): void {
    const previous = this.#filter;
    this.#filter = filter;
    try {
      this.#rebuildView(this.#currentIndex);
    } catch (error) {
      this.#filter = previous;
      throw error;
    }
    this.#aggregates = [];
    this.#touch(true);
  }

  #rebuildView(previousIndex: number): void {
    this.#computeView();
    if (this.#currentRow !== null) {
      const index = this.#indexOfSlot(this.#currentRow);
      if (index !== -1) {
        this.#currentIndex = index;
        return;
      }
      this.#moveCurrent(this.#rowNear(previousIndex));
    } else if (this.#view.length > 0 && !this.#noCurrent) {
      this.#moveCurrent(this.#view[0] as number);
    }
  }

  #computeView(): void {
    const visible: number[] = [];
    const reader = this.#reader();
    for (const rowId of this.#base) {
      const status = this.#status[rowId];
      if (status === DELETED || status === REMOVED) continue;
      if (this.#filter) {
        reader.rowId = rowId;
        if (!this.#filter(reader.get)) continue;
      }
      visible.push(rowId);
    }
    const view = Int32Array.from(visible);
    if (this.#sortKeys.length > 0) this.#sortView(view);
    this.#setView(view);
  }

  #sortView(view: Int32Array): void {
    const basePosition = new Int32Array(this.#status.length);
    this.#base.forEach((rowId, position) => {
      basePosition[rowId] = position;
    });
    const keys = this.#sortKeys.map((key) => {
      const c = this.#col(key.column);
      return {
        data: this.#data[c] as CellValue[],
        type: (this.columns[c] as ColumnDef).type,
        direction: key.descending ? -1 : 1,
      };
    });
    view.sort((a, b) => {
      for (const key of keys) {
        const x = key.data[a] as CellValue;
        const y = key.data[b] as CellValue;
        if (x === y) continue;
        if (x === null) return 1;
        if (y === null) return -1;
        const order = compareValues(key.type, x, y);
        if (order !== 0) return order * key.direction;
      }
      return (basePosition[a] as number) - (basePosition[b] as number);
    });
  }

  #setView(view: Int32Array): void {
    this.#view = view;
    this.#viewPositions = null;
    if (this.#currentRow !== null) {
      const index = this.#indexOfSlot(this.#currentRow);
      this.#currentIndex = index;
    }
  }

  #reader(): { rowId: number; get: RowGetter } {
    const reader = {
      rowId: -1,
      get: (column: string): CellValue => (this.#data[this.#col(column)] as CellValue[])[reader.rowId] as CellValue,
    };
    return reader;
  }

  // Aggregates, over the visible rows. Empty values are skipped.

  count<K extends keyof C & string>(column?: K): number {
    if (column === undefined) return this.#view.length;
    const c = this.#col(column);
    const agg = this.#aggregatesOf(c);
    if (agg.count !== undefined) return agg.count;
    const data = this.#data[c] as CellValue[];
    let total = 0;
    for (const rowId of this.#view) if (data[rowId] !== null) total++;
    agg.count = total;
    return total;
  }

  /** An exact string for decimal columns, a number for int and float columns. */
  sum<K extends keyof C & string>(column: K): number | string {
    const c = this.#col(column);
    const def = this.columns[c] as ColumnDef;
    const data = this.#data[c] as CellValue[];
    const agg = this.#aggregatesOf(c);
    if (def.type === 'decimal') {
      if (!agg.decimalSum) {
        const sum = new DecimalSum();
        for (const rowId of this.#view) {
          const value = data[rowId] as string | null;
          if (value !== null) sum.add(value);
        }
        agg.decimalSum = sum;
      }
      return agg.decimalSum.toString();
    }
    if (def.type !== 'int' && def.type !== 'float') {
      throw new TypeError(`Can't sum column "${column}" of type ${def.type}`);
    }
    if (agg.numberSum !== undefined) return agg.numberSum;
    let total = 0;
    for (const rowId of this.#view) total += (data[rowId] as number | null) ?? 0;
    if (def.type === 'int' && !Number.isSafeInteger(total)) {
      throw new RangeError(`The sum of int column "${column}" is too large to be exact. Use a decimal column`);
    }
    // A float total depends on the order values were added in, so it is only kept until the next edit or sort.
    agg.numberSum = total;
    return total;
  }

  /**
   * The average, or null if every value is empty. Decimal results are exact to `scale` digits,
   * which defaults to the column's scale plus two, rounded half away from zero.
   */
  avg<K extends keyof C & string>(column: K, scale?: number): number | string | null {
    const count = this.count(column);
    if (count === 0) return null;
    const def = this.columns[this.#col(column)] as ColumnDef;
    const total = this.sum(column);
    if (def.type === 'decimal') {
      return decDiv(total as string, String(count), scale ?? (def.scale ?? 0) + 2);
    }
    return (total as number) / count;
  }

  min<K extends keyof C & string>(column: K): CellValue {
    return this.#extreme(column, -1);
  }

  max<K extends keyof C & string>(column: K): CellValue {
    return this.#extreme(column, 1);
  }

  #extreme(column: string, direction: number): CellValue {
    const c = this.#col(column);
    const agg = this.#aggregatesOf(c);
    const kept = direction < 0 ? agg.min : agg.max;
    if (kept) return kept.value;
    const def = this.columns[c] as ColumnDef;
    const data = this.#data[c] as CellValue[];
    let best: CellValue = null;
    for (const rowId of this.#view) {
      const value = data[rowId] as CellValue;
      if (value === null) continue;
      if (best === null || compareValues(def.type, value, best) * direction > 0) best = value;
    }
    if (direction < 0) agg.min = { value: best };
    else agg.max = { value: best };
    return best;
  }

  #aggregatesOf(c: number): ColumnAggregates {
    return (this.#aggregates[c] ??= {});
  }

  /**
   * Keeps cached totals right after one cell changed. Rows outside the view don't count. The exact
   * ones (count, decimal and int sums) are adjusted by the difference, and anything that could
   * differ from a full recount is dropped, so a read always gives what a recount would.
   */
  #updateAggregates(slot: number, c: number, before: CellValue, after: CellValue): void {
    const agg = this.#aggregates[c];
    if (!agg || this.#indexOfSlot(slot) === -1) return;
    agg.min = undefined;
    agg.max = undefined;
    if (agg.count !== undefined) agg.count += (after === null ? 0 : 1) - (before === null ? 0 : 1);
    if (agg.decimalSum) {
      try {
        if (before !== null) agg.decimalSum.remove(before as string);
        if (after !== null) agg.decimalSum.add(after as string);
      } catch {
        agg.decimalSum = undefined;
      }
    }
    if (agg.numberSum !== undefined) {
      if ((this.columns[c] as ColumnDef).type === 'int') {
        const total = agg.numberSum + ((after as number | null) ?? 0) - ((before as number | null) ?? 0);
        agg.numberSum = Number.isSafeInteger(total) ? total : undefined;
      } else {
        agg.numberSum = undefined;
      }
    }
  }

  /** A sort keeps the same rows, but a float total and a tie between equal decimals can depend on the order. */
  #dropOrderDependentAggregates(): void {
    this.#aggregates.forEach((agg, c) => {
      const type = (this.columns[c] as ColumnDef).type;
      if (!agg || (type !== 'float' && type !== 'decimal')) return;
      agg.min = undefined;
      agg.max = undefined;
      if (type === 'float') agg.numberSum = undefined;
    });
  }

  // Issues

  /**
   * Replaces the issues shown on cells, for example with errors from the server. Issues for rows that
   * no longer exist are ignored, because a server answer can arrive after a reload. An issue goes away
   * when its cell is written, and all go away on a replacing load or a revert.
   */
  setIssues(issues: readonly ValidationIssue[]): void {
    const next = new Map<number, ValidationIssue>();
    for (const issue of issues) {
      const c = this.#columnIndex.get(issue.column);
      if (c === undefined) throw new Error(`Dataset "${this.id}" has no column "${issue.column}"`);
      const slot = issue.rowId - this.#idBase;
      if (!Number.isInteger(slot) || slot < 0 || slot >= this.#status.length) continue;
      const key = slot * this.columns.length + c;
      if (!next.has(key)) next.set(key, { ...issue });
    }
    const previous = this.#issues;
    if (previous.size === 0 && next.size === 0) return;
    this.#issues = next;
    this.#touchIssues(previous);
    this.#touchIssues(next);
  }

  /** The issue on a cell, or undefined. A stale row id or unknown column also gives undefined. */
  issueAt(rowId: number, column: string): ValidationIssue | undefined {
    const c = this.#columnIndex.get(column);
    if (c === undefined) return undefined;
    const slot = rowId - this.#idBase;
    if (!Number.isInteger(slot) || slot < 0) return undefined;
    return this.#issues.get(slot * this.columns.length + c);
  }

  /** All issues now set, ordered by row then column. */
  issues(): ValidationIssue[] {
    return [...this.#issues.entries()].sort((a, b) => a[0] - b[0]).map(([, issue]) => ({ ...issue }));
  }

  #clearIssues(): void {
    if (this.#issues.size === 0) return;
    const previous = this.#issues;
    this.#issues = new Map();
    this.#touchIssues(previous);
  }

  #touchIssues(map: ReadonlyMap<number, ValidationIssue>): void {
    const width = this.columns.length;
    for (const key of map.keys()) {
      this.#touch(false, Math.floor(key / width), (this.columns[key % width] as ColumnDef).id);
    }
  }

  // Selection

  /** Marks a row selected or not. A stale id is ignored, and so is selecting a deleted row. */
  setRowSelected(rowId: number, selected: boolean): void {
    const slot = rowId - this.#idBase;
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.#status.length) return;
    if (selected && !this.#isEditable(slot)) return;
    if (selected === this.#selected.has(slot)) return;
    if (selected) this.#selected.add(slot);
    else this.#selected.delete(slot);
    this.#touch(false, slot);
  }

  isRowSelected(rowId: number): boolean {
    return this.#selected.has(rowId - this.#idBase);
  }

  /** Selected row ids in natural order, whatever the sort and filter. */
  selectedRows(): number[] {
    if (this.#selected.size === 0) return [];
    return this.#base.filter((slot) => this.#selected.has(slot)).map((slot) => this.#idBase + slot);
  }

  clearSelection(): void {
    if (this.#selected.size === 0) return;
    const gone = this.#selected;
    this.#selected = new Set();
    for (const slot of gone) this.#touch(false, slot);
  }

  // Validation

  /** Adds a custom rule to a column, on top of the rules in its definition. */
  setValidator(column: string, validator: Validator | null): void {
    const c = this.#col(column);
    if (validator) this.#validators.set(c, validator);
    else this.#validators.delete(c);
  }

  validateRow(publicId: number): ValidationIssue[] {
    const rowId = this.#slot(publicId);
    const issues: ValidationIssue[] = [];
    const reader = this.#reader();
    reader.rowId = rowId;
    this.columns.forEach((column, c) => {
      const value = (this.#data[c] as CellValue[])[rowId] as CellValue;
      const add = (code: ValidationCode, message: string) => {
        issues.push({ rowId: publicId, column: column.id, code, message });
      };
      const label = column.label ?? column.id;

      if (value === null || value === '') {
        if (column.required) add('required', `${label} is required`);
      } else {
        if (column.type === 'string' && column.size !== undefined && (value as string).length > column.size) {
          add('length', `${label} can be at most ${column.size} characters`);
        }
        if (column.min !== undefined && compareBound(column, value, column.min) < 0) {
          add('range', `${label} must be at least ${column.min}`);
        }
        if (column.max !== undefined && compareBound(column, value, column.max) > 0) {
          add('range', `${label} must be at most ${column.max}`);
        }
        const pattern = this.#patterns[c];
        if (pattern && !pattern.test(String(value))) {
          add('pattern', `${label} is not in the expected format`);
        }
        if (column.type === 'decimal' && !decFits(value as string, column.precision, column.scale)) {
          add('precision', `${label} doesn't fit precision ${column.precision ?? '-'} and scale ${column.scale ?? '-'}`);
        }
      }
      const message = this.#validators.get(c)?.(value, reader.get);
      if (message) add('custom', message);
    });
    return issues;
  }

  /** Checks rows that will be saved. Rows being deleted aren't checked. */
  validate(): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    for (const rowId of this.#base) {
      const status = this.#status[rowId];
      if (status === INSERTED || status === UPDATED) issues.push(...this.validateRow(this.#idBase + rowId));
    }
    return issues;
  }

  // Saving

  /** Inserted, updated and deleted rows, in natural order. */
  getChanges(): RowChange[] {
    const changes: RowChange[] = [];
    for (const rowId of this.#base) {
      const status = this.#status[rowId];
      if (status === INSERTED) {
        changes.push({ status: 'I', rowId: this.#idBase + rowId, values: this.#snapshot(rowId) });
      } else if (status === DELETED) {
        changes.push({ status: 'D', rowId: this.#idBase + rowId, values: this.#originals.get(rowId)?.slice() ?? this.#snapshot(rowId) });
      } else if (status === UPDATED) {
        const originals = this.#originals.get(rowId) as CellValue[];
        const changed: Record<number, CellValue> = {};
        this.columns.forEach((column, c) => {
          const value = (this.#data[c] as CellValue[])[rowId] as CellValue;
          if (!valuesEqual(column.type, value, originals[c] as CellValue)) changed[c] = originals[c] as CellValue;
        });
        changes.push({ status: 'U', rowId: this.#idBase + rowId, values: this.#snapshot(rowId), originals: changed });
      }
    }
    return changes;
  }

  /** Records what's being sent. If the save fails, simply don't accept it: nothing has changed. */
  beginSave(): SaveTicket {
    return { generation: this.#generation, changes: this.getChanges() };
  }

  /**
   * Marks a save as done, once the server has confirmed it.
   *
   * The Dataset may have moved on while the save ran, so each sent row is compared with what the
   * server now holds. A row untouched since sending becomes normal. A row edited since sending
   * stays updated, with the sent values as its new originals, so those edits aren't lost and the
   * next save's conflict check compares against what the server really has.
   *
   * `applied` holds values the server assigned, such as generated keys and new versions.
   */
  acceptSave(ticket: SaveTicket, applied?: ReadonlyMap<number, Readonly<Record<string, unknown>>>): void {
    if (ticket.generation !== this.#generation) return;
    this.#aggregates = [];

    let purged = false;
    for (const sent of ticket.changes) {
      const rowId = sent.rowId - this.#idBase;
      const status = this.#status[rowId];

      if (sent.status === 'D') {
        if (status === DELETED) {
          this.#status[rowId] = REMOVED;
          this.#originals.delete(rowId);
          purged = true;
        } else {
          // The delete was undone during the save, but the server has already removed the row.
          this.#status[rowId] = INSERTED;
          this.#originals.delete(rowId);
        }
        continue;
      }

      const serverValues = sent.values.slice();
      const patch = applied?.get(sent.rowId);
      if (patch) {
        for (const [column, raw] of Object.entries(patch)) {
          const c = this.#col(column);
          const def = this.columns[c] as ColumnDef;
          const value = coerceValue(def, raw);
          const data = this.#data[c] as CellValue[];
          if (valuesEqual(def.type, data[rowId] as CellValue, serverValues[c] as CellValue)) data[rowId] = value;
          serverValues[c] = value;
        }
      }

      if (status === DELETED || status === REMOVED) {
        // Deleted during the save, but the server now has the row, so the next save must delete it.
        this.#status[rowId] = DELETED;
        this.#originals.set(rowId, serverValues);
      } else {
        const same = this.columns.every((column, c) =>
          valuesEqual(column.type, (this.#data[c] as CellValue[])[rowId] as CellValue, serverValues[c] as CellValue),
        );
        if (same) {
          this.#status[rowId] = NORMAL;
          this.#originals.delete(rowId);
        } else {
          this.#status[rowId] = UPDATED;
          this.#originals.set(rowId, serverValues);
        }
      }
    }

    // Rows that are gone for good no longer need a place in the natural order.
    if (purged || this.#base.some((rowId) => this.#status[rowId] === REMOVED)) {
      this.#base = this.#base.filter((rowId) => this.#status[rowId] !== REMOVED);
    }
    this.#touch(true);
  }

  // Guards

  #col(column: string): number {
    const index = this.#columnIndex.get(column);
    if (index === undefined) throw new Error(`Dataset "${this.id}" has no column "${column}"`);
    return index;
  }

  /** Turns a public row id into a slot. An id from before a reload is stale and throws. */
  #slot(rowId: number): number {
    const slot = rowId - this.#idBase;
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.#status.length) {
      throw new RangeError(`Dataset "${this.id}" has no row with id ${rowId}`);
    }
    return slot;
  }

  #assertRow(rowId: number): void {
    if (!Number.isInteger(rowId) || rowId < 0 || rowId >= this.#status.length) {
      throw new RangeError(`Dataset "${this.id}" has no row with id ${rowId}`);
    }
  }

  #isEditable(rowId: number): boolean {
    const status = this.#status[rowId];
    return status === NORMAL || status === INSERTED || status === UPDATED;
  }

  #assertEditable(rowId: number): void {
    this.#assertRow(rowId);
    if (!this.#isEditable(rowId)) throw new Error(`Row ${rowId} of Dataset "${this.id}" is deleted, so it can't be edited`);
  }
}
