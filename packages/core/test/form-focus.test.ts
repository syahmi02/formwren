import { describe, expect, it, vi } from 'vitest';
import { createForm, type ComponentDefinition, type FormDefinition, type FormInstance } from '../src/index.ts';

const layout = { left: 0, top: 0, width: 10, height: 10 };
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function definition(components: ComponentDefinition[]): FormDefinition {
  return {
    formatVersion: 1,
    id: 'test.Focus',
    datasets: [
      {
        id: 'dsEmp',
        confirmUnsaved: true,
        columns: [
          { id: 'empNo', type: 'string', required: true },
          { id: 'name', type: 'string', required: true },
        ],
        initialRows: [
          { empNo: 'E1', name: 'Ann' },
          { empNo: 'E2', name: 'Bob' },
        ],
      },
      { id: 'dsSearch', columns: [{ id: 'text', type: 'string', size: 3 }], initialRows: [{ text: 'way too long' }] },
      { id: 'dsOther', confirmUnsaved: true, columns: [{ id: 'code', type: 'string' }] },
    ],
    components,
  };
}

type Handled = { id: string; setHandle(h: { focus: (cell?: { rowId: number; track: number }) => void }): void; children: { peek(): readonly Handled[] } };

function setup(components: ComponentDefinition[]): { form: FormInstance; focus: Record<string, ReturnType<typeof vi.fn>> } {
  const form = createForm(definition(components));
  const focus: Record<string, ReturnType<typeof vi.fn>> = {};
  const visit = (models: readonly Handled[]): void => {
    for (const model of models) {
      const spy = vi.fn();
      focus[model.id] = spy;
      model.setHandle({ focus: spy });
      visit(model.children.peek());
    }
  };
  visit(form.components.value as unknown as readonly Handled[]);
  return { form: form as unknown as FormInstance, focus };
}

const nameInput: ComponentDefinition = { id: 'nameInput', type: 'TextInput', layout, bind: { value: 'dsEmp.name' } };
const grid: ComponentDefinition = {
  id: 'grid',
  type: 'Grid',
  layout,
  bind: { dataset: 'dsEmp' },
  props: {
    columns: [{ id: 'c0', width: 50 }, { id: 'c1', width: 50 }],
    recordRows: [{ cells: [{ field: 'empNo' }, { field: 'name' }] }],
  },
};

describe('which Datasets validate checks', () => {
  it('checks only Datasets with confirmUnsaved by default', () => {
    const { form } = setup([grid]);
    const search = form.getDataset('dsSearch')!;
    search.setValue(0, 'text', 'still too long');
    expect(form.validate()).toEqual([]);
    expect(search.validate()).toHaveLength(1);
    expect(search.issues()).toEqual([]);
  });

  it('checks the named Datasets, and clears issues only on those it checked', () => {
    const { form } = setup([grid]);
    const emp = form.getDataset('dsEmp')!;
    const search = form.getDataset('dsSearch')!;
    search.setValue(0, 'text', 'still too long');
    expect(form.validate({ datasets: ['dsSearch'] }).map((i) => i.dataset)).toEqual(['dsSearch']);
    emp.setIssues([{ rowId: emp.rowIdAt(1), column: 'name', code: 'x', message: 'server' }]);
    form.validate({ datasets: ['dsSearch'] });
    expect(emp.issues()).toHaveLength(1);
    // The default run checks dsEmp, which has nothing wrong, and leaves dsSearch alone.
    form.validate();
    expect(emp.issues()).toEqual([]);
    expect(search.issues()).toHaveLength(1);
  });

  it('throws for an unknown Dataset name', () => {
    const { form } = setup([grid]);
    expect(() => form.validate({ datasets: ['nope'] })).toThrow(/Unknown Dataset/);
  });
});

describe('focus targets', () => {
  const tabbed: ComponentDefinition = {
    id: 'tabs',
    type: 'Tabs',
    layout,
    children: [
      { id: 'page0', type: 'Page', layout, children: [{ id: 'other', type: 'TextInput', layout, bind: { value: 'dsOther.code' } }] },
      { id: 'page1', type: 'Page', layout, children: [nameInput] },
    ],
  };

  it('makes the row current and focuses the input when there is no Grid', async () => {
    const { form, focus } = setup([nameInput]);
    const emp = form.getDataset('dsEmp')!;
    emp.setCurrentIndex(0);
    emp.setValue(1, 'name', '');
    form.validate();
    expect(emp.currentIndex).toBe(1);
    await tick();
    expect(focus.nameInput).toHaveBeenCalledTimes(1);
    expect(form.getComponent('nameInput')?.props.value.errorMessage).toBe('name is required');
  });

  it('leaves the current row alone if a handler refuses, and still returns the issues', async () => {
    const { form, focus } = setup([nameInput]);
    const emp = form.getDataset('dsEmp')!;
    emp.setCurrentIndex(0);
    emp.setValue(1, 'name', '');
    emp.on('currentRowChanging', (event) => event.preventDefault());
    const issues = form.validate();
    expect(issues).toHaveLength(1);
    expect(emp.currentIndex).toBe(0);
    await tick();
    expect(focus.nameInput).not.toHaveBeenCalled();
  });

  it('selects the Tabs page that holds the input before focusing it', async () => {
    const { form, focus } = setup([tabbed]);
    const emp = form.getDataset('dsEmp')!;
    emp.setCurrentIndex(0);
    emp.setValue(0, 'name', '');
    expect(form.getComponent('tabs')?.props.value.selectedIndex ?? 0).toBe(0);
    form.validate();
    expect(form.getComponent('tabs')?.props.value.selectedIndex).toBe(1);
    await tick();
    expect(focus.nameInput).toHaveBeenCalledTimes(1);
  });

  it('puts the first issue in view order, not load order', () => {
    const { form, focus } = setup([grid]);
    const emp = form.getDataset('dsEmp')!;
    const first = emp.rowIdAt(0);
    const second = emp.rowIdAt(1);
    emp.sort([{ column: 'name', descending: true }]);
    expect(emp.indexOfRow(second)).toBeLessThan(emp.indexOfRow(first));
    emp.setValue(0, 'empNo', '');
    emp.setValue(1, 'empNo', '');
    const issues = form.validate();
    expect(issues.map((i) => i.rowId)).toEqual([second, first]);
    expect(focus.grid).toHaveBeenCalledWith({ rowId: second, track: 0 });
  });

  it('applies the same order and focus to showRowErrors', async () => {
    const { form, focus } = setup([nameInput]);
    const emp = form.getDataset('dsEmp')!;
    emp.setCurrentIndex(0);
    emp.sort([{ column: 'empNo', descending: true }]);
    const low = emp.rowIdAt(1);
    const high = emp.rowIdAt(0);
    const issues = form.showRowErrors([
      { dataset: 'dsEmp', id: low, column: 'name', code: 'x', message: 'low' },
      { dataset: 'dsEmp', id: high, column: 'name', code: 'x', message: 'high' },
    ]);
    expect(issues.map((i) => i.rowId)).toEqual([high, low]);
    await tick();
    expect(focus.nameInput).toHaveBeenCalledTimes(1);
  });
});
