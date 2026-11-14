import { compileExpression, formatValue, placeGridCells, readOptions } from '@fw/core';
import type { AnyDataset, ColumnType, CompiledExpression, GridProps, OptionItem, PlacedCell } from '@fw/core';
import type { GridOptions } from '../contract.ts';

export type CellKind = 'text' | 'rowStatus' | 'rowSelect';

export interface OptionsSpec {
  /** A Dataset id or a static list. */
  source: unknown;
  optionValue?: string;
  optionLabel?: string;
}

/** What the engine needs to know about one cell of the record row, worked out once per definition. */
export interface RecordCell {
  placed: PlacedCell;
  /** First track the cell covers. */
  track: number;
  span: number;
  kind: CellKind;
  field: string | null;
  type: ColumnType;
  format: string | undefined;
  align: 'start' | 'end';
  frozen: boolean;
  options: OptionsSpec | null;
}

export interface FooterCell {
  placed: PlacedCell;
  text: string;
  expression: CompiledExpression | null;
  /** Last segment of each path the expression reads, so a footer only re-evaluates when one of them changes. */
  columns: ReadonlySet<string>;
  format: string | undefined;
}

export interface GridModel {
  definition: GridProps;
  trackCount: number;
  frozenCount: number;
  headerPlaced: PlacedCell[];
  recordPlaced: PlacedCell[];
  footerPlaced: PlacedCell[];
  headerRowCount: number;
  footerRowCount: number;
  record: RecordCell[];
  /** For each track, the index in `record` of the cell covering it, or -1. */
  recordAtTrack: number[];
  footer: FooterCell[];
  /** For each track, the record field under it (for sorting), or null. */
  fieldAtTrack: (string | null)[];
  errors: string[];
}

const NUMERIC: ReadonlySet<ColumnType> = new Set<ColumnType>(['int', 'float', 'decimal']);

export function buildModel(definition: GridProps, dataset: AnyDataset, report: (error: unknown, where: string) => void): GridModel {
  const trackCount = definition.columns.length;
  let frozenCount = 0;
  while (frozenCount < trackCount && definition.columns[frozenCount]?.frozen === 'left') frozenCount++;

  const errors: string[] = [];
  const place = (rows: GridProps['headerRows'], label: string): PlacedCell[] => {
    if (!rows || rows.length === 0) return [];
    const placement = placeGridCells(rows, trackCount);
    for (const message of placement.errors) errors.push(`${label}: ${message}`);
    return placement.cells;
  };
  const headerPlaced = place(definition.headerRows, 'Header');
  const recordPlaced = place(definition.recordRows.slice(0, 1), 'Record');
  const footerPlaced = place(definition.footerRows, 'Footer');
  if (definition.recordRows.length > 1) errors.push('Only one record row is supported');
  if (errors.length > 0) report(new Error(errors.join('; ')), 'grid.definition');

  const columnById = new Map(dataset.columns.map((column) => [column.id, column]));
  const record: RecordCell[] = recordPlaced.map((placed) => {
    const cell = placed.cell;
    const field = typeof cell.field === 'string' && columnById.has(cell.field) ? cell.field : null;
    if (typeof cell.field === 'string' && field === null) report(new Error(`Grid cell field "${cell.field}" is not a column of "${dataset.id}"`), 'grid.field');
    const column = field === null ? undefined : columnById.get(field);
    const type: ColumnType = column?.type ?? 'string';
    const kind: CellKind = cell.kind === 'rowStatus' || cell.kind === 'rowSelect' ? cell.kind : 'text';
    const options =
      cell.options !== undefined && cell.options !== null
        ? {
            source: cell.options,
            optionValue: typeof cell.optionValue === 'string' ? cell.optionValue : undefined,
            optionLabel: typeof cell.optionLabel === 'string' ? cell.optionLabel : undefined,
          }
        : null;
    return {
      placed,
      track: placed.column,
      span: placed.colSpan,
      kind,
      field,
      type,
      format: typeof cell.format === 'string' ? cell.format : undefined,
      align: NUMERIC.has(type) && kind === 'text' ? 'end' : 'start',
      frozen: placed.column + placed.colSpan <= frozenCount,
      options,
    };
  });

  const recordAtTrack = new Array<number>(trackCount).fill(-1);
  const fieldAtTrack = new Array<string | null>(trackCount).fill(null);
  record.forEach((cell, index) => {
    for (let t = cell.track; t < cell.track + cell.span; t++) {
      recordAtTrack[t] = index;
      if (cell.span === 1 && cell.kind === 'text') fieldAtTrack[t] = cell.field;
    }
  });

  const footer: FooterCell[] = footerPlaced.map((placed) => {
    const cell = placed.cell;
    let expression: CompiledExpression | null = null;
    if (typeof cell.value === 'string' && cell.value.startsWith('=')) {
      try {
        expression = compileExpression(cell.value);
      } catch (error) {
        report(error, 'grid.footer');
      }
    }
    return {
      placed,
      text: typeof cell.text === 'string' ? cell.text : typeof cell.value === 'string' && expression === null ? cell.value : '',
      expression,
      columns: new Set((expression?.paths ?? []).map((path) => path[path.length - 1] as string)),
      format: typeof cell.format === 'string' ? cell.format : undefined,
    };
  });

  return {
    definition,
    trackCount,
    frozenCount,
    headerPlaced,
    recordPlaced,
    footerPlaced,
    headerRowCount: definition.headerRows?.length ?? 0,
    footerRowCount: definition.footerRows?.length ?? 0,
    record,
    recordAtTrack,
    footer,
    fieldAtTrack,
    errors,
  };
}

const DECIMAL_TEXT = /^-?\d+(\.\d+)?$/;

/** Text for an evaluated footer value. Decimal results are text, so they're formatted without a double. */
export function footerText(result: unknown, format: string | undefined): string {
  if (result === null || result === undefined) return '';
  if (typeof result === 'number') {
    return format === undefined ? String(result) : formatValue(result, Number.isInteger(result) ? 'int' : 'float', format);
  }
  if (typeof result === 'string' && format !== undefined && DECIMAL_TEXT.test(result)) return formatValue(result, 'decimal', format);
  return String(result);
}

/** Caches the value-to-label map of a cell's options until the source Dataset changes. */
export class OptionsCache {
  readonly #entries = new Map<RecordCell, { version: number; dataset: AnyDataset | null; labels: Map<unknown, string> }>();
  readonly #options: GridOptions;
  readonly #report: (error: unknown, where: string) => void;

  constructor(options: GridOptions, report: (error: unknown, where: string) => void) {
    this.#options = options;
    this.#report = report;
  }

  clear(): void {
    this.#entries.clear();
  }

  label(cell: RecordCell, value: unknown): string | undefined {
    const spec = cell.options;
    if (!spec) return undefined;
    let dataset: AnyDataset | null = null;
    if (typeof spec.source === 'string') {
      dataset = spec.source === this.#options.dataset.id ? this.#options.dataset : (this.#options.resolveDataset?.(spec.source) ?? null);
    }
    const version = dataset?.version ?? 0;
    let entry = this.#entries.get(cell);
    if (!entry || entry.version !== version || entry.dataset !== dataset) {
      const labels = new Map<unknown, string>();
      let list: OptionItem[] = [];
      try {
        if (dataset) list = readOptions(dataset, spec.optionValue, spec.optionLabel);
        else if (Array.isArray(spec.source)) list = readOptions(spec.source);
      } catch (error) {
        this.#report(error, 'grid.options');
      }
      for (const item of list) if (!labels.has(item.value)) labels.set(item.value, item.label);
      entry = { version, dataset, labels };
      this.#entries.set(cell, entry);
    }
    return entry.labels.get(value);
  }
}
