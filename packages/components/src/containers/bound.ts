import type { ChangeResult } from '@fw/core';
import { useState } from 'react';

/**
 * State for a prop the user can change. A change shows only after `write` accepts it, and
 * `onCommitted` (for the matching event) runs only then. A refused write leaves the value as it was,
 * and an async one leaves it as it was until the answer comes. Props that change from outside
 * (a binding or an expression) replace the state.
 */
export function useWrittenState<T>(
  prop: string,
  value: T,
  write: (prop: string, value: unknown) => ChangeResult,
): [T, (next: T, onCommitted?: () => void) => void] {
  const [local, setLocal] = useState(value);
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setLocal(value);
  }
  const set = (next: T, onCommitted?: () => void): void => {
    const done = (): void => {
      setLocal(next);
      onCommitted?.();
    };
    const result = write(prop, next);
    if (result instanceof Promise) {
      void result.then(
        (ok) => {
          if (ok) done();
        },
        () => {},
      );
    } else if (result) done();
  };
  return [local, set];
}
