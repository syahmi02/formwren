import { describe, expect, it, vi } from 'vitest';
import { createForm, TransactionError, type ComponentDefinition, type FormDefinition, type FormInstance } from '../src/index.ts';

const layout = { left: 0, top: 0, width: 10, height: 10 };

function definition(components: ComponentDefinition[]): FormDefinition {
  return {
    formatVersion: 1,
    id: 'test.Validate',
    datasets: [
      {
        id: 'dsEmp',
        confirmUnsaved: true,
        columns: [
          { id: 'empNo', type: 'string', required: true },
          { id: 'name', type: 'string', required: true },
          { id: 'note', type: 'string', size: 3 },
        ],
        initialRows: [
          { empNo: 'E1', name: 'Ann' },
          { empNo: 'E2', name: 'Bob' },
        ],
      },
      { id: 'dsOther', confirmUnsaved: true, columns: [{ id: 'code', type: 'string', required: true }] },
    ],
    components,
  };
}

const grid: ComponentDefinition = {
  id: 'grid',
  type: 'Grid',
  layout,
  bind: { dataset: 'dsEmp' },
  props: {
    columns: [{ id: 'c0', width: 50 }, { id: 'c1', width: 50 }, { id: 'c2', width: 50 }],
    recordRows: [{ cells: [{ kind: 'rowStatus' }, { field: 'empNo' }, { field: 'name' }] }],
  },
};
const nameInput: ComponentDefinition = { id: 'nameInput', type: 'TextInput', layout, bind: { value: 'dsEmp.name' } };
const noteInput: ComponentDefinition = { id: 'noteInput', type: 'TextInput', layout, bind: { value: 'dsEmp.note' } };

function setup(components: ComponentDefinition[]): { form: FormInstance; focus: Record<string, ReturnType<typeof vi.fn>> } {
  const form = createForm(definition(components));
  const focus: Record<string, ReturnType<typeof vi.fn>> = {};
  const visit = (models: readonly { id: string; setHandle(h: { focus: (cell?: { rowId: number; track: number }) => void }): void; children: { peek(): readonly never[] } }[]): void => {
    for (const model of models) {
      const spy = vi.fn();
      focus[model.id] = spy;
      model.setHandle({ focus: spy });
      visit(model.children.peek());
    }
  };
  visit(form.components.value as never);
  return { form: form as unknown as FormInstance, focus };
}

describe('form.validate', () => {
  it('returns nothing and clears issues when nothing is wrong or to save', () => {
    const { form } = setup([nameInput]);
    expect(form.validate()).toEqual([]);
    const ds = form.getDataset('dsEmp')!;
    ds.setValue(0, 'name', 'Zed');
    expect(form.validate()).toEqual([]);
  });

  it('checks the rows to save of every Dataset and sets the issues', () => {
    const { form } = setup([nameInput]);
    const emp = form.getDataset('dsEmp')!;
    const other = form.getDataset('dsOther')!;
    emp.setValue(1, 'name', '');
    emp.setValue(0, 'note', 'too long');
    other.addRow({ code: null });
    const issues = form.validate();
    expect(issues.map((i) => `${i.dataset}.${i.column}:${i.code}`)).toEqual(['dsEmp.note:length', 'dsEmp.name:required', 'dsOther.code:required']);
    const row = emp.rowIdAt(1);
    expect(emp.issueAt(row, 'name')?.message).toBe('name is required');
    expect(other.issues()).toHaveLength(1);
    // Fixing the cells and validating again clears them.
    emp.setValue(1, 'name', 'Bob');
    emp.setValue(0, 'note', 'ok');
    other.setValue(0, 'code', 'X');
    expect(form.validate()).toEqual([]);
    expect(emp.issues()).toEqual([]);
  });

  it('shows the issue in the bound input props', () => {
    const { form } = setup([nameInput]);
    const emp = form.getDataset('dsEmp')!;
    emp.setValue(0, 'name', '');
    form.validate();
    expect(form.getComponent('nameInput')?.props.value.errorMessage).toBe('name is required');
  });

  it('focuses a bound input when the issue is on the current row', () => {
    const { form, focus } = setup([nameInput, grid]);
    const emp = form.getDataset('dsEmp')!;
    emp.setValue(0, 'name', '');
    emp.setCurrentIndex(0);
    expect(emp.currentRow).toBe(emp.rowIdAt(0));
    form.validate();
    expect(focus.nameInput).toHaveBeenCalledTimes(1);
    expect(focus.grid).not.toHaveBeenCalled();
  });

  it('focuses the Grid cell when the row is not the current one, by the track the Grid definition gives', () => {
    const { form, focus } = setup([nameInput, grid]);
    const emp = form.getDataset('dsEmp')!;
    emp.setValue(1, 'name', '');
    emp.setCurrentIndex(0);
    form.validate();
    expect(focus.nameInput).not.toHaveBeenCalled();
    expect(focus.grid).toHaveBeenCalledWith({ rowId: emp.rowIdAt(1), track: 2 });
  });

  it('focuses only the first issue, in Dataset then row order', () => {
    const { form, focus } = setup([grid]);
    const emp = form.getDataset('dsEmp')!;
    emp.setValue(1, 'empNo', '');
    emp.setValue(0, 'name', '');
    form.validate();
    expect(focus.grid).toHaveBeenCalledTimes(1);
    expect(focus.grid).toHaveBeenCalledWith({ rowId: emp.rowIdAt(0), track: 2 });
  });

  it('focuses nothing when no input or Grid cell shows the column', () => {
    const { form, focus } = setup([noteInput, grid]);
    const emp = form.getDataset('dsEmp')!;
    emp.setValue(1, 'note', 'too long');
    emp.setCurrentIndex(0);
    const issues = form.validate();
    expect(issues).toHaveLength(1);
    expect(focus.grid).not.toHaveBeenCalled();
    expect(focus.noteInput).not.toHaveBeenCalled();
  });

  it('is available to scripts as form.context.validate', () => {
    const { form } = setup([grid]);
    form.getDataset('dsEmp')!.setValue(0, 'name', '');
    expect(form.context.validate()).toHaveLength(1);
  });
});

describe('form.showRowErrors', () => {
  const rowError = (form: FormInstance, row: number, extra: Record<string, unknown> = {}) => ({
    dataset: 'dsEmp',
    id: form.getDataset('dsEmp')!.rowIdAt(row),
    column: 'name',
    code: 'duplicate',
    message: 'Name is taken',
    ...extra,
  });

  it('puts server row errors where client issues go, and focuses the first', () => {
    const { form, focus } = setup([nameInput, grid]);
    const emp = form.getDataset('dsEmp')!;
    emp.setCurrentIndex(1);
    const error = new TransactionError('validation', 'Not saved', [rowError(form, 1), rowError(form, 0, { column: 'empNo', message: 'Bad number' })]);
    const issues = form.showRowErrors(error);
    expect(issues.map((i) => `${i.dataset}.${i.column}:${i.code}`)).toEqual(['dsEmp.empNo:duplicate', 'dsEmp.name:duplicate']);
    expect(emp.issueAt(emp.rowIdAt(1), 'name')?.message).toBe('Name is taken');
    expect(form.getComponent('nameInput')?.props.value.errorMessage).toBe('Name is taken');
    // The first issue is on row 0, which is not current: the Grid cell.
    expect(focus.grid).toHaveBeenCalledWith({ rowId: emp.rowIdAt(0), track: 1 });
    expect(focus.nameInput).not.toHaveBeenCalled();
  });

  it('takes a plain list, and focuses an input on the current row', () => {
    const { form, focus } = setup([nameInput, grid]);
    form.getDataset('dsEmp')!.setCurrentIndex(1);
    const issues = form.context.showRowErrors([rowError(form, 1)]);
    expect(issues).toHaveLength(1);
    expect(focus.nameInput).toHaveBeenCalledTimes(1);
  });

  it('leaves out errors it cannot place, and other Datasets alone', () => {
    const { form } = setup([grid]);
    const other = form.getDataset('dsOther')!;
    other.addRow({ code: null });
    form.validate();
    expect(other.issues()).toHaveLength(1);
    const issues = form.showRowErrors([
      rowError(form, 0),
      { code: 'x', message: 'no dataset' },
      rowError(form, 0, { dataset: 'dsNope' }),
      rowError(form, 0, { column: 'nope' }),
      rowError(form, 0, { id: 9999 }),
      rowError(form, 0, { id: undefined }),
    ]);
    expect(issues).toHaveLength(1);
    expect(other.issues()).toHaveLength(1);
  });
});
