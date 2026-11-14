/**
 * What a component is, with no React in sight, so the CLI and designer can read it in Node.
 * This one source drives the palette, inspector, schema checks and typings.
 */
export type PropKind = 'string' | 'number' | 'boolean' | 'enum' | 'options' | 'json';

export interface PropMeta {
  kind: PropKind;
  description: string;
  default?: unknown;
  /** The allowed values, when `kind` is 'enum'. */
  values?: readonly string[];
}

export interface EventMeta {
  description: string;
}

export interface ComponentMeta {
  type: string;
  displayName: string;
  category: 'action' | 'display' | 'input' | 'container';
  /** True if the component can hold child components. */
  container: boolean;
  defaultSize: { width: number; height: number };
  props: Readonly<Record<string, PropMeta>>;
  /** What each `bind` key means: one column of the current row, or a whole Dataset. */
  bindings: Readonly<Record<string, 'column' | 'dataset'>>;
  events: Readonly<Record<string, EventMeta>>;
}

export function defineComponentMeta(meta: ComponentMeta): ComponentMeta {
  return meta;
}
