import { useEffect, useRef } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import type { HostProps } from '../contract.ts';
import { useFocusHandle } from './shared.ts';

export interface ButtonProps {
  text?: string;
  variant?: 'default' | 'primary';
  disabled?: boolean;
}

/**
 * A disabled button stays focusable (aria-disabled) but is left out of the tab order, because a focused button that became disabled
 * would otherwise drop focus to the page body.
 */
export function Button({ props, fire, handleRef, design }: HostProps<ButtonProps>) {
  const ref = useRef<HTMLButtonElement>(null);
  useFocusHandle(handleRef, () => ref.current?.focus());
  const disabled = props.disabled === true;
  // React Aria sets data-disabled itself from isDisabled, which we don't use, so mirror it by hand for the theme.
  useEffect(() => {
    ref.current?.toggleAttribute('data-disabled', disabled);
  }, [disabled]);
  return (
    <AriaButton
      ref={ref}
      className="fw-button"
      data-variant={props.variant ?? 'default'}
      aria-disabled={disabled || undefined}
      excludeFromTabOrder={disabled}
      onPress={() => {
        if (!design && !disabled) fire('click');
      }}
    >
      {props.text}
    </AriaButton>
  );
}
