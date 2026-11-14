import { existsSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fw, formText, project, read, write } from './helpers.ts';

const CONFLICTED = '<<<<<<< HEAD\n{ "id": "a" }\n=======\n{ "id": "b" }\n>>>>>>> other\n';

describe('fw check', () => {
  it('passes a good folder, finds forms below it and writes the types', async () => {
    const root = project({ 'a/One.form.json': formText(), 'b/c/Two.form.json': formText({ id: 'test.Two' }) });
    const run = await fw(root, 'check', '--no-tsc');
    expect(run.code).toBe(0);
    expect(run.all).toContain('Checked 2 forms: 0 errors, 0 warnings; updated 2 generated files');
    expect(read(root, 'a/One.form.gen.ts')).toContain('export type One = {');
    expect(existsSync(join(root, 'b/c/Two.form.gen.ts'))).toBe(true);
  });

  it('skips node_modules and dist', async () => {
    const root = project({
      'ok.form.json': formText(),
      'node_modules/pkg/bad.form.json': '{ nope',
      'dist/bad.form.json': '{ nope',
    });
    const run = await fw(root, 'check', '--no-tsc');
    expect(run.code).toBe(0);
    expect(run.all).toContain('Checked 1 form:');
  });

  it('reports path:line: severity: message and exits 1 on an error', async () => {
    const text = formText({
      components: [{ id: 'a', type: 'TextInput', layout: { left: 0, top: 0, width: 10, height: 10 }, bind: { value: 'dsA.nope' } }],
    });
    const root = project({ 'sub/Bad.form.json': text });
    const line = text.split('\n').findIndex((l) => l.includes('"value"')) + 1;
    const run = await fw(root, 'check', '--no-tsc');
    expect(run.code).toBe(1);
    expect(run.err).toContain(`sub/Bad.form.json:${line}: error: components[0].bind.value: Dataset "dsA" has no column "nope"`);
    expect(run.all).toMatch(/1 error/);
  });

  it('reports a failed expression with its line', async () => {
    const text = formText({
      components: [{ id: 'a', type: 'Label', layout: { left: 0, top: 0, width: 10, height: 10 }, props: { text: '=vars.nope' } }],
    });
    const root = project({ 'Bad.form.json': text });
    const line = text.split('\n').findIndex((l) => l.includes('"text"')) + 1;
    const run = await fw(root, 'check', '--no-tsc');
    expect(run.code).toBe(1);
    expect(run.err).toContain(`Bad.form.json:${line}: error: components[0].props.text: No variable named "nope"`);
  });

  it('does not fail on warnings', async () => {
    const root = project({ 'W.form.json': formText({ customKey: 1 }) });
    const run = await fw(root, 'check', '--no-tsc');
    expect(run.code).toBe(0);
    expect(run.out.join('\n')).toMatch(/W\.form\.json:\d+: warning: customKey: Unknown key/);
    expect(run.all).toContain('1 warning');
  });

  it('treats a conflicted file as an error and leaves it alone', async () => {
    const root = project({ 'C.form.json': CONFLICTED, 'ok.form.json': formText() });
    const run = await fw(root, 'check', '--no-tsc');
    expect(run.code).toBe(1);
    expect(run.err.join('\n')).toMatch(/C\.form\.json:1: error: .*conflict markers/);
    expect(read(root, 'C.form.json')).toBe(CONFLICTED);
    expect(existsSync(join(root, 'C.form.gen.ts'))).toBe(false);
    expect(existsSync(join(root, 'ok.form.gen.ts'))).toBe(true);
  });

  it('treats invalid JSON as an error with the line of the problem', async () => {
    const root = project({ 'J.form.json': '{\n  "formatVersion": 1,\n  "id": "a",,\n}' });
    const run = await fw(root, 'check', '--no-tsc');
    expect(run.code).toBe(1);
    expect(run.err[0]).toMatch(/^J\.form\.json:3: error: Line 3/);
  });

  it('fails when a generated types file cannot be written', async () => {
    // A folder in the way of the file makes writing impossible on every platform.
    const root = project({ 'G.form.json': formText(), 'G.form.gen.ts/keep': '' });
    const run = await fw(root, 'check', '--no-tsc');
    expect(run.code).toBe(1);
    expect(run.err.join(' ')).toMatch(/G.form.json:1: error: Could not write the types file/);
  });

  it('checks only the paths it is given', async () => {
    const root = project({ 'good/G.form.json': formText(), 'bad/B.form.json': '{' });
    expect((await fw(root, 'check', '--no-tsc', 'good')).code).toBe(0);
    expect((await fw(root, 'check', '--no-tsc', 'bad/B.form.json')).code).toBe(1);
  });

  it('exits 2 for a path that does not exist', async () => {
    const run = await fw(project({}), 'check', 'nowhere');
    expect(run.code).toBe(2);
    expect(run.err.join('\n')).toContain('No such file or folder: nowhere');
  });

  it('does not rewrite generated types that are already right', async () => {
    const root = project({ 'S.form.json': formText() });
    await fw(root, 'check', '--no-tsc');
    const generated = join(root, 'S.form.gen.ts');
    const old = new Date('2020-01-01T00:00:00Z');
    utimesSync(generated, old, old);
    const run = await fw(root, 'check', '--no-tsc');
    expect(run.all).not.toContain('updated');
    expect(statSync(generated).mtimeMs).toBe(old.getTime());
  });
});


describe('fw fmt', () => {
  const messy = '{"formatVersion":1,"id":"a","components":[]}';
  const canonical = '{\n  "formatVersion": 1,\n  "id": "a",\n  "components": []\n}\n';

  it('rewrites a file to the standard layout', async () => {
    const root = project({ 'F.form.json': messy });
    const run = await fw(root, 'fmt');
    expect(run.code).toBe(0);
    expect(run.out).toContain('Formatted F.form.json');
    expect(read(root, 'F.form.json')).toBe(canonical);
    // A second run has nothing left to do.
    expect((await fw(root, 'fmt')).out.join('\n')).toContain('formatted 0 files');
  });

  it('with --check lists the differences, exits 1 and writes nothing', async () => {
    const root = project({ 'F.form.json': messy, 'Good.form.json': canonical });
    const run = await fw(root, 'fmt', '--check');
    expect(run.code).toBe(1);
    expect(run.err).toContain('F.form.json: needs formatting');
    expect(run.err.join('\n')).not.toContain('Good.form.json: needs');
    expect(read(root, 'F.form.json')).toBe(messy);
  });

  it('with --check exits 0 when everything is standard', async () => {
    const root = project({ 'Good.form.json': canonical });
    expect((await fw(root, 'fmt', '--check')).code).toBe(0);
  });

  it('refuses a conflicted file, never writes it, and still formats the others', async () => {
    const root = project({ 'C.form.json': CONFLICTED, 'F.form.json': messy });
    const run = await fw(root, 'fmt');
    expect(run.code).toBe(1);
    expect(run.err.join('\n')).toMatch(/C\.form\.json:1: error: .*conflict markers.* Not formatted/);
    expect(read(root, 'C.form.json')).toBe(CONFLICTED);
    expect(read(root, 'F.form.json')).toBe(canonical);
  });

  it('refuses invalid JSON and leaves the bytes as they were', async () => {
    const broken = '{ "formatVersion": 1, // comment\n "id": "a" }';
    const root = project({ 'J.form.json': broken });
    const run = await fw(root, 'fmt');
    expect(run.code).toBe(1);
    expect(read(root, 'J.form.json')).toBe(broken);
  });

  it('refuses a file that fails the schema', async () => {
    const wrong = '{"formatVersion":1,"id":"a"}';
    const root = project({ 'S.form.json': wrong });
    const run = await fw(root, 'fmt');
    expect(run.code).toBe(1);
    expect(run.err.join('\n')).toMatch(/S\.form\.json:1: error: .*Not formatted/);
    expect(read(root, 'S.form.json')).toBe(wrong);
  });

  it('refuses in --check mode too', async () => {
    const root = project({ 'C.form.json': CONFLICTED });
    const run = await fw(root, 'fmt', '--check');
    expect(run.code).toBe(1);
    expect(read(root, 'C.form.json')).toBe(CONFLICTED);
  });

  it('formats only the files it is given', async () => {
    const root = project({ 'a/F.form.json': messy, 'b/G.form.json': messy });
    await fw(root, 'fmt', 'a');
    expect(read(root, 'a/F.form.json')).toBe(canonical);
    expect(read(root, 'b/G.form.json')).toBe(messy);
  });

  it('keeps unknown keys', async () => {
    const root = project({ 'U.form.json': '{"formatVersion":1,"id":"a","components":[],"futureKey":{"x":1}}' });
    await fw(root, 'fmt');
    expect(read(root, 'U.form.json')).toContain('"futureKey": {');
    expect(JSON.parse(read(root, 'U.form.json')).futureKey).toEqual({ x: 1 });
  });
});

describe('fw', () => {
  it('exits 2 and shows usage for no command or an unknown one', async () => {
    const root = project({});
    expect((await fw(root)).code).toBe(2);
    const unknown = await fw(root, 'frobnicate');
    expect(unknown.code).toBe(2);
    expect(unknown.err.join('\n')).toContain('Unknown command "frobnicate"');
  });

  it('exits 2 for an option the command does not have', async () => {
    const run = await fw(project({}), 'fmt', '--nope');
    expect(run.code).toBe(2);
  });

  it('shows usage for help with exit 0', async () => {
    const run = await fw(project({}), 'help');
    expect(run.code).toBe(0);
    expect(run.out.join('\n')).toContain('fmt [paths]');
  });

  it('writes a form file only through fmt, never through check', async () => {
    const root = project({});
    write(root, 'M.form.json', '{"formatVersion":1,"id":"a","components":[]}');
    await fw(root, 'check', '--no-tsc');
    expect(read(root, 'M.form.json')).toBe('{"formatVersion":1,"id":"a","components":[]}');
  });
});
