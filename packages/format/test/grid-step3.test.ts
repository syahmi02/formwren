import { readFileSync } from 'node:fs';
import { defineComponentMeta, type ComponentMeta } from '@fw/core';
import { describe, expect, it } from 'vitest';
import { openFormText, printForm, validateForm, type Diagnostic } from '../src/index.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
function load(): any {
  const opened = openFormText(readFileSync(new URL('./fixtures/EmpSearch.form.json', import.meta.url), 'utf8'));
  if (opened.status !== 'ok') throw new Error(opened.message);
  return opened.value;
}

function run(change: (grid: any, form: any) => void, components?: Record<string, ComponentMeta>): Diagnostic[] {
  const form = load();
  change(form.components[2], form);
  return validateForm(form, components ? { components } : {});
}

const errors = (found: Diagnostic[]): string[] =>
  found.filter((d) => d.severity === 'error').map((d) => `${d.path}: ${d.message}`);

const row0 = (grid: any) => grid.props.recordRows[0].cells;

describe('Grid cells: kind', () => {
  it('accepts a kind cell with no field in recordRows', () => {
    const found = run((grid) => {
      grid.props.columns.unshift({ id: 'sel', width: 30 });
      grid.props.headerRows[0].cells.unshift({ text: '', rowSpan: 2 });
      row0(grid).unshift({ kind: 'rowSelect' });
      grid.props.footerRows[0].cells.unshift({ text: '' });
    });
    expect(errors(found)).toEqual([]);
  });

  it('rejects an unknown kind in the schema', () => {
    expect(errors(run((grid) => (row0(grid)[0].kind = 'nope'))).length).toBeGreaterThan(0);
  });

  it('rejects a kind cell in a header or footer', () => {
    const found = errors(
      run((grid) => {
        grid.props.headerRows[1].cells[0] = { kind: 'rowStatus' };
        grid.props.footerRows[0].cells[1] = { kind: 'rowSelect' };
      }),
    );
    expect(found).toEqual([
      'components[2].props.headerRows[1].cells[0].kind: A "rowStatus" cell only works in recordRows',
      'components[2].props.footerRows[0].cells[1].kind: A "rowSelect" cell only works in recordRows',
    ]);
  });
});

describe('Grid cells: options', () => {
  const withOptions = (form: any): void => {
    form.datasets.push({
      id: 'dsDept',
      columns: [
        { id: 'code', type: 'string' },
        { id: 'name', type: 'string' },
      ],
    });
  };

  it('accepts a Dataset id with existing columns, and a static list', () => {
    expect(
      errors(
        run((grid, form) => {
          withOptions(form);
          Object.assign(row0(grid)[1], { editor: 'dropdown', options: 'dsDept', optionValue: 'code', optionLabel: 'name' });
        }),
      ),
    ).toEqual([]);
    expect(
      errors(run((grid) => Object.assign(row0(grid)[1], { editor: 'dropdown', options: [{ value: 'a', label: 'A' }, { value: 1, label: 'One' }] }))),
    ).toEqual([]);
  });

  it('rejects a missing options Dataset', () => {
    const found = errors(run((grid) => Object.assign(row0(grid)[1], { options: 'dsNope', optionValue: 'code' })));
    expect(found).toEqual(['components[2].props.recordRows[0].cells[1].options: No Dataset named "dsNope"']);
  });

  it('rejects missing optionValue and optionLabel columns', () => {
    const found = errors(
      run((grid, form) => {
        withOptions(form);
        Object.assign(row0(grid)[1], { options: 'dsDept', optionValue: 'nope', optionLabel: 'alsoNope' });
      }),
    );
    expect(found).toEqual([
      'components[2].props.recordRows[0].cells[1].optionValue: Dataset "dsDept" has no column "nope"',
      'components[2].props.recordRows[0].cells[1].optionLabel: Dataset "dsDept" has no column "alsoNope"',
    ]);
  });

  it('requires optionValue when options is a Dataset', () => {
    const found = errors(
      run((grid, form) => {
        withOptions(form);
        Object.assign(row0(grid)[1], { options: 'dsDept' });
      }),
    );
    expect(found).toEqual(['components[2].props.recordRows[0].cells[1].optionValue: Options from Dataset "dsDept" need optionValue']);
  });

  it('rejects a malformed static list in the schema', () => {
    expect(errors(run((grid) => (row0(grid)[1].options = [{ value: 'a' }]))).length).toBeGreaterThan(0);
  });

  it('needs options for a dropdown editor', () => {
    const found = errors(run((grid) => (row0(grid)[1].editor = 'dropdown')));
    expect(found).toEqual(['components[2].props.recordRows[0].cells[1].editor: A dropdown editor needs options']);
  });
});

describe('Grid checks', () => {
  it('requires bind.dataset', () => {
    const found = errors(run((grid) => delete grid.bind.dataset));
    expect(found).toContain('components[2].bind: A Grid needs bind.dataset, the Dataset it shows');
  });

  it('rejects a merged header or footer cell across the frozen boundary', () => {
    const found = errors(
      run((grid) => {
        grid.props.columns[0].frozen = 'left';
      }),
    );
    expect(found).toEqual([
      'components[2].props.headerRows[0]: A merged cell can\'t cross the frozen boundary (after column 1)',
      'components[2].props.footerRows[0]: A merged cell can\'t cross the frozen boundary (after column 1)',
    ]);
  });

  it('accepts a merge that ends at the boundary', () => {
    const found = errors(
      run((grid) => {
        grid.props.columns[0].frozen = 'left';
        grid.props.columns[1].frozen = 'left';
      }),
    );
    expect(found).toEqual([]);
  });
});

describe('Grid and component metas', () => {
  const textInput = defineComponentMeta({
    type: 'TextInput',
    displayName: 'Text input',
    category: 'input',
    container: false,
    defaultSize: { width: 200, height: 28 },
    props: { label: { kind: 'string', description: '' }, maxLength: { kind: 'number', description: '' } },
    bindings: { value: 'column' },
    events: {},
  });
  const button = defineComponentMeta({
    type: 'Button',
    displayName: 'Button',
    category: 'action',
    container: false,
    defaultSize: { width: 80, height: 28 },
    props: { text: { kind: 'string', description: '' }, disabled: { kind: 'boolean', description: '' } },
    bindings: {},
    events: { click: { description: '' } },
  } as any);
  const grid = defineComponentMeta({
    type: 'Grid',
    displayName: 'Grid',
    category: 'data',
    container: false,
    defaultSize: { width: 400, height: 300 },
    props: {},
    bindings: { dataset: 'dataset' },
    events: {},
  } as any);

  it('does not call Grid unknown while metas lack it', () => {
    const found = run(() => {}, { TextInput: textInput, Button: button });
    expect(found.filter((d) => /Unknown component type/.test(d.message))).toEqual([]);
  });

  it('treats Grid like any other type once a Grid meta exists, and still runs checkGrid', () => {
    const found = run((g) => delete g.bind.dataset, { TextInput: textInput, Button: button, Grid: grid });
    expect(found.filter((d) => /Unknown component type/.test(d.message))).toEqual([]);
    expect(errors(found)).toContain('components[2].bind: A Grid needs bind.dataset, the Dataset it shows');
    // props the meta does not list now warn, because the Grid is a known type
    expect(found.some((d) => d.severity === 'warning' && d.path === 'components[2].props.columns')).toBe(true);
  });
});

describe('printing the new cell keys', () => {
  it('writes them in a fixed order on one line', () => {
    const form = load();
    form.datasets.push({ id: 'dsDept', columns: [{ id: 'code', type: 'string' }] });
    Object.assign(row0(form.components[2])[1], {
      optionLabel: 'code',
      optionValue: 'code',
      options: 'dsDept',
      editor: 'dropdown',
    });
    row0(form.components[2]).unshift({ kind: 'rowSelect' });
    const text = printForm(form);
    expect(text).toContain('{ "kind": "rowSelect" }');
    expect(text).toContain('{ "field": "empName", "editor": "dropdown", "options": "dsDept", "optionValue": "code", "optionLabel": "code" }');
  });
});
