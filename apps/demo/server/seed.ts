import type { DatabaseSync } from 'node:sqlite';
import { setSequence } from '@fw/server';

/**
 * The demo's tables. Salaries are TEXT so six-place decimals stay exact, and dates are TEXT too. The reference from
 * an employee to a department is checked at commit, so a save can change both in any order.
 */
const SCHEMA = `
  CREATE TABLE department (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    ver  INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE employee (
    empNo   TEXT PRIMARY KEY,
    empName TEXT NOT NULL,
    dept    TEXT REFERENCES department (code) DEFERRABLE INITIALLY DEFERRED,
    level   TEXT,
    active  INTEGER,
    salary  TEXT,
    hiredOn TEXT,
    ver     INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX employee_dept ON employee (dept);
`;

const DEPARTMENTS = [
  ['ENG', 'Engineering'],
  ['SAL', 'Sales'],
  ['HR', 'Human Resources'],
  ['FIN', 'Finance'],
  ['OPS', 'Operations'],
] as const;

const NAMES = [
  'Alice Carter', 'Benjamin Hughes', 'Clara Jennings', 'Daniel Foster', 'Eleanor Brooks',
  'Frederick Mills', 'Grace Sullivan', 'Henry Parker', 'Isabel Reed', 'Jonathan Bailey',
  'Katherine Ward', 'Liam Murphy', 'Margaret Cole', 'Nathan Price', 'Olivia Hayes',
  'Patrick Russell', 'Quinn Ellis', 'Rebecca Stone', 'Samuel Wright', 'Teresa Grant',
  'Umar Khan', 'Victoria Lane', 'William Doyle', 'Xavier Moore', 'Yvonne Fisher',
];

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

/** Everything is derived from the index, so the same 25 employees come out every time. */
function employeeRows(): (string | number)[][] {
  return NAMES.map((name, i) => [
    `E${pad(i + 1, 3)}`,
    name,
    DEPARTMENTS[i % DEPARTMENTS.length]?.[0] ?? 'ENG',
    'ABC'[i % 3] ?? 'A',
    i % 7 !== 6 ? 1 : 0,
    `${48000 + i * 1733}.${pad(((i * 7919 + 104729) % 1_000_000), 6)}`,
    `${2012 + (i % 12)}-${pad(((i * 5) % 12) + 1, 2)}-${pad(((i * 11) % 28) + 1, 2)}`,
  ]);
}

/** Drops and rebuilds the demo's tables and data, in one transaction. Employee numbers continue after the last seeded one. */
export function resetDemoDatabase(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DROP TABLE IF EXISTS employee; DROP TABLE IF EXISTS department; DROP TABLE IF EXISTS fw_sequence; DROP TABLE IF EXISTS fw_tombstone;');
    db.exec(SCHEMA);
    const dept = db.prepare('INSERT INTO department (code, name) VALUES (?, ?)');
    for (const [code, name] of DEPARTMENTS) dept.run(code, name);
    const emp = db.prepare('INSERT INTO employee (empNo, empName, dept, level, active, salary, hiredOn) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const row of employeeRows()) emp.run(...(row as [string, string, string, string, number, string, string]));
    // Sequences are always stored, so a number is never issued twice. The next employee is E026.
    setSequence(db, 'employee', NAMES.length);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Seeds the database if it has no tables yet. */
export function ensureDemoDatabase(db: DatabaseSync): boolean {
  const found = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'employee'").get();
  if (found) return false;
  resetDemoDatabase(db);
  return true;
}
