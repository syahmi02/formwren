import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { printForm } from '@fw/format';
import { describe, inspectFormText } from './diagnostics.ts';
import { resolveForms } from './files.ts';
import { genPathOf, isFormFile, scriptImportOf, writeFormTypes } from './gen.ts';
import { readFormFile } from './source.ts';

export interface Io {
  /** Relative paths and the project's tsconfig are taken from here. */
  cwd: string;
  out(line: string): void;
  err(line: string): void;
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

export function displayPath(io: Io, file: string): string {
  return relative(io.cwd, file).split(sep).join('/');
}

/** A path as TypeScript prints it, so lists can be compared. */
function same(path: string): string {
  const normal = resolve(path).replace(/\\/g, '/');
  return process.platform === 'win32' ? normal.toLowerCase() : normal;
}

interface TsProject {
  config: string;
  /** The project has references of its own, which only \`tsc -b\` can follow. */
  build: boolean;
}

type TypeScript = typeof import('typescript');

/** A solution-style tsconfig (\`files: []\` plus \`references\`) checks nothing itself, so its referenced projects are what to check. */
function leafProjects(ts: TypeScript, config: string, seen = new Set<string>()): TsProject[] {
  if (seen.has(same(config))) return [];
  seen.add(same(config));
  const read = ts.readConfigFile(config, ts.sys.readFile);
  if (read.error) throw new Error(`${config}: ${ts.flattenDiagnosticMessageText(read.error.messageText, '\n')}`);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(config), undefined, config);
  const references = parsed.projectReferences ?? [];
  if (parsed.fileNames.length === 0 && references.length > 0) {
    return references.flatMap((reference) => leafProjects(ts, ts.resolveProjectReferencePath(reference), seen));
  }
  return [{ config, build: references.length > 0 }];
}

function tsc(io: Io, args: string[]): { ok: boolean; output: string } {
  const bin = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: io.cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: result.status === 0 && result.error === undefined, output: `${result.stdout}${result.stderr}` };
}

/** Runs the project's TypeScript check, and returns the files it covers. Reports problems itself. */
function runTypeScript(io: Io, config: string): { ok: boolean; covered: Set<string> } {
  const ts = createRequire(import.meta.url)('typescript') as TypeScript;
  let projects: TsProject[];
  try {
    projects = leafProjects(ts, config);
  } catch (failure) {
    io.err(`error: ${(failure as Error).message}`);
    return { ok: false, covered: new Set() };
  }
  if (projects.length === 0) {
    io.err(`${displayPath(io, config)}: error: No project to check. Is "references" empty?`);
    return { ok: false, covered: new Set() };
  }
  let ok = true;
  const covered = new Set<string>();
  for (const project of projects) {
    const run = tsc(io, project.build ? ['-b', '--noEmit', project.config] : ['--noEmit', '-p', project.config]);
    for (const line of run.output.split(/\r?\n/)) if (line !== '') io.err(line);
    ok &&= run.ok;
    for (const line of tsc(io, ['--listFilesOnly', '-p', project.config]).output.split(/\r?\n/)) {
      if (line.trim() !== '') covered.add(same(line.trim()));
    }
  }
  return { ok, covered };
}

export interface CheckFlags {
  tsc: boolean;
}

/** `fw check`: schema and semantic checks, regenerated types, then the TypeScript check. */
export function check(io: Io, paths: readonly string[], flags: CheckFlags): number {
  const files = resolveForms(io.cwd, paths);
  if (files.length === 0) {
    io.err('error: No *.form.json files found, so nothing was checked');
    return 1;
  }
  let errors = 0;
  let warnings = 0;
  let generated = 0;
  /** Files that have to be part of the TypeScript program, with the form that needs each. */
  const needed: { form: string; file: string }[] = [];

  for (const file of files) {
    const name = displayPath(io, file);
    const source = readFormFile(file);
    if (!source.ok) {
      io.err(`${name}:1: error: ${source.message}`);
      errors++;
      continue;
    }
    const inspection = inspectFormText(source.text, undefined, { file, root: io.cwd });
    if (inspection.status === 'unreadable') {
      io.err(`${name}:${inspection.line}: error: ${inspection.message}`);
      errors++;
      continue;
    }
    for (const diagnostic of inspection.diagnostics) {
      (diagnostic.severity === 'error' ? io.err : io.out)(
        `${name}:${diagnostic.line}: ${diagnostic.severity}: ${describe(diagnostic)}`,
      );
      if (diagnostic.severity === 'error') errors++;
      else warnings++;
    }
    if (!isFormFile(file)) {
      io.out(`${name}:1: warning: Not named *.form.json, so no types were generated for it`);
      warnings++;
      continue;
    }
    // The types are still useful while the form has other mistakes, as long as its shape is readable.
    if (!inspection.schemaValid) continue;
    try {
      if (writeFormTypes(file, inspection.definition)) generated++;
      needed.push({ form: name, file: genPathOf(file) });
      const script = inspection.definition.script;
      if (scriptImportOf(script) !== null && typeof script === 'string') needed.push({ form: name, file: resolve(dirname(file), script) });
    } catch (failure) {
      io.err(`${name}:1: error: Could not write the types file: ${(failure as Error).message}`);
      errors++;
    }
  }

  let typeErrors = false;
  if (flags.tsc) {
    const config = join(io.cwd, 'tsconfig.json');
    if (!existsSync(config)) {
      io.err(`error: No tsconfig.json in ${io.cwd}, so TypeScript was not checked. Add one, or pass --no-tsc`);
      typeErrors = true;
    } else {
      const result = runTypeScript(io, config);
      typeErrors = !result.ok;
      for (const { form, file } of needed) {
        if (result.ok && !result.covered.has(same(file))) {
          io.err(`${form}:1: error: ${displayPath(io, file)} is not part of the TypeScript program. Add it to "include" in tsconfig.json`);
          errors++;
        }
      }
    }
  }

  const summary = [
    `Checked ${plural(files.length, 'form')}: ${plural(errors, 'error')}, ${plural(warnings, 'warning')}`,
    ...(generated > 0 ? [`updated ${plural(generated, 'generated file')}`] : []),
    ...(typeErrors ? ['TypeScript was not clean'] : []),
  ];
  (errors > 0 || typeErrors ? io.err : io.out)(summary.join('; '));
  return errors > 0 || typeErrors ? 1 : 0;
}

/**
 * Replaces a file through a temporary file in the same folder. If the file changed since it was
 * read, nothing is replaced, so an edit made in between is never lost.
 */
export function replaceIfUnchanged(file: string, original: Buffer, next: string): 'written' | 'changed' {
  const temp = join(dirname(file), `.${basename(file)}.fw-${process.pid}.tmp`);
  writeFileSync(temp, next);
  try {
    if (!readFileSync(file).equals(original)) {
      unlinkSync(temp);
      return 'changed';
    }
    renameSync(temp, file);
    return 'written';
  } catch (failure) {
    try {
      unlinkSync(temp);
    } catch {
      // The temporary file may not exist any more.
    }
    throw failure;
  }
}

/** `fw fmt`: canonical text. A file that is conflicted, invalid or not UTF-8 is reported and never written. */
export function format(io: Io, paths: readonly string[], checkOnly: boolean): number {
  const files = resolveForms(io.cwd, paths);
  if (checkOnly && files.length === 0) {
    io.err('error: No *.form.json files found, so nothing was checked');
    return 1;
  }
  let problems = 0;
  const different: string[] = [];
  const rewritten: string[] = [];

  for (const file of files) {
    const name = displayPath(io, file);
    const source = readFormFile(file);
    if (!source.ok) {
      io.err(`${name}:1: error: ${source.message} Not formatted.`);
      problems++;
      continue;
    }
    const inspection = inspectFormText(source.text, {});
    if (inspection.status === 'unreadable') {
      io.err(`${name}:${inspection.line}: error: ${inspection.message} Not formatted.`);
      problems++;
      continue;
    }
    if (!inspection.schemaValid) {
      const first = inspection.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
      io.err(`${name}:${first?.line ?? 1}: error: ${first ? describe(first) : 'Invalid form'}. Not formatted.`);
      problems++;
      continue;
    }
    const next = printForm(inspection.definition);
    if (next === source.text) continue;
    different.push(name);
    if (checkOnly) continue;
    try {
      if (replaceIfUnchanged(file, source.bytes, next) === 'written') {
        rewritten.push(name);
        // Reported straight away, so a failure on a later file can't hide what was already changed.
        io.out(`Formatted ${name}`);
      } else {
        io.err(`${name}:1: error: The file changed while it was being formatted, so it was left as it is. Run fw fmt again.`);
        problems++;
      }
    } catch (failure) {
      io.err(`${name}:1: error: Could not write the file: ${(failure as Error).message}`);
      problems++;
    }
  }

  if (checkOnly) for (const name of different) io.err(`${name}: needs formatting`);
  const done = checkOnly ? `${plural(different.length, 'file')} need formatting` : `formatted ${plural(rewritten.length, 'file')}`;
  const summary = `Checked ${plural(files.length, 'form')}: ${done}${problems > 0 ? `, ${plural(problems, 'file')} refused or failed` : ''}`;
  const failed = problems > 0 || (checkOnly && different.length > 0);
  (failed ? io.err : io.out)(summary);
  return failed ? 1 : 0;
}
