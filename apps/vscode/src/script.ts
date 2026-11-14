import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import * as vscode from 'vscode';
import type { ScriptResult } from './protocol.ts';

/** The minimal part of esbuild's API this file uses. */
interface Esbuild {
  build(options: Record<string, unknown>): Promise<{ outputFiles: Array<{ text: string }> }>;
  stop?(): Promise<void> | void;
}

/** The handler module for a form: `X.form.json` has `X.form.ts` in the same folder. */
export function scriptUri(form: vscode.Uri): vscode.Uri {
  const name = form.path.split('/').pop() ?? '';
  const base = name.replace(/\.form\.json$/i, '');
  return form.with({ path: `${form.path.slice(0, form.path.length - name.length)}${base}.form.ts` });
}

/** True if `path` is inside `folder` once links are followed, so a link can't lead out of the workspace. */
export function isInside(folder: string, path: string): boolean {
  try {
    const relation = relative(realpathSync.native(folder), realpathSync.native(path));
    return relation !== '' && !relation.startsWith('..') && !isAbsolute(relation);
  } catch {
    return false;
  }
}

/**
 * Finds the project's own esbuild, starting from the folder with the form: first as a dependency of
 * the project, then as the one that comes with the project's Vite. Node's lookup also walks every
 * parent folder, `NODE_PATH` and the global folders, and what it finds is run inside the extension
 * host. So a result counts only if it is inside `workspaceFolder`, links followed. Returns null if not.
 */
export function findEsbuild(folder: string, workspaceFolder: string): Esbuild | null {
  const from = createRequire(join(folder, 'noop.js'));
  const attempts: Array<() => string> = [
    () => {
      const found = from.resolve('esbuild');
      if (!isInside(workspaceFolder, found)) throw new Error('outside the workspace');
      return found;
    },
    () => {
      const vite = from.resolve('vite/package.json');
      if (!isInside(workspaceFolder, vite)) throw new Error('outside the workspace');
      const found = createRequire(join(dirname(vite), 'noop.js')).resolve('esbuild');
      if (!isInside(workspaceFolder, found)) throw new Error('outside the workspace');
      return found;
    },
  ];
  for (const attempt of attempts) {
    try {
      return from(attempt()) as Esbuild;
    } catch {
      // Try the next place.
    }
  }
  return null;
}

/**
 * The form script can use relative imports and `@fw/core`, which is the webview's own copy so there
 * is one runtime. Anything else is an error that says so, because the preview page has no way to load it.
 */
function previewPlugin(): { name: string; setup(build: Record<string, any>): void } { // eslint-disable-line @typescript-eslint/no-explicit-any
  return {
    name: 'fw-preview',
    setup(build) {
      build.onResolve({ filter: /^@fw\/core$/ }, () => ({ path: '@fw/core', namespace: 'fw-shared' }));
      build.onLoad({ filter: /.*/, namespace: 'fw-shared' }, () => ({ contents: 'module.exports = globalThis.__fwCore;', loader: 'js' }));
      build.onResolve({ filter: /^[^./]/ }, (args: { path: string }) =>
        /^[A-Za-z]:/.test(args.path) || args.path === '@fw/core'
          ? undefined
          : { errors: [{ text: `"${args.path}" can't be used in the preview. A form script can import relative files and @fw/core only.` }] },
      );
    },
  };
}

/** Compiles the handler beside a form for the preview. Reads files, writes nothing, never throws. */
export async function compileScript(form: vscode.Uri): Promise<ScriptResult> {
  if (form.scheme !== 'file') return { status: 'unavailable', message: "Scripts run in the preview only for files on disk." };
  const script = scriptUri(form);
  try {
    await vscode.workspace.fs.stat(script);
  } catch {
    return { status: 'none' };
  }
  // The window being trusted isn't enough: an empty window counts as trusted, and so does a file from outside the folders.
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(form);
  if (!workspaceFolder) {
    return { status: 'unavailable', message: 'Scripts run in the preview only for forms inside a trusted workspace folder.' };
  }
  if (!vscode.workspace.isTrusted) {
    return { status: 'unavailable', message: "Scripts don't run in the preview until the workspace is trusted. Trust the workspace to run them." };
  }
  const folder = dirname(form.fsPath);
  const esbuild = findEsbuild(folder, workspaceFolder.uri.fsPath);
  if (!esbuild) {
    return {
      status: 'unavailable',
      message: `Scripts don't run in the preview because esbuild was not found inside the workspace folder ${workspaceFolder.uri.fsPath}, looking from ${folder}. Install the project's dependencies there (it comes with Vite), then reopen the preview.`,
    };
  }
  try {
    const result = await esbuild.build({
      entryPoints: [script.fsPath],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      target: 'es2023',
      absWorkingDir: folder,
      logLevel: 'silent',
      // The type check belongs to `fw check`. This only strips the types.
      tsconfigRaw: '{}',
      loader: { '.json': 'json' },
      plugins: [previewPlugin()],
    });
    return { status: 'ok', code: result.outputFiles[0]?.text ?? '' };
  } catch (error) {
    return { status: 'error', message: describeFailure(error) };
  } finally {
    try {
      await esbuild.stop?.();
    } catch {
      // Nothing to do.
    }
  }
}

interface Failure {
  errors?: Array<{ text: string; location?: { file: string; line: number; column: number } | null }>;
}

function describeFailure(error: unknown): string {
  const errors = (error as Failure).errors;
  if (!errors || errors.length === 0) return error instanceof Error ? error.message : String(error);
  return errors
    .slice(0, 3)
    .map((item) => {
      const where = item.location ? `${item.location.file}:${item.location.line}:${item.location.column + 1}: ` : '';
      return `${where}${item.text}`;
    })
    .join('\n');
}
