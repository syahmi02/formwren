import { TransactionError, defineForm } from '@fw/core';
import type { EmployeeLookup } from './EmployeeLookup.form.gen';

/** The lookup popup: a search box and the matching employees. It hands back `{ empNo, empName }`, or nothing if cancelled. */
export default defineForm<EmployeeLookup>((form) => {
  const { dsCond, dsEmp } = form.ds;

  const keywordNow = (): string => String(dsCond.getValueById(dsCond.rowIdAt(0), 'keyword') ?? '');
  // The keyword the list was last searched for, and whether the loop below is running.
  let loaded: string | null = null;
  let searching = false;

  /**
   * Searches until the list matches the box. A search asked for while one runs isn't sent at once, since the transaction client
   * allows one call per service. The loop does it when the answer arrives, and `busy` stays on until the list is current.
   */
  async function search(): Promise<void> {
    if (searching) return;
    searching = true;
    form.vars.busy = true;
    try {
      for (let keyword = keywordNow(); keyword !== loaded; keyword = keywordNow()) {
        let message: string;
        try {
          const result = await form.tx.call({
            service: 'hr.emp.lookup',
            inputs: { cond: dsCond },
            outputs: { list: dsEmp },
          });
          if (dsEmp.rowCount === 0) message = 'No employee matches';
          else if (result.params.more === true) message = `The first ${dsEmp.rowCount} are shown. Type more to narrow the search`;
          else message = `${dsEmp.rowCount} ${dsEmp.rowCount === 1 ? 'employee' : 'employees'}`;
        } catch (error) {
          message = error instanceof TransactionError ? `Failed: ${error.message}` : 'Failed: unexpected error';
        }
        loaded = keyword;
        // Only the answer for the keyword now in the box is reported. An older one is replaced by the next pass.
        if (keywordNow() === keyword) form.vars.message = message;
      }
    } finally {
      searching = false;
      form.vars.busy = false;
    }
  }

  /** Closes with the employee in the given row. */
  function choose(rowId: number): Promise<boolean> {
    // While a search runs the list may not match the box yet.
    if (form.vars.busy) {
      form.vars.message = 'Searching, try again in a moment';
      return Promise.resolve(false);
    }
    const empNo = dsEmp.getValueById(rowId, 'empNo');
    const empName = dsEmp.getValueById(rowId, 'empName');
    if (empNo === null || empNo === undefined || empName === null || empName === undefined) {
      form.vars.message = 'Choose an employee first';
      return Promise.resolve(false);
    }
    return form.close({ empNo, empName });
  }

  return {
    async onInit() {
      // The text the user typed in the opening field starts the search.
      const row = dsCond.rowIdAt(0);
      dsCond.setValueById(row, 'keyword', form.params.keyword ?? '');
      await search();
      form.c.keywordInput.focus();
    },
    onSearch() {
      // Pressing Search again looks again, even for the same text.
      if (!searching) loaded = null;
      return search();
    },
    onChoose(event: { detail: { rowId: number } }) {
      return choose(event.detail.rowId);
    },
    onOk() {
      const index = dsEmp.currentIndex;
      if (index < 0) {
        form.vars.message = 'Choose an employee first';
        return;
      }
      return choose(dsEmp.rowIdAt(index));
    },
    onCancel() {
      return form.close();
    },
  };
});
