import { describe, expect, it } from 'vitest';
import { defineForm, type Dataset, type FormEntry } from '../src/index.ts';

// Shaped like a generated *.form.gen.ts. Checked by `tsc`; vitest only runs the runtime part.
type EmpSearch = {
  datasets: { dsCond: Dataset<{ deptCode: string }> };
  variables: { busy: boolean };
  params: { deptCode: string };
  handlers: 'onInit' | 'onSearch';
};

describe('defineForm types', () => {
  it('checks column names, variable types and required handlers', () => {
    const module = defineForm<EmpSearch>((form) => {
      const onSearch = async () => {
        form.vars.busy = true;
        form.ds.dsCond.setValue(0, 'deptCode', form.params.deptCode);
        // @ts-expect-error not a column of dsCond
        form.ds.dsCond.setValue(0, 'nope', 'x');
        // @ts-expect-error a number is not a string column value
        form.ds.dsCond.setValue(0, 'deptCode', 1);
        // @ts-expect-error busy is a boolean
        form.vars.busy = 'yes';
        // @ts-expect-error not a declared dataset
        void form.ds.dsOther;
      };
      return { onSearch, onInit: async () => {} };
    });
    expect(typeof module.setup).toBe('function');
  });

  it('makes a missing handler a compile error', () => {
    // @ts-expect-error onInit is missing
    defineForm<EmpSearch>(() => ({ onSearch: () => {} }));
    expect(true).toBe(true);
  });

  it('types the init event', () => {
    defineForm<EmpSearch>((form) => ({
      onSearch: () => {},
      async onInit({ params }) {
        form.ds.dsCond.setValue(0, 'deptCode', params.deptCode);
      },
    }));
    expect(true).toBe(true);
  });

  it('types the result of close and open', () => {
    type Lookup = { datasets: { [K in never]: never }; variables: { [K in never]: never }; params: { search: string | undefined }; result: { empNo: string }; handlers: 'onOk' };
    type Caller = { datasets: { [K in never]: never }; variables: { [K in never]: never }; params: { [K in never]: never }; handlers: 'onOpen' };
    const lookup = {} as FormEntry<Lookup>;
    defineForm<Lookup>((form) => ({
      onOk: () => {
        void form.close({ empNo: 'E1' });
        // @ts-expect-error empNo is a string
        void form.close({ empNo: 1 });
        // @ts-expect-error not a member of the result
        void form.close({ other: 'x' });
      },
    }));
    defineForm<Caller>((form) => ({
      onOpen: async () => {
        const picked = await form.open(lookup, { params: { search: 'E' } });
        const empNo: string | undefined = picked?.empNo;
        void empNo;
        // @ts-expect-error not a param of the popup
        void form.open(lookup, { params: { nope: 'E' } });
        void form.close();
      },
    }));
    expect(true).toBe(true);
  });
});
