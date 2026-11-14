// Installs the packaged .vsix into the user's VS Code. Run with `pnpm vscode:install`, when you decide to.
// FW_VSCODE_CLI and FW_VSCODE_EXTENSIONS_DIR let the tests use another copy of VS Code.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { name, version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string; version: string };
const vsix = join(root, `${name}-${version}.vsix`);
if (!existsSync(vsix)) {
  console.error(`${vsix} does not exist. Run "pnpm vscode:package" first.`);
  process.exit(1);
}
const cli = process.env['FW_VSCODE_CLI'] ?? 'code';
const extra = process.env['FW_VSCODE_EXTENSIONS_DIR'] ? ['--extensions-dir', process.env['FW_VSCODE_EXTENSIONS_DIR']] : [];
const result = spawnSync(cli, [...extra, '--install-extension', vsix, '--force'], { stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(result.status ?? 1);
