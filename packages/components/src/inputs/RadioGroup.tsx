import { useRef } from 'react';
import { FieldError, Label, Radio, RadioGroup as AriaRadioGroup } from 'react-aria-components';
import type { HostProps } from '../contract.ts';
import { commitSelection, readOptions, toText, useFocusHandle } from './shared.ts';

export interface RadioGroupProps {
  label?: string;
  value?: unknown;
  options?: unknown;
  orientation?: 'vertical' | 'horizontal';
  required?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  errorMessage?: string;
}

export function RadioGroup({ props, id, write, fire, handleRef, design }: HostProps<RadioGroupProps>) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusHandle(handleRef, () => ref.current?.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus());
  const options = readOptions(props.options);
  // An unknown value selects nothing, which keeps the group reachable by keyboard.
  const known = options.find((o) => props.value !== null && props.value !== undefined && toText(o.value) === toText(props.value));
  const selected = known ? toText(known.value) : null;
  const message = props.errorMessage || undefined;
  return (
    <AriaRadioGroup
      ref={ref}
      className="fw-radiogroup"
      aria-label={props.label ? undefined : id}
      value={selected}
      orientation={props.orientation ?? 'vertical'}
      isDisabled={props.disabled}
      isReadOnly={props.readOnly}
      isRequired={props.required}
      isInvalid={message !== undefined}
      validationBehavior="aria"
      data-required={props.required || undefined}
      onChange={(key) => {
        if (design) return;
        const option = options.find((o) => toText(o.value) === key);
        if (option) commitSelection(write, fire, option.value);
      }}
    >
      {props.label ? <Label className="fw-radiogroup__label">{props.label}</Label> : null}
      <div className="fw-radiogroup__options">
        {options.map((o) => (
          <Radio key={toText(o.value)} value={toText(o.value)} className="fw-radiogroup__option">
            <span className="fw-radiogroup__dot" aria-hidden="true" />
            <span className="fw-radiogroup__text">{o.label}</span>
          </Radio>
        ))}
      </div>
      {message ? (
        <FieldError className="fw-radiogroup__error">
          <span title={message}>{message}</span>
        </FieldError>
      ) : null}
    </AriaRadioGroup>
  );
}
