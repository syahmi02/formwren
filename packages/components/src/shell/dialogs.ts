import type { Subscribable } from '../host/index.tsx';

export interface ConfirmRequest {
  readonly message: string;
  answer(yes: boolean): void;
}

/**
 * The bridge between the shell's `confirm(message)` option, which is a promise, and the confirm dialog, which
 * is React. Pass `confirm` to `createShell` and `dialogs` to `AppShell`. Requests queue, and the dialog shows one at a time.
 */
export interface ShellDialogs {
  confirm(message: string): Promise<boolean>;
  readonly request: Subscribable<ConfirmRequest | null>;
}

export function createShellDialogs(): ShellDialogs {
  const queue: ConfirmRequest[] = [];
  const listeners = new Set<(value: ConfirmRequest | null) => void>();
  const notify = (): void => {
    const head = queue[0] ?? null;
    for (const listener of [...listeners]) listener(head);
  };
  return {
    confirm(message) {
      return new Promise<boolean>((resolve) => {
        const request: ConfirmRequest = {
          message,
          answer(yes) {
            const at = queue.indexOf(request);
            if (at < 0) return;
            queue.splice(at, 1);
            notify();
            resolve(yes);
          },
        };
        queue.push(request);
        notify();
      });
    },
    request: {
      peek: () => queue[0] ?? null,
      subscribe(fn) {
        listeners.add(fn);
        fn(queue[0] ?? null);
        return () => {
          listeners.delete(fn);
        };
      },
    },
  };
}
