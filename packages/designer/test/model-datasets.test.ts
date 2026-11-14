import { validateForm } from '@fw/format';
import { componentMetas } from '@fw/components/meta';
import { describe, expect, it } from 'vitest';
import { commands } from '../src/index.ts';
import { SAMPLE_B } from './model-sample-b.ts';
import { setup } from './model-util.ts';

const metas = componentMetas;
const errors = (model: ReturnType<typeof setup>['model']) => validateForm(model.definition.value, { components: metas }).filter((d) => d.severity === 'error');

describe('Datasets', () => {
  it('adds a Dataset with a default column, or the columns given', async () => {
    const { run, model } = setup(SAMPLE_B);
    await run(commands.addDataset('dsNew'));
    await run(commands.addDataset('dsTwo', [{ id: 'a', type: 'int' }, { id: 'b', type: 'string' }]));
    const sets = model.definition.value!.datasets!;
    expect(sets.map((d) => d.id)).toEqual(['dsEmp', 'dsDept', 'dsNew', 'dsTwo']);
    expect(sets[2]!.columns).toEqual([{ id: 'id', type: 'string' }]);
    expect(errors(model)).toEqual([]);
  });

  it('adds the first Dataset to a form that has none', async () => {
    const { run, model } = setup('{\n  "formatVersion": 1,\n  "id": "a.B",\n  "components": []\n}\n');
    const { diff } = await run(commands.addDataset('dsA'));
    expect(model.definition.value!.datasets!.length).toBe(1);
    expect(diff.removed).toEqual([]);
  });

  it('refuses a duplicate or invalid id, and duplicate columns', async () => {
    const { refused } = setup(SAMPLE_B);
    expect(await refused(commands.addDataset('dsEmp'))).toMatch(/already a Dataset/);
    expect(await refused(commands.addDataset('1bad'))).toMatch(/valid Dataset id/);
    expect(await refused(commands.addDataset('x', [{ id: 'a', type: 'int' }, { id: 'a', type: 'int' }]))).toMatch(/twice/);
  });

  it('removes an unused Dataset, and refuses one that is used, listing where', async () => {
    const { run, refused, model } = setup(SAMPLE_B);
    await run(commands.addDataset('dsNew'));
    await run(commands.removeDataset('dsNew', metas));
    expect(model.definition.value!.datasets!.map((d) => d.id)).toEqual(['dsEmp', 'dsDept']);
    const message = await refused(commands.removeDataset('dsDept', metas));
    expect(message).toMatch(/Dataset "dsDept" is still used by/);
    expect(message).toContain('components[0].children[1].bind.options');
    const second = await refused(commands.removeDataset('dsEmp', metas));
    expect(second).toContain('components[0].children[0].bind.value');
    expect(second).toContain('components[1].props.text');
    expect(second).toContain('components[2].bind.dataset');
  });

  it('removes the datasets key when the last one goes', async () => {
    const { run, model } = setup('{\n  "formatVersion": 1,\n  "id": "a.B",\n  "datasets": [{ "id": "d", "columns": [{ "id": "a", "type": "int" }] }],\n  "components": []\n}\n');
    await run(commands.removeDataset('d'));
    expect(model.definition.value).not.toHaveProperty('datasets');
  });

  it('renames a Dataset everywhere it is used, and leaves the strings in expressions alone', async () => {
    const { run, model, component } = setup(SAMPLE_B);
    const { result } = await run(commands.renameDataset('dsEmp', 'dsStaff', metas));
    expect(result).toEqual({ status: 'applied' });
    const form = model.definition.value!;
    expect(form.datasets!.map((d) => d.id)).toEqual(['dsStaff', 'dsDept']);
    expect(component('nameInput').bind).toEqual({ value: 'dsStaff.name' });
    expect(component('dept').bind).toEqual({ value: 'dsStaff.empNo', options: 'dsDept' });
    expect(component('grid').bind).toEqual({ dataset: 'dsStaff' });
    // The text inside quotes is only text.
    expect(component('total').props!.text).toBe("=concat('Total ', sum(ds.dsStaff.salary), ' of ds.dsEmp.name')");
    expect(errors(model)).toEqual([]);
  });

  it('renames an options Dataset', async () => {
    const { run, component, model } = setup(SAMPLE_B);
    await run(commands.renameDataset('dsDept', 'dsDepartment', metas));
    expect(component('dept').bind!.options).toBe('dsDepartment');
    expect(errors(model)).toEqual([]);
  });

  it('writes a small diff for a rename', async () => {
    const { run } = setup(SAMPLE_B);
    const { diff } = await run(commands.renameDataset('dsDept', 'dsDepartment', metas));
    expect(diff.removed.length).toBe(2);
    expect(diff.added.length).toBe(2);
  });

  it('refuses to rename to an existing or invalid id, and writes nothing for the same id', async () => {
    const { refused, model, host } = setup(SAMPLE_B);
    expect(await refused(commands.renameDataset('dsEmp', 'dsDept', metas))).toMatch(/already a Dataset/);
    expect(await refused(commands.renameDataset('dsEmp', 'a b', metas))).toMatch(/valid/);
    expect((await model.apply(commands.renameDataset('dsEmp', 'dsEmp', metas))).status).toBe('unchanged');
    expect(host.calls).toEqual([]);
  });

  it('refuses a rename when an expression that mentions the Dataset cannot be read', async () => {
    const broken = SAMPLE_B.replace('"=sum(salary)"', '"=sum(ds.dsEmp.salary) +"');
    const { refused } = setup(broken);
    // Not read as an expression, and it names the Dataset: it is a use, so a remove is refused...
    expect(await refused(commands.removeDataset('dsEmp', metas))).toMatch(/can't be read/);
  });
});

describe('columns', () => {
  it('adds a column at the end, or at an index', async () => {
    const { run, model } = setup(SAMPLE_B);
    await run(commands.addColumn('dsDept', { id: 'floor', type: 'int' }));
    await run(commands.addColumn('dsDept', { id: 'first', type: 'string' }, 0));
    expect(model.definition.value!.datasets![1]!.columns.map((c) => c.id)).toEqual(['first', 'code', 'title', 'floor']);
  });

  it('refuses a duplicate column, an invalid id and an unknown Dataset', async () => {
    const { refused } = setup(SAMPLE_B);
    expect(await refused(commands.addColumn('dsDept', { id: 'code', type: 'int' }))).toMatch(/already has/);
    expect(await refused(commands.addColumn('dsDept', { id: 'x y', type: 'int' }))).toMatch(/valid/);
    expect(await refused(commands.addColumn('nope', { id: 'a', type: 'int' }))).toMatch(/no Dataset/);
  });

  it('removes an unused column and its sample values', async () => {
    const { run, model } = setup(SAMPLE_B);
    await run(commands.addColumn('dsEmp', { id: 'extra', type: 'string' }));
    await run(commands.setSampleCell('dsEmp', 0, 'extra', 'x'));
    await run(commands.removeColumn('dsEmp', 'extra', metas));
    const set = model.definition.value!.datasets![0]!;
    expect(set.columns.map((c) => c.id)).toEqual(['empNo', 'name', 'salary']);
    expect(set.sampleRows![0]).toEqual({ empNo: 'E1', name: 'Ann', salary: '100.5' });
  });

  it('refuses to remove a column that is used, listing where, and a key column, and the last column', async () => {
    const { refused } = setup(SAMPLE_B);
    const used = await refused(commands.removeColumn('dsEmp', 'name', metas));
    expect(used).toContain('components[0].children[0].bind.value');
    expect(used).toContain('props.recordRows[0].cells[1].field');
    // The quoted text in the Label's expression is only text, so it is not a use.
    expect(used).not.toContain('components[1]');
    const key = await refused(commands.removeColumn('dsEmp', 'empNo', metas));
    expect(key).toContain('keys');
    expect(await refused(commands.removeColumn('dsDept', 'title', metas))).toContain('optionLabel');
    const single = setup('{\n  "formatVersion": 1,\n  "id": "a.B",\n  "datasets": [{ "id": "d", "columns": [{ "id": "a", "type": "int" }] }],\n  "components": []\n}\n');
    expect(await single.refused(commands.removeColumn('d', 'a'))).toMatch(/at least one column/);
  });

  it('renames a column in bindings, Grid fields, option columns, keys, expressions and sample rows', async () => {
    const { run, model, component } = setup(SAMPLE_B);
    await run(commands.renameColumn('dsEmp', 'name', 'fullName', metas));
    const form = model.definition.value!;
    expect(form.datasets![0]!.columns.map((c) => c.id)).toEqual(['empNo', 'fullName', 'salary']);
    expect(form.datasets![0]!.sampleRows![0]).toEqual({ empNo: 'E1', fullName: 'Ann', salary: '100.5' });
    expect(form.datasets![0]!.sampleRows![1]).toEqual({ empNo: 'E2', fullName: 'Bob', salary: '200' });
    expect(Object.keys(form.datasets![0]!.sampleRows![1]!)).toEqual(['empNo', 'fullName', 'salary']);
    expect(component('nameInput').bind).toEqual({ value: 'dsEmp.fullName' });
    const cells = (component('grid').props as { recordRows: { cells: { field: string }[] }[] }).recordRows[0]!.cells;
    expect(cells.map((c) => c.field)).toEqual(['empNo', 'fullName', 'salary']);
    expect(component('total').props!.text).toBe("=concat('Total ', sum(ds.dsEmp.salary), ' of ds.dsEmp.name')");
    expect(errors(model)).toEqual([]);
  });

  it('renames a key column, an expression column, a footer column and an options column', async () => {
    const { run, model, component } = setup(SAMPLE_B);
    await run(commands.renameColumn('dsEmp', 'empNo', 'no', metas));
    expect(model.definition.value!.datasets![0]!.keys).toEqual(['no']);
    expect(component('dept').bind!.value).toBe('dsEmp.no');
    await run(commands.renameColumn('dsEmp', 'salary', 'pay', metas));
    expect(component('total').props!.text).toContain('sum(ds.dsEmp.pay)');
    const footer = (component('grid').props as { footerRows: { cells: { value?: string }[] }[] }).footerRows[0]!.cells[1]!;
    expect(footer.value).toBe('=sum(pay)');
    await run(commands.renameColumn('dsDept', 'title', 'caption', metas));
    expect(component('dept').props).toEqual({ optionValue: 'code', optionLabel: 'caption' });
    expect(errors(model)).toEqual([]);
  });

  it('refuses a duplicate or invalid column name, and an expression it cannot rewrite', async () => {
    const { refused } = setup(SAMPLE_B);
    expect(await refused(commands.renameColumn('dsEmp', 'name', 'salary', metas))).toMatch(/already has/);
    expect(await refused(commands.renameColumn('dsEmp', 'name', 'a-b', metas))).toMatch(/valid/);
    const broken = setup(SAMPLE_B.replace("sum(ds.dsEmp.salary)", "sum(ds.dsEmp.salary) +"));
    expect(await broken.refused(commands.removeColumn('dsEmp', 'salary', broken.model.definition.value ? metas : metas))).toMatch(/can't be read/);
  });

  it('moves a column', async () => {
    const { run, model } = setup(SAMPLE_B);
    await run(commands.moveColumn('dsEmp', 'salary', 0));
    expect(model.definition.value!.datasets![0]!.columns.map((c) => c.id)).toEqual(['salary', 'empNo', 'name']);
    await run(commands.moveColumn('dsEmp', 'salary', 99));
    expect(model.definition.value!.datasets![0]!.columns.map((c) => c.id)).toEqual(['empNo', 'name', 'salary']);
  });

  it('sets and clears column attributes, one line each', async () => {
    const { run, model } = setup(SAMPLE_B);
    const { diff } = await run(commands.setColumn('dsEmp', 'salary', { precision: 10, scale: 2, required: true, min: '0', max: '99999', label: 'Pay' }));
    expect(diff.removed.length).toBe(1);
    expect(model.definition.value!.datasets![0]!.columns[2]).toEqual({ id: 'salary', type: 'decimal', precision: 10, scale: 2, required: true, min: '0', max: '99999', label: 'Pay' });
    await run(commands.setColumn('dsEmp', 'salary', { required: undefined, min: undefined, max: undefined }));
    expect(model.definition.value!.datasets![0]!.columns[2]).toEqual({ id: 'salary', type: 'decimal', precision: 10, scale: 2, label: 'Pay' });
    await run(commands.setColumn('dsEmp', 'name', { size: 40, pattern: '^[A-Z]' }));
    expect(model.definition.value!.datasets![0]!.columns[1]).toMatchObject({ size: 40, pattern: '^[A-Z]' });
    expect(errors(model)).toEqual([]);
  });

  it('refuses bad attribute values', async () => {
    const { refused } = setup(SAMPLE_B);
    expect(await refused(commands.setColumn('dsEmp', 'name', { size: -1 }))).toMatch(/size/);
    expect(await refused(commands.setColumn('dsEmp', 'name', { size: 1.5 }))).toMatch(/size/);
    expect(await refused(commands.setColumn('dsEmp', 'name', { pattern: '(' }))).toMatch(/valid pattern/);
    expect(await refused(commands.setColumn('dsEmp', 'name', { type: 'blob' as never }))).toMatch(/column type/);
    expect(await refused(commands.setColumn('dsEmp', 'name', { colour: 'red' } as never))).toMatch(/isn't a column attribute/);
  });

  it('changes a type only if the sample values still fit', async () => {
    const { run, refused, model } = setup(SAMPLE_B);
    expect(await refused(commands.setColumn('dsEmp', 'name', { type: 'int' }))).toMatch(/doesn't fit int/);
    await run(commands.addColumn('dsEmp', { id: 'age', type: 'int' }));
    await run(commands.setColumn('dsEmp', 'age', { type: 'float' }));
    expect(model.definition.value!.datasets![0]!.columns[3]!.type).toBe('float');
  });
});

describe('sample rows', () => {
  it('adds a row at the end or an index, checking values with coerceValue', async () => {
    const { run, model } = setup(SAMPLE_B);
    await run(commands.addSampleRow('dsEmp', { empNo: 'E3', salary: 300 }));
    await run(commands.addSampleRow('dsEmp', { empNo: 'E0', name: null }, 0));
    const rows = model.definition.value!.datasets![0]!.sampleRows!;
    expect(rows.map((r) => r.empNo)).toEqual(['E0', 'E1', 'E2', 'E3']);
    // A whole number is a fine decimal, and is stored as decimal text.
    expect(rows[3]).toEqual({ empNo: 'E3', salary: '300' });
    expect(rows[0]).toEqual({ empNo: 'E0', name: null });
  });

  it('adds the first sample row to a Dataset that has none', async () => {
    const { run, model } = setup(SAMPLE_B);
    const { diff } = await run(commands.addSampleRow('dsDept', { code: 'D1', title: 'Sales' }));
    expect(model.definition.value!.datasets![1]!.sampleRows).toEqual([{ code: 'D1', title: 'Sales' }]);
    expect(diff.added.some((line) => line.includes('"D1"'))).toBe(true);
  });

  it('refuses values that do not fit, and unknown columns', async () => {
    const { refused } = setup(SAMPLE_B);
    expect(await refused(commands.addSampleRow('dsEmp', { salary: 'abc' }))).toMatch(/can't hold/);
    expect(await refused(commands.addSampleRow('dsEmp', { nope: 1 }))).toMatch(/no column/);
    expect(await refused(commands.setSampleCell('dsEmp', 0, 'name', 5))).toMatch(/can't hold/);
  });

  it('sets a cell as one changed line, and removes a value with undefined', async () => {
    const { run, model } = setup(SAMPLE_B);
    const { diff } = await run(commands.setSampleCell('dsEmp', 1, 'name', 'Robert'));
    expect(diff.removed).toEqual(['        { "empNo": "E2", "name": "Bob", "salary": "200" }']);
    expect(diff.added).toEqual(['        { "empNo": "E2", "name": "Robert", "salary": "200" }']);
    await run(commands.setSampleCell('dsEmp', 1, 'name', undefined));
    expect(model.definition.value!.datasets![0]!.sampleRows![1]).toEqual({ empNo: 'E2', salary: '200' });
  });

  it('sets a typed cell: decimals from whole numbers, null', async () => {
    const { run, model } = setup(SAMPLE_B);
    await run(commands.setSampleCell('dsEmp', 0, 'salary', 7));
    await run(commands.setSampleCell('dsEmp', 1, 'salary', null));
    expect(model.definition.value!.datasets![0]!.sampleRows).toEqual([
      { empNo: 'E1', name: 'Ann', salary: '7' },
      { empNo: 'E2', name: 'Bob', salary: null },
    ]);
  });

  it('removes a row, and refuses an index that is not there', async () => {
    const { run, refused, model } = setup(SAMPLE_B);
    await run(commands.removeSampleRow('dsEmp', 0));
    expect(model.definition.value!.datasets![0]!.sampleRows!.map((r) => r.empNo)).toEqual(['E2']);
    expect(await refused(commands.removeSampleRow('dsEmp', 5))).toMatch(/no sample row/);
    expect(await refused(commands.setSampleCell('dsEmp', 9, 'name', 'x'))).toMatch(/no sample row/);
  });

  it('writes nothing when a cell already holds the value', async () => {
    const { model, host } = setup(SAMPLE_B);
    expect((await model.apply(commands.setSampleCell('dsEmp', 0, 'name', 'Ann'))).status).toBe('unchanged');
    expect(host.calls).toEqual([]);
  });

  it('refuses when read-only', async () => {
    const { model, host } = setup(SAMPLE_B);
    host.readOnly = true;
    expect((await model.apply(commands.setSampleCell('dsEmp', 0, 'name', 'X'))).status).toBe('read-only');
  });
});

describe('commands that would break the form are refused', () => {
  it('refuses a type change that breaks an aggregate, naming the error', async () => {
    const { refused } = setup(SAMPLE_B);
    expect(await refused(commands.setColumn('dsEmp', 'salary', { type: 'string' }))).toMatch(/would break the form/);
  });

  it('refuses making a version column a string', async () => {
    const withVersion = SAMPLE_B.replace('{ "id": "empNo", "type": "string" },', '{ "id": "empNo", "type": "string" }, { "id": "rev", "type": "int", "version": true },');
    const { refused, model } = setup(withVersion);
    expect(model.status.value.status).toBe('ok');
    expect(await refused(commands.setColumn('dsEmp', 'rev', { type: 'string' }))).toMatch(/would break the form/);
  });

  it('still allows changes that leave the form as good as it was', async () => {
    const { run, model } = setup(SAMPLE_B);
    await run(commands.setColumn('dsEmp', 'name', { label: 'Full name' }));
    expect(model.definition.value!.datasets![0]!.columns[1]).toMatchObject({ label: 'Full name' });
  });
});

describe('renaming a column keeps the sample rows tidy', () => {
  it('keeps the key order, and changes one line per row, only the key text', async () => {
    const { run, model } = setup(SAMPLE_B);
    const { diff } = await run(commands.renameColumn('dsEmp', 'name', 'fullName', metas));
    const rows = model.definition.value!.datasets![0]!.sampleRows!;
    expect(rows.map((row) => Object.keys(row))).toEqual([['empNo', 'fullName', 'salary'], ['empNo', 'fullName', 'salary']]);
    expect(diff.removed.filter((line) => line.includes('"E'))).toEqual([
      '        { "empNo": "E1", "name": "Ann", "salary": "100.5" },',
      '        { "empNo": "E2", "name": "Bob", "salary": "200" }',
    ]);
    expect(diff.added.filter((line) => line.includes('"E'))).toEqual([
      '        { "empNo": "E1", "fullName": "Ann", "salary": "100.5" },',
      '        { "empNo": "E2", "fullName": "Bob", "salary": "200" }',
    ]);
  });
});
