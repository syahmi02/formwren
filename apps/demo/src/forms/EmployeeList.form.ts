import { TransactionError, defineForm } from '@fw/core';
import type { EmployeeList } from './EmployeeList.form.gen';
import { placeRowErrors } from './rowErrors';

/** Position of each column in the Grid's `columns`, which `focus(cell)` needs. Keep in step with the form file. */
const TRACK = { empNo: 2, empName: 3, dept: 4, level: 5, active: 6, salary: 7, hiredOn: 8 } as const;

export default defineForm<EmployeeList>((form) => {
  const { dsCond, dsDept, dsEmp } = form.ds;

  /** Runs one call with `busy` set, and turns a failure into the status text. */
  async function whileBusy(work: () => Promise<string>): Promise<void> {
    form.vars.busy = true;
    try {
      form.vars.message = await work();
    } catch (error) {
      if (!(error instanceof TransactionError)) {
        form.vars.message = 'Failed: unexpected error';
      } else if (error.outcomeUnknown) {
        form.vars.message = 'The save may or may not have gone through. Your edits are kept. Reload to check before saving again.';
      } else if (error.committed) {
        // The server accepted the save, so the edits are saved even though the screen could not finish.
        form.vars.message = `Saved, but the screen could not be updated: ${error.message}`;
      } else {
        // Row errors from the server go onto the cells they name, by the same path as the client's issues.
        // A conflict names no column, so the name cell is marked.
        form.showRowErrors(placeRowErrors(error.rowErrors, { emp: { dataset: 'dsEmp', column: 'empName' } }));
        // Nothing was saved and the edits are still there, so the user can decide what to do with them.
        form.vars.message =
          error.code === 'conflict'
            ? 'Not saved: someone else changed a marked row after you loaded it. Your edits are kept. Revert and search again to see their version'
            : `Failed: ${error.message}`;
      }
    } finally {
      form.vars.busy = false;
    }
  }

  const onSearch = async () => {
    // A search replaces the rows, so it must not run over edits that aren't saved.
    if (dsEmp.hasChanges()) {
      form.vars.message = 'Save or revert your changes first';
      return;
    }
    await whileBusy(async () => {
      await form.tx.call({
        service: 'hr.emp.query',
        inputs: { cond: dsCond },
        outputs: { list: dsEmp },
      });
      return `Found ${dsEmp.rowCount} employees`;
    });
  };

  const onSave = () =>
    whileBusy(async () => {
      if (!dsEmp.hasChanges()) return 'Nothing to save';
      // Marks the cells and moves the Grid to the first one, so the user lands on what to fix.
      const issues = form.validate();
      if (issues.length > 0) {
        return `Not saved: ${issues[0]?.message ?? 'a value is not valid'}`;
      }
      const result = await form.tx.call({
        service: 'hr.emp.saveList',
        inputs: { emp: { dataset: dsEmp, rows: 'changed' } },
      });
      const saved = Number(result.params.saved ?? 0);
      return `Saved ${saved} ${saved === 1 ? 'row' : 'rows'}`;
    });

  return {
    async onInit() {
      await form.tx.call({ service: 'hr.dept.list', outputs: { list: dsDept } });
      await onSearch();
    },
    onSearch,
    onSave,
    onAddRow() {
      const rowId = dsEmp.addRow({ active: true });
      dsEmp.setCurrentIndex(dsEmp.indexOfRow(rowId));
      form.c.empGrid.focus({ rowId, track: TRACK.empNo });
      form.vars.message = 'Row added';
    },
    onDeleteRow() {
      // Ticked rows if there are any, otherwise the current row.
      const ticked = dsEmp.selectedRows().map((id) => dsEmp.indexOfRow(id)).filter((index) => index >= 0);
      const indexes = ticked.length > 0 ? ticked : dsEmp.currentIndex >= 0 ? [dsEmp.currentIndex] : [];
      if (indexes.length === 0) {
        form.vars.message = 'No row to delete';
        return;
      }
      dsEmp.deleteRows(indexes);
      dsEmp.clearSelection();
      form.vars.message = `Deleted ${indexes.length} ${indexes.length === 1 ? 'row' : 'rows'}. Save to apply`;
    },
    onRevert() {
      dsEmp.revertAll();
      dsEmp.setIssues([]);
      form.vars.message = 'Changes reverted';
    },
  };
});
