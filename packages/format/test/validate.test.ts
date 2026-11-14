import { readFileSync } from 'node:fs';
import { COLUMN_TYPES } from '@fw/core';
import { describe, expect, it } from 'vitest';
import schema from '../schema/form.schema.json';
import { openFormText, placeGridCells, validateForm } from '../src/index.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
function load(name: string): any {
  const opened = openFormText(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
  if (opened.status !== 'ok') throw new Error(opened.message);
  return opened.value;
}

function problems(change: (form: any) => void): string[] {
  const form = load('EmpSearch.form.json');
  change(form);
  return validateForm(form)
    .filter((diagnostic) => diagnostic.severity === 'error')
    .map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('valid forms', () => {
  it('accepts the standard example with no diagnostics', () => {
    expect(validateForm(load('EmpSearch.form.json'))).toEqual([]);
  });

  it('accepts a hand-formatted form, warning about unknown keys only', () => {
    const diagnostics = validateForm(load('hand-formatted.form.json'));
    expect(diagnostics.every((diagnostic) => diagnostic.severity === 'warning')).toBe(true);
    expect(diagnostics.map((diagnostic) => diagnostic.path).sort()).toEqual([
      'components[0].layout.futureEdge',
      'components[2].props.recordRows[0].cells[1].futureCellOption',
      'customTopLevel',
      'datasets[0].columns[0].futureColumnOption',
    ]);
  });

  it('accepts a minimal form', () => {
    expect(validateForm({ formatVersion: 1, id: 'a', components: [] })).toEqual([]);
  });
});

describe('schema errors', () => {
  it('stays in step with the Dataset column types', () => {
    expect(schema.$defs.columnType.enum).toEqual([...COLUMN_TYPES]);
  });

  it.each([
    ['missing id', (f: any) => delete f.id, /required property "id"/], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['wrong format version', (f: any) => (f.formatVersion = 2), /formatVersion/], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['bad form id', (f: any) => (f.id = 'has space'), /id/], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['bad column type', (f: any) => (f.datasets[0].columns[0].type = 'money'), /datasets\[0\]\.columns\[0\]\.type/], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['no columns', (f: any) => (f.datasets[0].columns = []), /columns/], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['layout not a number', (f: any) => (f.components[0].layout.left = '16'), /components\[0\]\.layout\.left/], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['component without layout', (f: any) => delete f.components[0].layout, /required property "layout"/], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['Grid without props', (f: any) => delete f.components[2].props, /required property "props"/], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['Grid without record rows', (f: any) => delete f.components[2].props.recordRows, /required property "recordRows"/], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['bad cell editor', (f: any) => (f.components[2].props.recordRows[0].cells[1].editor = 'magic'), /editor/], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['footer value without =', (f: any) => (f.components[2].props.footerRows[0].cells[1].value = 'sum(x)'), /value/], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['handler not a name', (f: any) => (f.components[1].events.click = 'do it()'), /click/], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['frozen on the right', (f: any) => (f.components[2].props.columns[0].frozen = 'right'), /frozen/], // eslint-disable-line @typescript-eslint/no-explicit-any
  ])('%s', (_name, change, expected) => {
    const found = problems(change);
    expect(found.length).toBeGreaterThan(0);
    expect(found.join('\n')).toMatch(expected);
  });

  it('reports the real problem, not the wrappers around it', () => {
    const found = problems((form) => (form.components[0].layout.left = '16'));
    expect(found).toHaveLength(1);
  });

  it('rejects something that is not a form at all', () => {
    expect(validateForm('nope').length).toBeGreaterThan(0);
    expect(validateForm(null).length).toBeGreaterThan(0);
  });
});

describe('semantic errors', () => {
  it.each([
    ['duplicate component id', (f: any) => (f.components[1].id = 'empNameInput'), /Two components are named "empNameInput"/], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['duplicate id in a child', (f: any) => (f.components[1].children = [{ ...f.components[0] }]), /Two components/], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['duplicate Dataset id', (f: any) => (f.datasets[1].id = 'dsCond'), /Two Datasets/], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['duplicate column id', (f: any) => (f.datasets[0].columns[1].id = 'deptCode'), /Two columns/], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['unknown key column', (f: any) => (f.datasets[1].keys = ['nope']), /No column named "nope"/], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['binding to no Dataset', (f: any) => (f.components[0].bind.value = 'dsNope.x'), /No Dataset named "dsNope"/], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['binding to no column', (f: any) => (f.components[0].bind.value = 'dsCond.nope'), /has no column "nope"/], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['binding without a dot', (f: any) => (f.components[0].bind.value = 'dsCond'), /dataset\.column/], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['Grid bound to no Dataset', (f: any) => (f.components[2].bind.dataset = 'nope'), /No Dataset named "nope"/], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['Grid cell on no column', (f: any) => (f.components[2].props.recordRows[0].cells[0].field = 'nope'), /has no column "nope"/], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['two record lines', (f: any) => f.components[2].props.recordRows.push(f.components[2].props.recordRows[0]), /more than one line/], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['cell too wide', (f: any) => (f.components[2].props.footerRows[0].cells[0].colSpan = 3), /past the last column/], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['too few cells', (f: any) => f.components[2].props.recordRows[0].cells.pop(), /without a cell/], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['row span too tall', (f: any) => (f.components[2].props.headerRows[0].cells[1].rowSpan = 3), /only 2 are left/], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['frozen after unfrozen', (f: any) => (f.components[2].props.columns[1].frozen = 'left'), /Frozen columns must come first/], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['too many horizontal edges', (f: any) => (f.components[0].layout.right = 1), /two of left, right and width/], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['too few vertical edges', (f: any) => delete f.components[0].layout.height, /two of top, bottom and height/], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['initial row with no such column', (f: any) => (f.datasets[0].initialRows = [{ nope: 1 }]), /No column named "nope"/], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['initial row with a bad value', (f: any) => (f.datasets[0].initialRows = [{ deptCode: 5 }]), /can't hold 5/], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['scale above precision', (f: any) => (f.datasets[1].columns[2].scale = 13), /larger than precision/], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['bad pattern', (f: any) => (f.datasets[1].columns[0].pattern = '('), /not a valid pattern/], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['bad decimal bound', (f: any) => (f.datasets[1].columns[2].min = 'x'), /not a decimal/], // eslint-disable-line @typescript-eslint/no-explicit-any
  ])('%s', (_name, change, expected) => {
    expect(problems(change).join('\n')).toMatch(expected);
  });

  it('allows frozen columns at the left', () => {
    const found = problems((form) => {
      form.components[2].props.columns[0].frozen = 'left';
      form.components[2].props.columns[1].frozen = 'left';
    });
    expect(found).toEqual([]);
  });
});

describe('placeGridCells', () => {
  it('places cells the way an HTML table does', () => {
    const { cells, errors } = placeGridCells(
      [
        { cells: [{ text: 'A', colSpan: 2 }, { text: 'B', rowSpan: 2 }] },
        { cells: [{ text: 'C' }, { text: 'D' }] },
      ],
      3,
    );
    expect(errors).toEqual([]);
    expect(cells.map((cell) => [cell.cell.text, cell.row, cell.column, cell.rowSpan, cell.colSpan])).toEqual([
      ['A', 0, 0, 1, 2],
      ['B', 0, 2, 2, 1],
      ['C', 1, 0, 1, 1],
      ['D', 1, 1, 1, 1],
    ]);
  });

  it('skips a column taken by a row span on the left', () => {
    const { cells, errors } = placeGridCells(
      [
        { cells: [{ text: 'A', rowSpan: 2 }, { text: 'B' }] },
        { cells: [{ text: 'C' }] },
      ],
      2,
    );
    expect(errors).toEqual([]);
    expect(cells[2]).toMatchObject({ row: 1, column: 1 });
  });

  it('reports overlaps, overflow and gaps', () => {
    expect(placeGridCells([{ cells: [{}, {}, {}] }], 2).errors.join()).toMatch(/past the last column/);
    expect(placeGridCells([{ cells: [{}] }], 2).errors.join()).toMatch(/1 of 2 columns/);
    expect(placeGridCells([{ cells: [{ rowSpan: 2 }, {}] }], 2).errors.join()).toMatch(/only 1 are left/);
    expect(
      placeGridCells(
        [
          { cells: [{}, { rowSpan: 2 }] },
          { cells: [{ colSpan: 2 }] },
        ],
        2,
      ).errors.join(),
    ).toMatch(/overlaps/);
  });

  it('accepts an empty section', () => {
    expect(placeGridCells([], 3)).toEqual({ cells: [], errors: [] });
  });
});
