import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/index.ts';
import { seedWorld, tempDatabase, worldServices } from './world.ts';

const dir = new URL('../../core/test/fixtures/dsx/', import.meta.url);

interface Entry {
  http: number;
  conformance: boolean;
  service: string;
  request?: string;
  prepare?: { table: string; where?: Record<string, unknown>; set?: Record<string, unknown>; rows?: string }[];
  after?: Record<string, unknown[][]>;
}

const manifest = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8')) as { vectors: Record<string, Entry> };
const read = (file: string): string => readFileSync(new URL(file, dir), 'utf8');

interface Wire {
  status: { ok: boolean; code?: string };
  params?: object;
  datasets?: object;
  applied?: object;
  errors?: { dataset?: string; id?: number; column?: string; code: string }[];
}

const errorSet = (response: Wire): string[] =>
  (response.errors ?? []).map((e) => JSON.stringify([e.dataset ?? null, e.id ?? null, e.column ?? null, e.code])).sort();

const pk: Record<string, string> = { emp: 'empNo', dept: 'deptCode', qa_types: 'id' };
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

describe('golden vectors through the real server', () => {
  for (const [name, entry] of Object.entries(manifest.vectors)) {
    if (!entry.conformance) continue;
    it(name, async () => {
      const t = tempDatabase();
      cleanups.push(t.cleanup);
      seedWorld(t.db);
      for (const step of entry.prepare ?? []) {
        if (step.set && step.where) {
          const set = Object.keys(step.set);
          const where = Object.keys(step.where);
          t.db
            .prepare(`UPDATE ${step.table} SET ${set.map((c) => `${c} = ?`).join(', ')} WHERE ${where.map((c) => `${c} = ?`).join(' AND ')}`)
            .run(...([...Object.values(step.set), ...Object.values(step.where)] as never[]));
        } else if (step.rows) {
          const source = manifest.vectors['p4-types-save']?.after?.[step.table] ?? [];
          for (const row of source) t.db.prepare(`INSERT INTO ${step.table} VALUES (${row.map(() => '?').join(', ')})`).run(...(row as never[]));
        } else throw new Error(`Unknown prepare step in ${name}`);
      }
      const app = createServer({ services: worldServices, db: t.db, logger: { error() {} } });
      const res = await app.inject({
        method: 'POST',
        url: `/dsx/v1/tx/${entry.service}`,
        headers: { 'content-type': 'application/json' },
        payload: read(entry.request ?? `${name}.request.json`),
      });
      const got = res.json() as Wire;
      const want = JSON.parse(read(`${name}.response.json`)) as Wire;

      expect(res.statusCode).toBe(entry.http);
      expect(got.status.ok).toBe(want.status.ok);
      expect(got.status.code).toBe(want.status.code);
      expect(got.params ?? {}).toEqual(want.params ?? {});
      expect(got.datasets ?? {}).toEqual(want.datasets ?? {});
      expect(got.applied ?? {}).toEqual(want.applied ?? {});
      expect(errorSet(got)).toEqual(errorSet(want));

      for (const [table, rows] of Object.entries(entry.after ?? {})) {
        const actual = (t.db.prepare(`SELECT * FROM ${table} ORDER BY ${pk[table]}`).all() as Record<string, unknown>[]).map((r) => Object.values(r));
        expect(actual, `table ${table}`).toEqual(rows);
      }
      await app.close();
    });
  }
});
