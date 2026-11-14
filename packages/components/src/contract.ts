/** The shared contract between the host and the components. See docs/plans/step-2.md. */
import type { ChangeResult, ColumnType, ComponentHandle, ComponentMeta } from '@fw/core';
import type { ComponentType, ReactNode, Ref } from 'react';

/** Props every input-like component understands. */
export interface CommonProps {
  disabled?: boolean;
  readOnly?: boolean;
  /** Set when the value is known to be invalid, with the message to show. */
  errorMessage?: string;
  /** Id of the row the bound value was read from, or null if there is none. Pass it back as `write`'s `rowId`. */
  boundRow?: number | null;
  /** Changes whenever the bound cell changes, even to an equal value. */
  boundRevision?: number;
  /** The bound column's type. */
  boundType?: ColumnType;
}

/** What the host passes to every component. Everything in `props` is a plain value. */
export interface HostProps<P = Record<string, unknown>> {
  id: string;
  props: Readonly<P & CommonProps>;
  /**
   * Writes a bound prop. Text inputs call this on commit (blur or Enter), and a selection control
   * calls it on change. `rowId` targets a specific row, such as the one a draft was typed on, instead of the
   * current row. A false result means it wasn't written, so go back to `props.value`.
   */
  write(prop: string, value: unknown, rowId?: number): ChangeResult;
  /**
   * True if `write` could store this value in the bound column. Check before writing typed text:
   * false means the text doesn't fit, so keep it on screen marked invalid. A false result from
   * `write` after this returned true means a handler refused, so go back to `props.value`.
   */
  accepts(prop: string, value: unknown): boolean;
  fire(event: string, detail?: unknown): void;
  /** Attach to the element that should take focus, through `useImperativeHandle` if needed. */
  handleRef: Ref<ComponentHandle>;
  /** In design mode a component draws normally but must not take focus or respond to input. */
  design: boolean;
  /** Rendered children, for container components. */
  children?: ReactNode;
}

export interface ComponentRegistration {
  meta: ComponentMeta;
  /**
   * True if the component draws itself in a portal, such as a modal. In run mode its host then takes no
   * space and catches no pointer events, so it can't block what it overlaps.
   */
  portal?: boolean;
  // Each component declares its own prop type, so the registry stores them loosely.
  render: ComponentType<HostProps<never>>;
}

export type Registry = Readonly<Record<string, ComponentRegistration>>;

/** Types a component's render function and pairs it with its meta. */
export function registerComponent<P>(
  meta: ComponentMeta,
  render: ComponentType<HostProps<P>>,
  options: { portal?: boolean } = {},
): ComponentRegistration {
  return { meta, render: render as ComponentType<HostProps<never>>, ...(options.portal ? { portal: true } : {}) };
}
