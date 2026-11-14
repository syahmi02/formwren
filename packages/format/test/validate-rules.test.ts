import { readFileSync } from 'node:fs';
import { defineComponentMeta, type ComponentMeta } from '@fw/core';
import { describe, expect, it } from 'vitest';
import { openFormText, validateForm, type Diagnostic } from '../src/index.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
function load(): any {
  const opened = openFormText(readFileSync(new URL('./fixtures/EmpSearch.form.json', import.meta.url), 'utf8'));
  if (opened.status !== 'ok') throw new Error(opened.message);
  return opened.value;
}

function run(change: (form: any) => void, components?: Record<string, ComponentMeta>): Diagnostic[] {
  const form = load();
  change(form);
  return validateForm(form, components ? { components } : {});
}

const errors = (found: Diagnostic[]): string[] =>
  found.filter((d) => d.severity === 'error').map((d) => `${d.path}: ${d.message}`);
const warnings = (found: Diagnostic[]): string[] =>
  found.filter((d) => d.severity === 'warning').map((d) => `${d.path}: ${d.message}`);

/** A small set of metas shaped like the real ones. */
const metas: Record<string, ComponentMeta> = {
  TextInput: defineComponentMeta({
    type: 'TextInput',
    displayName: 'Text input',
    category: 'input',
    container: false,
    defaultSize: { width: 200, height: 28 },
    props: { label: { kind: 'string', description: '' }, maxLength: { kind: 'number', description: '' } },
    bindings: { value: 'column' },
    events: {},
  }),
  Button: defineComponentMeta({
    type: 'Button',
    displayName: 'Button',
    category: 'action',
    container: false,
    defaultSize: { width: 88, height: 28 },
    props: { text: { kind: 'string', description: '' }, disabled: { kind: 'boolean', description: '' } },
    bindings: {},
    events: { click: { description: '' } },
  }),
  ComboBox: defineComponentMeta({
    type: 'ComboBox',
    displayName: 'Combo box',
    category: 'input',
    container: false,
    defaultSize: { width: 200, height: 28 },
    props: { optionValue: { kind: 'string', description: '' } },
    bindings: { value: 'column', options: 'dataset' },
    events: {},
  }),
};
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('dataset-level bindings', () => {
  const combo = (bind: Record<string, string>) => (form: any) => // eslint-disable-line @typescript-eslint/no-explicit-any
    form.components.push({ id: 'combo', type: 'ComboBox', layout: { left: 0, top: 0, width: 10, height: 10 }, bind });

  it('accepts bind.options holding a Dataset id', () => {
    expect(errors(run(combo({ value: 'dsEmp.empNo', options: 'dsCond' })))).toEqual([]);
  });

  it('reports bind.options naming no Dataset', () => {
    expect(errors(run(combo({ options: 'dsNope' })))).toEqual(['components[3].bind.options: No Dataset named "dsNope"']);
  });

  it('still wants dataset.column for other keys', () => {
    expect(errors(run(combo({ value: 'dsEmp' })))).toEqual(['components[3].bind.value: "dsEmp" should look like dataset.column']);
  });

  it('follows the meta when there is one', () => {
    const found = run(combo({ value: 'dsEmp.empNo', options: 'dsCond' }), metas);
    expect(errors(found)).toEqual([]);
  });
});

describe('expressions', () => {
  const setProp = (value: string) => (form: any) => (form.components[1].props.text = value); // eslint-disable-line @typescript-eslint/no-explicit-any

  it.each([
    "=concat('Row ', ds.dsEmp.$currentIndex + 1, ' of ', ds.dsEmp.$rowCount)",
    '=sum(ds.dsEmp.salary)',
    '=vars.busy ? params.deptCode : ds.dsCond.empName',
    '="plain text"',
  ])('accepts %s', (expression) => {
    expect(errors(run(setProp(expression)))).toEqual([]);
  });

  it('reports bad syntax with the path of the prop', () => {
    const found = errors(run(setProp('=1 +')));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^components\[1\]\.props\.text: /);
  });

  it.each([
    ['=vars.nope', /No variable named "nope"/],
    ['=params.nope', /No parameter named "nope"/],
    ['=ds.dsNope.x', /No Dataset named "dsNope"/],
    ['=ds.dsEmp.nope', /Dataset "dsEmp" has no column "nope"/],
    ['=sum(ds.dsEmp.nope)', /has no column "nope"/],
    ['=ds.dsEmp', /should look like ds\.dataset\.column/],
    ['=salary', /doesn't refer to anything/],
  ])('reports %s', (expression, expected) => {
    const found = errors(run(setProp(expression)));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^components\[1\]\.props\.text: /);
    expect(found[0]).toMatch(expected);
  });

  it('names the nested path of a child component', () => {
    const found = errors(
      run((form) => {
        form.components[0].children = [{ ...form.components[1], id: 'inner', props: { text: '=vars.nope' } }];
      }),
    );
    expect(found).toEqual(['components[0].children[0].props.text: No variable named "nope"']);
  });

  it('resolves a bare name in a Grid footer to the Grid Dataset', () => {
    expect(errors(run(() => undefined))).toEqual([]);
    const found = errors(
      run((form) => {
        form.components[2].props.footerRows[0].cells[1].value = '=sum(nope)';
      }),
    );
    expect(found).toEqual([
      'components[2].props.footerRows[0].cells[1].value: Dataset "dsEmp" has no column "nope"',
    ]);
  });

  it('does not accept a bare name outside a footer', () => {
    const found = errors(
      run((form) => {
        form.components[2].props.recordRows[0].cells[2].value = '=salary';
      }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/recordRows\[0\]\.cells\[2\]\.value: .*doesn't refer to anything/);
  });

  it('does not accept a bare name when the Grid has no Dataset', () => {
    const found = errors(
      run((form) => {
        delete form.components[2].bind;
      }),
    );
    expect(found.filter((message) => message.includes('footerRows'))).toHaveLength(1);
    expect(found.some((message) => /needs bind.dataset/.test(message))).toBe(true);
  });

  it('still checks full paths in a Grid footer', () => {
    const found = errors(
      run((form) => {
        form.components[2].props.footerRows[0].cells[1].value = '=count(ds.dsCond.empName) + vars.nope';
      }),
    );
    expect(found).toEqual(['components[2].props.footerRows[0].cells[1].value: No variable named "nope"']);
  });
});

describe('component metas', () => {
  it('says nothing about types and props when no metas are passed', () => {
    expect(run((form) => (form.components[0].props.madeUp = 1))).toEqual([]);
  });

  it('warns about an unknown type, except for Grid', () => {
    const found = warnings(run((form) => (form.components[1].type = 'Gizmo'), metas));
    expect(found).toEqual(['components[1].type: Unknown component type "Gizmo"']);
  });

  it('warns about an unknown prop', () => {
    const found = warnings(run((form) => (form.components[0].props.madeUp = 1), metas));
    expect(found).toEqual(['components[0].props.madeUp: TextInput has no prop "madeUp"']);
  });

  it('errors on a bind key the meta does not list', () => {
    const found = errors(run((form) => (form.components[0].bind = { text: 'dsCond.empName' }), metas));
    expect(found).toEqual(['components[0].bind.text: TextInput can\'t bind "text"']);
  });

  it('accepts the standard example against these metas', () => {
    expect(validateForm(load(), { components: metas })).toEqual([]);
  });

  it('keeps the same result as before when no metas are given', () => {
    expect(validateForm(load())).toEqual(validateForm(load(), {}));
  });
});

describe('the version column', () => {

  it('accepts one int version column', () => {
    const found = run((form) => {
      form.datasets[0].columns.push({ id: 'verCol', type: 'int', version: true });
    });
    expect(errors(found).filter((e) => e.includes('version'))).toEqual([]);
  });

  it('rejects a version column that is not an int', () => {
    const found = run((form) => {
      form.datasets[0].columns.push({ id: 'verCol', type: 'string', version: true });
    });
    expect(errors(found).some((e) => e.includes('.version') && e.includes('must be an int'))).toBe(true);
  });

  it('rejects a second version column in one Dataset', () => {
    const found = run((form) => {
      form.datasets[0].columns.push({ id: 'v1', type: 'int', version: true }, { id: 'v2', type: 'int', version: true });
    });
    expect(errors(found).filter((e) => e.includes('at most one version column'))).toHaveLength(1);
  });

  it('is only a boolean in the schema', () => {
    const schema = JSON.parse(readFileSync(new URL('../schema/form.schema.json', import.meta.url), 'utf8'));
    expect(schema.$defs.column.properties.version).toEqual({ type: 'boolean' });
  });
});
