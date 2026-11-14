import { formatValue, type ColumnType } from '@fw/core';
import type { HostProps } from '../contract.ts';
import { toText } from './shared.ts';

export interface LabelProps {
  text?: unknown;
  align?: 'left' | 'center' | 'right';
  format?: string;
  /** Announce changes to screen readers. */
  live?: boolean;
}

/** The bound column's type if the host says so, else a guess from the JS type. */
export function formatType(value: unknown, boundType: ColumnType | undefined): ColumnType {
  return boundType ?? (typeof value === 'number' ? 'float' : 'decimal');
}

export function Label({ props }: HostProps<LabelProps>) {
  const raw = toText(props.text);
  let text = raw;
  if (props.format && raw !== '') {
    try {
      const v = props.text as string | number;
      text = formatValue(v, formatType(v, props.boundType), props.format);
    } catch {
      text = raw;
    }
  }
  return (
    <div
      className="fw-label"
      role={props.live ? 'status' : undefined}
      data-align={props.align ?? 'left'}
      style={{ textAlign: props.align ?? 'left' }}
    >
      {text}
    </div>
  );
}
