import { valuesEqual, type CellValue, type ChangeResult, type ColumnType, type ComponentHandle } from '@fw/core';
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type Ref } from 'react';

export const GENERIC_INVALID = "This value isn't valid";

export interface Option {
  value: unknown;
  label: string;
}

export function toText(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

/** Calls `done` with the outcome, synchronously when `write` was synchronous. A rejection counts as false. */
export function settle(result: ChangeResult, done: (ok: boolean) => void): void {
  if (typeof result === 'boolean') done(result);
  else result.then(done, () => done(false));
}

/** Writes a selection straight away. A false result leaves `props.value` as it was. */
export function commitSelection(
  write: (prop: string, value: unknown, rowId?: number) => ChangeResult,
  fire: (event: string, detail?: unknown) => void,
  value: unknown,
  onRefused?: () => void,
  onSettled?: () => void,
): void {
  let result: ChangeResult;
  try {
    result = write('value', value);
  } catch {
    result = false;
  }
  settle(result, (ok) => {
    onSettled?.();
    if (ok) fire('change', { value });
    else onRefused?.();
  });
}

/** Makes `handleRef.focus()` focus whatever `focus` returns. */
export function useFocusHandle(handleRef: Ref<ComponentHandle>, focus: () => void): void {
  const latest = useRef(focus);
  latest.current = focus;
  useImperativeHandle(handleRef, () => ({ focus: () => latest.current() }), []);
}

export function readOptions(raw: unknown): Option[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((o: { value?: unknown; label?: unknown }) => ({ value: o?.value, label: toText(o?.label ?? o?.value) }));
}

/** A label for a field that has none, so it still has an accessible name. */
export function fallbackName(props: { label?: string; placeholder?: string }, id: string): string | undefined {
  return props.label ? undefined : props.placeholder || id;
}

export interface DraftOptions {
  value: unknown;
  boundRow?: number | null;
  boundRevision?: number;
  boundType?: ColumnType;
  /** The text the field shows when it is neither focused nor edited. Defaults to the value as text. */
  display?: (value: unknown) => string;
  write(prop: string, value: unknown, rowId?: number): ChangeResult;
  accepts(prop: string, value: unknown): boolean;
  fire(event: string, detail?: unknown): void;
  design: boolean;
  readOnly?: boolean;
  disabled?: boolean;
  /** Check `accepts` and `check` first, and keep text that fails them on screen marked invalid. */
  checkFit: boolean;
  /** Why the text is out of range, or null. Runs after `accepts`. */
  check?: (text: string) => string | null;
  /** Turns committed text into the value to write. Defaults to the text. */
  toWrite?: (text: string) => unknown;
  /** Enter commits (everything except TextArea). */
  commitOnEnter: boolean;
  /** Called on Enter after a successful commit, or when there was nothing to commit. */
  onSubmit?: () => void;
}

interface Slot {
  text: string;
  row: number | null;
  /** The bound value when the first key was typed. */
  before: unknown;
}

interface Rejected {
  text: string;
  message: string;
  row: number | null;
  revision: number;
  value: unknown;
}

type Trigger = 'blur' | 'enter' | 'row';

/**
 * Shared by the text-like inputs. Only typing creates a draft, and a draft belongs to the row it
 * was typed on. It commits on blur or Enter, or straight away if the row changes. An untouched field
 * always shows the bound value. Text that doesn't fit stays on screen marked invalid until the next
 * edit, Esc, a new row, or a new bound value or revision.
 */
export function useDraft(o: DraftOptions) {
  const row = o.boundRow ?? null;
  const revision = o.boundRevision ?? 0;
  const [edited, setEditedState] = useState<Slot | null>(null);
  const [pending, setPending] = useState<(Slot & { id: number }) | null>(null);
  const [rejected, setRejected] = useState<Rejected | null>(null);
  const [focused, setFocused] = useState(false);
  const [committed, setCommitted] = useState<{ row: number | null; before: unknown } | null>(null);
  const [restores, setRestores] = useState(0);
  const latest = useRef(o);
  latest.current = o;
  const editedRef = useRef<Slot | null>(null);
  const pendingId = useRef(0);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const setEdited = useCallback((slot: Slot | null) => {
    editedRef.current = slot;
    setEditedState(slot);
  }, []);

  const commit = useCallback(
    (trigger: Trigger, done?: (ok: boolean) => void) => {
      const L = latest.current;
      const slot = editedRef.current;
      if (!slot) {
        done?.(true);
        return;
      }
      setEdited(null);
      if (L.design || L.readOnly || L.disabled) return;
      const currentRow = L.boundRow ?? null;
      const { text } = slot;
      if (slot.row === currentRow && text === toText(L.value)) {
        done?.(true);
        return;
      }
      const toWrite = L.toWrite ? L.toWrite(text) : text;
      if (L.checkFit) {
        let message: string | null = null;
        try {
          message = L.accepts('value', toWrite) ? (L.check?.(text) ?? null) : GENERIC_INVALID;
        } catch {
          message = GENERIC_INVALID;
        }
        if (message !== null) {
          if (trigger !== 'row') {
            setRejected({ text, message, row: slot.row, revision: L.boundRevision ?? 0, value: L.value });
          }
          done?.(false);
          return;
        }
      }
      const id = ++pendingId.current;
      setPending({ ...slot, id });
      let result: ChangeResult;
      try {
        result = slot.row === null ? L.write('value', toWrite) : L.write('value', toWrite, slot.row);
      } catch {
        result = false;
      }
      settle(result, (ok) => {
        setPending((p) => (p?.id === id ? null : p));
        if (!mounted.current) return;
        if (ok) setCommitted({ row: slot.row, before: slot.before });
        done?.(ok);
      });
    },
    [setEdited],
  );

  // The row moved under an edited draft: it goes to the row it was typed on, and the field shows the new row.
  useEffect(() => {
    if (editedRef.current && editedRef.current.row !== row) commit('row');
  }, [row, commit]);

  // After a successful write, `change` fires only if the stored value really differs from before.
  useEffect(() => {
    if (!committed) return;
    setCommitted(null);
    const L = latest.current;
    if ((L.boundRow ?? null) !== committed.row) return;
    let same = Object.is(L.value, committed.before);
    if (!same && L.boundType) {
      try {
        same = valuesEqual(L.boundType, L.value as CellValue, committed.before as CellValue);
      } catch {
        same = false;
      }
    }
    if (!same) L.fire('change', { value: L.value });
  }, [committed]);

  const ed = edited && edited.row === row ? edited : null;
  const pend = pending && pending.row === row ? pending : null;
  const rej =
    rejected && rejected.row === row && rejected.revision === revision && Object.is(rejected.value, o.value) ? rejected : null;
  const shown = focused ? toText(o.value) : o.display ? o.display(o.value) : toText(o.value);
  const text = ed?.text ?? pend?.text ?? rej?.text ?? shown;

  return {
    text,
    invalid: rej !== null,
    message: rej?.message,
    /** Changes whenever the draft was thrown away, so a control with its own inner state can reset. */
    restores,
    /** Writes straight away, for a choice made in a popup rather than typed. */
    commitText(next: string) {
      if (latest.current.design || latest.current.readOnly) return;
      setRejected(null);
      setEdited({ text: next, row, before: latest.current.value });
      commit('enter');
    },
    /** Drops the draft and marks the field invalid, for input that can't become a value at all. */
    markInvalid(message: string) {
      setEdited(null);
      setPending(null);
      setRejected({ text, message, row, revision, value: latest.current.value });
    },
    handlers: {
      onFocus: () => setFocused(true),
      onChange: (next: string) => {
        const L = latest.current;
        if (L.design || L.readOnly || L.disabled) return;
        if (editedRef.current && editedRef.current.row !== (L.boundRow ?? null)) commit('row');
        const cur = editedRef.current;
        setRejected(null);
        setPending(null);
        setEdited({ text: next, row: L.boundRow ?? null, before: cur ? cur.before : L.value });
      },
      onBlur: () => {
        setFocused(false);
        commit('blur');
      },
      onKeyDown: (e: KeyboardEvent) => {
        const L = latest.current;
        if (L.design) return;
        if (e.key === 'Escape') {
          if (editedRef.current || rej) e.stopPropagation();
          setEdited(null);
          setPending(null);
          setRejected(null);
          setRestores((n) => n + 1);
        } else if (e.key === 'Enter' && L.commitOnEnter) {
          commit('enter', (ok) => {
            if (ok) latest.current.onSubmit?.();
          });
        }
      },
    },
  };
}
