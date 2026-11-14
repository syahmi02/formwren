import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { Subscribable } from '../host/index.tsx';

/**
 * Reads a part of a signal as a primitive, so the component re-renders only when that part changes. For example
 * one tab asks "am I the active one", and the others stay still when the active tab moves.
 */
export function useSignalSelect<T, R extends string | number | boolean | null>(source: Subscribable<T>, select: (value: T) => R): R {
  const subscribe = useCallback(
    (notify: () => void) => {
      let first = true;
      let last = select(source.peek());
      return source.subscribe((value) => {
        if (first) {
          first = false;
          return;
        }
        const next = select(value);
        if (next !== last) {
          last = next;
          notify();
        }
      });
    },
    [source, select],
  );
  return useSyncExternalStore(subscribe, () => select(source.peek()));
}

/** True once `on` has been true for `delayMs` without a break. Turns false at once. */
export function useDelayedFlag(on: boolean, delayMs: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!on) {
      setShown(false);
      return undefined;
    }
    const timer = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(timer);
  }, [on, delayMs]);
  return on && shown;
}

/** What the error dialog shows: the message only, never a stack. */
export function plainErrorMessage(error: unknown): string {
  const message = error && typeof error === 'object' ? (error as { message?: unknown }).message : undefined;
  const raw = typeof error === 'string' ? error : typeof message === 'string' ? message : '';
  const text = raw.trim();
  if (text === '') return 'Something went wrong. Try again, and tell the administrator if it keeps happening.';
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}
