import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { CellValue, DsxRowError } from '@fw/core';
import { BadRequestError, ConflictError, isConstraintError } from './errors.ts';
import { ensureSequenceTable } from './database.ts';
import type { Applied, Change, ColumnDecl, InputDataset, SaveOptions, SaveOutcome, TableDecl } from './types.ts';

const quote = (id: string): string => `"${id}"`;

/** Declared names are checked as plain identifiers when the service is defined, so quoting is enough. */
function tableName(table: TableDecl): string {
  return quote(table.table);
}

/** A value as SQLite should hold it. Ints go in as BigInt so they stay exact, booleans as 0 or 1. */
function bind(column: ColumnDecl, value: CellValue): SQLInputValue {
  if (value === null) return null;
  if (column.type === 'int') return BigInt(value as number);
  if (column.type === 'boolean') return value ? 1n : 0n;
  return value as string | number;
}

function serverColumns(table: TableDecl, sent: readonly ColumnDecl[]): ColumnDecl[] {
  const ids = new Set(sent.map((column) => column.id));
  return table.columns.filter((column) => ids.has(column.id));
}

/**
 * The WHERE clause that finds a row only if it is still as loaded: the key, plus the version if the table has one and
 * it was sent, otherwise every sent column except floats. `IS` makes null and the empty string different from each other.
 */
function unchangedWhere(table: TableDecl, sent: readonly ColumnDecl[], original: Readonly<Record<string, CellValue>>): { sql: string; args: SQLInputValue[] } {
  const present = serverColumns(table, sent);
  const keys = table.columns.filter((column) => column.key);
  for (const key of keys) {
    if (!present.includes(key)) throw new BadRequestError(`The key column ${JSON.stringify(key.id)} must be sent`);
  }
  const version = present.find((column) => column.version);
  const compared = version ? [...keys, version] : present.filter((column) => column.type !== 'float' || column.key);
  const unique = [...new Set(compared)];
  return {
    sql: unique.map((column) => `${quote(column.id)} IS ?`).join(' AND '),
    args: unique.map((column) => bind(column, original[column.id] as CellValue)),
  };
}

export function isUnchanged(db: DatabaseSync, table: TableDecl, original: Readonly<Record<string, CellValue>>): boolean {
  const sent = table.columns.filter((column) => Object.hasOwn(original, column.id));
  const where = unchangedWhere(table, sent, original);
  return db.prepare(`SELECT 1 FROM ${tableName(table)} WHERE ${where.sql}`).get(...where.args) !== undefined;
}

/** The next key of a sequence: one step after the last one handed out, and never one that is already in the table. */
function nextSequenceKey(db: DatabaseSync, table: TableDecl, column: ColumnDecl & { generated: Exclude<ColumnDecl['generated'], 'rowid' | undefined> }): string {
  ensureSequenceTable(db);
  const spec = column.generated;
  const prefix = spec.prefix ?? '';
  const step = spec.step ?? 1;
  const stored = db.prepare('SELECT value FROM fw_sequence WHERE name = ?').get(spec.sequence) as { value: number } | undefined;
  // A sequence only moves forward and is always stored, so a number is never issued twice, even after its row is deleted.
  let last = stored?.value ?? (spec.start ?? step) - step;
  for (;;) {
    last += step;
    const key = prefix + String(last).padStart(spec.width ?? 0, '0');
    const taken = db.prepare(`SELECT 1 FROM ${tableName(table)} WHERE ${quote(column.id)} = ?`).get(key);
    if (taken === undefined) {
      db.prepare('INSERT INTO fw_sequence (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value').run(spec.sequence, last);
      return key;
    }
  }
}

/**
 * Remembers the last version of a row that was deleted, so a row later created under the same key starts above it.
 * Without this, a client still holding the old row at version 1 would pass the check against the new row at version 1.
 */
function ensureTombstones(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS fw_tombstone (tbl TEXT NOT NULL, key TEXT NOT NULL, ver INTEGER NOT NULL, PRIMARY KEY (tbl, key))');
}

function keyText(table: TableDecl, values: Readonly<Record<string, CellValue>>): string {
  return JSON.stringify(table.columns.filter((c) => c.key).map((c) => values[c.id] ?? null));
}

function rememberVersion(db: DatabaseSync, table: TableDecl, key: string, ver: number): void {
  ensureTombstones(db);
  db.prepare(
    'INSERT INTO fw_tombstone (tbl, key, ver) VALUES (?, ?, ?) ON CONFLICT(tbl, key) DO UPDATE SET ver = MAX(ver, excluded.ver)',
  ).run(table.table, key, BigInt(ver));
}

function startingVersion(db: DatabaseSync, table: TableDecl, key: string): number {
  ensureTombstones(db);
  const row = db.prepare('SELECT ver FROM fw_tombstone WHERE tbl = ? AND key = ?').get(table.table, key) as { ver: number } | undefined;
  return (row?.ver ?? 0) + 1;
}

const isBlank = (value: unknown): boolean => value === null || value === undefined || (typeof value === 'string' && value.trim() === '');

function keyWhere(table: TableDecl, values: Readonly<Record<string, CellValue>>): string {
  void values;
  return table.columns.filter((c) => c.key).map((c) => `${quote(c.id)} IS ?`).join(' AND ');
}

function keyArgs(table: TableDecl, values: Readonly<Record<string, CellValue>>): SQLInputValue[] {
  return table.columns.filter((c) => c.key).map((c) => bind(c, values[c.id] as CellValue));
}

function setApplied(applied: Applied, dataset: string, id: number, column: string, value: CellValue): void {
  ((applied[dataset] ??= {})[String(id)] ??= {})[column] = value;
}

function conflictError(dataset: string, id: number): DsxRowError {
  return { dataset, id, code: 'conflict', message: `Row ${id} was changed by someone else` };
}

function constraintFailure(dataset: string, id: number): DsxRowError {
  return { dataset, id, code: 'constraint', message: 'This row clashes with existing data, such as a duplicate key or a missing reference' };
}

/** Deletes, then updates, then inserts. A zero-row delete or update is reported as a conflict, and the caller rolls back. */
export function saveChanges(
  db: DatabaseSync,
  input: InputDataset,
  table: TableDecl,
  applied: Applied,
  failures: DsxRowError[],
  options: SaveOptions = {},
): SaveOutcome {
  if (input.kind === 'rows') throw new BadRequestError(`Dataset ${JSON.stringify(input.name)} takes changes, not rows`);
  const outcome: SaveOutcome = { inserted: 0, updated: 0, deleted: 0, conflicts: [] };
  const sentIds = new Set(input.columns.map((column) => column.id));
  const hasVersion = table.columns.find((column) => column.version);
  const versionSent = hasVersion !== undefined && sentIds.has(hasVersion.id);
  // A constraint failure is noted and the save goes on, so conflicts further down are still found. They win over it.
  const guard = <T>(change: Change, work: () => T): T | undefined => {
    try {
      return work();
    } catch (error) {
      if (isConstraintError(error)) {
        failures.push(constraintFailure(input.name, change.id));
        return undefined;
      }
      throw error;
    }
  };
  const versionName = hasVersion ? quote(hasVersion.id) : '';

  for (const change of input.changes.filter((c) => c.status === 'D')) {
    const where = unchangedWhere(table, input.columns, change.original);
    const sql = `DELETE FROM ${tableName(table)} WHERE ${where.sql}${hasVersion ? ` RETURNING ${versionName} AS v` : ''}`;
    const statement = db.prepare(sql);
    const gone = guard(change, () => (hasVersion ? (statement.get(...where.args) as { v: number | null } | undefined) : statement.run(...where.args).changes > 0 ? { v: 0 } : undefined));
    if (gone === undefined) {
      if (!failures.some((f) => f.dataset === input.name && f.id === change.id)) outcome.conflicts.push(conflictError(input.name, change.id));
      continue;
    }
    outcome.deleted += 1;
    if (hasVersion) rememberVersion(db, table, keyText(table, change.original), gone.v ?? 0);
  }

  for (const change of input.changes.filter((c) => c.status === 'U')) {
    const columns = serverColumns(table, input.columns);
    const set = columns.filter((column) => change.changed.includes(column.id) && !column.version);
    if (set.some((column) => column.generated)) throw new BadRequestError("A generated key can't be changed");
    if (set.length === 0) throw new BadRequestError('An update has no column to change');
    const where = unchangedWhere(table, input.columns, change.original);
    const assignments = set.map((column) => `${quote(column.id)} = ?`);
    if (hasVersion) assignments.push(`${versionName} = COALESCE(${versionName}, 0) + 1`);
    const sql = `UPDATE ${tableName(table)} SET ${assignments.join(', ')} WHERE ${where.sql}${hasVersion ? ` RETURNING ${versionName} AS v` : ''}`;
    const args = [...set.map((column) => bind(column, change.values[column.id] as CellValue)), ...where.args];
    const statement = db.prepare(sql);
    const row = guard(change, () => (hasVersion ? (statement.get(...args) as { v: number } | undefined) : statement.run(...args).changes > 0 ? { v: 0 } : undefined));
    if (!row) {
      if (!failures.some((f) => f.dataset === input.name && f.id === change.id)) outcome.conflicts.push(conflictError(input.name, change.id));
      continue;
    }
    outcome.updated += 1;
    if (hasVersion) {
      const keyChanged = set.some((column) => column.key);
      // Moving a row to another key frees the old one, which must not restart at a version already used.
      if (keyChanged) rememberVersion(db, table, keyText(table, change.original), row.v);
      // A row that takes over a key some other row used before must start above that row's last version.
      const floor = keyChanged ? startingVersion(db, table, keyText(table, { ...change.original, ...change.values })) : 0;
      if (floor > row.v) {
        db.prepare(`UPDATE ${tableName(table)} SET ${versionName} = ? WHERE ${keyWhere(table, { ...change.original, ...change.values })}`).run(
          BigInt(floor),
          ...keyArgs(table, { ...change.original, ...change.values }),
        );
        row.v = floor;
      }
      if (versionSent) setApplied(applied, input.name, change.id, hasVersion.id, row.v);
    }
  }

  // Keys are generated in id order, so the same request always gets the same keys.
  for (const change of input.changes.filter((c) => c.status === 'I').sort((a, b) => a.id - b.id)) {
    const values: Record<string, CellValue | undefined> = {};
    let rowid: ColumnDecl | undefined;
    const generatedHere: [ColumnDecl, CellValue][] = [];
    for (const column of table.columns) {
      let value: CellValue | undefined = sentIds.has(column.id) ? (change.values[column.id] as CellValue) : undefined;
      // An empty or blank value counts as not given.
      if (column.generated !== undefined && isBlank(value)) {
        if (column.generated === 'rowid') {
          rowid = column;
          continue;
        }
        value = nextSequenceKey(db, table, column as Parameters<typeof nextSequenceKey>[2]);
        generatedHere.push([column, value]);
      }
      values[column.id] = value;
    }
    const full = values as Record<string, CellValue>;
    if (hasVersion) values[hasVersion.id] = rowid ? 1 : startingVersion(db, table, keyText(table, full));
    const names: string[] = [];
    const args: SQLInputValue[] = [];
    for (const column of table.columns) {
      const value = values[column.id];
      if (value === undefined) continue;
      names.push(quote(column.id));
      args.push(bind(column, value));
    }
    const sql = names.length === 0 ? `INSERT INTO ${tableName(table)} DEFAULT VALUES` : `INSERT INTO ${tableName(table)} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`;
    const result = guard(change, () => db.prepare(sql).run(...args));
    if (result === undefined) continue;
    outcome.inserted += 1;
    let version = hasVersion ? (values[hasVersion.id] as number) : 0;
    if (rowid) {
      const assigned = Number(result.lastInsertRowid);
      if (!Number.isSafeInteger(assigned)) throw new Error('The generated key is too large');
      generatedHere.push([rowid, assigned]);
      if (hasVersion) {
        // SQLite hands out rowids above the largest one in use, so a deleted top row's number can come back.
        const floor = startingVersion(db, table, keyText(table, { ...full, [rowid.id]: assigned }));
        if (floor > version) {
          db.prepare(`UPDATE ${tableName(table)} SET ${versionName} = ? WHERE ${quote(rowid.id)} = ?`).run(BigInt(floor), BigInt(assigned));
          version = floor;
        }
      }
    }
    for (const [column, value] of generatedHere) if (sentIds.has(column.id)) setApplied(applied, input.name, change.id, column.id, value);
    if (hasVersion && versionSent) setApplied(applied, input.name, change.id, hasVersion.id, version);
  }

  if (outcome.conflicts.length > 0 && options.conflicts !== 'return') throw new ConflictError(outcome.conflicts);
  return outcome;
}
