import { describe, expect, it } from 'vitest';
import { createShell, defineForm, type FormDefinition, type FormEntry, type FormHandler, type Shell } from '../src/index.ts';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function entry(id: string, events: Record<string, string> = {}, handlers: Record<string, FormHandler> = {}): FormEntry {
  const definition: FormDefinition = { formatVersion: 1, id, events, components: [] };
  return { definition, load: () => Promise.resolve(defineForm(() => handlers)) };
}

function makeShell(): { shell: Shell; errors: unknown[] } {
  const errors: unknown[] = [];
  const shell = createShell({ confirm: () => Promise.resolve(true), onError: (error) => errors.push(error) });
  return { shell, errors };
}

/** A popup whose init waits for the test. */
function slowPopup(): { entry: FormEntry; finish: () => void } {
  let finish = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { finish: () => finish(), entry: entry('a.Slow', { init: 'onInit' }, { onInit: () => gate }) };
}

describe('popups are modal from the start', () => {
  it('lists the popup at once, as loading, and clears the flag after init', async () => {
    const { shell } = makeShell();
    const tab = await shell.open('a', entry('a.A'));
    const slow = slowPopup();
    const result = tab!.form.context.open(slow.entry);
    expect(shell.popups.value).toHaveLength(1);
    expect(shell.popups.value[0]).toMatchObject({ loading: true, title: 'a.Slow', opener: tab!.form, form: null });
    await tick();
    expect(shell.popups.value[0]?.loading).toBe(true);
    expect(shell.popups.value[0]?.form).not.toBeNull();
    slow.finish();
    await tick();
    expect(shell.popups.value[0]?.loading).toBe(false);
    await shell.closePopup(shell.popups.value[0]!.id);
    await expect(result).resolves.toBeUndefined();
  });

  it('cancels a popup closed while its script is still loading, and never starts it', async () => {
    const { shell } = makeShell();
    const tab = await shell.open('a', entry('a.A'));
    let release = (): void => undefined;
    const loaded = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    const slowLoad: FormEntry = {
      definition: { formatVersion: 1, id: 'a.SlowLoad', events: { init: 'onInit' }, components: [] },
      load: () => loaded.then(() => defineForm(() => ({ onInit: () => void (started = true) }))),
    };
    const result = tab!.form.context.open(slowLoad);
    expect(shell.popups.value[0]).toMatchObject({ loading: true, form: null });
    await expect(shell.closePopup(shell.popups.value[0]!.id)).resolves.toBe(true);
    expect(shell.popups.value).toHaveLength(0);
    await expect(result).resolves.toBeUndefined();
    release();
    await tick();
    expect(started).toBe(false);
    expect(shell.popups.value).toHaveLength(0);
  });

  it('refuses open, activate and close while a popup exists', async () => {
    const { shell } = makeShell();
    const a = await shell.open('a', entry('a.A'));
    const b = await shell.open('b', entry('a.B'));
    const slow = slowPopup();
    void b!.form.context.open(slow.entry);
    expect(await shell.open('c', entry('a.C'))).toBeUndefined();
    shell.activate(a!.id);
    expect(shell.activeId.value).toBe(b!.id);
    await expect(shell.close(b!.id)).resolves.toBe(false);
    expect(shell.tabs.value).toHaveLength(2);
    slow.finish();
    await tick();
    await shell.closePopup(shell.popups.value[0]!.id);
    shell.activate(a!.id);
    expect(shell.activeId.value).toBe(a!.id);
  });

  it('removes the entry and resolves undefined when loading fails', async () => {
    const { shell } = makeShell();
    const tab = await shell.open('a', entry('a.A'));
    const broken: FormEntry = { definition: entry('a.P').definition, load: () => Promise.reject(new Error('gone')) };
    const result = tab!.form.context.open(broken);
    expect(shell.popups.value[0]?.loading).toBe(true);
    await expect(result).resolves.toBeUndefined();
    expect(shell.popups.value).toHaveLength(0);
  });

  it('cancels a popup whose script is still loading when the opener closes', async () => {
    const { shell } = makeShell();
    const tab = await shell.open('a', entry('a.A'));
    let release = (): void => undefined;
    const late: FormEntry = {
      definition: entry('a.P').definition,
      load: () =>
        new Promise((resolve) => {
          release = () => resolve(defineForm(() => ({})));
        }),
    };
    const result = tab!.form.context.open(late);
    expect(shell.popups.value[0]?.form).toBeNull();
    await expect(tab!.form.close()).resolves.toBe(true);
    await expect(result).resolves.toBeUndefined();
    expect(shell.popups.value).toHaveLength(0);
    release();
    await tick();
    expect(shell.popups.value).toHaveLength(0);
  });

  it('cancels a popup that is running init when the opener closes', async () => {
    const { shell } = makeShell();
    const tab = await shell.open('a', entry('a.A'));
    const slow = slowPopup();
    const result = tab!.form.context.open(slow.entry);
    await tick();
    await expect(tab!.form.close()).resolves.toBe(true);
    await expect(result).resolves.toBeUndefined();
    slow.finish();
    await tick();
    expect(shell.popups.value).toHaveLength(0);
  });
});

describe('shell.reportError', () => {
  it('shows an error that belongs to no form', () => {
    const { shell, errors } = makeShell();
    const error = new Error('Menu item failed to load');
    shell.reportError(error, 'menu');
    expect(shell.lastError.value).toMatchObject({ message: 'Menu item failed to load', where: 'menu', formId: '', error });
    expect(errors).toEqual([error]);
  });
});
