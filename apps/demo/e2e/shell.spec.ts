/**
 * Step 5, the shell (FR-011 to FR-014, FR-063): the menu and tabs, state kept across tab switches, closing with unsaved
 * changes, the browser's own warning on reload, the loading indicator, the common error dialog and the hash deep links.
 * Real server, real database.
 */
import type { Dialog } from '@playwright/test';
import { employee } from './p4-support.ts';
import { employeesOf, shellOf, sleep, watchService } from './shell-support.ts';
import { expect, test } from './support.ts';

test.describe('Shell: menu and tabs', () => {
  test('the menu opens each screen, and opening one twice reuses its tab', async ({ page }) => {
    const shell = shellOf(page);
    const emp = employeesOf(page);
    const searches = watchService(page, 'hr.emp.search');
    const queries = watchService(page, 'hr.emp.query');
    const departments = watchService(page, 'hr.dept.withEmployees');
    await page.goto('/');
    await emp.waitLoaded();
    expect(await shell.titles()).toEqual(['Employees']);
    await expect(shell.item('Employees')).toHaveAttribute('aria-current', 'page');

    await shell.open('Employee list');
    await expect(shell.active.getByRole('grid')).toBeVisible();
    await expect(shell.active.getByText('Found 25 employees')).toBeVisible();
    await expect(shell.item('Employee list')).toHaveAttribute('aria-current', 'page');
    await expect(shell.item('Employees')).not.toHaveAttribute('aria-current', 'page');

    await shell.open('Departments');
    await expect(shell.active.getByRole('grid')).toHaveCount(2);
    await expect(shell.active.getByText('5 departments')).toBeVisible();

    expect(await shell.titles()).toEqual(['Employees', 'Employee list', 'Departments']);
    await expect(shell.pages).toHaveCount(3);
    // Only the selected tab's page is showing. The others stay mounted and hidden.
    await expect(shell.active).toHaveCount(1);

    // Opening one that is open only activates its tab. No second copy, and nothing is loaded again.
    for (const title of ['Employees', 'Employee list', 'Departments', 'Employees'] as const) {
      await shell.item(title).click();
      await expect(shell.tab(title)).toHaveAttribute('aria-selected', 'true');
      await expect(shell.tabs).toHaveCount(3);
      await expect(shell.pages).toHaveCount(3);
      await expect(shell.active).toHaveCount(1);
    }
    expect(await shell.titles()).toEqual(['Employees', 'Employee list', 'Departments']);
    expect(searches.calls).toHaveLength(1);
    expect(queries.calls).toHaveLength(1);
    expect(departments.calls.length).toBeGreaterThan(0);
    const loadedDepartments = departments.calls.length;
    await shell.item('Departments').click();
    await sleep(400);
    expect(departments.calls).toHaveLength(loadedDepartments);
  });

  test('state is kept across tab switches: an unsaved edit, a scrolled Grid and a form tab', async ({ page }) => {
    const shell = shellOf(page);
    const emp = employeesOf(page);
    const searches = watchService(page, 'hr.emp.search');
    await page.goto('/');
    await emp.waitLoaded();

    // An edit on the Employees screen that isn't saved, with another page of the form selected.
    await emp.enter(emp.name, 'Alicia Carter');
    await emp.next.click();
    await expect(emp.rowInfo).toHaveText('Row 2 of 25');
    await shell.active.getByRole('tab', { name: 'Summary' }).click();

    // The list, scrolled down.
    await shell.open('Employee list');
    const scroller = shell.active.locator('.fw-grid__scroller');
    await expect(shell.active.getByText('Found 25 employees')).toBeVisible();
    await expect.poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(200);
    await scroller.evaluate((el) => (el.scrollTop = 250));
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(250);
    const scrollTopBefore = await scroller.evaluate((el) => el.scrollTop);
    // The data-index of the first row whose box reaches into the Grid's viewport.
    const firstRowInView = () =>
      scroller.evaluate((el) => {
        const top = el.getBoundingClientRect().top + 40;
        const rows = [...el.querySelectorAll<HTMLElement>('.fw-grid__row[data-index]')];
        const hit = rows.find((row) => row.getBoundingClientRect().bottom > top);
        return hit ? Number(hit.dataset.index) : -1;
      });
    const firstRowBefore = await firstRowInView();

    // Away and back, twice, through a third tab as well.
    await shell.open('Departments');
    await shell.open('Employees');
    await expect(emp.rowInfo).toHaveText('Row 2 of 25');
    await expect(shell.active.getByRole('tab', { name: 'Summary' })).toHaveAttribute('aria-selected', 'true');
    await shell.active.getByRole('tab', { name: 'Details' }).click();
    await emp.previous.click();
    await expect(emp.name).toHaveValue('Alicia Carter');

    await shell.open('Employee list');
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop), 'the Grid is where it was left').toBeGreaterThan(scrollTopBefore - 2);
    expect(await scroller.evaluate((el) => el.scrollTop)).toBeLessThan(scrollTopBefore + 2);
    // The rows drawn are the ones at that scroll position: the first one showing is the same as before, and it is really in view.
    expect(await firstRowInView(), 'the same first row is in view').toBe(firstRowBefore);
    expect(firstRowBefore).toBeGreaterThan(3);

    // Nothing was loaded again, and the edit still counts as unsaved, so Save sends it.
    await shell.open('Employees');
    expect(searches.calls).toHaveLength(1);
    await emp.save.click();
    await expect(emp.status).toHaveText('Saved 1 row');
    expect(employee('E001')['empName']).toBe('Alicia Carter');
  });

  test('the tab strip works by keyboard', async ({ page }) => {
    const shell = shellOf(page);
    const emp = employeesOf(page);
    await page.goto('/');
    await emp.waitLoaded();
    await shell.open('Employee list');
    await shell.open('Departments');
    await expect(shell.tabs).toHaveCount(3);

    // One Tab stop for the whole strip: the selected tab.
    await expect(shell.tab('Departments')).toHaveAttribute('tabindex', '0');
    await expect(shell.tab('Employees')).toHaveAttribute('tabindex', '-1');
    await shell.tab('Departments').focus();

    const select = async (title: 'Employees' | 'Employee list' | 'Departments') => {
      await expect(shell.tab(title)).toHaveAttribute('aria-selected', 'true');
      await expect(shell.tab(title)).toBeFocused();
      await expect(shell.tab(title)).toHaveAttribute('tabindex', '0');
    };
    await page.keyboard.press('ArrowRight');
    await select('Employees'); // wraps to the first
    await page.keyboard.press('ArrowLeft');
    await select('Departments'); // wraps to the last
    await page.keyboard.press('ArrowLeft');
    await select('Employee list');
    await expect(shell.active.getByRole('grid')).toBeVisible();
    await expect(shell.active.getByRole('button', { name: 'Add row' })).toBeVisible();
    await page.keyboard.press('Home');
    await select('Employees');
    await expect(shell.active.getByRole('button', { name: 'Previous' })).toBeVisible();
    await page.keyboard.press('End');
    await select('Departments');

    // Tab leaves the strip for the page of the selected tab, and Shift+Tab comes back to it.
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.closest('.fw-shell__page') !== null)).toBe(true);
    await page.keyboard.press('Shift+Tab');
    await select('Departments');

    // Delete closes a clean tab with no question and moves focus to a neighbour.
    await page.keyboard.press('Delete');
    await expect(shell.tabs).toHaveCount(2);
    expect(await shell.titles()).toEqual(['Employees', 'Employee list']);
    await expect(shell.confirm).toHaveCount(0);
    await expect(shell.tab('Employee list')).toBeFocused();
    await expect(shell.tab('Employee list')).toHaveAttribute('aria-selected', 'true');
    await expect(shell.pages).toHaveCount(2);
  });

  test('closing a tab with unsaved changes asks: No keeps it with the edit, Yes closes it', async ({ page }) => {
    const shell = shellOf(page);
    const emp = employeesOf(page);
    await page.goto('/');
    await emp.waitLoaded();
    await shell.open('Employee list');
    await shell.open('Employees');

    // A clean tab closes with no question.
    await shell.closeButton('Employee list').click();
    await expect(shell.tabs).toHaveCount(1);
    await expect(shell.confirm).toHaveCount(0);

    await emp.enter(emp.name, 'Alicia Carter');
    await shell.closeButton('Employees').click();
    await expect(shell.confirm).toBeVisible();
    await expect(shell.confirm).toContainText('Discard unsaved changes in Employees?');
    // The safe answer has the focus.
    await expect(shell.confirm.getByRole('button', { name: 'No' })).toBeFocused();
    await shell.confirm.getByRole('button', { name: 'No' }).click();
    await expect(shell.confirm).toHaveCount(0);
    await expect(shell.tabs).toHaveCount(1);
    await expect(emp.name).toHaveValue('Alicia Carter');

    // Esc is a No too.
    await shell.closeButton('Employees').click();
    await expect(shell.confirm).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(shell.confirm).toHaveCount(0);
    await expect(shell.tabs).toHaveCount(1);
    await expect(emp.name).toHaveValue('Alicia Carter');

    // Enter on the focused answer is a No as well: it never discards work by accident.
    await shell.closeButton('Employees').click();
    await page.keyboard.press('Enter');
    await expect(shell.confirm).toHaveCount(0);
    await expect(shell.tabs).toHaveCount(1);

    await shell.closeButton('Employees').click();
    await shell.confirm.getByRole('button', { name: 'Yes' }).click();
    await expect(shell.confirm).toHaveCount(0);
    await expect(shell.tabs).toHaveCount(0);
    await expect(shell.pages).toHaveCount(0);
    // Nothing was written, and opening the screen again shows the saved data.
    expect(employee('E001')['empName']).toBe('Alice Carter');
    await shell.open('Employees');
    await emp.waitLoaded();
    await expect(emp.name).toHaveValue('Alice Carter');
  });

  test('closing a tab with unsaved changes by keyboard asks too, and Save makes it clean', async ({ page }) => {
    const shell = shellOf(page);
    const emp = employeesOf(page);
    await page.goto('/');
    await emp.waitLoaded();
    await emp.enter(emp.name, 'Alicia Carter');
    await shell.tab('Employees').focus();
    await page.keyboard.press('Delete');
    await expect(shell.confirm).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(shell.tabs).toHaveCount(1);
    // After a save there is nothing to lose.
    await emp.save.click();
    await expect(emp.status).toHaveText('Saved 1 row');
    await shell.closeButton('Employees').click();
    await expect(shell.confirm).toHaveCount(0);
    await expect(shell.tabs).toHaveCount(0);
  });
});

test.describe('Shell: leaving the page', () => {
  /** Records every dialog the page opens and answers it. */
  function watchDialogs(page: import('@playwright/test').Page, answer: 'accept' | 'dismiss'): Dialog[] {
    const seen: Dialog[] = [];
    page.on('dialog', (dialog) => {
      seen.push(dialog);
      void (answer === 'accept' ? dialog.accept() : dialog.dismiss());
    });
    return seen;
  }

  test('reloading with clean tabs shows no warning', async ({ page }) => {
    const shell = shellOf(page);
    const emp = employeesOf(page);
    const dialogs = watchDialogs(page, 'dismiss');
    await page.goto('/');
    await emp.waitLoaded();
    await shell.open('Employee list');
    await shell.open('Departments');
    // The page has had user interaction, which the browser needs before it shows a beforeunload warning at all.
    await page.mouse.click(5, 5);
    await page.reload();
    await expect(shell.tab('Employees')).toBeVisible();
    await emp.waitLoaded();
    expect(dialogs).toHaveLength(0);
    // After a save, too.
    await emp.enter(emp.name, 'Alicia Carter');
    await emp.save.click();
    await expect(emp.status).toHaveText('Saved 1 row');
    await page.reload();
    await emp.waitLoaded();
    expect(dialogs).toHaveLength(0);
  });

  test('reloading with unsaved changes opens the browser warning: staying keeps the page, leaving reloads it', async ({ page }) => {
    const shell = shellOf(page);
    const emp = employeesOf(page);
    await page.goto('/');
    await emp.waitLoaded();
    await page.evaluate(() => ((window as unknown as { marker: string }).marker = 'same page'));
    await emp.enter(emp.name, 'Alicia Carter');

    // Stay.
    const staying = page.waitForEvent('dialog');
    void page.reload().catch(() => undefined);
    const first = await staying;
    expect(first.type()).toBe('beforeunload');
    await first.dismiss();
    await sleep(500);
    expect(await page.evaluate(() => (window as unknown as { marker?: string }).marker)).toBe('same page');
    await expect(emp.name).toHaveValue('Alicia Carter');

    // The edit sits in a tab that isn't showing: it still counts.
    await shell.open('Departments');
    const stayingAgain = page.waitForEvent('dialog');
    void page.reload().catch(() => undefined);
    const second = await stayingAgain;
    expect(second.type()).toBe('beforeunload');
    await second.dismiss();
    await sleep(500);
    expect(await page.evaluate(() => (window as unknown as { marker?: string }).marker)).toBe('same page');

    // Leave.
    const leaving = page.waitForEvent('dialog');
    const reloaded = page.reload();
    const third = await leaving;
    expect(third.type()).toBe('beforeunload');
    await third.accept();
    await reloaded;
    expect(await page.evaluate(() => (window as unknown as { marker?: string }).marker)).toBeUndefined();
    await emp.waitLoaded();
    await expect(emp.name).toHaveValue('Alice Carter');
    expect(employee('E001')['empName']).toBe('Alice Carter');
  });

  test('(review fix) a field that was typed in but not committed still triggers the warning', async ({ page }) => {
    const emp = employeesOf(page);
    await page.goto('/');
    await emp.waitLoaded();
    await emp.name.click();
    await emp.name.press('Control+A');
    await emp.name.pressSequentially('Alicia Carter');
    // No Enter and no Tab: the text is only a draft in the field.
    const staying = page.waitForEvent('dialog', { timeout: 5000 });
    void page.reload().catch(() => undefined);
    const dialog = await staying;
    expect(dialog.type()).toBe('beforeunload');
    await dialog.dismiss();
    await sleep(300);
    await expect(emp.name).toHaveValue('Alicia Carter');
  });

  test('closing the page runs the same warning, and a clean page closes without one', async ({ context, page }) => {
    const emp = employeesOf(page);
    const dialogs = watchDialogs(page, 'accept');
    await page.goto('/');
    await emp.waitLoaded();
    await page.mouse.click(5, 5);
    const closed = page.waitForEvent('close');
    await page.close({ runBeforeUnload: true });
    await closed;
    expect(dialogs).toHaveLength(0);

    const dirty = await context.newPage();
    await dirty.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));
    const dirtyEmp = employeesOf(dirty);
    const dirtyDialogs = watchDialogs(dirty, 'dismiss');
    await dirty.goto('/');
    await dirtyEmp.waitLoaded();
    await dirtyEmp.enter(dirtyEmp.name, 'Alicia Carter');
    await dirty.close({ runBeforeUnload: true });
    await expect.poll(() => dirtyDialogs.map((d) => d.type())).toEqual(['beforeunload']);
    // Dismissing kept the page open.
    await sleep(300);
    expect(dirty.isClosed()).toBe(false);
    await dirty.close({ runBeforeUnload: false });
  });
});

test.describe('Shell: loading indicator and error dialog', () => {
  test('the loading indicator shows for slow calls only, after a short delay', async ({ page }) => {
    const shell = shellOf(page);
    const emp = employeesOf(page);
    let mode: 'pass' | 'quick' | 'slow' = 'pass';
    let saved = '';
    await page.route('**/dsx/v1/tx/hr.emp.search', async (route) => {
      if (mode === 'quick') {
        // Faster than the server's own delay: a call that is over long before the indicator's delay.
        await sleep(100);
        await route.fulfill({ status: 200, contentType: 'application/json', body: saved });
        return;
      }
      const response = await route.fetch();
      saved = await response.text();
      if (mode === 'slow') await sleep(900);
      await route.fulfill({ response, body: saved });
    });
    // Counts how many times the indicator was turned on, which a test that only looks now and then could miss.
    await page.addInitScript(() => {
      const w = window as unknown as { shownCount: number };
      w.shownCount = 0;
      new MutationObserver((records) => {
        for (const record of records) {
          const target = record.target as HTMLElement;
          if (target.classList.contains('fw-shell__busy') && target.hasAttribute('data-shown')) w.shownCount++;
        }
      }).observe(document, { attributes: true, subtree: true, attributeFilter: ['data-shown'] });
    });
    const shownCount = () => page.evaluate(() => (window as unknown as { shownCount: number }).shownCount);

    await page.goto('/');
    await emp.waitLoaded();
    // The live region is always there, and says nothing while idle.
    await expect(shell.busy).toHaveAttribute('role', 'status');
    await expect(shell.busy).toHaveText('');

    // Whatever the start-up did (two calls of 200 ms in a row), the counts below are relative to here.
    await sleep(500);
    const base = await shownCount();
    test.info().annotations.push({ type: 'indicator turned on during start-up', description: String(base) });

    // A quick call: no indicator.
    mode = 'quick';
    const quick = page.waitForResponse('**/dsx/v1/tx/hr.emp.search');
    await emp.search.click();
    await quick;
    await sleep(500);
    expect(await shownCount()).toBe(base);
    await expect(shell.busy).not.toHaveAttribute('data-shown', /.*/);

    // A slow call: nothing at first, then "Loading", and it goes when the answer arrives.
    mode = 'slow';
    const slow = page.waitForResponse('**/dsx/v1/tx/hr.emp.search');
    await emp.search.click();
    await sleep(120);
    expect(await shownCount(), 'not shown before its delay').toBe(base);
    await expect(shell.busy).toHaveAttribute('data-shown', /.*/);
    await expect(shell.busy).toHaveText('Loading');
    expect(await shownCount()).toBe(base + 1);
    await slow;
    await expect(shell.busy).not.toHaveAttribute('data-shown', /.*/);
    await expect(shell.busy).toHaveText('');
    expect(await shownCount()).toBe(base + 1);
  });

  test('a failure no script handles opens the common error dialog with a plain message', async ({ page, problems }) => {
    const shell = shellOf(page);
    const emp = employeesOf(page);
    await page.goto('/');
    await emp.waitLoaded();

    // The list screen's init loads the departments without a try block, so a failure there is nobody's to handle. The
    // answer is "200 and not DSX", which a proxy in front of the server could send. It is not an HTTP error, so the browser logs no network error.
    await page.route('**/dsx/v1/tx/hr.dept.list', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>maintenance</body></html>' }));
    await shell.item('Employee list').click();
    await expect(shell.errorDialog).toBeVisible();
    const text = (await shell.errorDialog.innerText()).trim();
    expect(text).toContain('Something went wrong');
    expect(text).toContain("The server answered HTTP 200 with something that isn't DSX");
    // A plain message: no stack, no file names, no class names.
    expect(text).not.toMatch(/\bat\s+\S+\s+\(|\.tsx?:\d+|\.js:\d+|node_modules|TransactionError|Error:/);
    await expect(shell.errorDialog.getByRole('button', { name: 'Dismiss' })).toBeFocused();
    await shell.errorDialog.getByRole('button', { name: 'Dismiss' }).click();
    await expect(shell.errorDialog).toHaveCount(0);
    // The screen that was open still works.
    await shell.tab('Employees').click();
    await expect(emp.name).toHaveValue('Alice Carter');

    // Esc dismisses it too, and the screen opens once the server answers properly again.
    await shell.closeButton('Employee list').click();
    await expect(shell.tab('Employee list')).toHaveCount(0);
    await shell.item('Employee list').click();
    await expect(shell.errorDialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(shell.errorDialog).toHaveCount(0);
    await shell.closeButton('Employee list').click();
    await page.unroute('**/dsx/v1/tx/hr.dept.list');
    await shell.open('Employee list');
    await expect(shell.active.getByText('Found 25 employees')).toBeVisible();

    // The shell reports it to the console as well (for the developer), and that is all that was logged: once per failure.
    expect(problems).toHaveLength(2);
    for (const problem of problems) expect(problem).toMatch(/^console\.error: \[shell\] init TransactionError: The server answered HTTP 200/);
    problems.length = 0;
  });
});

test.describe('Shell: hash deep links', () => {
  test('each hash opens its screen as the first tab, and an unknown one falls back to Employees', async ({ page }) => {
    const shell = shellOf(page);
    await page.goto('/#list');
    await expect(shell.active.getByText('Found 25 employees')).toBeVisible();
    expect(await shell.titles()).toEqual(['Employee list']);
    await expect(shell.tab('Employee list')).toHaveAttribute('aria-selected', 'true');

    await page.goto('/#dept');
    await page.reload();
    await expect(shell.active.getByText('5 departments')).toBeVisible();
    expect(await shell.titles()).toEqual(['Departments']);

    await page.goto('/#nowhere');
    await page.reload();
    await expect(shell.active.getByText('Found 25 employees')).toBeVisible();
    expect(await shell.titles()).toEqual(['Employees']);

    await page.goto('/');
    await page.reload();
    await expect(shell.tabs).toHaveCount(1);
    expect(await shell.titles()).toEqual(['Employees']);
  });

  test('changing the hash later opens or activates the matching tab, and Back goes to the previous screen', async ({ page }) => {
    const shell = shellOf(page);
    const emp = employeesOf(page);
    await page.goto('/#list');
    await expect(shell.active.getByText('Found 25 employees')).toBeVisible();

    await page.evaluate(() => {
      window.location.hash = '#dept';
    });
    await expect(shell.tab('Departments')).toHaveAttribute('aria-selected', 'true');
    expect(await shell.titles()).toEqual(['Employee list', 'Departments']);

    await page.goBack();
    await expect(page).toHaveURL(/#list$/);
    await expect(shell.tab('Employee list')).toHaveAttribute('aria-selected', 'true');
    expect(await shell.titles()).toEqual(['Employee list', 'Departments']);

    await page.evaluate(() => {
      window.location.hash = '';
    });
    await expect(shell.tab('Employees')).toHaveAttribute('aria-selected', 'true');
    await emp.waitLoaded();
    expect(await shell.titles()).toEqual(['Employee list', 'Departments', 'Employees']);
  });
});
