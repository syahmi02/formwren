import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach } from 'vitest';
import { main } from '../src/main.ts';

const folders: string[] = [];

/** A temp folder holding the given files, removed after the test. */
export function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'fw-cli-'));
  folders.push(root);
  for (const [name, content] of Object.entries(files)) write(root, name, content);
  return root;
}

export function write(root: string, name: string, content: string): void {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export function read(root: string, name: string): string {
  return readFileSync(join(root, name), 'utf8');
}

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

export interface Run {
  code: number;
  out: string[];
  err: string[];
  /** Everything printed, in order. */
  all: string;
}

export async function fw(cwd: string, ...args: string[]): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, { cwd, out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out, err, all: [...out, ...err].join('\n') };
}

/** A small valid form, with the given pieces replaced. */
export function formText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      formatVersion: 1,
      id: 'test.Sample',
      title: 'Sample',
      datasets: [{ id: 'dsA', columns: [{ id: 'name', type: 'string' }] }],
      components: [],
      ...overrides,
    },
    null,
    2,
  );
}

const posix = (path: string): string => path.replace(/\\/g, '/');

/** A tsconfig for a temp folder that uses the real @fw/core source and the repo's compiler options. */
export function tsconfig(include: string[] = ['*.ts'], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    extends: posix(fileURLToPath(new URL('../../../tsconfig.base.json', import.meta.url))),
    compilerOptions: {
      lib: ['ES2023', 'DOM'],
      types: [],
      paths: { '@fw/core': [posix(fileURLToPath(new URL('../../core/src/index.ts', import.meta.url)))] },
    },
    include,
    ...extra,
  });
}

/** A form `E` with a script, a Dataset and one handler, and a script that matches it. */
export const goodScript = "import { defineForm } from '@fw/core';\nimport type { E } from './E.form.gen';\nexport default defineForm<E>(() => ({ onInit() {} }));\n";

export const scriptedForm = formText({
  script: './E.form.ts',
  events: { init: 'onInit' },
});
