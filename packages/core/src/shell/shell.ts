import { batch, computed, signal } from '@preact/signals-core';
import { createForm } from '../form/runtime.ts';
import type { FormEntry, FormHost, FormInstance, FormShape } from '../form/contract.ts';
import type { DsxResponse, Transport } from '../tx/contract.ts';
import type { Shell, ShellError, ShellOpenOptions, ShellOptions, ShellPopup, ShellTab } from './contract.ts';

export const DEFAULT_MAX_TABS = 10;

function plainMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return text.trim() === '' ? 'Something went wrong.' : text;
}

export function createShell(options: ShellOptions): Shell {
  const maxTabs = options.maxTabs ?? DEFAULT_MAX_TABS;
  const tabs = signal<readonly ShellTab[]>([]);
  const activeId = signal<string | null>(null);
  const popups = signal<readonly ShellPopup[]>([]);
  const busy = signal(0);
  const lastError = signal<ShellError | null>(null);
  const activeTab = computed(() => tabs.value.find((tab) => tab.id === activeId.value));
  const pendingKeys = new Map<string, Promise<ShellTab | undefined>>();
  const closingTabs = new Map<string, Promise<boolean>>();
  let counter = 0;

  const report = (error: unknown, where: string, formId = ''): void => {
    lastError.value = { message: plainMessage(error), error, where, formId };
    try {
      if (options.onError) options.onError(error, where);
      else console.error(`[shell] ${where}`, error);
    } catch {
      // A broken error handler must not break the shell.
    }
  };

  // Every form's calls go through here, so they are counted in one place.
  const inner = options.transport;
  const transport: Transport | undefined = inner && {
    send(request, sendOptions) {
      busy.value++;
      let counted = true;
      const done = (): void => {
        if (!counted) return;
        counted = false;
        busy.value--;
        sendOptions.signal.removeEventListener('abort', done);
      };
      // A call that was cancelled is over for the user, even if the transport is slow to say so.
      sendOptions.signal.addEventListener('abort', done, { once: true });
      let pending: Promise<DsxResponse>;
      try {
        pending = Promise.resolve(inner.send(request, sendOptions));
      } catch (error) {
        done();
        return Promise.reject(error);
      }
      return pending.then(
        (response) => {
          done();
          return response;
        },
        (error: unknown) => {
          done();
          throw error;
        },
      );
    },
  };

  const setActive = (id: string | null): void => {
    const previous = activeId.peek();
    if (previous === id) return;
    batch(() => {
      tabs.peek().find((tab) => tab.id === previous)?.form.deactivate();
      activeId.value = id;
      tabs.peek().find((tab) => tab.id === id)?.form.activate();
    });
  };

  const removeTab = (id: string): void => {
    const list = tabs.peek();
    const index = list.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const next = list.filter((tab) => tab.id !== id);
    batch(() => {
      tabs.value = next;
      if (activeId.peek() === id) {
        const pick = next[Math.min(index, next.length - 1)];
        activeId.value = pick?.id ?? null;
        pick?.form.activate();
      }
    });
  };

  const cancelled = new Set<string>();
  const resolvers = new Map<string, (result: unknown) => void>();
  const patchPopup = (id: string, change: Partial<{ form: FormInstance | null; loading: boolean }>): void => {
    popups.value = popups.peek().map((popup) => (popup.id === id ? ({ ...popup, ...change } as ShellPopup) : popup));
  };
  const dropPopup = (id: string): void => {
    popups.value = popups.peek().filter((popup) => popup.id !== id);
  };

  const host: FormHost = {
    openPopup(opener, entry, popupOptions) {
      return new Promise<unknown>((resolve) => {
        const id = `popup-${++counter}`;
        const finish = (result: unknown): void => {
          resolvers.delete(id);
          cancelled.delete(id);
          dropPopup(id);
          resolve(result);
        };
        resolvers.set(id, finish);
        popups.value = [
          ...popups.peek(),
          { id, title: popupOptions.title ?? entry.definition.title ?? entry.definition.id, opener, loading: true, form: null },
        ];
        void (async () => {
          let form: FormInstance;
          try {
            const module = await entry.load();
            // Cancelled while the script loaded. `finish` has already run, so the popup must never start.
            if (cancelled.has(id) || !resolvers.has(id)) {
              cancelled.delete(id);
              return;
            }
            const created = createForm(entry.definition, {
              module,
              ...(popupOptions.params ? { params: popupOptions.params } : {}),
              ...(transport ? { transport } : {}),
              host,
              onError: (error, where) => report(error, where, entry.definition.id),
              onClosed: (result) => finish(result),
            });
            form = created as unknown as FormInstance;
            patchPopup(id, { form });
            await created.init();
          } catch (error) {
            report(error, `open ${entry.definition.id}`, entry.definition.id);
            finish(undefined);
            return;
          }
          if (form.state.value === 'closed') return;
          // The opener may have gone while this was loading.
          if (opener.state.value === 'closing' || opener.state.value === 'closed') {
            await form.close();
            finish(undefined);
            return;
          }
          patchPopup(id, { loading: false });
        })();
      });
    },

    async closePopups(opener) {
      const mine = popups.peek().filter((popup) => popup.opener === opener);
      for (const popup of mine.reverse()) {
        if (popup.form) {
          if (!(await popup.form.close())) return false;
        } else {
          // Still loading the script: there is no form yet, so just stop it from starting.
          cancelled.add(popup.id);
          resolvers.get(popup.id)?.(undefined);
        }
      }
      return true;
    },
  };

  async function openTab<S extends FormShape>(key: string, entry: FormEntry<S>, openOptions: ShellOpenOptions<S>): Promise<ShellTab | undefined> {
    const id = `tab-${++counter}`;
    let form: FormInstance;
    try {
      const module = await entry.load();
      const created = createForm<S>(entry.definition, {
        module,
        ...(openOptions.params ? { params: openOptions.params } : {}),
        ...(transport ? { transport } : {}),
        host,
        onError: (error, where) => report(error, where, entry.definition.id),
        onClosed: () => removeTab(id),
      });
      form = created as unknown as FormInstance;
      await created.init();
    } catch (error) {
      report(error, `open ${key}`, entry.definition.id);
      return undefined;
    }
    if (form.state.value === 'closed') return undefined;
    const tab: ShellTab = { id, key, title: openOptions.title ?? entry.definition.title ?? key, form };
    batch(() => {
      tabs.value = [...tabs.peek(), tab];
      setActive(id);
    });
    return tab;
  }

  return {
    tabs,
    activeId,
    activeTab,
    popups,
    busy,
    lastError,
    maxTabs,

    async open(key, entry, openOptions = {}) {
      if (popups.peek().length > 0) return undefined;
      const existing = tabs.peek().find((tab) => tab.key === key);
      if (existing) {
        setActive(existing.id);
        return existing;
      }
      const pending = pendingKeys.get(key);
      if (pending) {
        const tab = await pending;
        if (tab) setActive(tab.id);
        return tab;
      }
      if (tabs.peek().length + pendingKeys.size >= maxTabs) {
        report(new Error(`Too many tabs are open (${maxTabs} at most). Close one to open another.`), 'open');
        return undefined;
      }
      const opening = openTab(key, entry, openOptions);
      pendingKeys.set(key, opening);
      try {
        return await opening;
      } finally {
        pendingKeys.delete(key);
      }
    },

    activate(id) {
      if (popups.peek().length > 0) return;
      if (tabs.peek().some((tab) => tab.id === id)) setActive(id);
    },

    close(id) {
      if (popups.peek().length > 0) return Promise.resolve(false);
      const running = closingTabs.get(id);
      if (running) return running;
      const tab = tabs.peek().find((candidate) => candidate.id === id);
      if (!tab) return Promise.resolve(false);
      const closing = (async () => {
        if (tab.form.hasUnsavedChanges()) {
          let discard = false;
          try {
            discard = await options.confirm(`Discard unsaved changes in ${tab.title}?`);
          } catch (error) {
            report(error, 'confirm', tab.form.id);
          }
          if (!discard) return false;
        }
        if (!(await tab.form.close())) return false;
        removeTab(id);
        return true;
      })().finally(() => {
        closingTabs.delete(id);
      });
      closingTabs.set(id, closing);
      return closing;
    },

    closePopup(id) {
      const popup = popups.peek().find((candidate) => candidate.id === id);
      if (!popup) return Promise.resolve(false);
      if (popup.form) return popup.form.close();
      // Still loading the script: cancel it now, the same way closing the opener does.
      cancelled.add(popup.id);
      resolvers.get(popup.id)?.(undefined);
      return Promise.resolve(true);
    },

    hasUnsavedChanges: () => tabs.peek().some((tab) => tab.form.hasUnsavedChanges()),

    dismissError() {
      lastError.value = null;
    },

    reportError: (error, where) => report(error, where),
  };
}
