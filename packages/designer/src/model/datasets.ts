/** Commands that edit Datasets: the Dataset itself, its columns, and its sample rows (FR-072). */
import { COLUMN_TYPES, coerceValue, type ColumnDefinition, type ComponentMeta, type DatasetDefinition, type FormDefinition } from '@fw/core';
import { CommandError, guarded, requireId, type Command } from './command-base.ts';
import { findRefs, inUseMessage } from './refs.ts';

type Metas = Readonly<Record<string, ComponentMeta>> | undefined;

/** The attributes of a column the designer edits. `undefined` removes one. */
export interface ColumnAttributes {
  type?: ColumnDefinition['type'];
  size?: number | undefined;
  precision?: number | undefined;
  scale?: number | undefined;
  required?: boolean | undefined;
  min?: number | string | undefined;
  max?: number | string | undefined;
  pattern?: string | undefined;
  label?: string | undefined;
}

const ATTRIBUTES = ['type', 'size', 'precision', 'scale', 'required', 'min', 'max', 'pattern', 'label'] as const;

function datasetOf(form: FormDefinition, id: string): DatasetDefinition {
  const found = form.datasets?.find((dataset) => dataset.id === id);
  if (!found) throw new CommandError(`There is no Dataset "${id}"`);
  return found;
}

function columnOf(dataset: DatasetDefinition, id: string): ColumnDefinition {
  const found = dataset.columns.find((column) => column.id === id);
  if (!found) throw new CommandError(`Dataset "${dataset.id}" has no column "${id}"`);
  return found;
}

function mapDataset(form: FormDefinition, id: string, change: (dataset: DatasetDefinition) => DatasetDefinition): FormDefinition {
  datasetOf(form, id);
  return { ...form, datasets: (form.datasets ?? []).map((dataset) => (dataset.id === id ? change(dataset) : dataset)) };
}

type Row = Record<string, unknown>;
const ROW_LISTS = ['initialRows', 'sampleRows'] as const;

/** Applies a change to every row of both row lists, leaving a list alone if no row changes. */
function mapRows(dataset: DatasetDefinition, change: (row: Row) => Row): DatasetDefinition {
  const next: DatasetDefinition = { ...dataset };
  for (const list of ROW_LISTS) {
    const rows = dataset[list];
    if (!rows) continue;
    const mapped = rows.map(change);
    if (mapped.some((row, i) => row !== rows[i])) next[list] = mapped;
  }
  return next;
}

function checkAttributes(attributes: ColumnAttributes): void {
  for (const key of Object.keys(attributes)) {
    if (!(ATTRIBUTES as readonly string[]).includes(key)) throw new CommandError(`"${key}" isn't a column attribute the designer edits`);
  }
  const { type, size, precision, scale, required, min, max, pattern, label } = attributes;
  if (type !== undefined && !COLUMN_TYPES.includes(type)) throw new CommandError(`"${String(type)}" isn't a column type`);
  for (const [name, value] of [['size', size], ['precision', precision], ['scale', scale]] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) throw new CommandError(`${name} must be a whole number, 0 or more`);
  }
  if (required !== undefined && typeof required !== 'boolean') throw new CommandError('required must be true or false');
  for (const [name, value] of [['min', min], ['max', max]] as const) {
    if (value !== undefined && typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) {
      throw new CommandError(`${name} must be a number or text`);
    }
  }
  if (pattern !== undefined) {
    if (typeof pattern !== 'string') throw new CommandError('pattern must be text');
    try {
      new RegExp(pattern);
    } catch {
      throw new CommandError(`"${pattern}" isn't a valid pattern`);
    }
  }
  if (label !== undefined && typeof label !== 'string') throw new CommandError('label must be text');
}

function sampleRowOf(dataset: DatasetDefinition, index: number): Row {
  const row = dataset.sampleRows?.[index];
  if (!row) throw new CommandError(`Dataset "${dataset.id}" has no sample row ${index + 1}`);
  return row;
}

/** Values checked against the column types with `coerceValue`. Unknown columns are refused. */
function coerceRow(dataset: DatasetDefinition, values: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const column = columnOf(dataset, key);
    try {
      out[key] = coerceValue(column, value);
    } catch (error) {
      throw new CommandError(error instanceof Error ? error.message : String(error));
    }
  }
  return out;
}

export const datasetCommands = {
  /** Adds a Dataset at the end, with the given columns, or one string column `id`. */
  addDataset(id: string, columns?: readonly ColumnDefinition[]): Command {
    return guarded({
      label: `Add Dataset ${id}`,
      run(form) {
        requireId('Dataset', id);
        if (form.datasets?.some((dataset) => dataset.id === id)) throw new CommandError(`There is already a Dataset "${id}"`);
        const list = columns && columns.length > 0 ? columns : [{ id: 'id', type: 'string' as const }];
        const seen = new Set<string>();
        for (const column of list) {
          requireId('column', column.id);
          if (seen.has(column.id)) throw new CommandError(`The column "${column.id}" appears twice`);
          seen.add(column.id);
        }
        return { ...form, datasets: [...(form.datasets ?? []), { id, columns: list.map((column) => ({ ...column })) }] };
      },
    });
  },

  /** Removes a Dataset. Refused, with where it is used, while anything refers to it. */
  removeDataset(id: string, metas?: Metas): Command {
    return guarded({
      label: `Remove Dataset ${id}`,
      run(form) {
        datasetOf(form, id);
        const { uses } = findRefs(form, { dataset: id }, metas);
        if (uses.length > 0) throw new CommandError(inUseMessage(`Dataset "${id}"`, uses));
        const datasets = (form.datasets ?? []).filter((dataset) => dataset.id !== id);
        if (datasets.length > 0) return { ...form, datasets };
        const rest = { ...form };
        delete rest.datasets;
        return rest;
      },
    });
  },

  /** Renames a Dataset, and every binding, option source and expression that names it. */
  renameDataset(id: string, newId: string, metas?: Metas): Command {
    return guarded({
      label: `Rename Dataset ${id} to ${newId}`,
      run(form) {
        requireId('Dataset', newId);
        datasetOf(form, id);
        if (newId === id) return form;
        if (form.datasets?.some((dataset) => dataset.id === newId)) throw new CommandError(`There is already a Dataset "${newId}"`);
        const { form: rewritten } = findRefs(form, { dataset: id, to: newId }, metas);
        return mapDataset(rewritten, id, (dataset) => ({ ...dataset, id: newId }));
      },
    });
  },

  /** Adds a column at `index` (default: the end). Sample rows keep their values. */
  addColumn(datasetId: string, column: ColumnDefinition, index?: number): Command {
    return guarded({
      label: `Add column ${column.id} to ${datasetId}`,
      run(form) {
        requireId('column', column.id);
        return mapDataset(form, datasetId, (dataset) => {
          if (dataset.columns.some((existing) => existing.id === column.id)) throw new CommandError(`Dataset "${datasetId}" already has a column "${column.id}"`);
          const at = index === undefined ? dataset.columns.length : Math.min(Math.max(Math.trunc(index), 0), dataset.columns.length);
          return { ...dataset, columns: [...dataset.columns.slice(0, at), { ...column }, ...dataset.columns.slice(at)] };
        });
      },
    });
  },

  /** Removes a column and its sample values. Refused, with where it is used, while anything refers to it, and for the last column. */
  removeColumn(datasetId: string, columnId: string, metas?: Metas): Command {
    return guarded({
      label: `Remove column ${columnId} from ${datasetId}`,
      run(form) {
        const dataset = datasetOf(form, datasetId);
        columnOf(dataset, columnId);
        if (dataset.columns.length === 1) throw new CommandError(`Dataset "${datasetId}" needs at least one column`);
        const { uses } = findRefs(form, { dataset: datasetId, column: columnId }, metas);
        if (dataset.keys?.includes(columnId)) uses.push(`datasets "${datasetId}" keys`);
        if (uses.length > 0) throw new CommandError(inUseMessage(`Column "${datasetId}.${columnId}"`, uses));
        return mapDataset(form, datasetId, (current) => {
          const next = mapRows({ ...current, columns: current.columns.filter((column) => column.id !== columnId) }, (row) => {
            if (!Object.hasOwn(row, columnId)) return row;
            const copy = { ...row };
            delete copy[columnId];
            return copy;
          });
          return next;
        });
      },
    });
  },

  /** Renames a column, and every binding, Grid cell field, option column, key and expression that names it, and the sample values. */
  renameColumn(datasetId: string, columnId: string, newId: string, metas?: Metas): Command {
    return guarded({
      label: `Rename column ${columnId} to ${newId}`,
      run(form) {
        requireId('column', newId);
        const dataset = datasetOf(form, datasetId);
        columnOf(dataset, columnId);
        if (newId === columnId) return form;
        if (dataset.columns.some((column) => column.id === newId)) throw new CommandError(`Dataset "${datasetId}" already has a column "${newId}"`);
        const { form: rewritten } = findRefs(form, { dataset: datasetId, column: columnId, to: newId }, metas);
        return mapDataset(rewritten, datasetId, (current) => {
          const renamed: DatasetDefinition = {
            ...current,
            columns: current.columns.map((column) => (column.id === columnId ? { ...column, id: newId } : column)),
          };
          if (current.keys) renamed.keys = current.keys.map((key) => (key === columnId ? newId : key));
          // Keep each row's key order, so the text diff stays small.
          return mapRows(renamed, (row) => (Object.hasOwn(row, columnId) ? Object.fromEntries(Object.entries(row).map(([key, value]) => [key === columnId ? newId : key, value])) : row));
        });
      },
    });
  },

  /** Moves a column to `index` among the columns. */
  moveColumn(datasetId: string, columnId: string, index: number): Command {
    return guarded({
      label: `Move column ${columnId}`,
      run(form) {
        const dataset = datasetOf(form, datasetId);
        const from = dataset.columns.findIndex((column) => column.id === columnId);
        if (from < 0) throw new CommandError(`Dataset "${datasetId}" has no column "${columnId}"`);
        const to = Math.min(Math.max(Math.trunc(index), 0), dataset.columns.length - 1);
        if (to === from) return form;
        const columns = dataset.columns.filter((column) => column.id !== columnId);
        columns.splice(to, 0, dataset.columns[from] as ColumnDefinition);
        return mapDataset(form, datasetId, (current) => ({ ...current, columns }));
      },
    });
  },

  /**
   * Sets column attributes (type, size, precision, scale, required, min, max, pattern, label);
   * `undefined` removes one. A new type must still fit the sample values, which are checked.
   */
  setColumn(datasetId: string, columnId: string, attributes: ColumnAttributes): Command {
    return guarded({
      label: `Change column ${columnId}`,
      run(form) {
        checkAttributes(attributes);
        const dataset = datasetOf(form, datasetId);
        const column = columnOf(dataset, columnId);
        const next: ColumnDefinition = { ...column };
        for (const [key, value] of Object.entries(attributes)) {
          if (value === undefined) delete next[key];
          else next[key] = value;
        }
        if (attributes.type !== undefined && attributes.type !== column.type) {
          for (const list of ROW_LISTS) {
            dataset[list]?.forEach((row, i) => {
              if (!Object.hasOwn(row, columnId)) return;
              try {
                coerceValue(next, row[columnId]);
              } catch {
                throw new CommandError(`Row ${i + 1} of ${list} holds ${JSON.stringify(row[columnId])} in "${columnId}", which doesn't fit ${attributes.type}`);
              }
            });
          }
        }
        return mapDataset(form, datasetId, (current) => ({ ...current, columns: current.columns.map((c) => (c.id === columnId ? next : c)) }));
      },
    });
  },

  /** Adds a sample row (the values are checked with `coerceValue`) at `index` (default: the end). */
  addSampleRow(datasetId: string, values: Row = {}, index?: number): Command {
    return guarded({
      label: `Add sample row to ${datasetId}`,
      run(form) {
        const dataset = datasetOf(form, datasetId);
        const rows = dataset.sampleRows ?? [];
        const at = index === undefined ? rows.length : Math.min(Math.max(Math.trunc(index), 0), rows.length);
        const row = coerceRow(dataset, values);
        return mapDataset(form, datasetId, (current) => ({ ...current, sampleRows: [...rows.slice(0, at), row, ...rows.slice(at)] }));
      },
    });
  },

  /** Removes the sample row at a zero-based index. */
  removeSampleRow(datasetId: string, index: number): Command {
    return guarded({
      label: `Remove sample row from ${datasetId}`,
      run(form) {
        const dataset = datasetOf(form, datasetId);
        sampleRowOf(dataset, index);
        return mapDataset(form, datasetId, (current) => ({ ...current, sampleRows: (current.sampleRows ?? []).filter((_row, i) => i !== index) }));
      },
    });
  },

  /** Sets one sample cell, checked with `coerceValue`. `undefined` removes the value from the row. */
  setSampleCell(datasetId: string, index: number, columnId: string, value: unknown): Command {
    return guarded({
      label: `Change sample value of ${columnId}`,
      run(form) {
        const dataset = datasetOf(form, datasetId);
        const column = columnOf(dataset, columnId);
        const row = sampleRowOf(dataset, index);
        const next: Row = { ...row };
        if (value === undefined) {
          if (!Object.hasOwn(row, columnId)) return form;
          delete next[columnId];
        } else {
          try {
            next[columnId] = coerceValue(column, value);
          } catch (error) {
            throw new CommandError(error instanceof Error ? error.message : String(error));
          }
        }
        return mapDataset(form, datasetId, (current) => ({ ...current, sampleRows: (current.sampleRows ?? []).map((existing, i) => (i === index ? next : existing)) }));
      },
    });
  },
} as const;
