/**
 * One command for the demo: starts the server and `fw dev` together, prefixes their output, and stops both
 * on Ctrl+C or when either one exits. `--reset` makes the server rebuild its database first.
 * Run it with `pnpm demo` or `pnpm demo:reset`. It uses only Node.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';

const demoDir = fileURLToPath(new URL('..', import.meta.url));
const reset = process.argv.includes('--reset');

const children: { name: string; child: ChildProcess }[] = [];
let stopping = false;
let exitCode = 0;
let announced = false;

function prefixLines(name: string, stream: NodeJS.ReadableStream, target: NodeJS.WritableStream): void {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    const lines = (pending + chunk).split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) {
      target.write(`[${name}] ${line}\n`);
      // Vite prints its address once it's listening, which is when the whole demo is ready.
      const local = /Local:\s+(\S+)/.exec(line.replace(/\x1b\[[0-9;]*m/g, ''));
      if (name === 'web' && local && !announced) {
        announced = true;
        process.stdout.write(`\n  Demo ready: ${local[1]}  (the server is at http://127.0.0.1:5300, press Ctrl+C to stop both)\n\n`);
      }
    }
  });
  stream.on('end', () => {
    if (pending) target.write(`[${name}] ${pending}\n`);
  });
}

/** Signals a child's whole process group (Linux and macOS). If the group is gone, signals the process alone. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // It has gone already.
    }
  }
}

function stopAll(): void {
  if (stopping) return;
  stopping = true;
  for (const { child } of children) {
    if (child.pid === undefined) continue;
    if (process.platform === 'win32') {
      // On Windows a plain kill leaves the grandchildren (pnpm's node) running, so the whole tree is ended.
      if (child.exitCode === null) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      // Each child leads its own group (see start), so this also ends what pnpm started, even after pnpm has exited.
      signalGroup(child.pid, 'SIGTERM');
    }
  }
}

function start(name: string, command: string, args: string[]): void {
  // pnpm is a .cmd file on Windows and needs a shell. The command is one fixed string, so nothing outside is put into it.
  const viaShell = process.platform === 'win32' && command === 'pnpm';
  const options = {
    cwd: demoDir,
    stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0' },
    // On Linux and macOS each child gets its own process group, so the whole tree can be ended (signalGroup). Windows uses taskkill /T.
    detached: process.platform !== 'win32',
  };
  const child = viaShell ? spawn([command, ...args].join(' '), { ...options, shell: true }) : spawn(command, args, options);
  children.push({ name, child });
  if (child.stdout) prefixLines(name, child.stdout, process.stdout);
  if (child.stderr) prefixLines(name, child.stderr, process.stderr);
  child.on('error', (error) => {
    process.stderr.write(`[${name}] could not start: ${error.message}\n`);
    exitCode = 1;
    stopAll();
  });
  child.on('exit', (code, signal) => {
    if (!stopping) {
      process.stderr.write(`[${name}] exited (${signal ?? code}), stopping the demo\n`);
      exitCode = code ?? 1;
    }
    stopAll();
    if (children.every((c) => c.child.exitCode !== null || c.child.signalCode !== null)) process.exit(exitCode);
  });
}

/** True if something already accepts connections on the port, on IPv4 or IPv6. */
function portInUse(port: number): Promise<boolean> {
  const tryHost = (host: string): Promise<boolean> =>
    new Promise((resolve) => {
      const socket = connect({ port, host });
      socket.setTimeout(1000);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('error', () => resolve(false));
    });
  return Promise.all([tryHost('127.0.0.1'), tryHost('::1')]).then(([a, b]) => a || b);
}

// A separate process that outlives this one. If this process or the one that started it (such as pnpm) is killed hard,
// nothing here runs, so the watchdog notices within a second and ends this process and both children with their
// trees, so no port stays taken.
const WATCHDOG = `
const { spawnSync } = require('node:child_process');
const { watched, kill } = JSON.parse(process.argv[1]);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// Windows: the tree below the roots, listed while it is still connected. Once a middle process is gone its children
// are orphans that 'taskkill /T' can no longer find, so the list is kept up to date and every pid on it is ended.
const tree = new Set();
function refresh() {
  if (process.platform !== 'win32') return;
  const script = '$a = Get-CimInstance Win32_Process; $ids = @(' + kill.join(',') + '); $n = 1; while ($n -gt 0) { $n = 0; foreach ($p in $a) { if (($ids -contains [int]$p.ParentProcessId) -and -not ($ids -contains [int]$p.ProcessId)) { $ids += [int]$p.ProcessId; $n++ } } }; $ids -join ","';
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 8000 });
  for (const t of (r.stdout || '').trim().split(',')) if (Number(t) > 1) tree.add(Number(t));
}
refresh();
let ticks = 0;
const timer = setInterval(() => {
  if (watched.every(alive)) {
    if (++ticks % 8 === 0) refresh();
    return;
  }
  clearInterval(timer);
  refresh();
  const all = [...new Set([...kill, ...tree])];
  if (process.platform === 'win32') {
    spawnSync('taskkill', [...all.flatMap((pid) => ['/pid', String(pid)]), '/f', '/t'], { stdio: 'ignore' });
  } else {
    // Each child leads its own group, so the group is signalled first. The plain pid is a fallback.
    for (const pid of all) {
      for (const target of [-pid, pid]) { try { process.kill(target, 'SIGTERM'); } catch {} }
    }
  }
  process.exit(0);
}, 500);
`;

/**
 * The processes that launched this one through pnpm: the cmd.exe wrappers and pnpm's own node. When `pnpm demo` is
 * killed hard, they die or are orphaned in a way that only the whole chain shows. Windows only, and best effort.
 */
function launcherChain(): number[] {
  if (process.platform !== 'win32') return process.ppid > 1 ? [process.ppid] : [];
  const script =
    '$all = @{}; Get-CimInstance Win32_Process | ForEach-Object { $all[[int]$_.ProcessId] = $_ }; ' +
    `$id = ${process.pid}; $out = @(); ` +
    'while ($all.ContainsKey($id)) { $parent = [int]$all[$id].ParentProcessId; $p = $all[$parent]; if (-not $p) { break }; ' +
    "if ($p.Name -eq 'cmd.exe' -or ($p.Name -eq 'node.exe' -and $p.CommandLine -match 'pnpm')) { $out += $parent; $id = $parent } else { break } }; " +
    '$out -join ","';
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 8000 });
  const found = (result.stdout ?? '').trim().split(',').map(Number).filter((pid) => Number.isInteger(pid) && pid > 1);
  return found.length > 0 ? found : process.ppid > 1 ? [process.ppid] : [];
}

function startWatchdog(): void {
  const pids = children.map((c) => c.child.pid).filter((pid): pid is number => pid !== undefined);
  const watched = [process.pid, ...launcherChain()];
  const arg = JSON.stringify({ watched, kill: [...pids, process.pid] });
  const watcher = spawn(process.execPath, ['-e', WATCHDOG, arg], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  watcher.unref();
  // The watchdog has nothing left to do once the demo has stopped on its own.
  process.on('exit', () => {
    if (watcher.pid !== undefined) {
      try {
        process.kill(watcher.pid);
      } catch {
        // It has gone already.
      }
    }
  });
}

process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);

const taken = (await Promise.all([5300, 5173].map(async (port) => ((await portInUse(port)) ? port : 0)))).filter((port) => port !== 0);
if (taken.length > 0) {
  process.stderr.write(
    `Port ${taken.join(' and ')} ${taken.length > 1 ? 'are' : 'is'} already in use, so the demo can't start. ` +
      'Another demo may still be running. Stop it, or whatever else uses the port, and run this again.\n',
  );
  process.exit(1);
}

start('server', process.execPath, ['server/main.ts', ...(reset ? ['--reset'] : [])]);
start('web', 'pnpm', ['exec', 'fw', 'dev']);
startWatchdog();
