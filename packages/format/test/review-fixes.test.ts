import { readFileSync } from 'node:fs';
import { defineComponentMeta, type ComponentMeta } from '@fw/core';
import { describe, expect, it } from 'vitest';
import schema from '../schema/form.schema.json';
import { ROLES, type Role } from '../src/print.ts';
import { diffFormText, openFormText, validateForm, writeFormText, type Diagnostic } from '../src/index.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const canonical = fixture('EmpSearch.form.json');
const hand = fixture('hand-formatted.form.json');

function parse(text: string): any {
  const opened = openFormText(text);
  if (opened.status !== 'ok') throw new Error(opened.message);
  return opened.value;
}

function changedLines(before: string, after: string): { removed: string[]; added: string[] } {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return { removed: a.slice(start, a.length - end), added: b.slice(start, b.length - end) };
}

const meta = (type: string, category: ComponentMeta['category'], props: string[], events: string[] = [], bindings: ComponentMeta['bindings'] = {}) =>
  defineComponentMeta({
    type,
    displayName: type,
    category,
    container: false,
    defaultSize: { width: 1, height: 1 },
    props: Object.fromEntries(props.map((p) => [p, { kind: 'string' as const, description: '' }])),
    bindings,
    events: Object.fromEntries(events.map((e) => [e, { description: '' }])),
  });
const metas: Record<string, ComponentMeta> = {
  TextInput: meta('TextInput', 'input', ['label', 'maxLength'], ['change'], { value: 'column' }),
  Button: meta('Button', 'action', ['text', 'disabled'], ['click']),
  Label: meta('Label', 'display', ['text']),
  Panel: meta('Panel', 'container', ['title']),
};

function run(change: (form: any) => void, withMetas = false): Diagnostic[] {
  const form = parse(canonical);
  change(form);
  return validateForm(form, withMetas ? { components: metas } : {});
}
const errors = (d: Diagnostic[]) => d.filter((x) => x.severity === 'error').map((x) => `${x.path}: ${x.message}`);
const warnings = (d: Diagnostic[]) => d.filter((x) => x.severity === 'warning').map((x) => `${x.path}: ${x.message}`);

describe('1. numbers a double cannot hold', () => {
  it.each(['12345678901234567890', '0.12345678901234567890123', '1e-400', '1e400', '9007199254740993', '-12345678901234567890'])(
    'opens %s as invalid, naming the line',
    (literal) => {
      const opened = openFormText(`{\n  "a": ${literal}\n}`);
      expect(opened.status).toBe('invalid');
      if (opened.status === 'invalid') {
        expect(opened.line).toBe(2);
        expect(opened.message).toMatch(/string/);
      }
    },
  );

  it.each(['1.10', '1e3', '0', '-0', '0.1', '100000000000000000000', '1E+2', '0.30000000000000004', '5e-324', '1.7976931348623157e308', '0e5'])(
    'keeps %s legal',
    (literal) => {
      expect(openFormText(`{"a": ${literal}}`).status).toBe('ok');
    },
  );

  it('refuses to write over a file holding one', () => {
    expect(() => writeFormText('{"a": 12345678901234567890}', { a: 1 })).toThrow(/string/);
  });

  it('finds a bad number nested in an array', () => {
    expect(openFormText('{"a": [1, {"b": 1e-400}]}').status).toBe('invalid');
  });
});

describe('2. renaming an id in a hand-formatted file', () => {
  it('is a one-line change', () => {
    const form = parse(hand);
    form.components[1].id = 'panel2';
    const { removed, added } = changedLines(hand, writeFormText(hand, form));
    expect(removed).toHaveLength(1);
    expect(added).toHaveLength(1);
  });

  it('is a one-line change in a standard file', () => {
    const single = parse(canonical);
    single.components[1].id = 'go';
    const text = writeFormText(canonical, single);
    expect(parse(text)).toEqual(single);
    const result = changedLines(canonical, text);
    expect([result.removed.length, result.added.length]).toEqual([1, 1]);
  });

  it.each([
    ['a column', (f: any) => (f.datasets[0].columns[0].id = 'dept')],
    ['a dataset', (f: any) => (f.datasets[1].id = 'dsEmp2')],
    ['a grid', (f: any) => (f.components[2].id = 'grid2')],
    ['a grid track', (f: any) => (f.components[2].props.columns[0].id = 'k1')],
  ])('renaming %s is one line', (_name, change) => {
    const form = parse(canonical);
    change(form);
    const text = writeFormText(canonical, form);
    expect(parse(text)).toEqual(form);
    const result = changedLines(canonical, text);
    expect([result.removed.length, result.added.length]).toEqual([1, 1]);
  });

  it('keeps key order when renaming', () => {
    const text = '{"formatVersion":1,"id":"a","components":[{"type":"Label","id":"x","layout":{"left":0,"top":0,"width":1,"height":1}}]}';
    const form = parse(text);
    form.components[0].id = 'y';
    expect(writeFormText(text, form)).toBe(text.replace('"x"', '"y"'));
    expect(diffFormText(text, form)).toHaveLength(1);
  });
});

describe('3. defaults are checked against type', () => {
  it.each([
    [{ type: 'boolean', default: 'yes' }],
    [{ type: 'decimal', default: 1.5 }],
    [{ type: 'int', default: 'x' }],
  ])('rejects %j', (typed) => {
    expect(errors(run((f) => (f.variables.bad = typed)))).toHaveLength(1);
    expect(errors(run((f) => (f.params.bad = typed)))[0]).toMatch(/^params\.bad\.default: /);
  });
  it('accepts good defaults', () => {
    expect(errors(run((f) => (f.variables.n = { type: 'decimal', default: '1.50' })))).toEqual([]);
    expect(errors(run((f) => (f.variables.n = { type: 'int', default: null })))).toEqual([]);
  });
});

describe('4. unknown event names', () => {
  it('flags a misspelled component event', () => {
    expect(errors(run((f) => (f.components[1].events = { clikc: 'onClick' }), true))).toEqual([
      'components[1].events.clikc: Button has no event "clikc"',
    ]);
  });
  it('flags a misspelled form event', () => {
    expect(errors(run((f) => (f.events = { inti: 'onInit' }), true))).toEqual(['events.inti: A form has no event "inti"']);
  });
  it('accepts the form events', () => {
    expect(errors(run((f) => (f.events = { init: 'a', beforeClose: 'b', close: 'c' }), true))).toEqual([]);
  });
  it('says nothing without metas', () => {
    expect(errors(run((f) => (f.events = { inti: 'a' })))).toEqual([]);
  });
});

describe('5. aggregates need a real column', () => {
  const text = (expression: string) => (f: any) => (f.components[1].props.text = expression);
  it.each([
    ['=sum(vars.busy)', /needs a column/],
    ['=sum(ds.dsEmp.$rowCount)', /needs a column/],
    ['=sum(ds.dsEmp.empName)', /int, float or decimal/],
    ['=avg(ds.dsEmp.hiredOn)', /int, float or decimal/],
    ['=count(vars.busy)', /needs a column/],
    ['=1 + sum(params.deptCode)', /needs a column/],
  ])('reports %s', (expression, expected) => {
    const found = errors(run(text(expression)));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(expected);
  });
  it.each([
    '=sum(ds.dsEmp.salary)',
    '=min(ds.dsEmp.empName)',
    '=max(ds.dsEmp.hiredOn)',
    '=count(ds.dsEmp.empName)',
    "='sum(vars.busy)'",
    '=vars.busy ? 1 : sum(ds.dsEmp.salary)',
  ])('accepts %s', (expression) => {
    expect(errors(run(text(expression)))).toEqual([]);
  });
  it('checks a footer aggregate by the Grid Dataset', () => {
    const found = errors(run((f) => (f.components[2].props.footerRows[0].cells[1].value = '=sum(empNo)')));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/int, float or decimal/);
  });
});

describe('6. optionValue and optionLabel', () => {
  const combo = (props: any) => (f: any) =>
    f.components.push({ id: 'cb', type: 'ComboBox', layout: { left: 0, top: 0, width: 1, height: 1 }, props, bind: { options: 'dsCond' } });
  it('flags missing columns', () => {
    expect(errors(run(combo({ optionValue: 'nope', optionLabel: 'empName' })))).toEqual([
      'components[3].props.optionValue: Dataset "dsCond" has no column "nope"',
    ]);
    expect(errors(run(combo({ optionValue: 'deptCode', optionLabel: 'gone' })))).toEqual([
      'components[3].props.optionLabel: Dataset "dsCond" has no column "gone"',
    ]);
  });
  it('accepts real columns', () => {
    expect(errors(run(combo({ optionValue: 'deptCode', optionLabel: 'empName' })))).toEqual([]);
  });
});

describe('7. min and max on other column types', () => {
  const column = (c: any) => (f: any) => f.datasets[0].columns.push({ id: 'z', ...c });
  it.each([
    [{ type: 'int', min: 'abc' }],
    [{ type: 'float', max: 'abc' }],
    [{ type: 'date', min: 5 }],
    [{ type: 'date', max: '2024-13-45' }],
    [{ type: 'datetime', min: 'soon' }],
  ])('rejects %j', (c) => {
    expect(errors(run(column(c)))).toHaveLength(1);
  });
  it.each([
    [{ type: 'int', min: 0, max: 10 }],
    [{ type: 'float', min: -1.5 }],
    [{ type: 'date', min: '2024-01-01' }],
    [{ type: 'datetime', max: '2024-01-01T10:00:00' }],
  ])('accepts %j', (c) => {
    expect(errors(run(column(c)))).toEqual([]);
  });
});

describe('8. Grid props outside cells', () => {
  it('checks expressions', () => {
    expect(errors(run((f) => (f.components[2].props.disabled = '=vars.nope')))).toEqual([
      'components[2].props.disabled: No variable named "nope"',
    ]);
  });
});

describe('9. decimal bounds as JSON numbers', () => {
  const column = (c: any) => (f: any) => (f.datasets[1].columns[2] = { id: 'salary', type: 'decimal', ...c });
  it('accepts finite numbers', () => {
    expect(errors(run(column({ min: 0.5, max: 1000 })))).toEqual([]);
  });
  it('still rejects text that is not a decimal', () => {
    expect(errors(run(column({ min: 'abc' })))).toHaveLength(1);
  });
});

describe('10. input without a label', () => {
  const add = (c: any) => (f: any) => f.components.push({ layout: { left: 0, top: 0, width: 1, height: 1 }, ...c });
  it('warns for an input', () => {
    expect(warnings(run(add({ id: 'u', type: 'TextInput' }), true))).toEqual([
      'components[3].props.label: TextInput has no label, so it has no visible name',
    ]);
  });
  it('does not warn for Button, Label, containers or a labelled input', () => {
    const found = run((f) => {
      add({ id: 'b', type: 'Button' })(f);
      add({ id: 'l', type: 'Label' })(f);
      add({ id: 'p', type: 'Panel' })(f);
      add({ id: 't', type: 'TextInput', props: { label: 'x' } })(f);
    }, true);
    expect(warnings(found)).toEqual([]);
  });
  it('says nothing without metas', () => {
    expect(warnings(run(add({ id: 'u', type: 'TextInput' })))).toEqual([]);
  });
});

describe('11. tabIndex is gone', () => {
  it('is not in the schema', () => {
    expect(Object.keys(schema.$defs.component.properties)).not.toContain('tabIndex');
    expect(ROLES.component.keys).not.toContain('tabIndex');
  });
  it('is an unknown key that is kept, with a warning', () => {
    const form = parse(canonical);
    form.components[0].tabIndex = 2;
    expect(warnings(validateForm(form))).toEqual(['components[0].tabIndex: Unknown key "tabIndex". It will be kept as is']);
    const text = writeFormText(canonical, form);
    expect(parse(text).components[0].tabIndex).toBe(2);
    expect(parse(writeFormText(text, parse(text))).components[0].tabIndex).toBe(2);
  });
});

describe('12. schema and print roles agree', () => {
  const defs: any = schema.$defs;
  const cases: [Role, any][] = [
    ['form', schema],
    ['size', schema.properties.size],
    ['dataset', defs.dataset],
    ['column', defs.column],
    ['component', defs.component],
    ['layout', defs.layout],
    ['gridProps', defs.gridProps],
    ['track', defs.gridTrack],
    ['gridRow', defs.gridRow],
    ['cell', defs.gridCell],
  ];
  it.each(cases)('%s', (role, definition) => {
    expect([...(ROLES[role].keys ?? [])].sort()).toEqual(Object.keys(definition.properties).sort());
  });
});
