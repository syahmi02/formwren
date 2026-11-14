import { useRef } from 'react';
import { FieldError, Input, Label, TextArea as AriaTextArea, TextField as AriaTextField } from 'react-aria-components';
import type { HostProps } from '../contract.ts';
import { fallbackName, useDraft, useFocusHandle } from './shared.ts';

export interface TextProps {
  label?: string;
  value?: unknown;
  placeholder?: string;
  maxLength?: number;
  required?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  errorMessage?: string;
}

/** TextInput and TextArea differ only in the element, in what Enter does, and in `submit`. */
export function TextFieldBase({ type, multiline, host }: { type: string; multiline: boolean; host: HostProps<TextProps> }) {
  const { props, id, write, accepts, fire, handleRef, design } = host;
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useFocusHandle(handleRef, () => ref.current?.focus());
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
    checkFit: !multiline,
    commitOnEnter: !multiline,
    onSubmit: multiline ? undefined : () => fire('submit'),
  });
  const message = props.errorMessage || draft.message;
  const cls = `fw-${type}`;
  return (
    <AriaTextField
      className={cls}
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
      maxLength={props.maxLength}
    >
      {props.label ? <Label className={`${cls}__label`}>{props.label}</Label> : null}
      {multiline ? (
        <AriaTextArea ref={ref} className={`${cls}__input`} placeholder={props.placeholder} onKeyDown={draft.handlers.onKeyDown} />
      ) : (
        <Input ref={ref} className={`${cls}__input`} placeholder={props.placeholder} onKeyDown={draft.handlers.onKeyDown} />
      )}
      {message ? (
        <FieldError className={`${cls}__error`}>
<span title={message}>{message}</span>
</FieldError>
      ) : null}
    </AriaTextField>
  );
}
