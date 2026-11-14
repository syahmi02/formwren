import { decRound } from '../decimal.ts';
import type { CellValue, ColumnType } from '../values.ts';

const NUMBER_PATTERN = /^(#,##0|0)(?:\.(0*#*))?$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DATE_PARTS = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_PARTS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/;

interface NumberShape {
  grouping: boolean;
  minFraction: number;
  maxFraction: number;
}

const shapes = new Map<string, NumberShape>();

function parseNumberPattern(pattern: string, type: ColumnType): NumberShape {
  const cached = shapes.get(pattern);
  if (cached) return cached;
  const shape = parseShape(pattern, type);
  shapes.set(pattern, shape);
  return shape;
}

function parseShape(pattern: string, type: ColumnType): NumberShape {
  const match = NUMBER_PATTERN.exec(pattern);
  if (!match || match[2] === '') {
    throw new Error(`Unknown number pattern "${pattern}" for a ${type} value. Use #,##0 #,##0.00 0 0.00 or #,##0.##`);
  }
  const fraction = match[2] ?? '';
  return {
    grouping: match[1] === '#,##0',
    minFraction: fraction.replace(/#/g, '').length,
    maxFraction: fraction.length,
  };
}

function groupDigits(digits: string): string {
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return out;
}

/** Formats decimal text with string operations only, so no digit is ever lost. */
function formatDecimal(text: string, pattern: string | undefined): string {
  if (pattern === undefined) return text;
  const shape = parseNumberPattern(pattern, 'decimal');
  const rounded = decRound(text, shape.maxFraction);
  const negative = rounded.startsWith('-');
  const body = negative ? rounded.slice(1) : rounded;
  const dot = body.indexOf('.');
  const integer = dot === -1 ? body : body.slice(0, dot);
  let fraction = dot === -1 ? '' : body.slice(dot + 1);
  while (fraction.length > shape.minFraction && fraction.endsWith('0')) fraction = fraction.slice(0, -1);
  const head = shape.grouping ? groupDigits(integer) : integer;
  return (negative ? '-' : '') + head + (fraction ? `.${fraction}` : '');
}

/** One formatter per type and pattern. A Grid formats thousands of cells per scroll. */
const formatters = new Map<string, Intl.NumberFormat>();

function numberFormatter(type: ColumnType, pattern: string | undefined): Intl.NumberFormat {
  const key = `${type}|${pattern ?? ''}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    if (pattern === undefined) {
      formatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: type === 'float' ? 20 : 0 });
    } else {
      const shape = parseNumberPattern(pattern, type);
      formatter = new Intl.NumberFormat('en-US', {
        useGrouping: shape.grouping,
        minimumFractionDigits: shape.minFraction,
        maximumFractionDigits: shape.maxFraction,
        roundingMode: 'halfExpand',
      } as Intl.NumberFormatOptions);
    }
    formatters.set(key, formatter);
  }
  return formatter;
}

function formatNumber(value: number, type: ColumnType, pattern: string | undefined): string {
  if (pattern === undefined) return numberFormatter(type, pattern).format(value);
  const text = numberFormatter(type, pattern).format(value);
  // A negative that rounds to zero would show as "-0.00".
  return /^-[0.,]*$/.test(text) ? text.slice(1) : text;
}

function pad(n: string): string {
  return n.padStart(2, '0');
}

const DATE_FORMATS: Record<string, (y: string, m: number, d: number) => string> = {
  'MM/dd/yyyy': (y, m, d) => `${pad(String(m))}/${pad(String(d))}/${y}`,
  'MMM d, yyyy': (y, m, d) => `${MONTHS[m - 1]} ${d}, ${y}`,
  'yyyy-MM-dd': (y, m, d) => `${y}-${pad(String(m))}-${pad(String(d))}`,
};

function formatDateTime(text: string, type: 'date' | 'datetime', pattern: string | undefined): string {
  if (pattern === undefined) return text;
  let datePattern = pattern;
  let time: 'HH:mm' | 'HH:mm:ss' | undefined;
  if (type === 'datetime') {
    for (const suffix of [' HH:mm:ss', ' HH:mm'] as const) {
      if (pattern.endsWith(suffix)) {
        datePattern = pattern.slice(0, -suffix.length);
        time = suffix.slice(1) as 'HH:mm' | 'HH:mm:ss';
        break;
      }
    }
  }
  const render = DATE_FORMATS[datePattern];
  if (!render) {
    throw new Error(
      `Unknown ${type} pattern "${pattern}". Use MM/dd/yyyy, MMM d, yyyy or yyyy-MM-dd` +
        (type === 'datetime' ? ', optionally followed by " HH:mm" or " HH:mm:ss"' : ''),
    );
  }
  const match = (type === 'date' ? DATE_PARTS : DATETIME_PARTS).exec(text);
  if (!match) throw new TypeError(`Not a ${type} text: ${JSON.stringify(text)}`);
  const out = render(match[1] as string, Number(match[2]), Number(match[3]));
  if (!time) return out;
  const clock = `${match[4]}:${match[5]}`;
  return `${out} ${time === 'HH:mm' ? clock : `${clock}:${match[6]}`}`;
}

/**
 * Text to show for a value. Decimals are formatted from their text, never through a double.
 * `pattern` is like "#,##0.00". Empty values give "".
 */
export function formatValue(value: CellValue, type: ColumnType, pattern?: string): string {
  if (value === null || value === undefined) return '';
  switch (type) {
    case 'string':
      return String(value);
    case 'boolean':
      return value ? 'Yes' : 'No';
    case 'decimal':
      return formatDecimal(String(value), pattern);
    case 'int':
    case 'float':
      return formatNumber(Number(value), type, pattern);
    case 'date':
    case 'datetime':
      return formatDateTime(String(value), type, pattern);
  }
}
