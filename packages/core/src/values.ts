import { decCompare, isDecimal } from './decimal.ts';

export const COLUMN_TYPES = ['string', 'int', 'decimal', 'float', 'boolean', 'date', 'datetime'] as const;

export type ColumnType = (typeof COLUMN_TYPES)[number];

/**
 * How each column type is held in memory:
 * string, decimal, date ("YYYY-MM-DD") and datetime ("YYYY-MM-DDTHH:mm:ss") are strings,
 * int and float are numbers, boolean is a boolean, and empty is null.
 */
export type CellValue = string | number | boolean | null;

export interface ColumnDef {
  id: string;
  type: ColumnType;
  label?: string;
  size?: number;
  precision?: number;
  scale?: number;
  required?: boolean;
  min?: number | string;
  max?: number | string;
  pattern?: string;
  /** The row's version: sent to the server, which checks and increments it. At most one per Dataset, and an int. */
  version?: boolean;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?$/;

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (lengths[month - 1] as number);
}

export function isDateText(text: string): boolean {
  const match = DATE_PATTERN.exec(text);
  return match !== null && isRealDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

export function isDateTimeText(text: string): boolean {
  const match = DATETIME_PATTERN.exec(text);
  return (
    match !== null &&
    isRealDate(Number(match[1]), Number(match[2]), Number(match[3])) &&
    Number(match[4]) <= 23 &&
    Number(match[5]) <= 59 &&
    Number(match[6]) <= 59
  );
}

function reject(column: ColumnDef, raw: unknown): never {
  throw new TypeError(`Column "${column.id}" (${column.type}) can't hold ${JSON.stringify(raw) ?? String(raw)}`);
}

/**
 * Checks a value against its column type. Nothing is rounded or guessed: a value that doesn't
 * fit exactly is an error, so bad data can't enter a Dataset silently.
 */
export function coerceValue(column: ColumnDef, raw: unknown): CellValue {
  if (raw === null || raw === undefined) return null;
  switch (column.type) {
    case 'string':
      return typeof raw === 'string' ? raw : reject(column, raw);
    case 'int':
      return Number.isSafeInteger(raw) ? (raw as number) : reject(column, raw);
    case 'float':
      return typeof raw === 'number' && Number.isFinite(raw) ? raw : reject(column, raw);
    case 'boolean':
      return typeof raw === 'boolean' ? raw : reject(column, raw);
    case 'decimal':
      if (typeof raw === 'string' && isDecimal(raw)) return raw;
      if (Number.isSafeInteger(raw)) return String(raw);
      return reject(column, raw);
    case 'date':
      return typeof raw === 'string' && isDateText(raw) ? raw : reject(column, raw);
    case 'datetime':
      return typeof raw === 'string' && isDateTimeText(raw) ? raw : reject(column, raw);
  }
}

export function valuesEqual(type: ColumnType, a: CellValue, b: CellValue): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return type === 'decimal' ? decCompare(a as string, b as string) === 0 : false;
}

const textCollator = new Intl.Collator('en');

/** Compares two non-null values of one column type. */
export function compareValues(type: ColumnType, a: CellValue, b: CellValue): number {
  switch (type) {
    case 'string':
      return textCollator.compare(a as string, b as string);
    case 'int':
    case 'float':
      return (a as number) - (b as number);
    case 'boolean':
      return Number(a) - Number(b);
    case 'decimal':
      return decCompare(a as string, b as string);
    case 'date':
    case 'datetime':
      return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;
  }
}
