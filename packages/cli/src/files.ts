import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SKIPPED = new Set(['node_modules', 'dist', '.git']);

function walk(dir: string, into: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED.has(entry.name)) walk(join(dir, entry.name), into);
    } else if (entry.name.endsWith('.form.json')) {
      into.push(join(dir, entry.name));
    }
  }
}

/** All `*.form.json` files under `root`, skipping `node_modules` and `dist`, sorted by path. */
export function findForms(root: string): string[] {
  const found: string[] = [];
  walk(root, found);
  return found.sort();
}

/** Form files named on the command line: a file is itself, a folder is searched. Throws if a path doesn't exist. */
export function resolveForms(cwd: string, paths: readonly string[]): string[] {
  const found = new Set<string>();
  for (const target of paths.length > 0 ? paths : ['.']) {
    const absolute = resolve(cwd, target);
    let isFolder: boolean;
    try {
      isFolder = statSync(absolute).isDirectory();
    } catch {
      throw new Error(`No such file or folder: ${target}`);
    }
    if (isFolder) {
      for (const file of findForms(absolute)) found.add(file);
    } else {
      found.add(absolute);
    }
  }
  return [...found].sort();
}
