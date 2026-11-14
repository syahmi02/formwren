/**
 * Finds and rewrites everything in a form that refers to a Dataset or one of its columns:
 * bindings, Grid cell fields and options, option columns, and `=` expressions.
 */
import { compileExpression, type ComponentDefinition, type ComponentMeta, type FormDefinition } from '@fw/core';
import { CommandError } from './command-base.ts';

export interface RefSpec {
  dataset: string;
  /** Only references to this column. Without it, every reference to the Dataset, columns included. */
  column?: string;
  /** The new name of the Dataset (no `column`) or of the column. Without it, references are only listed. */
  to?: string;
}

export interface RefResult {
  form: FormDefinition;
  /** Where the references are, such as `components[2].bind.value`. For an expression that can't be read, where it is. */
  uses: string[];
}

type Metas = Readonly<Record<string, ComponentMeta>> | undefined;

interface Chain {
  parts: string[];
  spans: [number, number][];
  followedByParen: boolean;
}

const isStart = (ch: string): boolean => /[A-Za-z_$]/.test(ch);
const isPart = (ch: string): boolean => /[A-Za-z0-9_$]/.test(ch);

/** Every name chain in an expression, such as `ds.dsEmp.salary`, with where each part is. Strings and numbers are skipped. */
function chains(src: string): Chain[] {
  const out: Chain[] = [];
  let i = 1;
  const skipSpace = (at: number): number => {
    while (/\s/.test(src.charAt(at)) && at < src.length) at++;
    return at;
  };
  while (i < src.length) {
    const ch = src.charAt(i);
    if (ch === '"' || ch === "'") {
      i++;
      while (i < src.length && src.charAt(i) !== ch) i += src.charAt(i) === '\\' ? 2 : 1;
      i++;
    } else if (/[0-9]/.test(ch)) {
      while (/[0-9.]/.test(src.charAt(i)) && i < src.length) i++;
    } else if (isStart(ch)) {
      const parts: string[] = [];
      const spans: [number, number][] = [];
      for (;;) {
        const start = i;
        while (i < src.length && isPart(src.charAt(i))) i++;
        parts.push(src.slice(start, i));
        spans.push([start, i]);
        const dot = skipSpace(i);
        const next = skipSpace(dot + 1);
        if (src.charAt(dot) === '.' && isStart(src.charAt(next))) i = next;
        else break;
      }
      out.push({ parts, spans, followedByParen: src.charAt(skipSpace(i)) === '(' });
    } else {
      i++;
    }
  }
  return out;
}

const RESERVED = new Set(['true', 'false', 'null', 'vars', 'params', 'ds']);

/** The expression with references rewritten, and whether it holds any. `bare` is the Dataset that bare column names mean (Grid footers). */
function rewriteExpression(src: string, spec: RefSpec, bare: string | undefined): { text: string; found: boolean } {
  const replacements: { span: [number, number]; text: string }[] = [];
  let found = false;
  for (const chain of chains(src)) {
    const [root, name, member] = chain.parts;
    if (root === 'ds' && chain.parts.length >= 2 && name === spec.dataset) {
      if (spec.column === undefined) {
        found = true;
        if (spec.to !== undefined) replacements.push({ span: chain.spans[1] as [number, number], text: spec.to });
      } else if (member === spec.column) {
        found = true;
        if (spec.to !== undefined) replacements.push({ span: chain.spans[2] as [number, number], text: spec.to });
      }
    } else if (bare === spec.dataset && chain.parts.length === 1 && !chain.followedByParen && !RESERVED.has(root as string)) {
      // A bare name in a Grid footer means a column of the Grid's Dataset.
      if (spec.column !== undefined && root === spec.column) {
        found = true;
        if (spec.to !== undefined) replacements.push({ span: chain.spans[0] as [number, number], text: spec.to });
      }
    }
  }
  let text = src;
  for (const { span, text: replacement } of replacements.sort((a, b) => b.span[0] - a.span[0])) {
    text = text.slice(0, span[0]) + replacement + text.slice(span[1]);
  }
  return { text, found };
}

/** The first line of work for one expression: rewrite it, or say it can't be read. */
function handleExpression(src: string, where: string, spec: RefSpec, bare: string | undefined, uses: string[]): string {
  const names = [spec.dataset, spec.column].filter((n): n is string => n !== undefined);
  try {
    compileExpression(src);
  } catch {
    // Can't be read, so it can't be rewritten safely. It only matters if it mentions the name.
    if (names.some((name) => src.includes(name))) uses.push(`${where} (an expression that can't be read, so it can't be rewritten)`);
    return src;
  }
  const { text, found } = rewriteExpression(src, spec, bare);
  if (!found) return src;
  uses.push(where);
  if (spec.to === undefined) return src;
  try {
    compileExpression(text);
  } catch {
    throw new CommandError(`The expression at ${where} can't be rewritten safely`);
  }
  return text;
}

/** Applies `change` to every `=` string inside a value, returning the same object when nothing changed. */
function mapExpressions(value: unknown, where: string, change: (src: string, where: string) => string): unknown {
  if (typeof value === 'string') return value.startsWith('=') ? change(value, where) : value;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item, i) => {
      const result = mapExpressions(item, `${where}[${i}]`, change);
      if (result !== item) changed = true;
      return result;
    });
    return changed ? next : value;
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const result = mapExpressions(item, `${where}.${key}`, change);
      if (result !== item) changed = true;
      next[key] = result;
    }
    return changed ? next : value;
  }
  return value;
}

function bindKind(key: string, meta: ComponentMeta | undefined): 'column' | 'dataset' {
  return meta?.bindings[key] ?? (key === 'dataset' || key === 'options' ? 'dataset' : 'column');
}

function refsOfComponent(component: ComponentDefinition, path: string, spec: RefSpec, metas: Metas, uses: string[]): ComponentDefinition {
  let next = component;
  const meta = metas?.[component.type];
  const rename = spec.to !== undefined;

  if (component.bind) {
    const bind: Record<string, string> = { ...component.bind };
    let changed = false;
    for (const [key, value] of Object.entries(component.bind)) {
      const where = `${path}.bind.${key}`;
      if (bindKind(key, meta) === 'dataset') {
        if (spec.column === undefined && value === spec.dataset) {
          uses.push(where);
          if (rename) {
            bind[key] = spec.to as string;
            changed = true;
          }
        }
        continue;
      }
      const dot = value.indexOf('.');
      if (dot < 0 || value.slice(0, dot) !== spec.dataset) continue;
      const column = value.slice(dot + 1);
      if (spec.column === undefined) {
        uses.push(where);
        if (rename) {
          bind[key] = `${spec.to as string}.${column}`;
          changed = true;
        }
      } else if (column === spec.column) {
        uses.push(where);
        if (rename) {
          bind[key] = `${spec.dataset}.${spec.to as string}`;
          changed = true;
        }
      }
    }
    if (changed) next = { ...next, bind };
  }

  // Option columns of a component whose options come from the Dataset.
  if (spec.column !== undefined && component.bind?.options === spec.dataset && next.props) {
    const props = { ...next.props };
    let changed = false;
    for (const prop of ['optionValue', 'optionLabel']) {
      if (props[prop] === spec.column) {
        uses.push(`${path}.props.${prop}`);
        if (rename) {
          props[prop] = spec.to;
          changed = true;
        }
      }
    }
    if (changed) next = { ...next, props };
  }

  if (next.props) {
    const gridDataset = component.type === 'Grid' ? component.bind?.dataset : undefined;
    const props: Record<string, unknown> = {};
    let changed = false;
    for (const [key, value] of Object.entries(next.props)) {
      const bare = key === 'footerRows' ? gridDataset : undefined;
      const result = mapExpressions(value, `${path}.props.${key}`, (src, where) => handleExpression(src, where, spec, bare, uses));
      if (result !== value) changed = true;
      props[key] = result;
    }
    if (changed) next = { ...next, props };
    if (component.type === 'Grid') next = refsOfGridCells(next, path, spec, gridDataset, uses);
  }

  if (next.children) {
    let changed = false;
    const children = next.children.map((child, i) => {
      const result = refsOfComponent(child, `${path}.children[${i}]`, spec, metas, uses);
      if (result !== child) changed = true;
      return result;
    });
    if (changed) next = { ...next, children };
  }
  return next;
}

/** Grid cells: `field` (a column of the Grid's Dataset), `options` (a Dataset) and the option columns. */
function refsOfGridCells(grid: ComponentDefinition, path: string, spec: RefSpec, gridDataset: string | undefined, uses: string[]): ComponentDefinition {
  const rename = spec.to !== undefined;
  const props: Record<string, unknown> = { ...grid.props };
  let changed = false;
  for (const section of ['headerRows', 'recordRows', 'footerRows']) {
    const rows = props[section];
    if (!Array.isArray(rows)) continue;
    const nextRows = rows.map((row: { cells?: Record<string, unknown>[] }, r: number) => {
      if (!Array.isArray(row.cells)) return row;
      let rowChanged = false;
      const cells = row.cells.map((cell, c) => {
        const at = `${path}.props.${section}[${r}].cells[${c}]`;
        const copy = { ...cell };
        let cellChanged = false;
        if (spec.column !== undefined && gridDataset === spec.dataset && copy.field === spec.column) {
          uses.push(`${at}.field`);
          if (rename) {
            copy.field = spec.to;
            cellChanged = true;
          }
        }
        if (typeof copy.options === 'string' && copy.options === spec.dataset) {
          if (spec.column === undefined) {
            uses.push(`${at}.options`);
            if (rename) {
              copy.options = spec.to;
              cellChanged = true;
            }
          } else {
            for (const prop of ['optionValue', 'optionLabel']) {
              if (copy[prop] === spec.column) {
                uses.push(`${at}.${prop}`);
                if (rename) {
                  copy[prop] = spec.to;
                  cellChanged = true;
                }
              }
            }
          }
        }
        if (cellChanged) rowChanged = true;
        return cellChanged ? copy : cell;
      });
      return rowChanged ? { ...row, cells } : row;
    });
    if (nextRows.some((row, i) => row !== rows[i])) {
      props[section] = nextRows;
      changed = true;
    }
  }
  return changed ? { ...grid, props } : grid;
}

/**
 * Finds every reference to a Dataset (or one of its columns), and, if `spec.to` is set, rewrites
 * them to the new name. Throws `CommandError` if an expression that holds a reference can't be rewritten.
 */
export function findRefs(form: FormDefinition, spec: RefSpec, metas?: Metas): RefResult {
  const uses: string[] = [];
  let changed = false;
  const components = form.components.map((component, i) => {
    const result = refsOfComponent(component, `components[${i}]`, spec, metas, uses);
    if (result !== component) changed = true;
    return result;
  });
  return { form: changed ? { ...form, components } : form, uses };
}

/** The refusal text for something that is still in use. */
export function inUseMessage(what: string, uses: readonly string[]): string {
  const shown = uses.slice(0, 5).join(', ');
  return `${what} is still used by ${shown}${uses.length > 5 ? ` and ${uses.length - 5} more` : ''}`;
}
