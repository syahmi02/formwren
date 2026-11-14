import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';

/** The label, the control and the help text of one inspector row. */
export function Field({ label, description, error, children, htmlFor, id }: { label: string; description?: string; error?: string | null; children: (ids: { inputId: string; describedBy: string | undefined }) => ReactNode; htmlFor?: string; id?: string }): ReactElement {
  const generated = useId();
  const inputId = htmlFor ?? `${generated}-input`;
  const helpId = `${generated}-help`;
  const errorId = `${generated}-error`;
  const describedBy = [description ? helpId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="dz-field" id={id}>
      <label className="dz-field__label" htmlFor={inputId}>
        {label}
      </label>
      <div className="dz-field__control">{children({ inputId, describedBy })}</div>
      {description ? (
        <small className="dz-field__help" id={helpId}>
          {description}
        </small>
      ) : null}
      {error ? (
        <small className="dz-field__error" id={errorId} role="alert">
          {error}
        </small>
      ) : null}
    </div>
  );
}

export interface CommitTextProps {
  id: string;
  value: string;
  /** Called with the new text, and only when it differs from `value`. Return an error message to refuse it. */
  onCommit(text: string): string | null | void;
  disabled?: boolean;
  multiline?: boolean;
  describedBy?: string | undefined;
  label?: string;
  invalid?: boolean;
  placeholder?: string;
  /** The id of a datalist of suggestions. The text can still be anything. */
  list?: string;
  onError?(message: string | null): void;
}

/**
 * A text field that writes on blur or Enter, never on a keystroke. Escape puts the old text back.
 * Multi-line fields commit on blur or Ctrl+Enter.
 */
export function CommitText({ id, value, onCommit, disabled, multiline, describedBy, label, invalid, placeholder, list, onError }: CommitTextProps): ReactElement {
  const [draft, setDraft] = useState(value);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  useEffect(() => {
    // Take in changes made elsewhere (undo, the text editor) unless someone is typing here.
    if (!dirtyRef.current) setDraft(value);
  }, [value]);

  const commit = (): void => {
    if (!dirty) return;
    setDirty(false);
    if (draft === value) {
      onError?.(null);
      return;
    }
    const problem = onCommit(draft);
    if (problem) {
      onError?.(problem);
      setDirty(true);
    } else onError?.(null);
  };
  const keyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && (!multiline || event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape' && dirty) {
      event.preventDefault();
      event.stopPropagation();
      setDraft(value);
      setDirty(false);
      onError?.(null);
    }
  };
  const common = {
    id,
    className: 'dz-input',
    value: draft,
    disabled,
    placeholder,
    list,
    'aria-describedby': describedBy,
    'aria-label': label,
    'aria-invalid': invalid || undefined,
    onChange: (event: { target: { value: string } }) => {
      setDraft(event.target.value);
      setDirty(true);
    },
    onBlur: commit,
    onKeyDown: keyDown,
    spellCheck: false,
    autoComplete: 'off',
  };
  return multiline ? <textarea {...common} rows={4} /> : <input type="text" {...common} />;
}
