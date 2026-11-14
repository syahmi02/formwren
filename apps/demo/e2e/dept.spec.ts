/**
 * Journey D2 (REQUIREMENTS section 2) on the department screen, against the real server and database: choosing a department
 * loads its employees, both Grids and the form edit, and one Save sends the changes of both Datasets.
 */
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './support.ts';

// Tracks of the two Grids.
const D = { status: 0, select: 1, code: 2, name: 3 } as const;
const E = { status: 0, select: 1, empNo: 2, name: 3, level: 4, active: 5, salary: 6, hired: 7 } as const;

function screen(page: Page) {
  const deptGrid = page.getByRole('grid').nth(0);
  const empGrid = page.getByRole('grid').nth(1);
  const cell = (grid: Locator, rowText: string, rowTrack: number, track: number): Locator =>
    grid.locator(`.fw-grid__row:has(.fw-grid__cell[data-track="${rowTrack}"]:text-is("${rowText}")) .fw-grid__cell[data-track="${track}"]`);
  return {
    deptGrid,
    empGrid,
    status: page.getByText(/^(\d+ departments|\d+ employees? in|Saved|Not saved|Failed|Nothing|Changes reverted|Save or revert|Department added|Employee added|Deleted|Delete or move|The code|No )/),
    deptCell: (code: string, track: number): Locator => cell(deptGrid, code, D.code, track),
    empCell: (no: string, track: number): Locator => cell(empGrid, no, E.empNo, track),
    empCellByName: (name: string, track: number): Locator => cell(empGrid, name, E.name, track),
    addDept: page.getByRole('button', { name: 'Add department' }),
    deleteDept: page.getByRole('button', { name: 'Delete department' }),
    addEmp: page.getByRole('button', { name: 'Add employee' }),
    deleteEmp: page.getByRole('button', { name: 'Delete employee' }),
    save: page.getByRole('button', { name: 'Save', exact: true }),
    revert: page.getByRole('button', { name: 'Revert' }),
    formName: page.getByRole('textbox', { name: 'Name', exact: true }),
    async open(): Promise<void> {
      await page.goto('/#dept');
      await expect(this.status).toHaveText('5 departments');
      await expect(this.deptCell('ENG', D.name)).toHaveText('Engineering');
    },
    /**
     * Renames a department. Enter moves the Grid to the next row, and with it the current department, so the person
     * goes back to the department they were editing and waits for its employees.
     */
    async editDeptName(code: string, name: string): Promise<void> {
      // Choosing a department loads its employees, and edits are refused until that is done. Add employee is off meanwhile.
      await this.deptCell(code, D.name).click();
      await expect(this.addEmp).toBeEnabled();
      await page.keyboard.type(name);
      await page.keyboard.press('Enter');
      await this.deptCell(code, D.code).click();
      await expect(this.addEmp).toBeEnabled();
      await expect(this.deptCell(code, D.name)).toHaveText(name);
    },
    /** Types into the cell with the keyboard, the way a person would: typing replaces the text, Enter commits. */
    async typeInto(target: Locator, text: string): Promise<void> {
      await target.click();
      await page.keyboard.type(text);
      await page.keyboard.press('Enter');
    },
  };
}
type Screen = ReturnType<typeof screen>;

/** The track of the active cell of one Grid, read from its `aria-activedescendant`. */
const activeTrack = (grid: Locator): Promise<number | null> =>
  grid.evaluate((root) => {
    const id = root.getAttribute('aria-activedescendant');
    const el = id ? document.getElementById(id) : null;
    return el ? Number(el.dataset.track) : null;
  });

test.describe('D2: master and detail', () => {
  let s: Screen;
  test.beforeEach(async ({ page }) => {
    s = screen(page);
    await s.open();
  });

  test('opens on the first department with its employees, and the form shows the current one', async () => {
    // Employees E001, E006, E011, E016 and E021 belong to ENG.
    await expect(s.empCell('E001', E.name)).toHaveText('Alice Carter');
    await expect(s.empCell('E021', E.name)).toHaveText('Umar Khan');
    await expect(s.empCell('E002', E.name)).toHaveCount(0);
    await expect(s.empGrid).toHaveAttribute('aria-rowcount', '6');
    await expect(s.formName).toHaveValue('Alice Carter');
    await s.empCell('E006', E.name).click();
    await expect(s.formName).toHaveValue('Frederick Mills');
  });

  test('choosing another department loads its employees', async () => {
    await s.deptCell('SAL', D.name).click();
    await expect(s.empCell('E002', E.name)).toHaveText('Benjamin Hughes');
    await expect(s.empCell('E001', E.name)).toHaveCount(0);
    await expect(s.status).toHaveText('5 employees in SAL');
  });

  test('one Save sends the changes of both Grids in a single call, then refreshes with the numbers the server assigned', async ({ page }) => {
    const saves: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/hr.dept.saveAll')) saves.push(request.postData() ?? '');
    });
    await s.editDeptName('ENG', 'Engineering Plus');
    await expect(s.deptCell('ENG', D.status)).toHaveText('U');
    await s.typeInto(s.empCell('E001', E.name), 'Alice Carter-Smith');
    await s.addEmp.click();
    await expect(s.status).toHaveText('Employee added. The number is assigned when you save');
    await page.keyboard.type('Zoe Zhang');
    await page.keyboard.press('Enter');
    await s.empCell('E006', E.select).click();
    await s.deleteEmp.click();
    await expect(s.status).toHaveText('Deleted 1 employee. Save to apply');

    await s.save.click();
    await expect(s.status).toHaveText('Saved 4 rows');
    expect(saves).toHaveLength(1);
    const body = JSON.parse(saves[0] ?? '{}') as { datasets: Record<string, { changes: { s: string }[] }> };
    expect(Object.keys(body.datasets).sort()).toEqual(['dept', 'emp']);
    expect(body.datasets.dept?.changes.map((c) => c.s)).toEqual(['U']);
    expect(body.datasets.emp?.changes.map((c) => c.s).sort()).toEqual(['D', 'I', 'U']);

    // The screen shows what is in the database: no marks left, the new number, the deleted row gone, the version moved on.
    await expect(s.deptCell('ENG', D.name)).toHaveText('Engineering Plus');
    await expect(s.deptCell('ENG', D.status)).toHaveText('');
    await expect(s.empCell('E026', E.name)).toHaveText('Zoe Zhang');
    await expect(s.empCell('E026', E.status)).toHaveText('');
    await expect(s.empCell('E001', E.name)).toHaveText('Alice Carter-Smith');
    await expect(s.empCell('E006', E.name)).toHaveCount(0);
    // A second save has nothing to send.
    await s.save.click();
    await expect(s.status).toHaveText('Nothing to save');
  });

  test('a new department with a new employee saves together, and stays selected', async ({ page }) => {
    await s.addDept.click();
    await page.keyboard.type('QA');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Quality');
    await page.keyboard.press('Enter');
    await expect(s.empGrid).toHaveAttribute('aria-rowcount', '1');
    await s.addEmp.click();
    await page.keyboard.type('Quinn Tester');
    await page.keyboard.press('Enter');
    await s.save.click();
    await expect(s.status).toHaveText('Saved 2 rows');
    await expect(s.deptCell('QA', D.name)).toHaveText('Quality');
    await expect(s.empCellByName('Quinn Tester', E.empNo)).toHaveText('E026');
    // It is in the database, not only on screen.
    await page.reload();
    await expect(s.status).toHaveText('6 departments');
    await s.deptCell('QA', D.name).click();
    await expect(s.empCell('E026', E.name)).toHaveText('Quinn Tester');
  });

  test('moving to another department with unsaved employee edits is refused, and the edits stay', async () => {
    await s.typeInto(s.empCell('E001', E.name), 'Edited Name');
    await s.deptCell('SAL', D.name).click();
    await expect(s.status).toHaveText('Save or revert the employee changes before choosing another department');
    await expect(s.empCell('E001', E.name)).toHaveText('Edited Name');
    await expect(s.empCell('E001', E.status)).toHaveText('U');
    await expect(s.empCell('E002', E.name)).toHaveCount(0);
    // After Revert the move works.
    await s.revert.click();
    await expect(s.empCell('E001', E.name)).toHaveText('Alice Carter');
    await s.deptCell('SAL', D.name).click();
    await expect(s.empCell('E002', E.name)).toHaveText('Benjamin Hughes');
  });

  test('edits to departments alone do not block moving between them', async () => {
    await s.editDeptName('SAL', 'Sales and Marketing');
    await s.deptCell('HR', D.name).click();
    await expect(s.empCell('E003', E.name)).toHaveText('Clara Jennings');
    await expect(s.deptCell('SAL', D.status)).toHaveText('U');
    await expect(s.deptCell('SAL', D.name)).toHaveText('Sales and Marketing');
  });

  test('a missing value marks the cell in the employee Grid and moves focus there', async () => {
    await s.addEmp.click();
    await s.save.click();
    await expect(s.status).toHaveText(/^Not saved:/);
    await expect(s.empGrid.locator('.fw-grid__cell[data-invalid]')).toHaveCount(1);
    await expect(s.deptGrid.locator('.fw-grid__cell[data-invalid]')).toHaveCount(0);
    // Decision 5 of step 5: an input bound to the column on the current row gets the focus before the Grid cell.
    // The "Selected employee" panel has one, for the name.
    await expect(s.formName).toBeFocused();
    await expect(s.formName).toHaveAttribute('aria-invalid', 'true');
    await expect(s.empGrid).not.toBeFocused();
  });

  test('a missing department name marks the cell in the department Grid and moves focus there', async ({ page }) => {
    await s.addDept.click();
    await page.keyboard.type('QA');
    await page.keyboard.press('Enter');
    await s.save.click();
    await expect(s.status).toHaveText(/^Not saved:/);
    await expect(s.deptGrid.locator('.fw-grid__cell[data-invalid]')).toHaveCount(1);
    await expect(s.deptGrid).toBeFocused();
    expect(await activeTrack(s.deptGrid)).toBe(D.name);
  });

  test('a conflict marks the department row, keeps every edit, and says someone else changed it', async ({ page }) => {
    // Somebody else renames Engineering after this page loaded it.
    const other = await page.request.post('/dsx/v1/tx/hr.dept.saveAll', {
      data: {
        dsx: 1,
        txId: 'other-user',
        service: 'hr.dept.saveAll',
        datasets: {
          dept: {
            columns: [
              { id: 'code', type: 'string', size: 10, key: true },
              { id: 'name', type: 'string', size: 50 },
              { id: 'ver', type: 'int', version: true },
            ],
            changes: [{ s: 'U', id: 0, v: ['ENG', 'Engineering (theirs)', 1], o: { '1': 'Engineering' } }],
          },
        },
      },
    });
    expect(other.ok()).toBe(true);

    await s.editDeptName('ENG', 'Engineering (mine)');
    await s.typeInto(s.empCell('E001', E.name), 'Alice Mine');
    await s.save.click();
    await expect(s.status).toHaveText(/^Not saved: someone else changed a marked row/);
    await expect(s.deptCell('ENG', D.name)).toHaveText('Engineering (mine)');
    await expect(s.empCell('E001', E.name)).toHaveText('Alice Mine');
    await expect(s.deptCell('ENG', D.name)).toHaveAttribute('data-invalid', /.*/);
    await expect(s.deptGrid).toBeFocused();
    // Nothing was written: the other user's value is still what the database holds, and the employee change was not saved.
    await s.revert.click();
    await s.save.click();
    await expect(s.status).toHaveText('Nothing to save');
    await page.reload();
    await expect(s.deptCell('ENG', D.name)).toHaveText('Engineering (theirs)');
    await expect(s.empCell('E001', E.name)).toHaveText('Alice Carter');
  });

  test('a department that still has employees cannot be deleted on screen, and one without can', async () => {
    await s.deleteDept.click();
    await expect(s.status).toHaveText('Delete or move the employees of this department first');
    await expect(s.deptCell('ENG', D.status)).toHaveText('');
    // Delete the employees with the department, in one save.
    for (const no of ['E001', 'E006', 'E011', 'E016', 'E021']) {
      await s.empCell(no, E.select).click();
    }
    await s.deleteEmp.click();
    await expect(s.status).toHaveText('Deleted 5 employees. Save to apply');
    await s.deptCell('ENG', D.name).click();
    await s.deleteDept.click();
    await expect(s.status).toHaveText('Deleted 1 department. Save to apply');
    await s.save.click();
    await expect(s.status).toHaveText('Saved 6 rows');
    await expect(s.deptCell('ENG', D.name)).toHaveCount(0);
    await expect(s.status).toBeVisible();
  });

  test('the code of a saved department cannot be changed', async () => {
    await s.typeInto(s.deptCell('ENG', D.code), 'XXX');
    await expect(s.status).toHaveText('The code of a saved department cannot be changed');
    await expect(s.deptCell('ENG', D.code)).toHaveText('ENG');
  });
});
