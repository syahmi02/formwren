import { TransactionError, defineForm, type FormEntry } from '@fw/core';
import type { EmployeeEdit } from './EmployeeEdit.form.gen';
import { placeRowErrors } from './rowErrors';
import lookup from './EmployeeLookup.form.json';
import type { EmployeeLookup } from './EmployeeLookup.form.gen';

export default defineForm<EmployeeEdit>((form) => {
  const { dsCond, dsDept, dsEmp, dsFind, dsFound, dsPick } = form.ds;

  /** Runs one call with `busy` set, and turns a failure into the status text. */
  async function whileBusy(work: () => Promise<string>): Promise<void> {
    form.vars.busy = true;
    try {
      form.vars.message = await work();
    } catch (error) {
      // Row errors go onto the field they name, by the same path as the client's issues. A conflict names no column, so the name is marked.
      if (error instanceof TransactionError && !error.outcomeUnknown && !error.committed) {
        form.showRowErrors(placeRowErrors(error.rowErrors, { emp: { dataset: 'dsEmp', column: 'empName' } }));
      }
      form.vars.message =
        error instanceof TransactionError
          ? error.outcomeUnknown
            ? 'The save may or may not have gone through. Your edits are kept. Reload to check before saving again.'
            : // The server accepted the save, so the edits are saved even though the screen could not finish.
            error.committed
            ? `Saved, but the screen could not be updated: ${error.message}`
            : error.code === 'conflict'
              ? 'Not saved: someone else changed this employee after you loaded it. Your edits are kept. Revert, then search again to see their version'
              : `Failed: ${error.message}`
          : 'Failed: unexpected error';
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
        service: 'hr.emp.search',
        inputs: { cond: dsCond },
        outputs: { list: dsEmp },
      });
      return `Found ${dsEmp.rowCount} employees`;
    });
  };

  // ---- Find employee (the D3 lookup) ----
  // The pair of values the user last settled on, so a cancelled lookup can put the field back as it was.
  let settled = { empNo: '', empName: '' };
  // One lookup runs at a time. `handled` is the text the field held when the last lookup finished or began.
  let lookingUp = false;
  let handled = '';

  const pickRow = () => dsPick.rowIdAt(0);
  const typedNow = (): string => String(dsPick.getValueById(pickRow(), 'empNo') ?? '').trim();

  function showPick(empNo: string, empName: string): void {
    const row = pickRow();
    dsPick.setValueById(row, 'empNo', empNo);
    dsPick.setValueById(row, 'empName', empName);
  }

  /** Makes an employee the settled choice and shows them: on screen if they are in the loaded rows. */
  function settle(empNo: string, empName: string): void {
    settled = { empNo, empName };
    handled = empNo;
    showPick(empNo, empName);
    const at = dsEmp.find((get) => get('empNo') === empNo);
    if (at >= 0) {
      void dsEmp.setCurrentIndex(at);
      form.vars.message = `${empName} (${empNo})`;
    } else {
      form.vars.message = `${empName} (${empNo}) is not in the rows shown. Search again to load them`;
    }
  }

  /** Puts the field back to the settled choice. */
  function restore(): void {
    handled = settled.empNo;
    showPick(settled.empNo, settled.empName);
  }

  /** Opens the popup with `keyword` as its search. Cancelling puts the field back. */
  async function openLookup(keyword: string): Promise<void> {
    const chosen = await form.open<EmployeeLookup>(lookup as FormEntry<EmployeeLookup>, { params: { keyword } });
    if (chosen) settle(chosen.empNo, chosen.empName);
    else restore();
  }

  /**
   * Searches for what was typed. One match (or an exact number) fills the field with no popup; anything else opens the popup.
   * An answer is used only if the field still holds the text it was asked for, so a late answer never overwrites newer typing
   * or moves the screen to the wrong employee.
   */
  async function resolveTyped(typed: string): Promise<void> {
    dsFind.setValueById(dsFind.rowIdAt(0), 'keyword', typed);
    try {
      await form.tx.call({ service: 'hr.emp.lookup', inputs: { cond: dsFind }, outputs: { list: dsFound } });
    } catch (error) {
      if (typedNow() !== typed) return;
      restore();
      form.vars.message = error instanceof TransactionError ? `Failed: ${error.message}` : 'Failed: unexpected error';
      return;
    }
    if (typedNow() !== typed) return;
    const rows = Array.from({ length: dsFound.rowCount }, (_, i) => ({
      empNo: dsFound.getValue(i, 'empNo') ?? '',
      empName: dsFound.getValue(i, 'empName') ?? '',
    }));
    const exact = rows.find((r) => r.empNo.toLowerCase() === typed.toLowerCase());
    const only = rows.length === 1 ? rows[0] : exact;
    if (only) settle(only.empNo, only.empName);
    else await openLookup(typed);
  }

  /** Brings the lookup up to date with the field. A change that arrives while one runs is picked up when it ends, never dropped. */
  async function catchUp(): Promise<void> {
    if (lookingUp) return;
    lookingUp = true;
    try {
      for (let text = typedNow(); text !== handled; text = typedNow()) {
        if (text === '') {
          settled = { empNo: '', empName: '' };
          handled = '';
          showPick('', '');
        } else if (text === settled.empNo) {
          restore();
        } else {
          handled = text;
          await resolveTyped(text);
        }
      }
    } finally {
      lookingUp = false;
    }
  }

  const onPickChange = () => catchUp();

  /** The button opens the popup with what is typed. A press while a lookup runs is ignored, because that lookup opens it if needed. */
  async function onPickClick(): Promise<void> {
    if (lookingUp) return;
    lookingUp = true;
    try {
      const typed = typedNow();
      await openLookup(typed === settled.empNo ? '' : typed);
    } finally {
      lookingUp = false;
    }
    await catchUp();
  }

  const onSave = () =>
    whileBusy(async () => {
      if (!dsEmp.hasChanges()) return 'Nothing to save';
      // Marks the field and focuses it, so the user lands on what to fix.
      const issues = form.validate();
      if (issues.length > 0) return `Not saved: ${issues[0]?.message ?? 'a value is not valid'}`;
      const result = await form.tx.call({
        service: 'hr.emp.save',
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
    onPickChange,
    onPickClick,
    onPrev() {
      dsEmp.setCurrentIndex(dsEmp.currentIndex - 1);
    },
    onNext() {
      dsEmp.setCurrentIndex(dsEmp.currentIndex + 1);
    },
    onRevert() {
      dsEmp.revertAll();
      dsEmp.setIssues([]);
      form.vars.message = 'Changes reverted';
    },
  };
});
