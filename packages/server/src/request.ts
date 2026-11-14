import { coerceValue, decCompare, decFits, isDecimal, type CellValue, type DsxRowError } from '@fw/core';
import { BadRequestError } from './errors.ts';
import type { Change, ColumnDecl, DatasetDecl, InputDataset, Limits, Row, Service } from './types.ts';

export interface Envelope {
  txId: string;
  params: Record<string, unknown>;
  datasets: Record<string, unknown>;
}

const MAX_ERRORS = 100;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A client-supplied name for a message, cut short so a hostile one can't flood a response. */
function shown(text: unknown): string {
  const s = typeof text === 'string' ? text : typeof text;
  return JSON.stringify(s.length > 40 ? `${s.slice(0, 40)}...` : s);
}

/** The shape and the limits, which are checked before anything else is done with the request. */
export function checkEnvelope(body: unknown, serviceId: string, limits: Limits): Envelope {
  if (!isObject(body)) throw new BadRequestError('The body must be a JSON object');
  if (body['dsx'] !== 1) throw new BadRequestError('Only DSX version 1 is supported');
  if (typeof body['txId'] !== 'string' || body['txId'].length === 0 || body['txId'].length > 200) {
    throw new BadRequestError('txId must be a non-empty string');
  }
  if (body['service'] !== serviceId) throw new BadRequestError('The service in the body must match the URL');
  const params = body['params'] ?? {};
  if (!isObject(params)) throw new BadRequestError('params must be an object');
  const datasets = body['datasets'] ?? {};
  if (!isObject(datasets)) throw new BadRequestError('datasets must be an object');

  const names = Object.keys(datasets);
  if (names.length > limits.datasets) throw new BadRequestError(`A request can have at most ${limits.datasets} datasets`, 'limit');
  for (const name of names) {
    const ds = datasets[name];
    if (!isObject(ds)) throw new BadRequestError(`Dataset ${shown(name)} must be an object`);
    if (!Array.isArray(ds['columns'])) throw new BadRequestError(`Dataset ${shown(name)} needs a columns array`);
    if (ds['columns'].length > limits.columns) throw new BadRequestError(`A dataset can have at most ${limits.columns} columns`, 'limit');
    for (const key of ['rows', 'changes', 'ids'] as const) {
      const list = ds[key];
      if (list === undefined) continue;
      if (!Array.isArray(list)) throw new BadRequestError(`${key} of dataset ${shown(name)} must be an array`);
      if (list.length > limits.rows) throw new BadRequestError(`A dataset can have at most ${limits.rows} rows`, 'limit');
    }
  }
  return { txId: body['txId'], params, datasets };
}

function isCell(value: unknown): value is CellValue {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isRowId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** Resolves the client's columns against the server's declaration. Throws if one is unknown or has another type. */
function resolveColumns(name: string, decl: DatasetDecl, sent: unknown[]): ColumnDecl[] {
  const known = new Map(decl.columns.map((column) => [column.id, column]));
  const seen = new Set<string>();
  return sent.map((raw) => {
    if (!isObject(raw) || typeof raw['id'] !== 'string') throw new BadRequestError(`A column of dataset ${shown(name)} has no id`);
    const column = known.get(raw['id']);
    if (!column) throw new BadRequestError(`Unknown column ${shown(raw['id'])} in dataset ${shown(name)}`);
    if (raw['type'] !== column.type) throw new BadRequestError(`Column ${shown(raw['id'])} of dataset ${shown(name)} has another type on the server`);
    if (seen.has(column.id)) throw new BadRequestError(`Column ${shown(raw['id'])} appears twice in dataset ${shown(name)}`);
    seen.add(column.id);
    return column;
  });
}

function toRecord(columns: readonly ColumnDecl[], cells: readonly CellValue[]): Record<string, CellValue> {
  const record: Record<string, CellValue> = {};
  columns.forEach((column, i) => {
    record[column.id] = cells[i] as CellValue;
  });
  return record;
}

/** Reads the cells of one row, checking only that there is one per column and each is a plain value. */
function readCells(where: string, columns: readonly ColumnDecl[], cells: unknown): CellValue[] {
  if (!Array.isArray(cells) || cells.length !== columns.length) {
    throw new BadRequestError(`${where} needs ${columns.length} values, one per column`);
  }
  for (const cell of cells) if (!isCell(cell)) throw new BadRequestError(`${where} has a value that isn't a string, number, boolean or null`);
  return cells as CellValue[];
}

/**
 * Turns the request's Datasets into `InputDataset`s for the service's declared inputs. Anything that makes the
 * request unreadable throws `BadRequestError`. Values are checked separately, by `validateInputs`.
 */
export function parseInputs(service: Service, envelope: Envelope): Map<string, InputDataset> {
  const result = new Map<string, InputDataset>();
  for (const [name, raw] of Object.entries(envelope.datasets)) {
    const decl = Object.hasOwn(service.inputs, name) ? service.inputs[name] : undefined;
    if (!decl) throw new BadRequestError(`This service has no input dataset ${shown(name)}`);
    const ds = raw as Record<string, unknown>;
    const columns = resolveColumns(name, decl, ds['columns'] as unknown[]);
    const mode = decl.mode ?? 'any';
    const hasRows = ds['rows'] !== undefined;
    const hasChanges = ds['changes'] !== undefined;
    if (hasRows && hasChanges) throw new BadRequestError(`Dataset ${shown(name)} has both rows and changes`);
    if (hasRows && mode === 'changes') throw new BadRequestError(`Dataset ${shown(name)} takes changes, not rows`);
    if (hasChanges && mode === 'rows') throw new BadRequestError(`Dataset ${shown(name)} takes rows, not changes`);

    const input: InputDataset = { name, columns, kind: 'none', rows: [], changes: [] };
    if (hasRows) {
      const list = ds['rows'] as unknown[];
      const ids = ds['ids'];
      if (ids !== undefined && (!Array.isArray(ids) || ids.length !== list.length || !ids.every(isRowId))) {
        throw new BadRequestError(`ids of dataset ${shown(name)} must be one row id per row`);
      }
      const rows: Row[] = list.map((cells, i) => ({
        id: ids === undefined ? i : (ids as number[])[i]!,
        values: toRecord(columns, readCells(`Row ${i} of dataset ${shown(name)}`, columns, cells)),
      }));
      Object.assign(input, { kind: 'rows', rows });
    } else if (hasChanges) {
      const changes: Change[] = (ds['changes'] as unknown[]).map((raw, i) => parseChange(name, columns, raw, i));
      Object.assign(input, { kind: 'changes', changes });
    }
    result.set(name, input);
  }
  return result;
}

function parseChange(name: string, columns: readonly ColumnDecl[], raw: unknown, index: number): Change {
  const where = `Change ${index} of dataset ${shown(name)}`;
  if (!isObject(raw)) throw new BadRequestError(`${where} must be an object`);
  const status = raw['s'];
  if (status !== 'I' && status !== 'U' && status !== 'D') throw new BadRequestError(`${where} has an unknown status`);
  if (!isRowId(raw['id'])) throw new BadRequestError(`${where} needs an integer id`);
  const values = toRecord(columns, readCells(where, columns, raw['v']));
  const original: Record<string, CellValue> = { ...values };
  const changed: string[] = [];
  const o = raw['o'];
  if (o !== undefined) {
    if (!isObject(o)) throw new BadRequestError(`${where} has an invalid o`);
    for (const [position, value] of Object.entries(o)) {
      const at = /^(0|[1-9]\d*)$/.test(position) ? Number(position) : -1;
      const column = columns[at];
      if (!column) throw new BadRequestError(`${where} names a column position that doesn't exist`);
      if (!isCell(value)) throw new BadRequestError(`${where} has an original value of the wrong kind`);
      original[column.id] = value;
      changed.push(column.id);
    }
  }
  if (status === 'U' && changed.length === 0) throw new BadRequestError(`${where} is an update with no changed columns`);
  if (status !== 'U' && changed.length > 0) throw new BadRequestError(`${where} has original values but isn't an update`);
  return { id: raw['id'], status, values, original, changed };
}

/** A key the server doesn't generate must always be given. */
function isRequired(column: ColumnDecl): boolean {
  return column.required === true || (column.key === true && !column.generated);
}

type Fault = { code: string; message: string };

function label(column: ColumnDecl): string {
  return column.label ?? column.id;
}

/** Checks that a value is of the column's type, without looking at size or precision. */
function checkType(column: ColumnDecl, value: CellValue): Fault | undefined {
  if (value === null) return undefined;
  const bad = (): Fault => ({ code: 'type', message: `${label(column)} isn't a valid ${column.type}` });
  switch (column.type) {
    case 'string':
      return typeof value === 'string' ? undefined : bad();
    case 'int':
      return Number.isSafeInteger(value) ? undefined : bad();
    case 'float':
      return typeof value === 'number' && Number.isFinite(value) ? undefined : bad();
    case 'boolean':
      return typeof value === 'boolean' ? undefined : bad();
    case 'decimal':
      // Decimals travel as text. A JSON number would already have been rounded to a double.
      return typeof value === 'string' && isDecimal(value) ? undefined : bad();
    case 'date':
    case 'datetime':
      try {
        coerceValue({ id: column.id, type: column.type }, value);
        return undefined;
      } catch {
        return bad();
      }
  }
}

/** Checks a value that will be saved: type, size, precision and range. */
function checkWritten(column: ColumnDecl, value: CellValue): Fault | undefined {
  const fault = checkType(column, value);
  if (fault || value === null) return fault;
  if (column.key && column.type === 'string' && value !== (value as string).trim()) {
    return { code: 'pattern', message: `${label(column)} can't start or end with a space` };
  }
  if (column.type === 'string' && column.size !== undefined && (value as string).length > column.size) {
    return { code: 'length', message: `${label(column)} can be at most ${column.size} characters` };
  }
  if (column.type === 'decimal') {
    const text = value as string;
    if (column.scale !== undefined && !decFits(text, undefined, column.scale)) {
      return {
        code: 'scale',
        message: column.scale === 0 ? `${label(column)} can have no decimal places` : `${label(column)} can have at most ${column.scale} decimal places`,
      };
    }
    if (!decFits(text, column.precision, column.scale)) {
      return { code: 'precision', message: `${label(column)} doesn't fit precision ${column.precision ?? '-'} and scale ${column.scale ?? '-'}` };
    }
  }
  if (column.min !== undefined && value !== '') {
    const min = column.min.value;
    const below = column.type === 'decimal' ? decCompare(value as string, String(min)) < 0 : typeof value === 'number' && value < Number(min);
    if (below) return { code: 'range', message: column.min.message };
  }
  return undefined;
}

export interface Validated {
  errors: DsxRowError[];
  /** The number of errors, which can be more than the ones returned. */
  count: number;
}

/**
 * Checks every value of every row against the server's declaration, before anything is written. A saved row
 * (insert, or the changed columns of an update) is checked fully. Values that are only compared are checked for type.
 */
export function validateInputs(service: Service, inputs: ReadonlyMap<string, InputDataset>): Validated {
  const errors: DsxRowError[] = [];
  let count = 0;
  const add = (dataset: string, id: number, column: ColumnDecl, fault: Fault): void => {
    count += 1;
    if (errors.length < MAX_ERRORS) errors.push({ dataset, id, column: column.id, code: fault.code, message: fault.message });
  };

  for (const input of inputs.values()) {
    const declared = service.inputs[input.name]?.columns ?? [];
    const check = (id: number, values: Record<string, CellValue>, written: (column: ColumnDecl) => boolean, requireAll: boolean): void => {
      for (const column of input.columns) {
        const value = values[column.id] as CellValue;
        if (column.version) continue;
        if (!written(column)) {
          const fault = checkType(column, value);
          if (fault) add(input.name, id, column, fault);
          continue;
        }
        const blank = value === null || (typeof value === 'string' && value.trim() === '');
        // A generated key that is empty or blank is not given, and the server assigns one.
        if (column.generated && blank) continue;
        if (isRequired(column) && (value === null || value === '')) {
          add(input.name, id, column, { code: 'required', message: `${label(column)} is required` });
          continue;
        }
        const fault = checkWritten(column, value);
        if (fault) add(input.name, id, column, fault);
      }
      if (!requireAll) return;
      // A required column the client left out of its columns can't have a value.
      const sent = new Set(input.columns.map((column) => column.id));
      for (const column of declared) {
        if (isRequired(column) && !column.generated && !column.version && !sent.has(column.id)) {
          add(input.name, id, column, { code: 'required', message: `${label(column)} is required` });
        }
      }
    };

    for (const row of input.rows) check(row.id, row.values, () => true, false);
    for (const change of input.changes) {
      if (change.status === 'I') check(change.id, change.values, () => true, true);
      else if (change.status === 'U') {
        const changed = new Set(change.changed);
        check(change.id, change.values, (column) => changed.has(column.id), false);
        // The loaded values in `o` are only compared, so they get the type check.
        for (const id of change.changed) {
          const column = input.columns.find((c) => c.id === id);
          const fault = column && checkType(column, change.original[id] as CellValue);
          if (column && fault) add(input.name, change.id, column, fault);
        }
      } else check(change.id, change.values, () => false, false);
    }
  }
  return { errors, count };
}
