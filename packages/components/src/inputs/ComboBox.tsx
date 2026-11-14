import { useRef, useState } from 'react';
import {
  Button,
  ComboBox as AriaComboBox,
  FieldError,
  Group,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
} from 'react-aria-components';
import type { HostProps } from '../contract.ts';
import { commitSelection, fallbackName, readOptions, toText, useFocusHandle } from './shared.ts';

export interface ComboBoxProps {
  label?: string;
  value?: unknown;
  options?: unknown;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  errorMessage?: string;
}

interface Shown {
  text: string;
  row: number | null;
}

export function ComboBox({ props, id, write, fire, handleRef, design }: HostProps<ComboBoxProps>) {
  const inputRef = useRef<HTMLInputElement>(null);
  useFocusHandle(handleRef, () => inputRef.current?.focus());
  const row = props.boundRow ?? null;
  const options = readOptions(props.options);
  const hasValue = props.value !== null && props.value !== undefined && props.value !== '';
  const selected = hasValue ? options.find((o) => toText(o.value) === toText(props.value)) : undefined;
  // An unknown bound value shows as it is, so the user can see what the data holds.
  const shownLabel = hasValue ? (selected?.label ?? toText(props.value)) : '';
  // Typed text exists only once the user typed, so passing through a field never clears it.
  const [typed, setTyped] = useState<Shown | null>(null);
  // The chosen label, shown from the moment of choosing until the write settles.
  const [choice, setChoice] = useState<Shown | null>(null);
  const typedRef = useRef<Shown | null>(null);
  typedRef.current = typed;
  const latest = useRef({ options, hasValue, value: props.value, row, design });
  latest.current = { options, hasValue, value: props.value, row, design };
  const typedNow = typed && typed.row === row ? typed.text : null;
  const choiceNow = choice && choice.row === row ? choice.text : null;
  const text = typedNow ?? choiceNow ?? shownLabel;

  const choose = (value: unknown, label: string) => {
    setTyped(null);
    setChoice({ text: label, row });
    commitSelection(write, fire, value, undefined, () => setChoice(null));
  };

  const items = options.map((o) => ({ id: toText(o.value), label: o.label }));

  return (
    <AriaComboBox
      className="fw-combobox"
      aria-label={fallbackName(props, id)}
      data-required={props.required || undefined}
      defaultItems={items}
      selectedKey={selected ? toText(selected.value) : null}
      inputValue={text}
      onSelectionChange={(key) => {
        if (design || key === null) return;
        const option = options.find((o) => toText(o.value) === String(key));
        if (!option) return;
        if (hasValue && toText(option.value) === toText(props.value)) {
          // React Aria re-reports the bound selection while the user types or clears, so ignore it.
          return;
        }
        choose(option.value, option.label);
      }}
      onBlur={() => {
        // Read through refs: the blur can arrive before React has re-rendered with the typed text.
        const L = latest.current;
        const t = typedRef.current;
        if (L.design || !t || t.row !== L.row) return;
        typedRef.current = null;
        setTyped(null);
        if (t.text === '') {
          if (L.hasValue) commitSelection(write, fire, null);
          return;
        }
        // Text that exactly matches an option (ignoring case) selects it. Anything else goes back.
        const match = L.options.find((o) => o.label.toLowerCase() === t.text.toLowerCase());
        if (match && !(L.hasValue && toText(match.value) === toText(L.value))) choose(match.value, match.label);
      }}
      isDisabled={props.disabled}
      isReadOnly={props.readOnly}
      isRequired={props.required}
      isInvalid={props.errorMessage ? true : undefined}
      validationBehavior="aria"
    >
      {props.label ? <Label className="fw-combobox__label">{props.label}</Label> : null}
      <Group className="fw-combobox__group">
        <Input
          ref={inputRef}
          className="fw-combobox__input"
          placeholder={props.placeholder}
          onChange={(e) => {
            if (design || props.readOnly) return;
            typedRef.current = { text: e.target.value, row };
            setTyped(typedRef.current);
          }}
        />
        <Button className="fw-combobox__button" aria-label="Show options">
          <span aria-hidden="true">{'▾'}</span>
        </Button>
      </Group>
      {props.errorMessage ? (
        <FieldError className="fw-combobox__error">
<span title={props.errorMessage}>{props.errorMessage}</span>
</FieldError>
      ) : null}
      <Popover className="fw-combobox__popover">
        <ListBox className="fw-combobox__list">
          {(item: { id: string; label: string }) => (
            <ListBoxItem id={item.id} textValue={item.label} className="fw-combobox__option">
              {item.label}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </AriaComboBox>
  );
}
