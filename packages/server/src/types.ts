import type { DatabaseSync } from 'node:sqlite';
import type { CellValue, ColumnType, DsxRowError } from '@fw/core';
import type { FastifyRequest } from 'fastify';

/** Generated keys: `'rowid'` lets SQLite assign an INTEGER PRIMARY KEY, a sequence builds text such as `E1003`. */
export type GeneratedKey =
  | 'rowid'
  | {
      /** The counter's name. It is shared by every service that uses the same name. */
      sequence: string;
      prefix?: string;
      /** Digits are padded with zeros to this width. */
      width?: number;
      /** The difference between two generated numbers. Defaults to 1. */
      step?: number;
      /** The first number if the table has no numbered rows yet. Defaults to `step`. */
      start?: number;
    };

/** A column as the server knows it. The server validates against this and never against the client's own columns. */
export interface ColumnDecl {
  /** Also the SQL column name, so it must be a plain identifier. */
  id: string;
  type: ColumnType;
  size?: number;
  precision?: number;
  scale?: number;
  label?: string;
  /** A saved value can't be null or an empty string. */
  required?: boolean;
  key?: boolean;
  /** Assigned by the server on insert when the client sends null. Needs `key`. */
  generated?: GeneratedKey;
  /** Counts up by one on every update. The conflict check uses it instead of comparing every column. */
  version?: boolean;
  /** A saved value below this is rejected with code `range`. Decimals compare exactly. */
  min?: { value: string | number; message: string };
}

export interface DatasetDecl {
  columns: readonly ColumnDecl[];
  /** `changes` accepts only I/U/D changes, `rows` only whole rows. The default accepts either. */
  mode?: 'changes' | 'rows' | 'any';
}

export interface TableDecl extends DatasetDecl {
  table: string;
}

export interface Row {
  /** The client row id: the `ids` entry, or the row's position if the client sent none. */
  id: number;
  /** By column id, for the columns the client sent. */
  values: Record<string, CellValue>;
}

export interface Change {
  id: number;
  status: 'I' | 'U' | 'D';
  /** New values for I and U, last known values for D. By column id, for the columns the client sent. */
  values: Record<string, CellValue>;
  /** What the database must still hold: the loaded value of every sent column. */
  original: Record<string, CellValue>;
  /** Ids of the columns that changed (U only). */
  changed: string[];
}

export interface InputDataset {
  name: string;
  /** The columns the client sent, as the server declares them, in the client's order. */
  columns: readonly ColumnDecl[];
  kind: 'none' | 'rows' | 'changes';
  rows: readonly Row[];
  changes: readonly Change[];
}

export interface SaveOutcome {
  inserted: number;
  updated: number;
  deleted: number;
  conflicts: DsxRowError[];
}

export interface SaveOptions {
  /** By default a zero-row update or delete throws a `ConflictError`. `'return'` hands the conflicts back in the outcome instead. */
  conflicts?: 'throw' | 'return';
}

export type Applied = Record<string, Record<string, Record<string, CellValue>>>;

export interface ServiceContext {
  /** Inside the request's transaction. Handlers are synchronous so nothing else can run in between. */
  readonly db: DatabaseSync;
  readonly txId: string;
  readonly serviceId: string;
  readonly params: Readonly<Record<string, unknown>>;
  /** The HTTP request, for identity checks. */
  readonly request: FastifyRequest;
  /** Server-assigned values to return. `saveChanges` fills it, and a handler can add to it. */
  readonly applied: Applied;
  /** A declared input. One the client didn't send comes back with kind `none`. */
  input(name: string): InputDataset;
  /**
   * Persists a `changes` input: deletes, then updates, then inserts. A zero-row update or delete is a conflict, and
   * by default it throws a `ConflictError`, which rolls everything back and answers 409. Pass `{ conflicts: 'return' }`
   * to get them in the outcome instead, and throw a `ConflictError` yourself once you have looked at every input.
   */
  saveChanges(inputName: string, table: TableDecl, options?: SaveOptions): SaveOutcome;
  /** True if a row with these loaded values still exists unchanged. By version if the table has one and `original` has it. */
  isUnchanged(table: TableDecl, original: Readonly<Record<string, CellValue>>): boolean;
}

export interface ServiceResult {
  params?: Record<string, unknown>;
  /** Rows as objects by column id, for datasets declared in `outputs`. */
  datasets?: Record<string, readonly Record<string, unknown>[]>;
}

export interface Service {
  readonly id: string;
  readonly inputs: Readonly<Record<string, DatasetDecl>>;
  readonly outputs: Readonly<Record<string, DatasetDecl>>;
  run(ctx: ServiceContext): ServiceResult | void;
}

export interface ServerLogger {
  error(details: Record<string, unknown>, message: string): void;
}

export interface Limits {
  bodyBytes: number;
  datasets: number;
  /** Per Dataset. */
  columns: number;
  /** Per Dataset: rows or changes. */
  rows: number;
}

export type Authorize = (request: FastifyRequest, service: Pick<Service, 'id'>) => boolean | Promise<boolean>;

export const DEFAULT_LIMITS: Limits = { bodyBytes: 5 * 1024 * 1024, datasets: 20, columns: 100, rows: 100_000 };
