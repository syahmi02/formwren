/**
 * Builds the bench page (production mode) and runs it in the installed Edge.
 *   node packages/grid/bench/run.mjs [--headed] [--dev] [--rows=100000] [--runs=3]
 * Serves on port 5191 and stops the server on exit.
 */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = new Map(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const headed = args.has('headed');
const dev = args.has('dev');
const rows = args.get('rows') ?? '100000';
const runs = Number(args.get('runs') ?? 1);
const config = path.join(here, 'vite.config.mjs');

function sh(cmd, argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: 'inherit', shell: true, cwd: here });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

let server;
function stopServer() {
  if (server && server.pid) {
    try {
      spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // Already gone.
    }
  }
}
process.on('exit', stopServer);

try {
  if (!dev) await sh('pnpm', ['exec', 'vite', 'build', '--config', `"${config}"`, '--logLevel', 'warn']);
  server = spawn('pnpm', ['exec', 'vite', ...(dev ? [] : ['preview']), '--config', `"${config}"`], { shell: true, cwd: here, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch('http://127.0.0.1:5191/');
      if (res.ok) break;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: !headed,
    args: ['--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'],
  });
  if (args.has('verify')) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
    page.on('pageerror', (e) => console.error('PAGE ERROR', e));
    await page.goto(`http://127.0.0.1:5191/?rows=${rows}`);
    await page.waitForFunction(() => window.__bench);
    console.log(JSON.stringify(await page.evaluate(() => window.__bench.verify()), null, 2));
    if (args.get('shot')) {
      await page.evaluate(() => window.__bench.verify());
    }
    await page.close();
    await browser.close();
    process.exit(0);
  }
  for (let r = 0; r < runs; r++) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
    page.on('pageerror', (e) => console.error('PAGE ERROR', e));
    page.on('console', (m) => m.type() === 'error' && console.error('CONSOLE', m.text()));
    await page.goto(`http://127.0.0.1:5191/?rows=${rows}`);
    await page.waitForFunction(() => window.__bench);
    const result = await page.evaluate(() => window.__bench.run());
    console.log(JSON.stringify({ run: r + 1, mode: dev ? 'dev' : 'production build', headed, ...result }, null, 2));
    await page.close();
  }
  await browser.close();
} finally {
  stopServer();
}
