import type { FormEntry } from '@fw/core';
import type { Subscribable } from '../host/index.tsx';

import type { Shell as CoreShell, ShellPopup } from '@fw/core';

export type { ShellError, ShellPopup, ShellTab } from '@fw/core';

/** The view only subscribes to `popups`, so a test double can supply any subscribable. */
export type Shell = Omit<CoreShell, 'popups'> & {
  readonly popups: Subscribable<readonly ShellPopup[]>;
};

/** A popup whose form has finished loading. */
export type ReadyShellPopup = Extract<ShellPopup, { loading: false }>;

/** One menu entry. `load` fetches the form file, so a screen's code isn't loaded before it's opened. */
export interface MenuItem {
  key: string;
  title: string;
  load(): Promise<FormEntry>;
}
