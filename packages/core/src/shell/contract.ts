/**
 * The shared contract for the shell. See docs/plans/step-5.md.
 * Others build against these types at the same time, so changes must be additive and reported.
 */
import type { ReadonlySignal } from '@preact/signals-core';
import type { FormEntry, FormInstance, FormShape } from '../form/contract.ts';
import type { Transport } from '../tx/contract.ts';

export interface ShellTab {
  readonly id: string;
  /** What identifies the screen, such as a menu item id. Opening the same key again activates this tab. */
  readonly key: string;
  readonly title: string;
  readonly form: FormInstance;
}

interface ShellPopupBase {
  readonly id: string;
  readonly title: string;
  /** The form that opened it. It stays open underneath. */
  readonly opener: FormInstance;
}

/**
 * A popup is listed the moment `open` starts, while its script loads and `init` runs, so it blocks
 * everything else from the start. Draw a modal "Loading..." for `loading: true`, and the form after.
 * `form` is null only while the script is still loading.
 */
export type ShellPopup =
  | (ShellPopupBase & { readonly loading: true; readonly form: FormInstance | null })
  | (ShellPopupBase & { readonly loading: false; readonly form: FormInstance });

/** An error no script handled, ready for the common error dialog. */
export interface ShellError {
  /** Plain text, never a stack trace. */
  readonly message: string;
  readonly error: unknown;
  /** Where it happened, such as `btnSave.click`. */
  readonly where: string;
  /** The `id` of the form file it came from, or empty for the shell itself. */
  readonly formId: string;
}

export interface ShellOptions {
  /** Every form's calls go through it, counted in `busy`. */
  transport?: Transport;
  /** Most tabs open at once. Default 10. */
  maxTabs?: number;
  /** Asks the user a yes/no question. Only a true answer proceeds. */
  confirm(message: string): Promise<boolean>;
  /** Called for each error no script handled, as well as `lastError` being set. Defaults to `console.error`. */
  onError?: (error: unknown, where: string) => void;
}

export interface ShellOpenOptions<S extends FormShape = FormShape> {
  /** The tab's title. Defaults to the form file's `title`, then `key`. */
  title?: string;
  params?: Partial<S['params']>;
}

export interface Shell {
  readonly tabs: ReadonlySignal<readonly ShellTab[]>;
  /** The active tab's id, or null with no tabs. */
  readonly activeId: ReadonlySignal<string | null>;
  readonly activeTab: ReadonlySignal<ShellTab | undefined>;
  /** Open popups from every tab, bottom first. Only the last is interactive. */
  readonly popups: ReadonlySignal<readonly ShellPopup[]>;
  /** Calls in flight from every tab and popup. 0 is idle. */
  readonly busy: ReadonlySignal<number>;
  readonly lastError: ReadonlySignal<ShellError | null>;
  readonly maxTabs: number;
  /**
   * Opens a form in a new active tab, or activates the tab that has this key (its `params` and
   * `title` are then ignored). Resolves with the tab, or undefined if it wasn't opened: at the tab
   * limit, or the script failed to load. Both set `lastError`. Refused (undefined, no message) while
   * any popup is open.
   */
  open<S extends FormShape = FormShape>(key: string, entry: FormEntry<S>, options?: ShellOpenOptions<S>): Promise<ShellTab | undefined>;
  /** Makes a tab active. The form that was active deactivates. An unknown id does nothing, and so does any call while a popup is open. */
  activate(id: string): void;
  /**
   * Closes a tab. With unsaved changes it asks `confirm` first, then the form's `close()` can still
   * veto. Resolves to whether it closed, which is false while any popup is open. The nearest remaining tab becomes active.
   */
  close(id: string): Promise<boolean>;
  /** Cancels a popup, as Esc or its close button does. Its opener's `open` resolves with `undefined`. Resolves to whether it closed. */
  closePopup(id: string): Promise<boolean>;
  /** True if any tab's form has unsaved changes. For `beforeunload`. */
  hasUnsavedChanges(): boolean;
  dismissError(): void;
  /** Sends an error that belongs to no form, such as a menu item that failed to load, to `lastError` and `onError`. */
  reportError(error: unknown, where: string): void;
}
