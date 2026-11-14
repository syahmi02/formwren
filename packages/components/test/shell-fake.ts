/**
 * A small double of `createShell` from @fw/core, which follows packages/core/src/shell/contract.ts with real
 * signals: tabs open once per key, a tab limit, a confirm before closing with unsaved changes, a veto from the
 * form, popups and the busy count. It is not the real shell, which has its own tests in core.
 */
import type { ComponentDefinition, FormEntry, FormInstance, Shell, ShellError, ShellPopup, ShellTab } from '@fw/core';
import { batch, computed, signal } from '@preact/signals-core';
import { createFakeForm, def, type FakeForm } from './support/fake-form.ts';

export interface FakeTabForm {
  fake: FakeForm;
  form: FormInstance;
  dirty: boolean;
  /** What `close()` answers. False is a veto. */
  allowClose: boolean;
  closed: boolean;
  events: string[];
}

export function fakeScreenForm(components: ComponentDefinition[] = [def('field', 'Field')]): FakeTabForm {
  const fake = createFakeForm(components, { size: { width: 320, height: 160 } });
  const state: FakeTabForm = { fake, form: fake.form, dirty: false, allowClose: true, closed: false, events: [] };
  Object.assign(fake.form, {
    hasUnsavedChanges: () => state.dirty,
    activate: () => state.events.push('activate'),
    deactivate: () => state.events.push('deactivate'),
    close: async () => {
      if (!state.allowClose) return false;
      state.closed = true;
      return true;
    },
  });
  return state;
}

export interface FakeShell {
  shell: Shell;
  forms: Map<string, FakeTabForm>;
  confirms: string[];
  /** What the fake `confirm` answers next. */
  answer: boolean;
  setBusy(count: number): void;
  fail(message: string): void;
  /** Opens a popup over `opener`. Resolves with the popup's result, like `form.open`. */
  openPopup(title: string, opener?: FormInstance, loading?: boolean): { popup: ShellPopup; result: Promise<unknown> };
  /** Like `form.close(result)` called in the top popup. */
  closeTopPopup(result: unknown): void;
  /** Marks a loading popup as ready, which core does when the popup's init finishes. */
  finishLoading(id: string): void;
  /** Like core while a popup's script is still loading: closePopup says no. */
  refuseWhileLoading: boolean;
  reported: { error: unknown; where: string }[];
}

export function createFakeShell(options: { maxTabs?: number; components?: ComponentDefinition[]; confirm?: (message: string) => Promise<boolean> } = {}): FakeShell {
  const maxTabs = options.maxTabs ?? 10;
  const confirmFn = options.confirm ?? (() => Promise.resolve(self.answer));
  const tabs = signal<readonly ShellTab[]>([]);
  const activeId = signal<string | null>(null);
  const popups = signal<readonly ShellPopup[]>([]);
  const busy = signal(0);
  const lastError = signal<ShellError | null>(null);
  const forms = new Map<string, FakeTabForm>();
  const resolvers = new Map<string, (result: unknown) => void>();
  let counter = 0;

  const fail = (message: string): void => {
    lastError.value = { message, error: new Error(message), where: 'test', formId: '' };
  };
  const self: FakeShell = {
    shell: undefined as unknown as Shell,
    forms,
    confirms: [],
    answer: true,
    setBusy: (count) => {
      busy.value = count;
    },
    fail,
    refuseWhileLoading: false,
    reported: [],
    finishLoading(id) {
      popups.value = popups.peek().map((p) => (p.id === id ? ({ ...p, loading: false } as ShellPopup) : p));
    },
    openPopup(title, opener, loading = false) {
      const state = fakeScreenForm([def('popField', 'Field')]);
      const id = `p${++counter}`;
      const popup = { id, title, form: state.form, opener: opener ?? tabs.peek().at(-1)?.form ?? state.form, loading } as ShellPopup;
      forms.set(id, state);
      const result = new Promise<unknown>((resolve) => resolvers.set(id, resolve));
      popups.value = [...popups.peek(), popup];
      return { popup, result };
    },
    closeTopPopup(result) {
      const top = popups.peek().at(-1);
      if (!top) return;
      popups.value = popups.peek().filter((p) => p !== top);
      resolvers.get(top.id)?.(result);
    },
  };

  const shell: Shell & { reportError(error: unknown, where: string): void } = {
    reportError: (error, where) => {
      self.reported.push({ error, where });
      fail(error instanceof Error ? error.message : String(error));
    },
    tabs,
    activeId,
    activeTab: computed(() => tabs.value.find((t) => t.id === activeId.value)),
    popups,
    busy,
    lastError,
    maxTabs,
    async open(key, entry: FormEntry, openOptions) {
      const existing = tabs.peek().find((t) => t.key === key);
      if (existing) {
        shell.activate(existing.id);
        return existing;
      }
      if (tabs.peek().length >= maxTabs) {
        fail(`At most ${maxTabs} screens can be open. Close one first.`);
        return undefined;
      }
      const state = fakeScreenForm(options.components);
      const tab: ShellTab = { id: `t${++counter}`, key, title: openOptions?.title ?? entry.definition.title ?? key, form: state.form };
      forms.set(tab.id, state);
      batch(() => {
        tabs.value = [...tabs.peek(), tab];
        shell.activate(tab.id);
      });
      return tab;
    },
    activate(id) {
      if (!tabs.peek().some((t) => t.id === id) || activeId.peek() === id) return;
      const before = activeId.peek();
      if (before) forms.get(before)?.events.push('deactivate');
      activeId.value = id;
      forms.get(id)?.events.push('activate');
    },
    async close(id) {
      const tab = tabs.peek().find((t) => t.id === id);
      const state = forms.get(id);
      if (!tab || !state) return false;
      if (state.dirty) {
        const message = `Discard unsaved changes in ${tab.title}?`;
        self.confirms.push(message);
        if (!(await confirmFn(message))) return false;
      }
      if (!(await tab.form.close())) return false;
      const rest = tabs.peek().filter((t) => t.id !== id);
      batch(() => {
        tabs.value = rest;
        if (activeId.peek() === id) activeId.value = rest.at(-1)?.id ?? null;
      });
      return true;
    },
    async closePopup(id) {
      const popup = popups.peek().find((p) => p.id === id);
      if (!popup) return false;
      if (self.refuseWhileLoading && (popup as { loading?: boolean }).loading) return false;
      popups.value = popups.peek().filter((p) => p !== popup);
      resolvers.get(id)?.(undefined);
      return true;
    },
    hasUnsavedChanges: () => [...forms.values()].some((f) => f.dirty),
    dismissError() {
      lastError.value = null;
    },
  };
  self.shell = shell;
  return self;
}
