import { isDecimal } from '../decimal.ts';
import { coerceValue, type CellValue, type ColumnDef } from '../values.ts';

const THOUSANDS = /^[+-]?\d{1,3}(,\d{3})+(\.\d*)?$/;
const INTEGER = /^[+-]?\d+$/;
const FLOAT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Removes thousands commas, but only where they sit in valid places, so "1,2" still fails. */
function stripThousands(text: string): string {
  return THOUSANDS.test(text) ? text.replace(/,/g, '') : text;
}

/** Thrown when text doesn't fit a column. `write` turns it into a false result. */
export class TextParseError extends Error {}

function fail(column: ColumnDef, text: string): never {
  throw new TextParseError(`"${text}" isn't a valid ${column.type} for column "${column.id}"`);
}

/**
 * Turns text from an input into a value for the column. An empty string is null, and nothing is
 * rounded or guessed. A decimal stays exact text.
 */
export function parseText(column: ColumnDef, text: string): CellValue {
  const trimmed = column.type === 'string' ? text : text.trim();
  if (trimmed === '') return null;
  switch (column.type) {
    case 'string':
      return text;
    case 'int': {
      const cleaned = stripThousands(trimmed);
      if (!INTEGER.test(cleaned)) return fail(column, text);
      const value = Number(cleaned);
      return Number.isSafeInteger(value) ? value : fail(column, text);
    }
    case 'float': {
      const cleaned = stripThousands(trimmed);
      if (!FLOAT.test(cleaned)) return fail(column, text);
      const value = Number(cleaned);
      return Number.isFinite(value) ? value : fail(column, text);
    }
    case 'decimal': {
      const cleaned = stripThousands(trimmed);
      return isDecimal(cleaned) ? cleaned : fail(column, text);
    }
    case 'boolean': {
      const lower = trimmed.toLowerCase();
      if (lower === 'true') return true;
      if (lower === 'false') return false;
      return fail(column, text);
    }
    case 'date':
    case 'datetime':
      try {
        return coerceValue(column, trimmed);
      } catch {
        return fail(column, text);
      }
  }
}

/** Parses text, or checks any other value against the column. Throws if it doesn't fit. */
export function toCellValue(column: ColumnDef, value: unknown): CellValue {
  return typeof value === 'string' ? parseText(column, value) : coerceValue(column, value);
}

export function shallowEqual(a: Readonly<Record<string, unknown>>, b: Readonly<Record<string, unknown>>): boolean {
  if (a === b) return true;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(b, key) || !Object.is(a[key], b[key])) return false;
  }
  return true;
}
