import { Dataset, type SaveTicket } from '../dataset.ts';
import { coerceValue, type CellValue } from '../values.ts';
import {
  TransactionError,
  type AnyDataset,
  type DsxChange,
  type DsxColumn,
  type DsxRequestDataset,
  type DsxResponseDataset,
  type TxInput,
  type TxOutput,
  type TxOutputMode,
  type TxRowSelection,
} from './contract.ts';

export function normalizeInput(input: TxInput): { dataset: AnyDataset; rows: TxRowSelection } {
  return input instanceof Dataset ? { dataset: input, rows: 'all' } : input;
}

export function normalizeOutput(output: TxOutput): { dataset: AnyDataset; mode: TxOutputMode } {
  return output instanceof Dataset ? { dataset: output, mode: 'replace' } : output;
}

function describeColumns(ds: AnyDataset): DsxColumn[] {
  return ds.columns.map((column) => {
    const out: DsxColumn = { id: column.id, type: column.type };
    if (column.size !== undefined) out.size = column.size;
    if (column.precision !== undefined) out.precision = column.precision;
    if (column.scale !== undefined) out.scale = column.scale;
    if (ds.keys.includes(column.id)) out.key = true;
    if (column.version === true) out.version = true;
    return out;
  });
}

/**
 * Builds the request part for one input Dataset. `all` sends the visible rows in view order.
 * `changed` sends the ticket's changes, so pass the ticket from `beginSave()` that will later be
 * accepted: what is sent then equals what is accepted. Without a ticket it takes a fresh one.
 * A column declared `version: true` is sent with that flag.
 */
export function encodeInput(name: string, input: TxInput, ticket?: SaveTicket): DsxRequestDataset {
  const { dataset: ds, rows } = normalizeInput(input);
  if (rows !== 'all' && rows !== 'changed' && rows !== 'selected') {
    throw new TransactionError('bad-request', `Input "${name}": rows must be 'all', 'changed' or 'selected'`);
  }
  const columns = describeColumns(ds);
  if (rows === 'selected') {
    const wanted = new Set(ds.selectedRows());
    const live = ds.liveRows();
    const keep = live.ids.map((id, i) => (wanted.has(id) ? i : -1)).filter((i) => i >= 0);
    return { columns, rows: keep.map((i) => live.rows[i] as CellValue[]), ids: keep.map((i) => live.ids[i] as number) };
  }
  if (rows === 'all') {
    // Every live row, whatever the filter, so a whole-set replace can't lose hidden rows.
    const live = ds.liveRows();
    return { columns, rows: live.rows, ids: live.ids };
  }
  const changes: DsxChange[] = (ticket ?? ds.beginSave()).changes.map((change) => {
    const out: DsxChange = { s: change.status, id: change.rowId, v: change.values.slice() };
    if (change.originals) {
      const o: Record<string, CellValue> = {};
      for (const [position, value] of Object.entries(change.originals)) o[position] = value;
      out.o = o;
    }
    return out;
  });
  return { columns, changes };
}

function bad(message: string): never {
  throw new TransactionError('bad-response', message);
}

/**
 * Checks a response Dataset against the target and returns its rows in the target's column order,
 * without touching the target. Throws `TransactionError` 'bad-response' if anything doesn't fit.
 */
export function prepareOutput(name: string, response: DsxResponseDataset | undefined, target: AnyDataset): CellValue[][] {
  if (!response || !Array.isArray(response.columns) || !Array.isArray(response.rows)) {
    return bad(`The response has no usable dataset "${name}"`);
  }
  const position = new Map<string, number>();
  response.columns.forEach((column, index) => {
    if (column && typeof column.id === 'string') position.set(column.id, index);
  });
  const sources = target.columns.map((column) => position.get(column.id));
  const width = response.columns.length;

  return response.rows.map((row, r) => {
    if (!Array.isArray(row) || row.length !== width) {
      return bad(`Dataset "${name}" row ${r} doesn't have ${width} values`);
    }
    return target.columns.map((column, c) => {
      const source = sources[c];
      if (source === undefined) return null;
      try {
        return coerceValue(column, row[source]);
      } catch (error) {
        return bad(`Dataset "${name}" row ${r}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  });
}

/** Loads a response Dataset into the target by column id. A bad value rejects and leaves the target unchanged. */
export function decodeOutput(response: DsxResponseDataset, target: AnyDataset, options: { append?: boolean } = {}): void {
  const rows = prepareOutput(target.id, response, target);
  target.load(rows, { append: options.append === true });
}
