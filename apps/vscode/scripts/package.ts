// Packages the extension into apps/vscode/fw-designer-<version>.vsix. Local only: no publisher account, no Marketplace.
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { name, version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string; version: string };

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: root });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with ${result.status}`);
}

// vsce only packs files from this folder, so the licence files travel in from the repository root.
// The copies are ignored by Git and removed afterwards.
const licenceFiles = ['LICENSE', 'NOTICE'];
try {
  for (const file of licenceFiles) copyFileSync(resolve(root, '../..', file), join(root, file));
  run(process.execPath, [join(root, 'scripts/build.ts')]);
  run(process.execPath, [
    resolve(root, '../../node_modules/@vscode/vsce/vsce'),
    'package',
    '--no-dependencies',
    '--allow-missing-repository',
    '--skip-license',
    '--out',
    join(root, `${name}-${version}.vsix`),
  ]);
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
} finally {
  for (const file of licenceFiles) rmSync(join(root, file), { force: true });
}
