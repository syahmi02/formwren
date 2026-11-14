import { isEmptyContainer, isObject, toJsonValue, type JsonObject, type JsonValue } from './json.ts';

/**
 * How each part of a form file is laid out. A short object stays on one line because of what it
 * is, never because of how wide it is, so one property change is always one line in a diff.
 */
export type Role =
  | 'form'
  | 'size'
  | 'typedMap'
  | 'typed'
  | 'datasetList'
  | 'dataset'
  | 'columnList'
  | 'column'
  | 'rowList'
  | 'componentList'
  | 'component'
  | 'layout'
  | 'gridProps'
  | 'trackList'
  | 'track'
  | 'gridRowList'
  | 'gridRow'
  | 'cellList'
  | 'cell'
  | 'inline'
  | 'default';

interface RoleSpec {
  /** Known keys in the order they're written. Unknown keys follow them. */
  keys?: readonly string[];
  /** Printed on one line, including everything inside it. */
  inline?: boolean;
  /** The role of each known key's value. */
  children?: Readonly<Record<string, Role>>;
  /** The role of each array element, or of each value in a map. */
  element?: Role;
}

export const ROLES: Readonly<Record<Role, RoleSpec>> = {
  form: {
    keys: ['$schema', 'formatVersion', 'id', 'title', 'script', 'size', 'params', 'result', 'events', 'datasets', 'components', 'variables'],
    children: {
      size: 'size',
      params: 'typedMap',
      result: 'typedMap',
      events: 'inline',
      datasets: 'datasetList',
      components: 'componentList',
      variables: 'typedMap',
    },
  },
  size: { inline: true, keys: ['width', 'height'] },
  typedMap: { element: 'typed' },
  typed: { inline: true, keys: ['type', 'default'] },
  datasetList: { element: 'dataset' },
  dataset: {
    keys: ['id', 'keys', 'confirmUnsaved', 'columns', 'initialRows', 'sampleRows'],
    children: { keys: 'inline', columns: 'columnList', initialRows: 'rowList', sampleRows: 'rowList' },
  },
  columnList: { element: 'column' },
  column: {
    inline: true,
    keys: ['id', 'type', 'label', 'size', 'precision', 'scale', 'required', 'min', 'max', 'pattern', 'version'],
  },
  rowList: { element: 'inline' },
  componentList: { element: 'component' },
  component: {
    keys: ['id', 'type', 'layout', 'props', 'bind', 'events', 'children', 'z'],
    children: { layout: 'layout', props: 'inline', bind: 'inline', events: 'inline', children: 'componentList' },
  },
  layout: { inline: true, keys: ['left', 'top', 'right', 'bottom', 'width', 'height'] },
  gridProps: {
    keys: ['columns', 'headerRows', 'recordRows', 'footerRows'],
    children: { columns: 'trackList', headerRows: 'gridRowList', recordRows: 'gridRowList', footerRows: 'gridRowList' },
  },
  trackList: { element: 'track' },
  track: { inline: true, keys: ['id', 'width', 'frozen'] },
  gridRowList: { element: 'gridRow' },
  gridRow: { keys: ['cells'], children: { cells: 'cellList' } },
  cellList: { element: 'cell' },
  cell: { inline: true, keys: ['text', 'field', 'kind', 'value', 'rowSpan', 'colSpan', 'format', 'editor', 'options', 'optionValue', 'optionLabel'] },
  inline: { inline: true },
  default: {},
};

/** The role of the value under `key`. `parent` is the object holding it, because Grid props are laid out differently. */
export function childRole(role: Role, key: string, parent: JsonObject): Role {
  if (role === 'component' && key === 'props' && parent.type === 'Grid') return 'gridProps';
  const spec = ROLES[role];
  return spec.children?.[key] ?? spec.element ?? (spec.inline ? 'inline' : 'default');
}

export function elementRole(role: Role): Role {
  const spec = ROLES[role];
  return spec.element ?? (spec.inline ? 'inline' : 'default');
}

/** A known key's place in the written order. Unknown keys come after all known ones. */
export function keyRank(role: Role, key: string): number {
  const rank = ROLES[role].keys?.indexOf(key) ?? -1;
  return rank === -1 ? Number.POSITIVE_INFINITY : rank;
}

/** Known keys in their written order, then unknown keys in the order they appear. */
export function orderedKeys(value: JsonObject, role: Role): string[] {
  const keys = Object.keys(value);
  const known = keys.filter((key) => keyRank(role, key) !== Number.POSITIVE_INFINITY);
  known.sort((a, b) => keyRank(role, a) - keyRank(role, b));
  return [...known, ...keys.filter((key) => keyRank(role, key) === Number.POSITIVE_INFINITY)];
}

/** Prints a value and everything inside it on one line. */
export function printInline(value: JsonValue, role: Role): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((item) => printInline(item, elementRole(role)));
    return `[${items.join(', ')}]`;
  }
  if (isObject(value)) {
    const keys = orderedKeys(value, role);
    if (keys.length === 0) return '{}';
    const entries = keys.map(
      (key) => `${JSON.stringify(key)}: ${printInline(value[key] as JsonValue, childRole(role, key, value))}`,
    );
    return `{ ${entries.join(', ')} }`;
  }
  return JSON.stringify(value);
}

function isAtom(value: JsonValue): boolean {
  return !(Array.isArray(value) || isObject(value)) || isEmptyContainer(value);
}

/** Prints a value in its standard layout. `indent` is the indentation of the line it starts on. */
export function printValue(value: JsonValue, role: Role, indent: string, eol: string): string {
  if (isAtom(value) || ROLES[role].inline) return printInline(value, role);
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.every(isAtom)) return printInline(value, role);
    const items = value.map((item) => inner + printValue(item, elementRole(role), inner, eol));
    return `[${eol}${items.join(`,${eol}`)}${eol}${indent}]`;
  }
  const object = value as JsonObject;
  const entries = orderedKeys(object, role).map(
    (key) =>
      `${inner}${JSON.stringify(key)}: ${printValue(object[key] as JsonValue, childRole(role, key, object), inner, eol)}`,
  );
  return `{${eol}${entries.join(`,${eol}`)}${eol}${indent}}`;
}

/** The standard text of a form file. The same form always gives exactly the same text. */
export function printForm(form: unknown): string {
  return `${printValue(toJsonValue(form, 'form'), 'form', '', '\n')}\n`;
}
