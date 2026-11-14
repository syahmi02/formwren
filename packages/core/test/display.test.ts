import { describe, expect, it } from 'vitest';
import { formatValue } from '../src/index.ts';

describe('formatValue: decimal', () => {
  const long = '12345678901234567890.125';
  it('shows text as is with no pattern', () => {
    expect(formatValue(long, 'decimal')).toBe(long);
    expect(formatValue('-0.50', 'decimal')).toBe('-0.50');
  });
  it('keeps every digit of long values through each pattern', () => {
    expect(formatValue(long, 'decimal', '#,##0')).toBe('12,345,678,901,234,567,890');
    expect(formatValue(long, 'decimal', '#,##0.00')).toBe('12,345,678,901,234,567,890.13');
    expect(formatValue(long, 'decimal', '0.00')).toBe('12345678901234567890.13');
    expect(formatValue(long, 'decimal', '0')).toBe('12345678901234567890');
    expect(formatValue(long, 'decimal', '#,##0.##')).toBe('12,345,678,901,234,567,890.13');
    expect(formatValue('99999999999999999999.999', 'decimal', '#,##0.00')).toBe('100,000,000,000,000,000,000.00');
  });
  it('rounds half away from zero', () => {
    expect(formatValue('2.5', 'decimal', '0')).toBe('3');
    expect(formatValue('-2.5', 'decimal', '0')).toBe('-3');
    expect(formatValue('1.005', 'decimal', '0.00')).toBe('1.01');
    expect(formatValue('-1.005', 'decimal', '0.00')).toBe('-1.01');
    expect(formatValue('1.004', 'decimal', '0.00')).toBe('1.00');
  });
  it('carries across a group', () => {
    expect(formatValue('999.995', 'decimal', '#,##0.00')).toBe('1,000.00');
    expect(formatValue('999999.5', 'decimal', '#,##0')).toBe('1,000,000');
    expect(formatValue('-999.995', 'decimal', '#,##0.00')).toBe('-1,000.00');
  });
  it('pads and trims fraction digits', () => {
    expect(formatValue('5', 'decimal', '#,##0.00')).toBe('5.00');
    expect(formatValue('5.1', 'decimal', '#,##0.##')).toBe('5.1');
    expect(formatValue('5.10', 'decimal', '#,##0.##')).toBe('5.1');
    expect(formatValue('5.00', 'decimal', '#,##0.##')).toBe('5');
    expect(formatValue('5.005', 'decimal', '#,##0.##')).toBe('5.01');
  });
  it('handles zero and negatives', () => {
    expect(formatValue('0', 'decimal', '#,##0.00')).toBe('0.00');
    expect(formatValue('0.00', 'decimal', '#,##0')).toBe('0');
    expect(formatValue('-0.001', 'decimal', '0.00')).toBe('0.00');
    expect(formatValue('-1234.5', 'decimal', '#,##0.00')).toBe('-1,234.50');
    expect(formatValue('-0.5', 'decimal', '#,##0.00')).toBe('-0.50');
    expect(formatValue('000123.4', 'decimal', '#,##0.0')).toBe('123.4');
  });
  it('groups at the right places', () => {
    expect(formatValue('1', 'decimal', '#,##0')).toBe('1');
    expect(formatValue('123', 'decimal', '#,##0')).toBe('123');
    expect(formatValue('1234', 'decimal', '#,##0')).toBe('1,234');
    expect(formatValue('123456', 'decimal', '#,##0')).toBe('123,456');
    expect(formatValue('1234567', 'decimal', '#,##0')).toBe('1,234,567');
  });
});

describe('formatValue: int and float', () => {
  it('groups with no pattern', () => {
    expect(formatValue(1234567, 'int')).toBe('1,234,567');
    expect(formatValue(-1234, 'int')).toBe('-1,234');
    expect(formatValue(1234.5678, 'float')).toBe('1,234.5678');
  });
  it('applies patterns', () => {
    expect(formatValue(1234.5, 'float', '#,##0.00')).toBe('1,234.50');
    expect(formatValue(1234.5, 'float', '0.00')).toBe('1234.50');
    expect(formatValue(1234567, 'int', '0')).toBe('1234567');
    expect(formatValue(1234.5, 'float', '#,##0.##')).toBe('1,234.5');
    expect(formatValue(1234, 'float', '#,##0.##')).toBe('1,234');
    expect(formatValue(2.5, 'float', '0')).toBe('3');
    expect(formatValue(-2.5, 'float', '0')).toBe('-3');
    expect(formatValue(0, 'int', '#,##0.00')).toBe('0.00');
    expect(formatValue(-0.001, 'float', '0.00')).toBe('0.00');
    expect(formatValue(999999.5, 'float', '#,##0')).toBe('1,000,000');
  });
});

describe('formatValue: date and datetime', () => {
  it('shows text as is with no pattern', () => {
    expect(formatValue('2026-03-05', 'date')).toBe('2026-03-05');
    expect(formatValue('2026-03-05T14:07:09', 'datetime')).toBe('2026-03-05T14:07:09');
  });
  it('formats dates from their parts', () => {
    expect(formatValue('2026-03-05', 'date', 'MM/dd/yyyy')).toBe('03/05/2026');
    expect(formatValue('2026-03-05', 'date', 'MMM d, yyyy')).toBe('Mar 5, 2026');
    expect(formatValue('2026-12-31', 'date', 'MMM d, yyyy')).toBe('Dec 31, 2026');
    expect(formatValue('2026-01-01', 'date', 'MM/dd/yyyy')).toBe('01/01/2026');
  });
  it('formats datetimes', () => {
    const v = '2026-03-05T14:07:09';
    expect(formatValue(v, 'datetime', 'MM/dd/yyyy HH:mm')).toBe('03/05/2026 14:07');
    expect(formatValue(v, 'datetime', 'MM/dd/yyyy HH:mm:ss')).toBe('03/05/2026 14:07:09');
    expect(formatValue(v, 'datetime', 'MMM d, yyyy HH:mm')).toBe('Mar 5, 2026 14:07');
    expect(formatValue(v, 'datetime', 'MMM d, yyyy')).toBe('Mar 5, 2026');
    expect(formatValue('2026-03-05T00:00:00.250', 'datetime', 'MM/dd/yyyy HH:mm:ss')).toBe('03/05/2026 00:00:00');
  });
});

describe('formatValue: other', () => {
  it('formats booleans', () => {
    expect(formatValue(true, 'boolean')).toBe('Yes');
    expect(formatValue(false, 'boolean')).toBe('No');
  });
  it('gives empty text for null', () => {
    for (const t of ['string', 'int', 'decimal', 'float', 'boolean', 'date', 'datetime'] as const) {
      expect(formatValue(null, t)).toBe('');
      expect(formatValue(null, t, 'nonsense')).toBe('');
    }
  });
  it('returns strings unchanged', () => {
    expect(formatValue('abc', 'string')).toBe('abc');
  });
  it('throws on unknown patterns', () => {
    expect(() => formatValue('1.5', 'decimal', '#.#')).toThrow(/Unknown number pattern/);
    expect(() => formatValue(1, 'int', 'abc')).toThrow(/Unknown number pattern/);
    expect(() => formatValue(1, 'float', '0.')).toThrow(/Unknown number pattern/);
    expect(() => formatValue('2026-03-05', 'date', 'dd.MM.yy')).toThrow(/Unknown date pattern/);
    expect(() => formatValue('2026-03-05', 'date', 'MM/dd/yyyy HH:mm')).toThrow(/Unknown date pattern/);
    expect(() => formatValue('2026-03-05T01:02:03', 'datetime', 'HH:mm')).toThrow(/Unknown datetime pattern/);
  });
});
