import { existsSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { openFormText, type FormDefinition } from '@fw/format';
import { describe, expect, it } from 'vitest';
import { generateFormTypes, genPathOf, handlerNames, typeNameOf, writeFormTypes } from '../src/gen.ts';
import { project, write } from './helpers.ts';

const fixturePath = new URL('../../format/test/fixtures/EmpSearch.form.json', import.meta.url);

function definition(text: string): FormDefinition {
  const opened = openFormText(text);
  if (opened.status !== 'ok') throw new Error(opened.message);
  return opened.value as unknown as FormDefinition;
}

const make = (extra: Record<string, unknown>, file = 'A.form.json'): string =>
  generateFormTypes(definition(JSON.stringify({ formatVersion: 1, id: 'a', components: [], ...extra })), file);

describe('generateFormTypes', () => {
  it('gives exactly this for the standard example', () => {
    const form = definition(readFileSync(fixturePath, 'utf8'));
    expect(generateFormTypes(form, '/x/EmpSearch.form.json')).toBe(
      [
        '// Generated from EmpSearch.form.json. Do not edit: changes are overwritten.',
        "import type { Dataset as FwDataset } from '@fw/core';",
        "import type { FormModule as FwFormModule } from '@fw/core';",
        "import type fwScript from './EmpSearch.form';",
        '',
        'export type EmpSearch = {',
        '  datasets: {',
        '    dsCond: FwDataset<{ deptCode: string; empName: string }>;',
        '    dsEmp: FwDataset<{ empNo: string; empName: string; salary: string; hiredOn: string }>;',
        '  };',
        '  variables: { busy: boolean };',
        '  params: { deptCode: string | undefined };',
        "  handlers: 'onInit' | 'onSearch';",
        '};',
        '',
        'type FwAssert<T extends true> = T;',
        'export type EmpSearchScriptCheck = FwAssert<[typeof fwScript] extends [FwFormModule<EmpSearch>] ? ([FwFormModule<EmpSearch>] extends [typeof fwScript] ? true : false) : false>;',
        '',
      ].join('\n'),
    );
  });

  it('adds a result member only for a form that declares one', () => {
    const withResult = make({ result: { empNo: { type: 'string' }, qty: { type: 'int', default: 1 }, ok: { type: 'boolean' } } });
    expect(withResult).toContain('  result: { empNo: string; qty: number; ok: boolean };');
    expect(withResult.indexOf('  params:')).toBeLessThan(withResult.indexOf('  result:'));
    expect(withResult.indexOf('  result:')).toBeLessThan(withResult.indexOf('  handlers:'));
    expect(make({})).not.toContain('result');
    expect(make({ result: {} })).toContain('  result: { [K in never]: never };');
  });

  it('maps every column type', () => {
    const columns = ['string', 'date', 'datetime', 'decimal', 'int', 'float', 'boolean'].map((type) => ({ id: `c_${type}`, type }));
    expect(make({ datasets: [{ id: 'ds', columns }] })).toContain(
      'ds: FwDataset<{ c_string: string; c_date: string; c_datetime: string; c_decimal: string; c_int: number; c_float: number; c_boolean: boolean }>;',
    );
  });

  it('is null or undefined when there is no default, the plain type when there is one', () => {
    const text = make({
      params: { n: { type: 'int' }, when: { type: 'datetime', default: '2020-01-01T00:00:00' } },
      variables: { on: { type: 'boolean', default: false }, amount: { type: 'decimal' } },
    });
    expect(text).toContain('variables: { on: boolean; amount: string | null };');
    expect(text).toContain('params: { n: number | undefined; when: string };');
  });

  it('gives a form with no variables or params types with no members, so a made-up name does not compile', () => {
    const text = make({});
    expect(text).toContain('variables: { [K in never]: never };');
    expect(text).toContain('params: { [K in never]: never };');
    expect(text).toContain('datasets: { [K in never]: never };');
    expect(text).toContain('handlers: never;');
    expect(text).not.toContain('import');
    expect(text).not.toContain('{}');
  });

  it('collects handlers from form events and nested components, sorted and without repeats', () => {
    const btn = { type: 'Button', layout: { left: 0, top: 0, width: 1, height: 1 } };
    const form = definition(
      JSON.stringify({
        formatVersion: 1,
        id: 'a',
        script: './A.form.ts',
        events: { init: 'onInit', beforeClose: 'onBeforeClose' },
        components: [
          {
            id: 'p',
            type: 'Panel',
            layout: btn.layout,
            events: { click: 'zeta' },
            children: [
              { id: 'q', type: 'Panel', layout: btn.layout, children: [{ id: 'b', ...btn, events: { click: 'alpha', change: 'onInit' } }] },
            ],
          },
        ],
      }),
    );
    expect(handlerNames(form)).toEqual(['alpha', 'onBeforeClose', 'onInit', 'zeta']);
    expect(generateFormTypes(form, 'A.form.json')).toContain("handlers: 'alpha' | 'onBeforeClose' | 'onInit' | 'zeta';");
  });

  it('gives the same text however the file orders its events', () => {
    expect(make({ events: { init: 'b', close: 'a' } })).toBe(make({ events: { close: 'a', init: 'b' } }));
  });

  it('asserts the script only when the form has one', () => {
    expect(make({})).not.toContain('ScriptCheck');
    expect(make({ script: './sub/A.form.tsx' })).toContain("import type fwScript from './sub/A.form';");
  });

  it('imports Dataset under an alias, so a form called Dataset compiles', () => {
    const text = make({ datasets: [{ id: 'd', columns: [{ id: 'c', type: 'string' }] }] }, 'Dataset.form.json');
    expect(text).toContain("import type { Dataset as FwDataset } from '@fw/core';");
    expect(text).toContain('export type Dataset = {');
    expect(text).toContain('d: FwDataset<{ c: string }>;');
  });

  it('does not use Record, so a form called Record compiles', () => {
    expect(make({}, 'Record.form.json')).not.toMatch(/Record</);
  });
});

describe('names', () => {
  it.each([
    ['/p/EmpSearch.form.json', 'EmpSearch'],
    ['/p/emp-search.form.json', 'emp_search'],
    ['/p/2fa.form.json', '_2fa'],
    ['/p/.form.json', 'Form'],
    ['/p/Dataset.form.json', 'Dataset'],
    ['/p/Record.form.json', 'Record'],
    // The same on every platform: both kinds of separator are understood.
    ['C:\\p\\Edit.form.gen.ts', 'Edit'],
    ['C:\\p\\Edit.form.json', 'Edit'],
    ['p\\sub/Edit.form.json', 'Edit'],
  ])('%s gives %s', (path, expected) => {
    expect(typeNameOf(path)).toBe(expected);
  });

  it.each(['class', 'string', 'number', 'default', 'FwDataset', 'fwScript'])('refuses %s with a clear message', (name) => {
    expect(() => typeNameOf(`/p/${name}.form.json`)).toThrow(new RegExp(`"${name}" can't be used as a type name`));
  });

  it('puts the generated file beside the form', () => {
    expect(genPathOf('/p/EmpSearch.form.json')).toBe('/p/EmpSearch.form.gen.ts');
  });

  it.each(['Copy.json', 'Up.Form.json', 'Bak.form.json.bak', 'a.form.gen.ts', 'form.json.ts'])('has no generated file for %s', (name) => {
    expect(() => genPathOf(`/p/${name}`)).toThrow(/not a \*\.form\.json file/);
  });
});

describe('writeFormTypes', () => {
  it('writes once and then leaves an unchanged file alone', () => {
    const root = project({});
    const formPath = join(root, 'A.form.json');
    write(root, 'A.form.json', '{}');
    const form = definition(readFileSync(fixturePath, 'utf8'));

    expect(writeFormTypes(formPath, form)).toBe(true);
    const genPath = join(root, 'A.form.gen.ts');
    expect(existsSync(genPath)).toBe(true);

    // An old timestamp shows whether the file is touched again.
    const old = new Date('2020-01-01T00:00:00Z');
    utimesSync(genPath, old, old);
    expect(writeFormTypes(formPath, form)).toBe(false);
    expect(statSync(genPath).mtimeMs).toBe(old.getTime());
  });

  it('rewrites when the form changes', () => {
    const root = project({});
    const formPath = join(root, 'A.form.json');
    const form = definition(readFileSync(fixturePath, 'utf8'));
    writeFormTypes(formPath, form);
    const changed = { ...form, events: { init: 'onStart' } } as FormDefinition;
    expect(writeFormTypes(formPath, changed)).toBe(true);
    expect(readFileSync(join(root, 'A.form.gen.ts'), 'utf8')).toContain('onStart');
  });

  it('never writes for a file with another name', () => {
    const root = project({ 'Copy.json': '{"keep":"me"}' });
    const form = definition(readFileSync(fixturePath, 'utf8'));
    expect(() => writeFormTypes(join(root, 'Copy.json'), form)).toThrow();
    expect(readFileSync(join(root, 'Copy.json'), 'utf8')).toBe('{"keep":"me"}');
  });
});

describe('the script import is always one quoted string', () => {
  it("escapes quotes, backslashes and line breaks in the form's script value", () => {
    const text = make({ script: "it's\n/x\\y'.ts" });
    const line = text.split('\n').find((l) => l.startsWith('import type fwScript')) ?? '';
    expect(line).toBe("import type fwScript from './it\\'s\\n/x/y\\'';");
  });
});
