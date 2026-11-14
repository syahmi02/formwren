import type { ColumnDef, ColumnType } from '../values.ts';

/** Files can hold keys this version doesn't know about. They're kept, never removed. */
type WithUnknownKeys = { [key: string]: unknown };

export interface TypedValue extends WithUnknownKeys {
  type: ColumnType;
  default?: unknown;
}

export type ColumnDefinition = ColumnDef & WithUnknownKeys;

export interface DatasetDefinition extends WithUnknownKeys {
  id: string;
  keys?: string[];
  confirmUnsaved?: boolean;
  columns: ColumnDefinition[];
  initialRows?: Record<string, unknown>[];
  sampleRows?: Record<string, unknown>[];
}

export interface LayoutDefinition extends WithUnknownKeys {
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
  width?: number;
  height?: number;
}

export interface ComponentDefinition extends WithUnknownKeys {
  id: string;
  type: string;
  layout: LayoutDefinition;
  props?: Record<string, unknown>;
  bind?: Record<string, string>;
  events?: Record<string, string>;
  children?: ComponentDefinition[];
  z?: number;
}

export interface GridTrackDefinition extends WithUnknownKeys {
  id: string;
  width: number;
  frozen?: 'left';
}

export interface GridCellDefinition extends WithUnknownKeys {
  text?: string;
  field?: string;
  value?: string;
  rowSpan?: number;
  colSpan?: number;
  format?: string;
  editor?: 'text' | 'number' | 'dropdown' | 'date' | 'checkbox';
  /** A built-in cell: the row's status, or a checkbox tied to the Dataset's row selection. Needs no `field`. */
  kind?: 'rowStatus' | 'rowSelect';
  /** Where a dropdown and code-to-name display get their options: a Dataset id, or a static list. */
  options?: string | { value: string | number | boolean | null; label: string }[];
  /** Column of the options Dataset holding the stored value. */
  optionValue?: string;
  /** Column of the options Dataset holding the text. Defaults to `optionValue`. */
  optionLabel?: string;
}

export interface GridRowDefinition extends WithUnknownKeys {
  cells: GridCellDefinition[];
}

export interface GridProps extends WithUnknownKeys {
  columns: GridTrackDefinition[];
  headerRows?: GridRowDefinition[];
  recordRows: GridRowDefinition[];
  footerRows?: GridRowDefinition[];
}

export interface FormDefinition extends WithUnknownKeys {
  $schema?: string;
  formatVersion: 1;
  id: string;
  title?: string;
  script?: string;
  size?: { width: number; height: number };
  params?: Record<string, TypedValue>;
  /** What the form passes to `close(result)`. Typed like `params`. */
  result?: Record<string, TypedValue>;
  events?: Record<string, string>;
  datasets?: DatasetDefinition[];
  components: ComponentDefinition[];
  variables?: Record<string, TypedValue>;
}
