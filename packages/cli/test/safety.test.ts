import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formText, fw, goodScript, project, read, scriptedForm, tsconfig, write } from './helpers.ts';

const SLOW = 90_000;

describe('files that are not *.form.json', () => {
  it.each(['Copy.json', 'Up.Form.json', 'Bak.form.json.bak'])('fw check never writes over beside %s', async (name) => {
    const original = formText();
    const root = project({ [name]: original });
    const before = readdirSync(root).sort();
    const run = await fw(root, 'check', '--no-tsc', name);
    // Nothing was created or changed: the file itself and the folder are as they were.
    expect(read(root, name)).toBe(original);
    expect(readdirSync(root).sort()).toEqual(before);
    expect(run.all).toMatch(/no types were generated/);
    expect(run.code).toBe(0);
  });
});

describe('text that is not UTF-8', () => {
  const bad = Buffer.concat([Buffer.from('{"formatVersion":1,"id":"a","title":"caf'), Buffer.from([0xe9]), Buffer.from('","components":[]}')]);

  it('fw check refuses it as an error', async () => {
    const root = project({});
    writeFileSync(join(root, 'L.form.json'), bad);
    const run = await fw(root, 'check', '--no-tsc');
    expect(run.code).toBe(1);
    expect(run.err.join('\n')).toMatch(/L\.form\.json:1: error: This file is not valid UTF-8/);
    expect(existsSync(join(root, 'L.form.gen.ts'))).toBe(false);
  });

  it('fw fmt refuses it and leaves every byte as it was', async () => {
    const root = project({});
    writeFileSync(join(root, 'L.form.json'), bad);
    const run = await fw(root, 'fmt');
    expect(run.code).toBe(1);
    expect(run.err.join('\n')).toMatch(/not valid UTF-8.*Not formatted/);
    expect(readFileSync(join(root, 'L.form.json')).equals(bad)).toBe(true);
    expect((await fw(root, 'fmt', '--check')).code).toBe(1);
  });

  it('still reads a file that starts with a byte order mark', async () => {
    const root = project({});
    writeFileSync(join(root, 'B.form.json'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(formText())]));
    expect((await fw(root, 'check', '--no-tsc')).code).toBe(0);
  });
});

describe('fw fmt writes carefully', () => {
  const messy = '{"formatVersion":1,"id":"a","components":[]}';

  it('leaves no temporary files behind', async () => {
    const root = project({ 'F.form.json': messy });
    await fw(root, 'fmt');
    expect(readdirSync(root)).toEqual(['F.form.json']);
  });

  it('reports each file it rewrote even when a later one is refused', async () => {
    const root = project({ 'A.form.json': messy, 'B.form.json': '{ nope', 'C.form.json': messy });
    const run = await fw(root, 'fmt');
    expect(run.code).toBe(1);
    expect(run.out).toContain('Formatted A.form.json');
    expect(run.out).toContain('Formatted C.form.json');
    expect(read(root, 'B.form.json')).toBe('{ nope');
  });

  it('does not replace a file that changed after it was read', async () => {
    // The file is changed by a second fmt-independent writer between the read and the rename.
    const { replaceIfUnchanged } = await import('../src/commands.ts');
    const root = project({ 'F.form.json': messy });
    const file = join(root, 'F.form.json');
    const original = readFileSync(file);
    writeFileSync(file, '{"formatVersion":1,"id":"edited-meanwhile","components":[]}');
    expect(replaceIfUnchanged(file, original, 'formatted\n')).toBe('changed');
    expect(readFileSync(file, 'utf8')).toContain('edited-meanwhile');
    expect(readdirSync(root)).toEqual(['F.form.json']);
  });
});

describe('a skipped TypeScript check is not a pass', () => {
  it('fails with no forms, for check and for fmt --check', async () => {
    const root = project({ 'readme.txt': 'nothing here' });
    const check = await fw(root, 'check', '--no-tsc');
    expect(check.code).toBe(1);
    expect(check.err.join('\n')).toMatch(/No \*\.form\.json files found/);
    const fmt = await fw(root, 'fmt', '--check');
    expect(fmt.code).toBe(1);
    expect(fmt.err.join('\n')).toMatch(/No \*\.form\.json files found/);
    expect((await fw(root, 'fmt')).code).toBe(0);
  });

  it('fails with no tsconfig.json unless --no-tsc is given', async () => {
    const root = project({ 'A.form.json': formText() });
    const run = await fw(root, 'check');
    expect(run.code).toBe(1);
    expect(run.err.join('\n')).toMatch(/No tsconfig\.json.*--no-tsc/);
    expect((await fw(root, 'check', '--no-tsc')).code).toBe(0);
  });

  it('really checks through a solution-style tsconfig', { timeout: SLOW }, async () => {
    const files = (code: string) => ({
      'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './app' }] }),
      // Composite projects can't include source from outside, so this form has no script and imports nothing.
      'app/tsconfig.json': JSON.stringify({ extends: JSON.parse(tsconfig()).extends, compilerOptions: { composite: true, lib: ['ES2023'], types: [] }, include: ['*.ts'] }),
      'app/E.form.json': formText({ datasets: undefined }),
      'app/use.ts': code,
    });
    const bad = project(files('export const n: number = "x";\n'));
    const badRun = await fw(bad, 'check');
    expect(badRun.code).toBe(1);
    expect(badRun.err.join('\n')).toMatch(/use\.ts\(1,\d+\): error TS2322/);

    const good = project(files('export const n: number = 1;\n'));
    const goodRun = await fw(good, 'check');
    expect(goodRun.err.join('\n')).not.toMatch(/error/);
    expect(goodRun.code).toBe(0);
  });

  it('fails when a form script or generated file is outside the program', { timeout: SLOW }, async () => {
    const root = project({
      'tsconfig.json': tsconfig(['src/**/*.ts']),
      'src/ok.ts': 'export const ok = 1;\n',
      'E.form.json': scriptedForm,
      'E.form.ts': goodScript,
    });
    const run = await fw(root, 'check');
    expect(run.code).toBe(1);
    const text = run.err.join('\n');
    expect(text).toMatch(/E\.form\.json:1: error: E\.form\.gen\.ts is not part of the TypeScript program/);
    expect(text).toMatch(/E\.form\.json:1: error: E\.form\.ts is not part of the TypeScript program/);
  });
});

describe('the script must match the form', () => {
  const run = async (script: string | null) => {
    const root = project({
      'tsconfig.json': tsconfig(),
      'E.form.json': scriptedForm,
      ...(script === null ? {} : { 'E.form.ts': script }),
    });
    return fw(root, 'check');
  };

  it('passes a script written with defineForm<E>', { timeout: SLOW }, async () => {
    const result = await run(goodScript);
    expect(result.err.join('\n')).not.toMatch(/error/);
    expect(result.code).toBe(0);
  });

  it('fails a script with no generic on defineForm', { timeout: SLOW }, async () => {
    const result = await run("import { defineForm } from '@fw/core';\nexport default defineForm(() => ({ onInit() {} }));\n");
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toMatch(/E\.form\.gen\.ts\(\d+,\d+\): error TS2344/);
  });

  it('fails a script typed for another form', { timeout: SLOW }, async () => {
    const result = await run(
      "import { defineForm } from '@fw/core';\nexport default defineForm<{ datasets: { [K in never]: never }; variables: { [K in never]: never }; params: { [K in never]: never }; handlers: 'other' }>(() => ({ other() {} }));\n",
    );
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toMatch(/error TS2344/);
  });

  it('fails a script with no default export', { timeout: SLOW }, async () => {
    const result = await run('export const nothing = 1;\n');
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toMatch(/E\.form\.gen\.ts\(\d+,\d+\): error TS1192/);
  });

  it('fails a script that leaves out a handler the form names', { timeout: SLOW }, async () => {
    const result = await run("import { defineForm } from '@fw/core';\nimport type { E } from './E.form.gen';\nexport default defineForm<E>(() => ({}));\n");
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toMatch(/E\.form\.ts\(\d+,\d+\): error TS/);
  });

  it('names a missing script file without needing tsc', async () => {
    const root = project({ 'E.form.json': scriptedForm });
    const result = await fw(root, 'check', '--no-tsc');
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toMatch(/E\.form\.json:\d+: error: script: Script file not found: \.\/E\.form\.ts/);
  });

  it('rejects handlers with no script', async () => {
    const root = project({
      'A.form.json': formText({
        events: { init: 'onInit' },
        components: [{ id: 'b', type: 'Button', layout: { left: 0, top: 0, width: 1, height: 1 }, events: { click: 'go' } }],
      }),
    });
    const result = await fw(root, 'check', '--no-tsc');
    expect(result.code).toBe(1);
    const text = result.err.join('\n');
    expect(text).toMatch(/events\.init: This form has handlers but no "script"/);
    expect(text).toMatch(/components\[0\]\.events\.click: This component has handlers but the form has no "script"/);
  });
});

describe('where a script may be', () => {
  it.each([
    ['../outside.ts', /script: The script must stay inside the project/],
    ['./sub/../../outside.ts', /script: The script must stay inside the project/],
    ['/abs/path/A.form.ts', /script: The script must be a relative path/],
    ['C:\\abs\\A.form.ts', /script: The script must be a relative path/],
    ['./A.txt', /script: The script must be a \.ts or \.tsx file/],
    ['./A.js', /script: The script must be a \.ts or \.tsx file/],
  ])('refuses %s', async (script, expected) => {
    const root = project({ 'proj/A.form.json': formText({ script }) });
    write(root, 'outside.ts', 'export default 1;\n');
    write(root, 'proj/A.txt', 'x');
    const run = await fw(join(root, 'proj'), 'check', '--no-tsc');
    expect(run.code).toBe(1);
    expect(run.err.join('\n')).toMatch(expected);
  });

  it('accepts a .tsx script inside the project', async () => {
    const root = project({ 'A.form.json': formText({ script: './sub/A.form.tsx' }), 'sub/A.form.tsx': 'export default 1;\n' });
    expect((await fw(root, 'check', '--no-tsc')).code).toBe(0);
  });
});

describe('names the generated code cannot use', () => {
  it.each(['class', 'string'])('fw check refuses %s.form.json with a clear error', async (name) => {
    const root = project({ [`${name}.form.json`]: formText() });
    const run = await fw(root, 'check', '--no-tsc');
    expect(run.code).toBe(1);
    expect(run.err.join('\n')).toMatch(new RegExp(`"${name}" can't be used as a type name`));
    expect(existsSync(join(root, `${name}.form.gen.ts`))).toBe(false);
  });

  it.each(['Dataset', 'Record'])('%s.form.json generates code that compiles', { timeout: SLOW }, async (name) => {
    const root = project({
      'tsconfig.json': tsconfig(),
      [`${name}.form.json`]: formText({
        datasets: [{ id: 'dsA', columns: [{ id: 'name', type: 'string' }] }],
        variables: { v: { type: 'int', default: 1 } },
      }),
      'use.ts': `import type { ${name} } from './${name}.form.gen';\nexport const v: ${name}['variables']['v'] = 1;\nexport const column: ${name}['datasets']['dsA']['columns'] extends unknown ? true : never = true;\n`,
    });
    const run = await fw(root, 'check');
    expect(run.err.join('\n')).not.toMatch(/error/);
    expect(run.code).toBe(0);
  });

  it('makes a made-up variable a compile error', { timeout: SLOW }, async () => {
    const root = project({
      'tsconfig.json': tsconfig(),
      'A.form.json': formText(),
      'use.ts': "import type { A } from './A.form.gen';\ndeclare const vars: A['variables'];\nexport const x = vars.nope;\n",
    });
    const run = await fw(root, 'check');
    expect(run.code).toBe(1);
    expect(run.err.join('\n')).toMatch(/use\.ts\(3,\d+\): error TS2339/);
  });
});
