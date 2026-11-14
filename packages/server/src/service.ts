import { COLUMN_TYPES } from '@fw/core';
import { ConflictError } from './errors.ts';
import type { DatasetDecl, Service, ServiceContext, ServiceResult, TableDecl } from './types.ts';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SERVICE_ID = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/;

function checkDataset(where: string, decl: DatasetDecl, table?: string): void {
  if (table !== undefined && !IDENTIFIER.test(table)) throw new TypeError(`${where}: "${table}" is not a plain table name`);
  const seen = new Set<string>();
  let versions = 0;
  for (const column of decl.columns) {
    const at = `${where}.${column.id}`;
    if (!IDENTIFIER.test(column.id)) throw new TypeError(`${at}: column ids must be plain identifiers`);
    if (seen.has(column.id)) throw new TypeError(`${at}: declared twice`);
    seen.add(column.id);
    if (!(COLUMN_TYPES as readonly string[]).includes(column.type)) throw new TypeError(`${at}: unknown type "${column.type}"`);
    if (column.version) {
      versions += 1;
      if (column.type !== 'int') throw new TypeError(`${at}: a version column must be an int`);
    }
    if (column.generated !== undefined) {
      if (!column.key) throw new TypeError(`${at}: only a key can be generated`);
      if (column.generated === 'rowid') {
        if (column.type !== 'int') throw new TypeError(`${at}: a rowid key must be an int`);
      } else {
        if (column.type !== 'string') throw new TypeError(`${at}: a sequence key must be a string`);
        if (!column.generated.sequence) throw new TypeError(`${at}: a sequence needs a name`);
      }
    }
  }
  if (versions > 1) throw new TypeError(`${where}: at most one version column`);
  if (table !== undefined && !decl.columns.some((column) => column.key)) throw new TypeError(`${where}: a table needs a key column`);
}

/** Checks a service's declaration and freezes it. Anything built with `tableService` or `customService` has been through this. */
export function defineService(service: Service): Service {
  if (!SERVICE_ID.test(service.id)) throw new TypeError(`"${service.id}" is not a dotted service id such as hr.emp.save`);
  for (const [name, decl] of Object.entries(service.inputs)) {
    checkDataset(`${service.id} input ${name}`, decl, (decl as Partial<TableDecl>).table);
  }
  for (const [name, decl] of Object.entries(service.outputs)) checkDataset(`${service.id} output ${name}`, decl);
  return Object.freeze({ ...service });
}

export interface CustomServiceOptions {
  id: string;
  inputs?: Record<string, DatasetDecl>;
  outputs?: Record<string, DatasetDecl>;
  /**
   * Runs inside the request's transaction, and must be synchronous. A thrown `ConflictError`, `ValidationError` or
   * any other error rolls everything back.
   */
  handler(ctx: ServiceContext): ServiceResult | void;
}

/** A hand-written service. It gets the same limits, validation, transaction and error mapping as a table service. */
export function customService(options: CustomServiceOptions): Service {
  return defineService({ id: options.id, inputs: options.inputs ?? {}, outputs: options.outputs ?? {}, run: options.handler });
}

export interface SaveTotals {
  inserted: number;
  updated: number;
  deleted: number;
  /** Inserted, updated and deleted rows together. */
  total: number;
}

export interface TableServiceOptions {
  id: string;
  /** Input Dataset name to table. Inputs are saved in this order, so list a master before its details. */
  inputs: Record<string, TableDecl>;
  /** The status message when a row was changed by someone else. */
  conflictMessage?: string;
  /** Values for the response's `params`. */
  result?: (totals: SaveTotals) => Record<string, unknown>;
}

/** A save service. The SQL comes from the table declarations, and every value goes in as a parameter. */
export function tableService(options: TableServiceOptions): Service {
  const inputs: Record<string, TableDecl> = {};
  for (const [name, table] of Object.entries(options.inputs)) inputs[name] = { ...table, mode: 'changes' };
  return defineService({
    id: options.id,
    inputs,
    outputs: {},
    run(ctx) {
      const totals: SaveTotals = { inserted: 0, updated: 0, deleted: 0, total: 0 };
      const conflicts = [];
      for (const [name, table] of Object.entries(inputs)) {
        if (ctx.input(name).kind === 'none') continue;
        const outcome = ctx.saveChanges(name, table, { conflicts: 'return' });
        totals.inserted += outcome.inserted;
        totals.updated += outcome.updated;
        totals.deleted += outcome.deleted;
        conflicts.push(...outcome.conflicts);
      }
      if (conflicts.length > 0) throw new ConflictError(conflicts, options.conflictMessage);
      totals.total = totals.inserted + totals.updated + totals.deleted;
      const params = options.result?.(totals);
      return params ? { params } : undefined;
    },
  });
}
