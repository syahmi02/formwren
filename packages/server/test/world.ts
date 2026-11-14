import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { customService, openDatabase, setSequence, tableService, type ColumnDecl, type Service, type TableDecl } from '../src/index.ts';

/** The tables and services the golden vectors run against (see manifest.json, `world`). */
const empColumns: ColumnDecl[] = [
  { id: 'empNo', type: 'string', size: 10, key: true, generated: { sequence: 'emp', prefix: 'E', width: 4 } },
  { id: 'empName', type: 'string', size: 50, required: true, label: 'A name' },
  { id: 'salary', type: 'decimal', precision: 12, scale: 0, label: 'Salary' },
  { id: 'ver', type: 'int', version: true },
];
export const empTable: TableDecl = { table: 'emp', columns: empColumns };

export const deptTable: TableDecl = {
  table: 'dept',
  columns: [
    { id: 'deptCode', type: 'string', size: 4, key: true, generated: { sequence: 'dept', prefix: 'D', width: 3, step: 10 } },
    { id: 'deptName', type: 'string', size: 30, required: true },
  ],
};

const typesColumns: ColumnDecl[] = [
  { id: 'id', type: 'int', key: true },
  { id: 'amount', type: 'decimal', precision: 30, scale: 10 },
  { id: 'day', type: 'date' },
  { id: 'stamp', type: 'datetime' },
  { id: 'note', type: 'string', size: 40 },
  { id: 'count', type: 'int' },
];
export const typesTable: TableDecl = { table: 'qa_types', columns: typesColumns };

export const worldServices: Service[] = [
  tableService({ id: 'hr.emp.save', inputs: { dsEmp: empTable }, result: (t) => ({ saved: t.total }) }),
  tableService({ id: 'hr.org.save', inputs: { dsEmp: empTable, dsDept: deptTable } }),
  tableService({ id: 'hr.dept.save', inputs: { dsDept: deptTable } }),
  tableService({ id: 'qa.types.save', inputs: { dsT: typesTable } }),
  customService({
    id: 'qa.types.list',
    outputs: { dsT: { columns: typesColumns.map(({ key: _key, ...rest }) => rest) } },
    handler: (ctx) => ({ datasets: { dsT: ctx.db.prepare('SELECT * FROM qa_types ORDER BY id').all() as Record<string, unknown>[] } }),
  }),
];

export const worldSchema = `
  CREATE TABLE emp (empNo TEXT PRIMARY KEY, empName TEXT NOT NULL, salary TEXT, ver INTEGER);
  CREATE TABLE dept (deptCode TEXT PRIMARY KEY, deptName TEXT NOT NULL);
  CREATE TABLE qa_types (id INTEGER PRIMARY KEY, amount TEXT, day TEXT, stamp TEXT, note TEXT, count INTEGER);
`;

export function seedWorld(db: DatabaseSync): void {
  db.exec(worldSchema);
  const emp = db.prepare('INSERT INTO emp VALUES (?, ?, ?, ?)');
  emp.run('E0999', 'Seojun Park', '3900000', 3);
  emp.run('E1001', 'Minju Kim', '5200000', 7);
  emp.run('E1002', 'Ara Cho', '4000000', 1);
  db.exec("INSERT INTO dept VALUES ('D010', 'Sales'), ('D020', 'Ops')");
  setSequence(db, 'emp', 1002);
  setSequence(db, 'dept', 20);
}

/** A real SQLite file in a temp folder. */
export function tempDatabase(): { db: DatabaseSync; path: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'fw-server-'));
  const path = join(dir, 'test.db');
  const db = openDatabase(path);
  return {
    db,
    path,
    cleanup() {
      try {
        db.close();
      } catch {
        // Already closed.
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
