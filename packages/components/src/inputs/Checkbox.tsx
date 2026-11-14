import { useId, useRef } from 'react';
import { Checkbox as AriaCheckbox } from 'react-aria-components';
import type { HostProps } from '../contract.ts';
import { commitSelection, useFocusHandle } from './shared.ts';

export interface CheckboxProps {
  label?: string;
  value?: boolean | null;
  required?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  errorMessage?: string;
}

export function Checkbox({ props, id, write, fire, handleRef, design }: HostProps<CheckboxProps>) {
  const ref = useRef<HTMLInputElement>(null);
  const messageId = useId();
  useFocusHandle(handleRef, () => ref.current?.focus());
  const message = props.errorMessage || undefined;
  return (
    <div className="fw-checkboxfield" data-required={props.required || undefined}>
      <AriaCheckbox
        className="fw-checkbox"
        aria-label={props.label ? undefined : id}
        aria-describedby={message ? messageId : undefined}
        data-required={props.required || undefined}
        inputRef={ref}
        isSelected={props.value === true}
        isDisabled={props.disabled}
        isReadOnly={props.readOnly}
        isRequired={props.required}
        isInvalid={message !== undefined}
        validationBehavior="aria"
        onChange={(checked) => {
          if (!design) commitSelection(write, fire, checked);
        }}
      >
        <span className="fw-checkbox__box" aria-hidden="true" />
        <span className="fw-checkbox__label">{props.label}</span>
      </AriaCheckbox>
      {message ? (
        <span id={messageId} className="fw-checkbox__error" title={message}>
          {message}
        </span>
      ) : null}
    </div>
  );
}
