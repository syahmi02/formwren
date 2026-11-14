import { Validator, type Schema } from '@cfworker/json-schema';
import {
  coerceValue,
  compileExpression,
  decCompare,
  ExpressionError,
  isExpression,
  type ColumnDefinition,
  type ComponentMeta,
} from '@fw/core';
import schema from '../schema/form.schema.json';
import { placeGridCells } from './grid.ts';
import { isObject, type JsonObject, type JsonValue } from './json.ts';
import { ROLES, childRole, elementRole, type Role } from './print.ts';
import type { ComponentDefinition, DatasetDefinition, FormDefinition, GridProps } from './types.ts';

export interface Diagnostic {
  severity: 'error' | 'warning';
  /** Where in the form, such as `components[2].layout`. */
  path: string;
  message: string;
}

// Interprets the schema with no generated code, so it also runs where `eval` is blocked.
const validator = new Validator(schema as unknown as Schema, '2020-12', false);

/** These only report that something nested failed. The nested error says what actually went wrong. */
const WRAPPER_KEYWORDS = new Set(['properties', 'additionalProperties', 'items', '$ref', 'allOf', 'if', 'then']);

function toPath(location: string): string {
  return location
    .replace(/^#\/?/, '')
    .split('/')
    .filter(Boolean)
    .map((part, i) => (/^\d+$/.test(part) ? `[${part}]` : i === 0 ? part : `.${part}`))
    .join('');
}

export function checkSchema(form: unknown): Diagnostic[] {
  const { errors } = validator.validate(form);
  return errors
    .filter((error) => !WRAPPER_KEYWORDS.has(error.keyword))
    .map((error) => ({ severity: 'error' as const, path: toPath(error.instanceLocation), message: error.error }));
}

/** Forward compatibility allows unknown keys, but a warning catches a misspelled one. */
function warnUnknownKeys(value: JsonValue, role: Role, path: string, out: Diagnostic[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => warnUnknownKeys(item, elementRole(role), `${path}[${i}]`, out));
    return;
  }
  if (!isObject(value)) return;
  const spec = ROLES[role];
  for (const key of Object.keys(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (spec.keys && !spec.keys.includes(key)) {
      out.push({ severity: 'warning', path: childPath, message: `Unknown key "${key}". It will be kept as is` });
      continue;
    }
    warnUnknownKeys(value[key] as JsonValue, childRole(role, key, value), childPath, out);
  }
}

function checkDuplicates(ids: readonly string[], what: string, path: string, out: Diagnostic[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) out.push({ severity: 'error', path, message: `Two ${what} are named "${id}"` });
    seen.add(id);
  }
}

const NUMERIC_TEXT = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** Why a column's min or max can't be compared with its values, or null if it can. */
function boundProblem(column: ColumnDefinition, value: unknown): string | null {
  try {
    switch (column.type) {
      case 'decimal':
        // The runtime compares String(bound), so a number must print as plain decimal text.
        if (typeof value === 'number' && !Number.isFinite(value)) return 'is not a decimal';
        decCompare(typeof value === 'number' ? String(value) : String(coerceValue(column, value)), '0');
        return null;
      case 'int':
      case 'float':
        return (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && NUMERIC_TEXT.test(value))
          ? null
          : 'is not a number';
      case 'date':
        coerceValue(column, value);
        return null;
      case 'datetime':
        // A bare date still compares correctly as text, so it is allowed as a bound.
        try {
          coerceValue(column, value);
        } catch {
          coerceValue({ ...column, type: 'date' }, value);
        }
        return null;
      default:
        return null;
    }
  } catch {
    return column.type === 'decimal' ? 'is not a decimal' : `is not a valid ${column.type}`;
  }
}

function checkDataset(dataset: DatasetDefinition, path: string, out: Diagnostic[]): void {
  const error = (where: string, message: string) => out.push({ severity: 'error', path: `${path}${where}`, message });
  const columns = new Map(dataset.columns.map((column) => [column.id, column]));
  checkDuplicates(dataset.columns.map((column) => column.id), 'columns', `${path}.columns`, out);

  dataset.keys?.forEach((key, i) => {
    if (!columns.has(key)) error(`.keys[${i}]`, `No column named "${key}"`);
  });

  const versions = dataset.columns.flatMap((column, i) => (column.version === true ? [i] : []));
  for (const i of versions.slice(1)) error(`.columns[${i}].version`, 'A Dataset can have at most one version column');

  dataset.columns.forEach((column, i) => {
    const where = `.columns[${i}]`;
    if (column.precision !== undefined && column.scale !== undefined && column.scale > column.precision) {
      error(where, `Scale ${column.scale} is larger than precision ${column.precision}`);
    }
    if (column.pattern !== undefined) {
      try {
        new RegExp(column.pattern, 'u');
      } catch {
        error(`${where}.pattern`, `"${column.pattern}" is not a valid pattern`);
      }
    }
    if (column.version === true && column.type !== 'int') {
      error(`${where}.version`, `A version column must be an int, but "${column.id}" is ${column.type}`);
    }
    for (const bound of ['min', 'max'] as const) {
      const value = column[bound];
      if (value === undefined) continue;
      const problem = boundProblem(column, value);
      if (problem) error(`${where}.${bound}`, `${JSON.stringify(value)} ${problem}`);
    }
  });

  for (const key of ['initialRows', 'sampleRows'] as const) {
    dataset[key]?.forEach((row, r) => {
      for (const [columnId, value] of Object.entries(row)) {
        const where = `.${key}[${r}].${columnId}`;
        const column = columns.get(columnId);
        if (!column) {
          error(where, `No column named "${columnId}"`);
          continue;
        }
        try {
          coerceValue(column, value);
        } catch (failure) {
          error(where, (failure as Error).message);
        }
      }
    });
  }
}

function checkLayout(component: ComponentDefinition, path: string, out: Diagnostic[]): void {
  const { left, right, width, top, bottom, height } = component.layout;
  const count = (...edges: (number | undefined)[]) => edges.filter((edge) => edge !== undefined).length;
  if (count(left, right, width) !== 2) {
    out.push({ severity: 'error', path: `${path}.layout`, message: 'Set exactly two of left, right and width' });
  }
  if (count(top, bottom, height) !== 2) {
    out.push({ severity: 'error', path: `${path}.layout`, message: 'Set exactly two of top, bottom and height' });
  }
}

function checkGrid(
  component: ComponentDefinition,
  path: string,
  dataset: DatasetDefinition | undefined,
  datasets: ReadonlyMap<string, DatasetDefinition>,
  out: Diagnostic[],
): void {
  if (component.bind?.dataset === undefined) {
    out.push({ severity: 'error', path: `${path}.bind`, message: 'A Grid needs bind.dataset, the Dataset it shows' });
  }
  const error = (where: string, message: string) => out.push({ severity: 'error', path: `${path}.props${where}`, message });
  const grid = component.props as unknown as GridProps;
  const tracks = grid.columns;
  checkDuplicates(tracks.map((track) => track.id), 'Grid columns', `${path}.props.columns`, out);

  const firstUnfrozen = tracks.findIndex((track) => track.frozen === undefined);
  tracks.forEach((track, i) => {
    if (track.frozen !== undefined && firstUnfrozen !== -1 && i > firstUnfrozen) {
      error(`.columns[${i}]`, 'Frozen columns must come first');
    }
  });

  const frozenCount = tracks.filter((track) => track.frozen !== undefined).length;
  if (grid.recordRows.length > 1) {
    error('.recordRows', 'Records with more than one line are not supported yet');
  }

  for (const section of ['headerRows', 'recordRows', 'footerRows'] as const) {
    const rows = grid[section];
    if (!rows) continue;
    const placement = placeGridCells(rows, tracks.length);
    for (const message of placement.errors) error(`.${section}`, message);
    if (section !== 'recordRows' && frozenCount > 0) {
      for (const placed of placement.cells) {
        if (placed.column < frozenCount && placed.column + placed.colSpan > frozenCount) {
          error(`.${section}[${placed.row}]`, `A merged cell can't cross the frozen boundary (after column ${frozenCount})`);
        }
      }
    }
    rows.forEach((row, r) => {
      row.cells.forEach((cell, c) => {
        const at = `.${section}[${r}].cells[${c}]`;
        if (cell.kind !== undefined && section !== 'recordRows') {
          error(`${at}.kind`, `A "${cell.kind}" cell only works in recordRows`);
        }
        if (cell.editor === 'dropdown' && cell.options === undefined) {
          error(`${at}.editor`, 'A dropdown editor needs options');
        }
        if (typeof cell.options === 'string') {
          const source = datasets.get(cell.options);
          if (!source) {
            error(`${at}.options`, `No Dataset named "${cell.options}"`);
          } else {
            if (cell.optionValue === undefined) error(`${at}.optionValue`, `Options from Dataset "${source.id}" need optionValue`);
            for (const prop of ['optionValue', 'optionLabel'] as const) {
              const column = cell[prop];
              if (column !== undefined && !source.columns.some((candidate) => candidate.id === column)) {
                error(`${at}.${prop}`, `Dataset "${source.id}" has no column "${column}"`);
              }
            }
          }
        }
        if (!dataset) return;
        if (cell.field !== undefined && !dataset.columns.some((column) => column.id === cell.field)) {
          error(`${at}.field`, `Dataset "${dataset.id}" has no column "${cell.field}"`);
        }
      });
    });
  }
}

/** What the checks need to look things up. */
interface Context {
  form: FormDefinition;
  datasets: Map<string, DatasetDefinition>;
  components: Readonly<Record<string, ComponentMeta>> | undefined;
  ids: string[];
}

export interface CheckOptions {
  /**
   * What each component type accepts, such as `componentMetas` from `@fw/components/meta`. Without
   * it, types, props and bind keys aren't checked against anything.
   */
  components?: Readonly<Record<string, ComponentMeta>>;
}

const FORM_EVENTS = new Set(['init', 'beforeClose', 'close']);
const DATASET_LEVEL_KEYS = new Set(['dataset', 'options']);
const COLUMN_FIELDS = new Set(['$currentIndex', '$rowCount']);

/** What is wrong with a path an expression reads, or null if it refers to something real. */
function unknownReference(reference: readonly string[], context: Context, gridDataset: DatasetDefinition | undefined): string | null {
  const [root, name, member] = reference;
  const text = reference.join('.');
  if (root === 'vars' || root === 'params') {
    const declared = root === 'vars' ? context.form.variables : context.form.params;
    if (reference.length !== 2 || name === undefined) return `"${text}" should look like ${root}.name`;
    return declared && Object.hasOwn(declared, name) ? null : `No ${root === 'vars' ? 'variable' : 'parameter'} named "${name}"`;
  }
  if (root === 'ds') {
    if (reference.length !== 3 || name === undefined || member === undefined) return `"${text}" should look like ds.dataset.column`;
    const dataset = context.datasets.get(name);
    if (!dataset) return `No Dataset named "${name}"`;
    if (COLUMN_FIELDS.has(member) || dataset.columns.some((column) => column.id === member)) return null;
    return `Dataset "${name}" has no column "${member}"`;
  }
  if (gridDataset && reference.length === 1 && root !== undefined) {
    return gridDataset.columns.some((column) => column.id === root) ? null : `Dataset "${gridDataset.id}" has no column "${root}"`;
  }
  return `"${text}" doesn't refer to anything. Use vars., params. or ds.`;
}

const AGGREGATE_CALL = /(?<![\w$.])(sum|avg|min|max|count)\s*\(\s*([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\)/g;
const NUMERIC_TYPES = new Set(['int', 'float', 'decimal']);

/** The aggregate calls in an expression that already compiled. String literals are blanked first. */
function aggregateCalls(source: string): { name: string; path: string[] }[] {
  const blanked = source.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, (literal) => ' '.repeat(literal.length));
  return [...blanked.matchAll(AGGREGATE_CALL)].map((match) => ({
    name: match[1] as string,
    path: (match[2] as string).split('.').map((part) => part.trim()),
  }));
}

function checkAggregates(
  source: string,
  path: string,
  context: Context,
  gridDataset: DatasetDefinition | undefined,
  out: Diagnostic[],
): void {
  for (const { name, path: reference } of aggregateCalls(source)) {
    const text = reference.join('.');
    // A bad reference is already reported as a plain read.
    if (unknownReference(reference, context, gridDataset) !== null) continue;
    const dataset = reference[0] === 'ds' && reference.length === 3 ? context.datasets.get(reference[1] as string) : gridDataset;
    const columnId = reference[0] === 'ds' ? reference[2] : reference.length === 1 ? reference[0] : undefined;
    const column = dataset?.columns.find((candidate) => candidate.id === columnId);
    if (!column) {
      out.push({ severity: 'error', path, message: `${name}() needs a column, such as ds.dsEmp.salary, but "${text}" isn't one` });
    } else if ((name === 'sum' || name === 'avg') && !NUMERIC_TYPES.has(column.type)) {
      out.push({ severity: 'error', path, message: `${name}() needs an int, float or decimal column, but "${text}" is ${column.type}` });
    }
  }
}

function checkExpression(
  source: string,
  path: string,
  context: Context,
  gridDataset: DatasetDefinition | undefined,
  out: Diagnostic[],
): void {
  let compiled;
  try {
    compiled = compileExpression(source);
  } catch (failure) {
    // Anything but ExpressionError is a fault in the compiler, so it must not be hidden.
    if (!(failure instanceof ExpressionError)) throw failure;
    out.push({ severity: 'error', path, message: failure.message });
    return;
  }
  const reported = new Set<string>();
  for (const reference of compiled.paths) {
    const message = unknownReference(reference, context, gridDataset);
    if (message !== null && !reported.has(message)) {
      reported.add(message);
      out.push({ severity: 'error', path, message });
    }
  }
  checkAggregates(source, path, context, gridDataset, out);
}

const GRID_STRUCTURE = new Set(['columns', 'headerRows', 'recordRows', 'footerRows']);

function checkExpressions(
  component: ComponentDefinition,
  path: string,
  context: Context,
  gridDataset: DatasetDefinition | undefined,
  out: Diagnostic[],
): void {
  if (component.type === 'Grid') {
    // Footer cells are the only place a bare column name works: it means a column of the Grid's Dataset.
    const grid = component.props as unknown as GridProps;
    for (const section of ['headerRows', 'recordRows', 'footerRows'] as const) {
      grid[section]?.forEach((row, r) => {
        row.cells.forEach((cell, c) => {
          if (isExpression(cell.value)) {
            const where = `${path}.props.${section}[${r}].cells[${c}].value`;
            checkExpression(cell.value, where, context, section === 'footerRows' ? gridDataset : undefined, out);
          }
        });
      });
    }
    for (const [name, value] of Object.entries(grid)) {
      if (!GRID_STRUCTURE.has(name) && isExpression(value)) checkExpression(value, `${path}.props.${name}`, context, undefined, out);
    }
    return;
  }
  for (const [name, value] of Object.entries(component.props ?? {})) {
    if (isExpression(value)) checkExpression(value, `${path}.props.${name}`, context, undefined, out);
  }
}

function checkAgainstMeta(component: ComponentDefinition, path: string, meta: ComponentMeta | undefined, context: Context, out: Diagnostic[]): void {
  // Until a Grid meta exists, Grid is never reported as unknown. Its props are checked by checkGrid.
  if (!context.components || (component.type === 'Grid' && !meta)) return;
  if (!meta) {
    out.push({ severity: 'warning', path: `${path}.type`, message: `Unknown component type "${component.type}"` });
    return;
  }
  for (const name of Object.keys(component.props ?? {})) {
    if (!Object.hasOwn(meta.props, name)) {
      out.push({ severity: 'warning', path: `${path}.props.${name}`, message: `${component.type} has no prop "${name}"` });
    }
  }
  for (const name of Object.keys(component.events ?? {})) {
    if (!Object.hasOwn(meta.events, name)) {
      out.push({ severity: 'error', path: `${path}.events.${name}`, message: `${component.type} has no event "${name}"` });
    }
  }
  if (meta.category === 'input' && Object.hasOwn(meta.props, 'label') && component.props?.label === undefined) {
    out.push({
      severity: 'warning',
      path: `${path}.props.label`,
      message: `${component.type} has no label, so it has no visible name`,
    });
  }
  for (const key of Object.keys(component.bind ?? {})) {
    if (!Object.hasOwn(meta.bindings, key)) {
      out.push({ severity: 'error', path: `${path}.bind.${key}`, message: `${component.type} can't bind "${key}"` });
    }
  }
}

function checkComponent(component: ComponentDefinition, path: string, context: Context, out: Diagnostic[]): void {
  const { datasets } = context;
  context.ids.push(component.id);
  checkLayout(component, path, out);

  const meta = context.components?.[component.type];
  checkAgainstMeta(component, path, meta, context, out);

  let boundDataset: DatasetDefinition | undefined;
  for (const [property, target] of Object.entries(component.bind ?? {})) {
    const where = `${path}.bind.${property}`;
    const kind = meta?.bindings[property];
    if (kind === 'dataset' || (kind === undefined && DATASET_LEVEL_KEYS.has(property))) {
      const dataset = datasets.get(target);
      if (property === 'dataset') boundDataset = dataset;
      if (!dataset) out.push({ severity: 'error', path: where, message: `No Dataset named "${target}"` });
      continue;
    }
    const dot = target.indexOf('.');
    const dataset = datasets.get(target.slice(0, dot));
    if (dot === -1) {
      out.push({ severity: 'error', path: where, message: `"${target}" should look like dataset.column` });
    } else if (!dataset) {
      out.push({ severity: 'error', path: where, message: `No Dataset named "${target.slice(0, dot)}"` });
    } else if (!dataset.columns.some((column) => column.id === target.slice(dot + 1))) {
      out.push({ severity: 'error', path: where, message: `Dataset "${dataset.id}" has no column "${target.slice(dot + 1)}"` });
    }
  }

  const optionsDataset = datasets.get(component.bind?.options ?? '');
  if (optionsDataset) {
    for (const prop of ['optionValue', 'optionLabel']) {
      const column = component.props?.[prop];
      if (typeof column === 'string' && !optionsDataset.columns.some((candidate) => candidate.id === column)) {
        out.push({ severity: 'error', path: `${path}.props.${prop}`, message: `Dataset "${optionsDataset.id}" has no column "${column}"` });
      }
    }
  }

  if (component.type === 'Grid') checkGrid(component, path, boundDataset, datasets, out);
  checkExpressions(component, path, context, boundDataset, out);

  component.children?.forEach((child, i) => checkComponent(child, `${path}.children[${i}]`, context, out));
}

/** Checks a form the schema can't: names that must exist, ids that must be unique, Grid cell placement, expressions. */
export function checkSemantics(form: FormDefinition, options: CheckOptions = {}): Diagnostic[] {
  const out: Diagnostic[] = [];
  const datasets = new Map((form.datasets ?? []).map((dataset) => [dataset.id, dataset]));
  checkDuplicates((form.datasets ?? []).map((dataset) => dataset.id), 'Datasets', 'datasets', out);
  form.datasets?.forEach((dataset, i) => checkDataset(dataset, `datasets[${i}]`, out));

  for (const [section, typedValues] of [['variables', form.variables], ['params', form.params], ['result', form.result]] as const) {
    for (const [name, typed] of Object.entries(typedValues ?? {})) {
      if (typed.default === undefined) continue;
      try {
        coerceValue({ id: name, type: typed.type }, typed.default);
      } catch (failure) {
        out.push({ severity: 'error', path: `${section}.${name}.default`, message: (failure as Error).message });
      }
    }
  }
  if (options.components) {
    for (const name of Object.keys(form.events ?? {})) {
      if (!FORM_EVENTS.has(name)) out.push({ severity: 'error', path: `events.${name}`, message: `A form has no event "${name}"` });
    }
  }

  const context: Context = { form, datasets, components: options.components, ids: [] };
  form.components.forEach((component, i) => checkComponent(component, `components[${i}]`, context, out));
  checkDuplicates(context.ids, 'components', 'components', out);

  warnUnknownKeys(form as unknown as JsonObject, 'form', '', out);
  return out;
}

/** All problems with a form. Semantic checks only run once the structure is valid. */
export function validateForm(form: unknown, options: CheckOptions = {}): Diagnostic[] {
  const schemaErrors = checkSchema(form);
  return schemaErrors.length > 0 ? schemaErrors : checkSemantics(form as FormDefinition, options);
}
