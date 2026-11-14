/** The shared contract for transactions and the DSX/1 wire format (FRAMEWORK.md §6). See docs/plans/step-2.md. */
import type { Dataset } from '../dataset.ts';
import type { CellValue, ColumnType } from '../values.ts';

export interface DsxColumn {
  id: string;
  type: ColumnType;
  size?: number;
  precision?: number;
  scale?: number;
  key?: boolean;
  version?: boolean;
}

export interface DsxChange {
  s: 'I' | 'U' | 'D';
  /** The client row id. */
  id: number;
  v: CellValue[];
  /** Original values of changed columns, by column position. Its keys are the changed columns. */
  o?: Record<string, CellValue>;
}

export interface DsxRequestDataset {
  columns: DsxColumn[];
  rows?: CellValue[][];
  /** With `rows`: the client row id of each row, so server errors map to the right row. */
  ids?: number[];
  changes?: DsxChange[];
}

export interface DsxRequest {
  dsx: 1;
  txId: string;
  service: string;
  params?: Record<string, unknown>;
  datasets?: Record<string, DsxRequestDataset>;
}

export interface DsxStatus {
  ok: boolean;
  code?: string;
  message?: string;
}

export interface DsxRowError {
  /** The input Dataset's name in the request. */
  dataset?: string;
  /** The client row id. */
  id?: number;
  column?: string;
  code: string;
  message: string;
}

export interface DsxResponseDataset {
  columns: DsxColumn[];
  rows: CellValue[][];
}

export interface DsxResponse {
  status: DsxStatus;
  params?: Record<string, unknown>;
  datasets?: Record<string, DsxResponseDataset>;
  /** Server-assigned values: input Dataset name, then client row id, then column. */
  applied?: Record<string, Record<string, Record<string, CellValue>>>;
  errors?: DsxRowError[];
}

/** How a request reaches a server. The fixture transport is for tests and previews, and `httpTransport` talks to the real server. `screen` is the form id, sent as the `DSX-Screen` header. */
export interface Transport {
  send(request: DsxRequest, options: { signal: AbortSignal; screen?: string }): Promise<DsxResponse>;
}

/** `selected` sends the Dataset's selected rows, in the same shape as `all`. */
export type TxRowSelection = 'all' | 'changed' | 'selected';

/** Any Dataset, whatever its column types. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDataset = Dataset<any>;

export type TxInput = AnyDataset | { dataset: AnyDataset; rows: TxRowSelection };

export type TxOutputMode = 'replace' | 'append';

export type TxOutput = AnyDataset | { dataset: AnyDataset; mode: TxOutputMode };

export interface TxCallOptions {
  service: string;
  /** Wire name to Dataset. A bare Dataset sends all rows. */
  inputs?: Record<string, TxInput>;
  /** Wire name to Dataset. A bare Dataset replaces its rows. */
  outputs?: Record<string, TxOutput>;
  params?: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface TxResult {
  status: DsxStatus;
  params: Record<string, unknown>;
  /** Wire names of outputs not applied, because their Dataset has edits made during its own save. */
  skippedOutputs: string[];
}

export interface TxClient {
  /**
   * Rejects with `TransactionError` if the server reports failure or the call can't complete. In
   * that case nothing was accepted, so edits and row status stay as they were for a retry. A call
   * to a service that already has one running is rejected with code 'duplicate'.
   */
  call(options: TxCallOptions): Promise<TxResult>;
}

export class TransactionError extends Error {
  readonly code: string;
  readonly rowErrors: readonly DsxRowError[];
  /** True when the server committed but the client couldn't finish applying the result. Saves are accepted. */
  readonly committed: boolean;
  /**
   * True when the request may have reached the server and the client can't tell whether it
   * committed: `network`, `timeout`, `aborted` after the request was sent, and a 2xx or 5xx answer
   * that isn't DSX. A response with a DSX body, a request that never started, and an abort before
   * sending are never unknown. Edits and row status are kept as for any failure, so the screen
   * should say "outcome unknown" and have the user check before saving again, because a retry
   * can duplicate inserts.
   */
  readonly outcomeUnknown: boolean;

  constructor(code: string, message: string, rowErrors: readonly DsxRowError[] = [], committed = false, outcomeUnknown = false) {
    super(message);
    this.outcomeUnknown = outcomeUnknown;
    this.committed = committed;
    this.name = 'TransactionError';
    this.code = code;
    this.rowErrors = rowErrors;
  }
}
