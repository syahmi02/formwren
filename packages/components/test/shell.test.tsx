// @vitest-environment jsdom
import type { ComponentDefinition, FormEntry } from '@fw/core';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell, createShellDialogs, type MenuItem } from '../src/shell/index.ts';
import { createFakeShell, type FakeShell } from './shell-fake.ts';
import { def } from './support/fake-form.ts';
import { renderCounts, testRegistry } from './support/test-components.tsx';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  renderCounts.clear();
});

const entry = (id: string): FormEntry => ({
  definition: { formatVersion: 1, id, components: [] },
  load: () => Promise.resolve({ setup: () => ({}) }),
});

interface Setup {
  fake: FakeShell;
  loads: string[];
  titleReads: { count: number };
  user: ReturnType<typeof userEvent.setup>;
}

function setup(options: { maxTabs?: number; busyDelayMs?: number; components?: ComponentDefinition[]; fakeTimers?: boolean } = {}): Setup {
  const dialogs = createShellDialogs();
  const fake = createFakeShell({ ...options, confirm: dialogs.confirm });
  const loads: string[] = [];
  const titleReads = { count: 0 };
  const item = (key: string, title: string): MenuItem => ({
    key,
    // Counts how often the menu reads the title, which it does once per render of the item.
    get title() {
      titleReads.count++;
      return title;
    },
    load: () => {
      loads.push(key);
      return Promise.resolve(entry(key));
    },
  });
  const menu = [item('employees', 'Employees'), item('list', 'Employee list'), item('departments', 'Departments')];
  render(<AppShell shell={fake.shell} menu={menu} registry={testRegistry} dialogs={dialogs} {...(options.busyDelayMs === undefined ? {} : { busyDelayMs: options.busyDelayMs })} />);
  const user = userEvent.setup(options.fakeTimers ? { advanceTimers: vi.advanceTimersByTime } : {});
  return { fake, loads, titleReads, user };
}

const openItem = async (user: Setup['user'], name: string) => {
  await user.click(within(screen.getByRole('navigation', { name: 'Menu' })).getByRole('button', { name }));
};
const tabNames = () => within(screen.getByRole('tablist', { name: 'Open screens', hidden: true })).getAllByRole('tab', { hidden: true }).map((tab) => tab.textContent);

describe('menu and tabs', () => {
  it('opens a menu item in an active tab and draws its form', async () => {
    const { user } = setup();
    await openItem(user, 'Employees');
    expect(await screen.findByRole('tab', { name: 'Employees', selected: true })).toBeTruthy();
    expect(screen.getByRole('tabpanel', { name: 'Employees' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'field' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Employees' }).getAttribute('aria-current')).toBe('page');
  });

  it('activates the tab of an item that is already open, without loading it again', async () => {
    const { user, loads } = setup();
    await openItem(user, 'Employees');
    await screen.findByRole('tab', { name: 'Employees' });
    await openItem(user, 'Departments');
    await screen.findByRole('tab', { name: 'Departments', selected: true });
    await openItem(user, 'Employees');
    expect(tabNames()).toEqual(['Employees', 'Departments']);
    expect(screen.getByRole('tab', { name: 'Employees' }).getAttribute('aria-selected')).toBe('true');
    expect(loads).toEqual(['employees', 'departments']);
  });

  it('refuses a tab beyond the limit and says why', async () => {
    const { user } = setup({ maxTabs: 2 });
    await openItem(user, 'Employees');
    await openItem(user, 'Employee list');
    await openItem(user, 'Departments');
    const alert = await screen.findByRole('alertdialog');
    expect(alert.textContent).toContain('At most 2 screens can be open');
    expect(tabNames()).toEqual(['Employees', 'Employee list']);
  });

  it('keeps an inactive tab mounted and hidden, with what the user typed', async () => {
    const { user, fake } = setup();
    await openItem(user, 'Employees');
    const field = (await screen.findByRole('textbox', { name: 'field' })) as HTMLInputElement;
    await user.type(field, 'draft text');
    await openItem(user, 'Departments');
    await screen.findByRole('tab', { name: 'Departments', selected: true });
    const panel = document.querySelector<HTMLElement>('[role="tabpanel"][aria-labelledby]')!;
    expect(panel.hasAttribute('hidden')).toBe(true);
    expect(field.isConnected).toBe(true);
    await user.click(screen.getByRole('tab', { name: 'Employees' }));
    expect(panel.hasAttribute('hidden')).toBe(false);
    expect(screen.getByRole('textbox', { name: 'field' })).toBe(field);
    expect(field.value).toBe('draft text');
    const [first, second] = [...fake.forms.values()];
    expect(first?.events).toEqual(['activate', 'deactivate', 'activate']);
    expect(second?.events).toEqual(['activate', 'deactivate']);
  });

  it('works by keyboard: arrows, Home, End and Delete, with one tab stop', async () => {
    const { user, fake } = setup();
    for (const name of ['Employees', 'Employee list', 'Departments']) await openItem(user, name);
    await screen.findByRole('tab', { name: 'Departments', selected: true });
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.tabIndex)).toEqual([-1, -1, 0]);
    act(() => tabs[2]!.focus());
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(tabs[0]);
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(tabs[2]);
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(tabs[1]);
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(tabs[0]);
    await user.keyboard('{Delete}');
    await waitFor(() => expect(tabNames()).toEqual(['Employee list', 'Departments']));
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Employee list' }));
    expect(fake.shell.tabs.peek()).toHaveLength(2);
  });
});

describe('closing a tab', () => {
  it('closes at once when nothing is unsaved', async () => {
    const { user, fake } = setup();
    await openItem(user, 'Employees');
    await screen.findByRole('tab', { name: 'Employees' });
    await user.click(screen.getByRole('button', { name: 'Close Employees' }));
    await waitFor(() => expect(screen.queryByRole('tab')).toBeNull());
    expect(fake.confirms).toEqual([]);
  });

  it('asks first with unsaved changes, and keeps the tab on No', async () => {
    const { user, fake } = setup();
    await openItem(user, 'Employees');
    await screen.findByRole('tab', { name: 'Employees' });
    [...fake.forms.values()][0]!.dirty = true;
    await user.click(screen.getByRole('button', { name: 'Close Employees' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Discard unsaved changes in Employees?');
    // The safe answer has focus.
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'No' }));
    await user.click(within(dialog).getByRole('button', { name: 'No' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(tabNames()).toEqual(['Employees']);
  });

  it('closes the tab on Yes', async () => {
    const { user, fake } = setup();
    await openItem(user, 'Employees');
    await screen.findByRole('tab', { name: 'Employees' });
    [...fake.forms.values()][0]!.dirty = true;
    await user.click(screen.getByRole('button', { name: 'Close Employees' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(screen.queryByRole('tab')).toBeNull());
  });

  it('answers No on Esc', async () => {
    const { user, fake } = setup();
    await openItem(user, 'Employees');
    await screen.findByRole('tab', { name: 'Employees' });
    [...fake.forms.values()][0]!.dirty = true;
    await user.click(screen.getByRole('button', { name: 'Close Employees' }));
    await screen.findByRole('alertdialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(tabNames()).toEqual(['Employees']);
  });

  it("stays open when the form's own beforeClose vetoes", async () => {
    const { user, fake } = setup();
    await openItem(user, 'Employees');
    await screen.findByRole('tab', { name: 'Employees' });
    [...fake.forms.values()][0]!.allowClose = false;
    await user.click(screen.getByRole('button', { name: 'Close Employees' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(tabNames()).toEqual(['Employees']);
    expect(screen.getByRole('textbox', { name: 'field' })).toBeTruthy();
  });
});

describe('popups', () => {
  it('draws a modal with its own form, a title and a close button, sized from the form', async () => {
    const { user, fake } = setup();
    await openItem(user, 'Employees');
    await screen.findByRole('tab', { name: 'Employees' });
    act(() => void fake.openPopup('Pick an employee'));
    const dialog = await screen.findByRole('dialog', { name: 'Pick an employee' });
    expect(within(dialog).getByRole('heading', { name: 'Pick an employee' })).toBeTruthy();
    expect(within(dialog).getByRole('textbox', { name: 'popField' })).toBeTruthy();
    const body = dialog.querySelector<HTMLElement>('.fw-shell__popup-body')!;
    expect(body.style.width).toBe('320px');
    expect(body.style.height).toBe('160px');
    expect(within(dialog).getByRole('button', { name: 'Close Pick an employee' })).toBeTruthy();
  });

  it('delivers the result of the popup to the opener', async () => {
    const { fake } = setup();
    let result!: Promise<unknown>;
    act(() => {
      result = fake.openPopup('Lookup').result;
    });
    await screen.findByRole('dialog', { name: 'Lookup' });
    act(() => fake.closeTopPopup({ empNo: 'E001' }));
    await expect(result).resolves.toEqual({ empNo: 'E001' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('cancels with the close button and with Esc, giving undefined', async () => {
    const { user, fake } = setup();
    let first!: Promise<unknown>;
    act(() => {
      first = fake.openPopup('One').result;
    });
    await user.click(await screen.findByRole('button', { name: 'Close One' }));
    await expect(first).resolves.toBeUndefined();
    let second!: Promise<unknown>;
    act(() => {
      second = fake.openPopup('Two').result;
    });
    await screen.findByRole('dialog', { name: 'Two' });
    await user.keyboard('{Escape}');
    await expect(second).resolves.toBeUndefined();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('stacks popups so that only the top one answers Esc', async () => {
    const { user, fake } = setup();
    let lower!: ReturnType<FakeShell['openPopup']>;
    act(() => {
      lower = fake.openPopup('Lower');
    });
    await screen.findByRole('dialog', { name: 'Lower' });
    let upper!: ReturnType<FakeShell['openPopup']>;
    act(() => {
      upper = fake.openPopup('Upper');
    });
    await screen.findByRole('dialog', { name: 'Upper' });
    // The one underneath is hidden from assistive technology.
    expect(screen.queryByRole('dialog', { name: 'Lower' })).toBeNull();
    const upperDialog = screen.getByRole('dialog', { name: 'Upper' });
    expect(upperDialog.contains(document.activeElement)).toBe(true);
    const settled = vi.fn();
    void lower.result.then(settled);
    await user.keyboard('{Escape}');
    await expect(upper.result).resolves.toBeUndefined();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Upper' })).toBeNull());
    expect(settled).not.toHaveBeenCalled();
    await screen.findByRole('dialog', { name: 'Lower' });
    await user.keyboard('{Escape}');
    await expect(lower.result).resolves.toBeUndefined();
  });

  it('returns focus to the opener when the popup closes', async () => {
    const { user, fake } = setup();
    await openItem(user, 'Employees');
    await screen.findByRole('tab', { name: 'Employees' });
    const opener = screen.getByRole('button', { name: 'Departments' });
    act(() => opener.focus());
    act(() => void fake.openPopup('Lookup'));
    const dialog = await screen.findByRole('dialog', { name: 'Lookup' });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});

describe('unsaved text on reload', () => {
  it('commits a typed draft by blurring before it checks, so reload warns', async () => {
    const { user, fake } = setup();
    await openItem(user, 'Employees');
    const field = await screen.findByRole('textbox', { name: 'field' });
    // Stands in for a TextInput, which writes its draft to the Dataset on blur.
    field.addEventListener('blur', () => {
      [...fake.forms.values()][0]!.dirty = true;
    });
    act(() => field.focus());
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(field);
  });

  it('does not warn on a clean screen, even with a field focused', async () => {
    const { user } = setup();
    await openItem(user, 'Employees');
    const field = await screen.findByRole('textbox', { name: 'field' });
    act(() => field.focus());
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('a popup that is still loading', () => {
  it('blocks everything behind it, then draws the form when loading ends', async () => {
    const { user, fake } = setup();
    await openItem(user, 'Employees');
    await screen.findByRole('tab', { name: 'Employees' });
    let popup!: ReturnType<FakeShell['openPopup']>;
    act(() => {
      popup = fake.openPopup('Lookup', undefined, true);
    });
    const loading = await screen.findByRole('dialog', { name: 'Loading Lookup' });
    expect(loading.textContent).toContain('Loading');
    expect(screen.queryByRole('textbox', { name: 'popField' })).toBeNull();
    // The tab strip and the menu are hidden from assistive technology behind the modal.
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
    act(() => fake.finishLoading(popup.popup.id));
    expect(await screen.findByRole('textbox', { name: 'popField' })).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Lookup' })).toBeTruthy();
  });

  it('is cancelled by Esc through closePopup', async () => {
    const { user, fake } = setup();
    let popup!: ReturnType<FakeShell['openPopup']>;
    act(() => {
      popup = fake.openPopup('Lookup', undefined, true);
    });
    await screen.findByRole('dialog', { name: 'Loading Lookup' });
    await user.keyboard('{Escape}');
    await expect(popup.result).resolves.toBeUndefined();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('focus after a popup that loaded first', () => {
  it('returns to the opener after the loading dialog is swapped for the form and closed', async () => {
    const { user, fake } = setup();
    await openItem(user, 'Employees');
    const opener = await screen.findByRole('textbox', { name: 'field' });
    act(() => opener.focus());
    let popup!: ReturnType<FakeShell['openPopup']>;
    act(() => {
      popup = fake.openPopup('Lookup', undefined, true);
    });
    await screen.findByRole('dialog', { name: 'Loading Lookup' });
    act(() => fake.finishLoading(popup.popup.id));
    await screen.findByRole('textbox', { name: 'popField' });
    act(() => fake.closeTopPopup({ empNo: 'E1' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(document.activeElement).not.toBe(document.body);
  });

  it('honours Esc pressed while the shell cannot close the popup yet, once its form is there', async () => {
    const { user, fake } = setup();
    fake.refuseWhileLoading = true;
    let popup!: ReturnType<FakeShell['openPopup']>;
    act(() => {
      popup = fake.openPopup('Lookup', undefined, true);
    });
    await screen.findByRole('dialog', { name: 'Loading Lookup' });
    await user.keyboard('{Escape}');
    // Still loading, so nothing could close.
    expect(screen.getByRole('dialog', { name: 'Loading Lookup' })).toBeTruthy();
    act(() => fake.finishLoading(popup.popup.id));
    await expect(popup.result).resolves.toBeUndefined();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('returns to the opener when the loading dialog is cancelled with Esc', async () => {
    const { user, fake } = setup();
    await openItem(user, 'Employees');
    const opener = await screen.findByRole('textbox', { name: 'field' });
    act(() => opener.focus());
    act(() => void fake.openPopup('Lookup', undefined, true));
    await screen.findByRole('dialog', { name: 'Loading Lookup' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('returns to the field in the lower popup when a stacked popup closes', async () => {
    const { user, fake } = setup();
    let lower!: ReturnType<FakeShell['openPopup']>;
    act(() => {
      lower = fake.openPopup('Lower', undefined, true);
    });
    await screen.findByRole('dialog', { name: 'Loading Lower' });
    act(() => fake.finishLoading(lower.popup.id));
    const field = await screen.findByRole('textbox', { name: 'popField' });
    act(() => field.focus());
    let upper!: ReturnType<FakeShell['openPopup']>;
    act(() => {
      upper = fake.openPopup('Upper', undefined, true);
    });
    await screen.findByRole('dialog', { name: 'Loading Upper' });
    act(() => fake.finishLoading(upper.popup.id));
    await screen.findByRole('dialog', { name: 'Upper' });
    await user.keyboard('{Escape}');
    await expect(upper.result).resolves.toBeUndefined();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Upper' })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(field));
  });
});

describe('a menu item that fails to load', () => {
  it('reports through the shell, so the common error dialog shows it', async () => {
    const dialogs = createShellDialogs();
    const fake = createFakeShell({ confirm: dialogs.confirm });
    const menu: MenuItem[] = [{ key: 'bad', title: 'Broken', load: () => Promise.reject(new Error('The screen could not be loaded.')) }];
    render(<AppShell shell={fake.shell} menu={menu} registry={testRegistry} dialogs={dialogs} />);
    await userEvent.click(screen.getByRole('button', { name: 'Broken' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('The screen could not be loaded.');
    expect(fake.reported.map((r) => r.where)).toEqual(['open bad']);
  });
});

describe('loading indicator', () => {
  beforeEach(() => vi.useFakeTimers());

  it('shows after the delay, announces politely, and hides when idle', () => {
    const { fake } = setup({ fakeTimers: true });
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    act(() => fake.setBusy(1));
    act(() => void vi.advanceTimersByTime(299));
    expect(status.textContent).toBe('');
    act(() => void vi.advanceTimersByTime(2));
    expect(status.textContent).toBe('Loading');
    act(() => fake.setBusy(0));
    expect(status.textContent).toBe('');
  });

  it('never shows for a quick call', () => {
    const { fake } = setup({ fakeTimers: true });
    const status = screen.getByRole('status');
    act(() => fake.setBusy(1));
    act(() => void vi.advanceTimersByTime(120));
    act(() => fake.setBusy(0));
    act(() => void vi.advanceTimersByTime(1000));
    expect(status.textContent).toBe('');
  });

  it('keeps showing while calls overlap', () => {
    const { fake } = setup({ fakeTimers: true });
    const status = screen.getByRole('status');
    act(() => fake.setBusy(1));
    act(() => void vi.advanceTimersByTime(200));
    act(() => fake.setBusy(2));
    act(() => void vi.advanceTimersByTime(150));
    expect(status.textContent).toBe('Loading');
  });
});

describe('common error dialog', () => {
  it('shows a plain message with a dismiss button and no stack', async () => {
    const { user, fake } = setup();
    act(() => fake.fail('The employee could not be saved.'));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('The employee could not be saved.');
    expect(dialog.textContent).not.toMatch(/\bat\s+\S+\s*\(|\.tsx?:\d+/);
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Dismiss' }));
    await user.click(within(dialog).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(fake.shell.lastError.peek()).toBeNull();
  });

  it('is dismissed with Esc', async () => {
    const { user, fake } = setup();
    act(() => fake.fail('Nope.'));
    await screen.findByRole('alertdialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(fake.shell.lastError.peek()).toBeNull();
  });
});

describe('beforeunload', () => {
  const tryUnload = (): boolean => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };

  it('warns only while a tab has unsaved changes', async () => {
    const { user, fake } = setup();
    await openItem(user, 'Employees');
    await screen.findByRole('tab', { name: 'Employees' });
    expect(tryUnload()).toBe(false);
    [...fake.forms.values()][0]!.dirty = true;
    expect(tryUnload()).toBe(true);
    [...fake.forms.values()][0]!.dirty = false;
    expect(tryUnload()).toBe(false);
  });

  it('leaves no listener behind once the shell unmounts', () => {
    const { fake } = setup();
    const added = vi.spyOn(window, 'removeEventListener');
    cleanup();
    expect(added.mock.calls.some(([type]) => type === 'beforeunload')).toBe(true);
    void fake;
    added.mockRestore();
  });
});

describe('render counts (React contract)', () => {
  const probes = [def('probeA', 'Probe', { text: 'a' }), def('probeB', 'Probe', { text: 'b' })];

  it('re-renders only the component whose data changed, not the shell or other tabs', async () => {
    const { user, fake, titleReads } = setup({ components: probes });
    await openItem(user, 'Employees');
    await screen.findByRole('tab', { name: 'Employees' });
    await openItem(user, 'Departments');
    await screen.findByRole('tab', { name: 'Departments', selected: true });
    const [firstForm, secondForm] = [...fake.forms.values()];
    const settled = { menu: titleReads.count, a1: renderCounts.get('probeA')!, b1: renderCounts.get('probeB')! };
    expect(settled.a1).toBeGreaterThan(0);

    // A data change in the hidden tab updates that one component and nothing else.
    const before = new Map(renderCounts);
    act(() => firstForm!.fake.model('probeA').setProps({ text: 'changed' }));
    expect(screen.getByText('changed')).toBeTruthy();
    expect(titleReads.count).toBe(settled.menu);
    expect(screen.getAllByTestId('probeA')).toHaveLength(2);
    expect(renderCounts.get('probeA')).toBe(before.get('probeA')! + 1);
    expect(renderCounts.get('probeB')).toBe(before.get('probeB'));

    // The same for the active tab.
    const mid = renderCounts.get('probeB')!;
    act(() => secondForm!.fake.model('probeA').setProps({ text: 'active change' }));
    expect(titleReads.count).toBe(settled.menu);
    expect(renderCounts.get('probeB')).toBe(mid);
  });

  it('does not re-render forms when a popup opens, or when the busy count moves', async () => {
    const { user, fake, titleReads } = setup({ components: probes });
    await openItem(user, 'Employees');
    await screen.findByRole('tab', { name: 'Employees' });
    const menuReads = titleReads.count;
    const before = new Map(renderCounts);
    act(() => void fake.openPopup('Lookup'));
    await screen.findByRole('dialog', { name: 'Lookup' });
    act(() => fake.setBusy(1));
    act(() => fake.setBusy(0));
    act(() => fake.closeTopPopup(undefined));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(renderCounts.get('probeA')).toBe(before.get('probeA'));
    expect(renderCounts.get('probeB')).toBe(before.get('probeB'));
    expect(titleReads.count).toBe(menuReads);
  });

  it('does not re-render the tab pages when the active tab changes', async () => {
    const { user, titleReads } = setup({ components: probes });
    await openItem(user, 'Employees');
    await screen.findByRole('tab', { name: 'Employees' });
    await openItem(user, 'Departments');
    await screen.findByRole('tab', { name: 'Departments', selected: true });
    const before = new Map(renderCounts);
    await user.click(screen.getByRole('tab', { name: 'Employees' }));
    expect(renderCounts.get('probeA')).toBe(before.get('probeA'));
    expect(renderCounts.get('probeB')).toBe(before.get('probeB'));
    void titleReads;
  });
});
