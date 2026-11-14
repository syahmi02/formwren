import { TransactionError, defineForm } from '@fw/core';
import type { DepartmentEmployees } from './DepartmentEmployees.form.gen';
import { placeRowErrors } from './rowErrors';

/** Position of each column in each Grid's `columns`, which `focus(cell)` needs. Keep in step with the form file. */
const DEPT_TRACK = { code: 2, name: 3 } as const;
const EMP_TRACK = { empNo: 2, empName: 3, level: 4, active: 5, salary: 6, hiredOn: 7 } as const;

export default defineForm<DepartmentEmployees>((form) => {
  const { dsDept, dsEmp } = form.ds;

  /** The code of the department being worked on, or '' if there is none or its code isn't typed yet. */
  const currentCode = (): string => {
    const index = dsDept.currentIndex;
    if (index < 0) return '';
    const row = dsDept.rowIdAt(index);
    return dsDept.statusOf(row) === 'deleted' ? '' : (dsDept.getValueById(row, 'code') ?? '');
  };

  // True while a load or a refresh moves the current department itself, so it isn't treated as the user's choice.
  let loading = false;
  // The department whose employees are in `dsEmp` now.
  let loadedCode: string | null = null;
  let loadChain: Promise<void> = Promise.resolve();
  // Loads and refreshes in progress. Their answer replaces a whole Dataset, so edits made meanwhile would be lost.
  // Instead, edits are refused while one runs, with a message, and the buttons that change rows are disabled.
  let loadsRunning = 0;
  async function trackLoad<T>(work: () => Promise<T>): Promise<T> {
    form.vars.loadingData = ++loadsRunning > 0;
    try {
      return await work();
    } finally {
      form.vars.loadingData = --loadsRunning > 0;
    }
  }
  const refuseWhileLoading = (event: { preventDefault(): void }): boolean => {
    if (loadsRunning === 0) return false;
    event.preventDefault();
    form.vars.message = 'Loading data, try again in a moment';
    return true;
  };
  dsEmp.on('cellChanging', refuseWhileLoading);

  /** Moving to another department replaces the employees, so it is refused while they have unsaved edits. Nothing is ever dropped silently. */
  dsDept.on('currentRowChanging', (event) => {
    if (loading || !dsEmp.hasChanges()) return;
    event.preventDefault();
    form.vars.message = 'Save or revert the employee changes before choosing another department';
  });

  dsDept.on('currentRowChanged', () => {
    if (!loading) void loadEmployees();
  });

  // A saved department keeps its code, because the rows that refer to it would no longer match.
  dsDept.on('cellChanging', (event) => {
    if (refuseWhileLoading(event)) return;
    if (event.detail.column !== 'code' || dsDept.statusOf(event.detail.rowId) === 'inserted') return;
    event.preventDefault();
    form.vars.message = 'The code of a saved department cannot be changed';
  });

  // The code of a new department, typed after its employees were added, goes to those employees too.
  dsDept.on('cellChanged', (change) => {
    if (change.column !== 'code' || change.rowId !== dsDept.currentRow) return;
    const code = String(change.newValue ?? '');
    for (let i = 0; i < dsEmp.rowCount; i++) {
      const row = dsEmp.rowIdAt(i);
      if (dsEmp.statusOf(row) === 'inserted') dsEmp.setValueById(row, 'dept', code);
    }
    loadedCode = code;
  });

  /** Runs one call with `busy` set, and turns a failure into the status text. */
  async function whileBusy(work: () => Promise<string>): Promise<void> {
    form.vars.busy = true;
    try {
      form.vars.message = await work();
    } catch (error) {
      if (!(error instanceof TransactionError)) {
        form.vars.message = 'Failed: unexpected error';
      } else if (error.outcomeUnknown) {
        // The connection dropped after the request went out. Nothing is retried, because a second save could be a duplicate.
        form.vars.message = 'The save may or may not have gone through. Your edits are kept. Reload to check before saving again.';
      } else if (error.committed) {
        // The server accepted the save, so the edits are saved even though the screen could not finish.
        form.vars.message = `Saved, but the screen could not be updated: ${error.message}`;
      } else {
        // Row errors name the input Dataset and the row, so each goes onto its own Grid, by the same path as the client's issues.
        // A conflict names no column, so the name cell is marked.
        form.showRowErrors(
          placeRowErrors(error.rowErrors, {
            dept: { dataset: 'dsDept', column: 'name' },
            emp: { dataset: 'dsEmp', column: 'empName' },
          }),
        );
        form.vars.message =
          error.code === 'conflict'
            ? 'Not saved: someone else changed a marked row after you loaded it. Your edits are kept. Revert to see their version'
            : `Failed: ${error.message}`;
      }
    } finally {
      form.vars.busy = false;
    }
  }

  /**
   * Loads the employees of the current department. Loads are queued, because a service runs one call at a time and the user
   * can click through departments quickly. Each waits for the one before, then loads whatever department is current by then.
   */
  function loadEmployees(): Promise<void> {
    loadsRunning++;
    form.vars.loadingData = true;
    loadChain = loadChain.then(async () => {
      try {
        await loadNow();
      } finally {
        form.vars.loadingData = --loadsRunning > 0;
      }
    });
    return loadChain;
  }

  async function loadNow(): Promise<void> {
    {
      const code = currentCode();
      if (code === loadedCode) return;
      if (dsEmp.hasChanges()) return;
      if (code === '') {
        dsEmp.load([]);
        loadedCode = code;
        return;
      }
      try {
        await form.tx.call({ service: 'hr.dept.withEmployees', params: { deptCode: code }, outputs: { emp: dsEmp } });
        loadedCode = code;
        form.vars.message = `${dsEmp.rowCount} ${dsEmp.rowCount === 1 ? 'employee' : 'employees'} in ${code}`;
      } catch (error) {
        loadedCode = null;
        form.vars.message = error instanceof TransactionError ? `Failed: ${error.message}` : 'Failed: unexpected error';
      }
    }
  }

  /** Loads every department and, with it, the employees of one. */
  function loadAll(select: string): Promise<void> {
    return trackLoad(() => loadAllNow(select));
  }

  async function loadAllNow(select: string): Promise<void> {
    loading = true;
    try {
      const refresh = {
        service: 'hr.dept.withEmployees',
        params: { deptCode: select },
        outputs: { dept: dsDept, emp: dsEmp },
      };
      // A Dataset with edits is left alone, so a refresh never replaces something the user changed meanwhile.
      if (dsDept.hasChanges()) delete (refresh.outputs as Record<string, unknown>).dept;
      if (dsEmp.hasChanges()) delete (refresh.outputs as Record<string, unknown>).emp;
      const replacesEmp = 'emp' in refresh.outputs;
      await form.tx.call(refresh);
      const at = dsDept.find((get) => get('code') === select);
      if (at >= 0) await dsDept.setCurrentIndex(at);
      // The employees now in the Grid are those of `select`, whichever row the Grid then shows as current.
      if (replacesEmp) loadedCode = select === '' ? null : select;
    } finally {
      loading = false;
    }
  }

  const onSave = () =>
    whileBusy(async () => {
      if (!dsDept.hasChanges() && !dsEmp.hasChanges()) return 'Nothing to save';
      // Marks the cells and moves the right Grid to the first one, so the user lands on what to fix.
      const issues = form.validate();
      if (issues.length > 0) return `Not saved: ${issues[0]?.message ?? 'a value is not valid'}`;
      const select = currentCode();
      // Both Datasets go in one call, so they are saved together or not at all.
      const result = await form.tx.call({
        service: 'hr.dept.saveAll',
        inputs: { dept: { dataset: dsDept, rows: 'changed' }, emp: { dataset: dsEmp, rows: 'changed' } },
      });
      const saved = Number(result.params.saved ?? 0);
      // Refresh from the database. Anything typed while the save ran still has changes, and `loadAll` leaves that Dataset alone.
      const code = dsDept.find((get) => get('code') === select) >= 0 ? select : '';
      try {
        await loadAll(code);
      } catch (error) {
        throw error instanceof TransactionError
          ? new TransactionError(error.code, error.message, error.rowErrors, true)
          : new TransactionError('refresh', `the refresh failed (${String(error)})`, [], true);
      }
      return `Saved ${saved} ${saved === 1 ? 'row' : 'rows'}`;
    });

  /** Rows to act on: ticked ones if there are any, otherwise the current row. */
  function targets(ds: typeof dsDept | typeof dsEmp): number[] {
    const ticked = ds.selectedRows().map((id) => ds.indexOfRow(id)).filter((index) => index >= 0);
    return ticked.length > 0 ? ticked : ds.currentIndex >= 0 ? [ds.currentIndex] : [];
  }

  return {
    async onInit() {
      await whileBusy(async () => {
        await loadAll('');
        // Start on the first department.
        if (dsDept.rowCount > 0) {
          loading = true;
          try {
            await dsDept.setCurrentIndex(0);
          } finally {
            loading = false;
          }
          await loadEmployees();
        }
        return `${dsDept.rowCount} departments`;
      });
    },
    onSave,
    onAddDept() {
      const rowId = dsDept.addRow();
      // Moving to the new row clears the employee list, which is refused if employee edits are unsaved.
      const moved = dsDept.setCurrentIndex(dsDept.indexOfRow(rowId));
      form.c.deptGrid.focus({ rowId, track: DEPT_TRACK.code });
      form.vars.message = moved === false ? 'Department added. Save or revert the employee changes to open it' : 'Department added';
    },
    onDeleteDept() {
      const indexes = targets(dsDept);
      if (indexes.length === 0) {
        form.vars.message = 'No department to delete';
        return;
      }
      const current = dsDept.currentIndex;
      if (indexes.includes(current) && [...Array(dsEmp.rowCount).keys()].some((i) => dsEmp.rowStatus(i) !== 'deleted')) {
        form.vars.message = 'Delete or move the employees of this department first';
        return;
      }
      dsDept.deleteRows(indexes);
      dsDept.clearSelection();
      form.vars.message = `Deleted ${indexes.length} ${indexes.length === 1 ? 'department' : 'departments'}. Save to apply`;
    },
    onAddEmp() {
      const code = currentCode();
      if (code === '') {
        form.vars.message = 'Choose a department with a code first';
        return;
      }
      const rowId = dsEmp.addRow({ dept: code, active: true });
      dsEmp.setCurrentIndex(dsEmp.indexOfRow(rowId));
      form.c.empGrid.focus({ rowId, track: EMP_TRACK.empName });
      form.vars.message = 'Employee added. The number is assigned when you save';
    },
    onDeleteEmp() {
      const indexes = targets(dsEmp);
      if (indexes.length === 0) {
        form.vars.message = 'No employee to delete';
        return;
      }
      dsEmp.deleteRows(indexes);
      dsEmp.clearSelection();
      form.vars.message = `Deleted ${indexes.length} ${indexes.length === 1 ? 'employee' : 'employees'}. Save to apply`;
    },
    async onRevert() {
      dsDept.setIssues([]);
      dsEmp.setIssues([]);
      dsEmp.revertAll();
      dsDept.revertAll();
      // Reverting can bring a department back or remove a new one, so the employee list is made to match.
      loadedCode = null;
      await loadEmployees();
      form.vars.message = 'Changes reverted';
    },
  };
});
