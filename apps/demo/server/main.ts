/**
 * Starts the demo's DSX server on 127.0.0.1:5300.
 *   --reset        rebuild the database from the seed
 *   --db <path>    use another database file (default: apps/demo/.data/demo.db)
 *   --delay <ms>   wait this long before every response, to see busy states
 *   --test         add POST /dsx/test/reset, which reseeds the database (for browser tests only)
 *   --port <n>     listen on another port
 */
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, openDatabase } from '@fw/server';
import { ensureDemoDatabase, resetDemoDatabase } from './seed.ts';
import { demoServices } from './services.ts';

function option(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

const flag = (name: string): boolean => process.argv.includes(name);

function numberOption(name: string, fallback: number): number {
  const raw = option(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} needs a whole number`);
  return value;
}

const defaultPath = fileURLToPath(new URL('../.data/demo.db', import.meta.url));
const path = resolve(option('--db') ?? defaultPath);
const delay = numberOption('--delay', 0);
const port = numberOption('--port', 5300);
const testMode = flag('--test');

if (flag('--reset')) {
  for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(path + suffix, { force: true });
}
const existed = existsSync(path);
const db = openDatabase(path);
const seeded = ensureDemoDatabase(db);

const app = createServer({ services: demoServices, db });

if (delay > 0) app.addHook('onRequest', async () => new Promise<void>((done) => setTimeout(done, delay)));

if (testMode) {
  app.post('/dsx/test/reset', async () => {
    resetDemoDatabase(db);
    return { status: { ok: true } };
  });
}

const shutdown = (): void => {
  void app.close().then(() => {
    db.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: '127.0.0.1', port });
process.stdout.write(
  `DSX server on http://127.0.0.1:${port}/dsx/v1/tx/:serviceId, database ${path}${seeded ? (existed ? ' (seeded)' : ' (created and seeded)') : ''}` +
    `${delay > 0 ? `, delay ${delay} ms` : ''}${testMode ? ', test reset enabled' : ''}\n`,
);
