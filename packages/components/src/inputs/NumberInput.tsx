import { decCompare, formatValue, isDecimal } from '@fw/core';
import { useRef } from 'react';
import { FieldError, Input, Label, TextField } from 'react-aria-components';
import type { HostProps } from '../contract.ts';
import { formatType } from './Label.tsx';
import { fallbackName, toText, useDraft, useFocusHandle } from './shared.ts';

export interface NumberProps {
  label?: string;
  value?: string | number | null;
  min?: number | string;
  max?: number | string;
  format?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  errorMessage?: string;
}

/** Range check on the text, never through a double. Text that isn't a plain decimal is left to `accepts`. */
function outOfRange(text: string, min: unknown, max: unknown): string | null {
  const t = text.trim();
  if (t === '' || !isDecimal(t)) return null;
  if (min !== undefined && min !== null && min !== '' && decCompare(t, String(min)) < 0) return `Must be at least ${min}`;
  if (max !== undefined && max !== null && max !== '' && decCompare(t, String(max)) > 0) return `Must be at most ${max}`;
  return null;
}

export function NumberInput({ props, id, write, accepts, fire, handleRef, design }: HostProps<NumberProps>) {
  const ref = useRef<HTMLInputElement>(null);
  useFocusHandle(handleRef, () => ref.current?.focus());
  const { format } = props;
  const draft = useDraft({
    value: props.value,
    boundRow: props.boundRow,
    boundRevision: props.boundRevision,
    boundType: props.boundType,
    write,
    accepts,
    fire,
    design,
    readOnly: props.readOnly,
    disabled: props.disabled,
    checkFit: true,
    check: (text) => outOfRange(text, props.min, props.max),
    commitOnEnter: true,
    display: (v) => {
      const raw = toText(v);
      if (!format || raw === '') return raw;
      try {
        // Text stays text: a string is formatted from its digits, never through a double.
        return formatValue(v as string | number, formatType(v, props.boundType), format);
      } catch {
        return raw;
      }
    },
  });
  const message = props.errorMessage || draft.message;
  return (
    <TextField
      className="fw-numberinput"
      aria-label={fallbackName(props, id)}
      data-required={props.required || undefined}
      value={draft.text}
      onChange={draft.handlers.onChange}
      onFocus={draft.handlers.onFocus}
      onBlur={draft.handlers.onBlur}
      isDisabled={props.disabled}
      isReadOnly={props.readOnly}
      isRequired={props.required}
      isInvalid={message !== undefined}
      validationBehavior="aria"
    >
      {props.label ? <Label className="fw-numberinput__label">{props.label}</Label> : null}
      <Input
        ref={ref}
        className="fw-numberinput__input"
        inputMode="decimal"
        placeholder={props.placeholder}
        onKeyDown={draft.handlers.onKeyDown}
      />
      {message ? (
        <FieldError className="fw-numberinput__error">
<span title={message}>{message}</span>
</FieldError>
      ) : null}
    </TextField>
  );
}
