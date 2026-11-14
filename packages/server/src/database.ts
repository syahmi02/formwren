import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Opens a SQLite file, creating it and its folder if needed. Foreign keys are on, and a locked file is waited
 * for up to five seconds. `:memory:` works too.
 */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

/** Creates the table that sequences use. Safe to call any time, including inside a transaction. */
export function ensureSequenceTable(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS fw_sequence (name TEXT PRIMARY KEY, value INTEGER NOT NULL)');
}

/** The last number a sequence handed out, or undefined if it hasn't started. */
export function readSequence(db: DatabaseSync, name: string): number | undefined {
  ensureSequenceTable(db);
  const row = db.prepare('SELECT value FROM fw_sequence WHERE name = ?').get(name) as { value: number } | undefined;
  return row?.value;
}

/** Sets a sequence's last number, so the next generated key is one step after it. */
export function setSequence(db: DatabaseSync, name: string, value: number): void {
  ensureSequenceTable(db);
  db.prepare('INSERT INTO fw_sequence (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value').run(name, value);
}
