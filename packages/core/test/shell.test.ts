import { describe, expect, it, vi } from 'vitest';
import {
  createForm,
  createShell,
  defineForm,
  TransactionError,
  type DsxRequest,
  type DsxResponse,
  type FormDefinition,
  type FormEntry,
  type FormHandler,
  type FormModule,
  type Shell,
  type Transport,
} from '../src/index.ts';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface EntryOptions {
  events?: Record<string, string>;
  handlers?: Record<string, FormHandler>;
  setup?: FormModule['setup'];
  confirmUnsaved?: boolean;
  title?: string;
}

function entry(id: string, options: EntryOptions = {}): FormEntry {
  const definition: FormDefinition = {
    formatVersion: 1,
    id,
    ...(options.title ? { title: options.title } : {}),
    params: { code: { type: 'string', default: 'D1' } },
    events: options.events ?? {},
    datasets: [
      {
        id: 'ds',
        confirmUnsaved: options.confirmUnsaved ?? true,
        columns: [{ id: 'name', type: 'string' }],
        initialRows: [{ name: 'a' }],
      },
    ],
    components: [{ id: 'btn', type: 'Button', layout: { left: 0, top: 0, width: 10, height: 10 }, events: { click: 'onClick' } }],
  };
  return {
    definition,
    load: () => Promise.resolve(options.setup ? defineForm(options.setup) : defineForm(() => options.handlers ?? {})),
  };
}

interface Made {
  shell: Shell;
  errors: unknown[];
  confirm: ReturnType<typeof vi.fn>;
}

function makeShell(extra: { transport?: Transport; maxTabs?: number; confirm?: (message: string) => Promise<boolean> } = {}): Made {
  const errors: unknown[] = [];
  const confirm = vi.fn(extra.confirm ?? (() => Promise.resolve(true)));
  const shell = createShell({
    confirm,
    onError: (error) => errors.push(error),
    ...(extra.transport ? { transport: extra.transport } : {}),
    ...(extra.maxTabs ? { maxTabs: extra.maxTabs } : {}),
  });
  return { shell, errors, confirm };
}

const OK: DsxResponse = { status: { ok: true } };

/** A transport whose calls stay open until the test settles them. */
function manualTransport(): { transport: Transport; settle: (index: number, response?: DsxResponse) => void; sent: DsxRequest[]; signals: AbortSignal[] } {
  const waiting: ((response: DsxResponse) => void)[] = [];
  const sent: DsxRequest[] = [];
  const signals: AbortSignal[] = [];
  return {
    sent,
    signals,
    settle: (index, response = OK) => waiting[index]?.(response),
    transport: {
      send(request, { signal }) {
        sent.push(request);
        signals.push(signal);
        return new Promise<DsxResponse>((resolve) => waiting.push(resolve));
      },
    },
  };
}

describe('shell tabs', () => {
  it('opens a tab, activates it and gives it a title', async () => {
    const { shell } = makeShell();
    const tab = await shell.open('emp', entry('a.Emp', { title: 'Employees' }));
    expect(tab?.key).toBe('emp');
    expect(tab?.title).toBe('Employees');
    expect(shell.tabs.value).toHaveLength(1);
    expect(shell.activeId.value).toBe(tab?.id);
    expect(shell.activeTab.value).toBe(tab);
    expect(tab?.form.state.value).toBe('active');
    const other = await shell.open('x', entry('a.X'), { title: 'Custom' });
    expect(other?.title).toBe('Custom');
    expect((await shell.open('y', entry('a.Y')))?.title).toBe('y');
  });

  it('passes params to the form', async () => {
    const { shell } = makeShell();
    const tab = await shell.open('emp', entry('a.Emp'), { params: { code: 'Z' } });
    expect(tab?.form.context.params.code).toBe('Z');
  });

  it('activates the existing tab for a key, even while it is still loading', async () => {
    const { shell } = makeShell();
    const a = await shell.open('a', entry('a.A'));
    const b = await shell.open('b', entry('a.B'));
    expect(shell.activeId.value).toBe(b?.id);
    expect(await shell.open('a', entry('a.A'))).toBe(a);
    expect(shell.tabs.value).toHaveLength(2);
    expect(shell.activeId.value).toBe(a?.id);

    const [first, second] = await Promise.all([shell.open('c', entry('a.C')), shell.open('c', entry('a.C'))]);
    expect(first).toBe(second);
    expect(shell.tabs.value).toHaveLength(3);
  });

  it('refuses a tab over the limit, with a message', async () => {
    const { shell, errors } = makeShell({ maxTabs: 2 });
    await shell.open('a', entry('a.A'));
    await shell.open('b', entry('a.B'));
    expect(await shell.open('c', entry('a.C'))).toBeUndefined();
    expect(shell.tabs.value).toHaveLength(2);
    expect(shell.lastError.value?.message).toContain('Too many tabs');
    expect(errors).toHaveLength(1);
    // An open key still activates.
    expect(await shell.open('a', entry('a.A'))).toBeDefined();
  });

  it('counts tabs still loading toward the limit', async () => {
    const { shell } = makeShell({ maxTabs: 1 });
    const results = await Promise.all([shell.open('a', entry('a.A')), shell.open('b', entry('a.B'))]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('follows the active tab with activate and deactivate', async () => {
    const { shell } = makeShell();
    const a = await shell.open('a', entry('a.A'));
    const b = await shell.open('b', entry('a.B'));
    expect(a?.form.state.value).toBe('inactive');
    expect(b?.form.state.value).toBe('active');
    shell.activate(a?.id as string);
    expect(a?.form.state.value).toBe('active');
    expect(b?.form.state.value).toBe('inactive');
    shell.activate('nope');
    expect(shell.activeId.value).toBe(a?.id);
  });

  it('closes a clean tab with no question, and activates the neighbour', async () => {
    const { shell, confirm } = makeShell();
    const a = await shell.open('a', entry('a.A'));
    const b = await shell.open('b', entry('a.B'));
    const c = await shell.open('c', entry('a.C'));
    shell.activate(b?.id as string);
    await expect(shell.close(b?.id as string)).resolves.toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(shell.tabs.value.map((t) => t.key)).toEqual(['a', 'c']);
    expect(shell.activeId.value).toBe(c?.id);
    expect(c?.form.state.value).toBe('active');
    expect(b?.form.state.value).toBe('closed');
    await shell.close(c?.id as string);
    expect(shell.activeId.value).toBe(a?.id);
    await shell.close(a?.id as string);
    expect(shell.activeId.value).toBeNull();
    await expect(shell.close('nope')).resolves.toBe(false);
  });

  it('keeps the active tab when another one closes', async () => {
    const { shell } = makeShell();
    const a = await shell.open('a', entry('a.A'));
    const b = await shell.open('b', entry('a.B'));
    await shell.close(a?.id as string);
    expect(shell.activeId.value).toBe(b?.id);
  });

  it('asks before closing a tab with unsaved changes', async () => {
    const no = makeShell({ confirm: () => Promise.resolve(false) });
    const tab = await no.shell.open('a', entry('a.A', { title: 'Employees' }));
    tab?.form.context.ds.ds?.setValue(0, 'name', 'changed');
    expect(no.shell.hasUnsavedChanges()).toBe(true);
    await expect(no.shell.close(tab?.id as string)).resolves.toBe(false);
    expect(no.confirm).toHaveBeenCalledWith('Discard unsaved changes in Employees?');
    expect(no.shell.tabs.value).toHaveLength(1);
    expect(tab?.form.state.value).toBe('active');

    const yes = makeShell();
    const other = await yes.shell.open('a', entry('a.A'));
    other?.form.context.ds.ds?.setValue(0, 'name', 'changed');
    await expect(yes.shell.close(other?.id as string)).resolves.toBe(true);
    expect(yes.shell.tabs.value).toHaveLength(0);
    expect(yes.shell.hasUnsavedChanges()).toBe(false);
  });

  it('does not ask when the Dataset does not confirm unsaved changes', async () => {
    const { shell, confirm } = makeShell();
    const tab = await shell.open('a', entry('a.A', { confirmUnsaved: false }));
    tab?.form.context.ds.ds?.setValue(0, 'name', 'changed');
    expect(shell.hasUnsavedChanges()).toBe(false);
    await shell.close(tab?.id as string);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('lets the form veto the close after the user agrees', async () => {
    const { shell, confirm } = makeShell();
    const tab = await shell.open('a', entry('a.A', { events: { beforeClose: 'onBeforeClose' }, handlers: { onBeforeClose: () => false } }));
    tab?.form.context.ds.ds?.setValue(0, 'name', 'changed');
    await expect(shell.close(tab?.id as string)).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(shell.tabs.value).toHaveLength(1);
    expect(tab?.form.state.value).toBe('active');
    expect(shell.activeId.value).toBe(tab?.id);
  });

  it('asks once when closed twice at the same time', async () => {
    const { shell, confirm } = makeShell();
    const tab = await shell.open('a', entry('a.A'));
    tab?.form.context.ds.ds?.setValue(0, 'name', 'changed');
    const results = await Promise.all([shell.close(tab?.id as string), shell.close(tab?.id as string)]);
    expect(results).toEqual([true, true]);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('removes a tab whose form closes itself', async () => {
    const { shell } = makeShell();
    const tab = await shell.open('a', entry('a.A'));
    await tab?.form.close();
    expect(shell.tabs.value).toHaveLength(0);
    expect(shell.activeId.value).toBeNull();
  });

  it('reports a script that fails to load, and opens nothing', async () => {
    const { shell } = makeShell();
    const broken: FormEntry = { definition: entry('a.A').definition, load: () => Promise.reject(new Error('no script')) };
    expect(await shell.open('a', broken)).toBeUndefined();
    expect(shell.lastError.value?.message).toBe('no script');
    expect(shell.tabs.value).toHaveLength(0);
    // The key is free to try again.
    expect(await shell.open('a', entry('a.A'))).toBeDefined();
  });
});

describe('shell busy count', () => {
  type WithTx = { context: { tx: { call(o: { service: string }): Promise<unknown> } } };
  const callOf = (form: WithTx, service = 's'): Promise<unknown> => form.context.tx.call({ service });

  it('counts calls in flight from every tab', async () => {
    const manual = manualTransport();
    const { shell } = makeShell({ transport: manual.transport });
    const a = await shell.open('a', entry('a.A'));
    const b = await shell.open('b', entry('a.B'));
    expect(shell.busy.value).toBe(0);
    const one = callOf(a!.form);
    const two = callOf(b!.form);
    await tick();
    expect(shell.busy.value).toBe(2);
    manual.settle(0);
    await one;
    expect(shell.busy.value).toBe(1);
    manual.settle(1);
    await two;
    expect(shell.busy.value).toBe(0);
  });

  it('counts a popup form too', async () => {
    const manual = manualTransport();
    const { shell } = makeShell({ transport: manual.transport });
    const popup = entry('a.P', {
      events: { init: 'onInit' },
      setup: (form) => ({ onInit: () => form.tx.call({ service: 'p' }).catch(() => undefined) }),
    });
    const tab = await shell.open('a', entry('a.A'));
    void tab?.form.context.open(popup);
    await tick();
    expect(shell.busy.value).toBe(1);
    manual.settle(0);
    await tick();
    await tick();
    expect(shell.busy.value).toBe(0);
    expect(shell.popups.value).toHaveLength(1);
  });

  it('stops counting a call that fails or throws at once', async () => {
    const thrower: Transport = {
      send() {
        throw new Error('sync boom');
      },
    };
    const rejecter: Transport = { send: () => Promise.reject(new Error('async boom')) };
    for (const transport of [thrower, rejecter]) {
      const { shell } = makeShell({ transport });
      const tab = await shell.open('a', entry('a.A'));
      await expect(callOf(tab!.form)).rejects.toMatchObject({ code: 'network' });
      expect(shell.busy.value).toBe(0);
    }
  });

  it('counts a transport that answers without a promise', async () => {
    const now: Transport = { send: () => OK as unknown as Promise<DsxResponse> };
    const { shell } = makeShell({ transport: now });
    const tab = await shell.open('a', entry('a.A'));
    await callOf(tab!.form);
    expect(shell.busy.value).toBe(0);
  });

  it('stops counting a call the moment its form closes', async () => {
    const manual = manualTransport();
    const { shell } = makeShell({ transport: manual.transport });
    const tab = await shell.open('a', entry('a.A'));
    const pending = callOf(tab!.form).catch((error: unknown) => error);
    await tick();
    expect(shell.busy.value).toBe(1);
    await shell.close(tab!.id);
    expect(manual.signals[0]?.aborted).toBe(true);
    expect(shell.busy.value).toBe(0);
    expect(await pending).toMatchObject({ code: 'aborted' });
    manual.settle(0);
    await tick();
    expect(shell.busy.value).toBe(0);
  });

  it('works with no transport', async () => {
    const { shell } = makeShell();
    const tab = await shell.open('a', entry('a.A'));
    await expect(callOf(tab!.form)).rejects.toMatchObject({ code: 'no-transport' });
    expect(shell.busy.value).toBe(0);
  });
});

describe('shell errors', () => {
  it('shows an error a handler did not handle, in plain text', async () => {
    const { shell, errors } = makeShell();
    const tab = await shell.open(
      'a',
      entry('a.A', {
        handlers: {
          onClick: () => {
            throw new Error('Salary is too high');
          },
        },
      }),
    );
    tab?.form.getComponent('btn')?.fire('click');
    expect(shell.lastError.value).toMatchObject({ message: 'Salary is too high', where: 'btn.click', formId: 'a.A' });
    expect(errors).toHaveLength(1);
    shell.dismissError();
    expect(shell.lastError.value).toBeNull();
  });

  it('shows a rejected async handler and a failed init', async () => {
    const { shell } = makeShell();
    const tab = await shell.open(
      'a',
      entry('a.A', {
        events: { init: 'onInit' },
        handlers: {
          onInit: () => Promise.reject(new Error('init failed')),
          onClick: () => Promise.reject(new TransactionError('server-error', 'Server said no')),
        },
      }),
    );
    expect(shell.lastError.value?.message).toBe('init failed');
    tab?.form.getComponent('btn')?.fire('click');
    await tick();
    expect(shell.lastError.value?.message).toBe('Server said no');
  });

  it('leaves an error the script caught to the script', async () => {
    const manual = manualTransport();
    const caught: unknown[] = [];
    const { shell } = makeShell({ transport: manual.transport });
    const tab = await shell.open(
      'a',
      entry('a.A', {
        setup: (form) => ({
          onClick: async () => {
            try {
              await form.tx.call({ service: 's' });
            } catch (error) {
              caught.push(error);
            }
          },
        }),
      }),
    );
    tab?.form.getComponent('btn')?.fire('click');
    await tick();
    manual.settle(0, { status: { ok: false, code: 'bad', message: 'nope' } });
    await tick();
    expect(caught[0]).toBeInstanceOf(TransactionError);
    expect(shell.lastError.value).toBeNull();
  });

  it('does not show calls cut short by closing', async () => {
    const manual = manualTransport();
    const { shell } = makeShell({ transport: manual.transport });
    const tab = await shell.open('a', entry('a.A', { setup: (form) => ({ onClick: () => form.tx.call({ service: 's' }) }) }));
    tab?.form.getComponent('btn')?.fire('click');
    await tick();
    await shell.close(tab!.id);
    await tick();
    expect(shell.lastError.value).toBeNull();
  });

  it('survives an onError that throws', async () => {
    const shell = createShell({
      confirm: () => Promise.resolve(true),
      onError: () => {
        throw new Error('bad logger');
      },
      maxTabs: 1,
    });
    await shell.open('a', entry('a.A'));
    expect(await shell.open('b', entry('a.B'))).toBeUndefined();
    expect(shell.lastError.value).not.toBeNull();
  });
});

describe('popups', () => {
  const picker = (extra: EntryOptions = {}): FormEntry =>
    entry('a.Picker', {
      setup: (form) => ({ onClick: () => form.close({ empNo: form.params.code as string }) }),
      ...extra,
    });

  it('resolves the opener with the result, and the popup closes', async () => {
    const { shell } = makeShell();
    const tab = await shell.open('a', entry('a.A'));
    const result = tab!.form.context.open(picker(), { params: { code: 'E7' } });
    await tick();
    expect(shell.popups.value).toHaveLength(1);
    const popup = shell.popups.value[0]!;
    expect(popup.opener).toBe(tab!.form);
    expect(popup.title).toBe('a.Picker');
    expect(popup.form!.context.params.code).toBe('E7');
    popup.form!.getComponent('btn')?.fire('click');
    await expect(result).resolves.toEqual({ empNo: 'E7' });
    expect(shell.popups.value).toHaveLength(0);
    expect(popup.form!.state.value).toBe('closed');
    expect(tab!.form.state.value).toBe('active');
  });

  it('resolves undefined when cancelled, from the shell or from a plain close', async () => {
    const { shell } = makeShell();
    const tab = await shell.open('a', entry('a.A'));
    const first = tab!.form.context.open(picker());
    await tick();
    await expect(shell.closePopup(shell.popups.value[0]!.id)).resolves.toBe(true);
    await expect(first).resolves.toBeUndefined();
    const second = tab!.form.context.open(picker());
    await tick();
    await shell.popups.value[0]!.form!.close();
    await expect(second).resolves.toBeUndefined();
    await expect(shell.closePopup('nope')).resolves.toBe(false);
  });

  it('stacks popups, and each opener stays open', async () => {
    const { shell } = makeShell();
    const tab = await shell.open('a', entry('a.A'));
    const outer = tab!.form.context.open(picker({ setup: (form) => ({ onClick: async () => form.close(await form.open(picker())) }) }));
    await tick();
    const first = shell.popups.value[0]!;
    first.form!.getComponent('btn')?.fire('click');
    await tick();
    expect(shell.popups.value).toHaveLength(2);
    const second = shell.popups.value[1]!;
    expect(second.opener).toBe(first.form!);
    expect(first.form!.state.value).toBe('active');
    expect(tab!.form.state.value).toBe('active');
    second.form!.getComponent('btn')?.fire('click');
    await expect(outer).resolves.toEqual({ empNo: 'D1' });
    expect(shell.popups.value).toHaveLength(0);
  });

  it('closing the opener cancels its popups first, top down', async () => {
    const { shell } = makeShell();
    const order: string[] = [];
    const logging = (name: string): EntryOptions => ({
      events: { close: 'onClose' },
      setup: (form) => ({ onClose: () => void order.push(`${name}:${String(form.signal.aborted)}`) }),
    });
    const tab = await shell.open('a', entry('a.A', { events: { close: 'onClose' }, setup: () => ({ onClose: () => void order.push('tab') }) }));
    const one = tab!.form.context.open(entry('a.P1', logging('p1')));
    await tick();
    const two = shell.popups.value[0]!.form!.context.open(entry('a.P2', logging('p2')));
    await tick();
    expect(shell.popups.value).toHaveLength(2);
    await expect(shell.close(tab!.id)).resolves.toBe(false);
    await expect(tab!.form.close()).resolves.toBe(true);
    await expect(one).resolves.toBeUndefined();
    await expect(two).resolves.toBeUndefined();
    expect(order).toEqual(['p2:true', 'p1:true', 'tab']);
    expect(shell.popups.value).toHaveLength(0);
    expect(tab!.form.state.value).toBe('closed');
  });

  it('keeps the opener open if a popup vetoes its close', async () => {
    const { shell } = makeShell();
    const tab = await shell.open('a', entry('a.A'));
    const result = tab!.form.context.open(entry('a.P', { events: { beforeClose: 'onBeforeClose' }, handlers: { onBeforeClose: () => false } }));
    await tick();
    await expect(tab!.form.close()).resolves.toBe(false);
    expect(tab!.form.state.value).toBe('active');
    expect(shell.popups.value).toHaveLength(1);
    await expect(shell.closePopup(shell.popups.value[0]!.id)).resolves.toBe(false);
    expect(await Promise.race([result, tick().then(() => 'pending')])).toBe('pending');
  });

  it('gives a popup its own lifecycle, Datasets and veto', async () => {
    const { shell } = makeShell();
    const log: string[] = [];
    const tab = await shell.open('a', entry('a.A'));
    void tab!.form.context.open(
      entry('a.P', {
        events: { init: 'onInit', beforeClose: 'onBeforeClose', close: 'onClose' },
        handlers: {
          onInit: () => void log.push('init'),
          onBeforeClose: () => {
            log.push('before');
            return true;
          },
          onClose: () => void log.push('close'),
        },
      }),
    );
    await tick();
    const popup = shell.popups.value[0]!;
    expect(popup.form!.context.ds.ds).not.toBe(tab!.form.context.ds.ds);
    await expect(shell.closePopup(popup.id)).resolves.toBe(true);
    expect(log).toEqual(['init', 'before', 'close']);
  });

  it('aborts the pending calls of a cancelled popup', async () => {
    const manual = manualTransport();
    const { shell } = makeShell({ transport: manual.transport });
    const outcome: unknown[] = [];
    const tab = await shell.open('a', entry('a.A'));
    const result = tab!.form.context.open(
      entry('a.P', { setup: (form) => ({ onClick: () => void form.tx.call({ service: 'slow' }).catch((error: unknown) => outcome.push(error)) }) }),
    );
    await tick();
    shell.popups.value[0]!.form!.getComponent('btn')?.fire('click');
    await tick();
    expect(shell.busy.value).toBe(1);
    await shell.closePopup(shell.popups.value[0]!.id);
    await expect(result).resolves.toBeUndefined();
    expect(manual.signals[0]?.aborted).toBe(true);
    expect(outcome[0]).toMatchObject({ code: 'aborted' });
    expect(shell.busy.value).toBe(0);
    expect(shell.lastError.value).toBeNull();
  });

  it('rejects open outside a shell, with a clear message', async () => {
    const form = createForm(entry('a.A').definition);
    await expect(form.context.open(entry('a.P'))).rejects.toThrow(/wasn't created by a shell/);
  });

  it('rejects open from a form that is closing or closed', async () => {
    const { shell } = makeShell();
    const tab = await shell.open('a', entry('a.A'));
    await shell.close(tab!.id);
    await expect(tab!.form.context.open(entry('a.P'))).rejects.toThrow(/is closing/);
  });

  it('resolves undefined and reports when the popup script fails to load', async () => {
    const { shell } = makeShell();
    const tab = await shell.open('a', entry('a.A'));
    const broken: FormEntry = { definition: entry('a.P').definition, load: () => Promise.reject(new Error('gone')) };
    await expect(tab!.form.context.open(broken)).resolves.toBeUndefined();
    expect(shell.lastError.value?.message).toBe('gone');
    expect(shell.popups.value).toHaveLength(0);
  });

  it('lets a popup close itself during init', async () => {
    const { shell } = makeShell();
    const tab = await shell.open('a', entry('a.A'));
    const result = tab!.form.context.open(entry('a.P', { events: { init: 'onInit' }, setup: (form) => ({ onInit: () => void form.close({ v: 1 }) }) }));
    await expect(result).resolves.toEqual({ v: 1 });
    expect(shell.popups.value).toHaveLength(0);
  });

  it('ignores a result given to a form that is not a popup', async () => {
    const { shell } = makeShell();
    const tab = await shell.open('a', entry('a.A'));
    await expect(tab!.form.context.close({ x: 1 })).resolves.toBe(true);
    expect(shell.tabs.value).toHaveLength(0);
  });
});
