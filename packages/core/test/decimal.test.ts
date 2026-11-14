import { describe, expect, it } from 'vitest';
import { decAdd, decCompare, decDiv, decFits, decMul, decRound, decSub, decSum, isDecimal } from '../src/index.ts';

describe('decimal arithmetic', () => {
  it('stays exact where doubles do not', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(decAdd('0.1', '0.2')).toBe('0.3');
    expect(decSub('0.3', '0.1')).toBe('0.2');
    expect(decMul('1.1', '1.1')).toBe('1.21');
  });

  it('keeps digits a double would lose', () => {
    expect(decAdd('12345678901234567890.12', '0.01')).toBe('12345678901234567890.13');
    expect(decSum(['99999999999999999.99', '0.01'])).toBe('100000000000000000.00');
  });

  it('handles negative values and small magnitudes', () => {
    expect(decAdd('-1.50', '1.25')).toBe('-0.25');
    expect(decSub('0.001', '0.002')).toBe('-0.001');
    expect(decMul('-0.5', '0.5')).toBe('-0.25');
  });

  it('sums with the largest scale and skips nulls', () => {
    expect(decSum([])).toBe('0');
    expect(decSum([null, null])).toBe('0');
    expect(decSum(['1.5', null, '2.25', '3'])).toBe('6.75');
    expect(decSum(['1.10', '2.20'])).toBe('3.30');
  });

  it('rounds half away from zero', () => {
    expect(decRound('2.345', 2)).toBe('2.35');
    expect(decRound('-2.345', 2)).toBe('-2.35');
    expect(decRound('2.344', 2)).toBe('2.34');
    expect(decRound('2.5', 0)).toBe('3');
    expect(decRound('2', 2)).toBe('2.00');
  });

  it('divides to a stated scale', () => {
    expect(decDiv('10', '3', 2)).toBe('3.33');
    expect(decDiv('20', '3', 2)).toBe('6.67');
    expect(decDiv('-20', '3', 2)).toBe('-6.67');
    expect(decDiv('1.5', '0.5', 0)).toBe('3');
    expect(() => decDiv('1', '0', 2)).toThrow(RangeError);
  });

  it('rejects text that is not a decimal', () => {
    for (const bad of ['', '.5', '1.', '+1', '1e5', '1,000', ' 1', 'abc', '--1']) {
      expect(isDecimal(bad)).toBe(false);
    }
    expect(() => decAdd('abc', '1')).toThrow(TypeError);
  });
});

describe('decCompare', () => {
  // Each entry is greater than the one before it, or numerically equal when grouped.
  const ordered = [
    ['-100'],
    ['-20.5'],
    ['-2'],
    ['-1.51'],
    ['-1.5', '-1.50', '-01.5'],
    ['-0.001'],
    ['0', '-0', '0.00', '-0.0', '00', '000.000'],
    ['0.001'],
    ['0.5', '0.50'],
    ['1', '1.0', '01', '001.000'],
    ['1.5', '1.50'],
    ['1.51'],
    ['2'],
    ['10'],
    ['20.5'],
    ['100'],
    ['123456789012345678901234567890.5'],
  ];

  it('agrees with the numeric order for every pair', () => {
    ordered.forEach((groupA, i) => {
      ordered.forEach((groupB, j) => {
        for (const a of groupA) {
          for (const b of groupB) {
            expect(decCompare(a, b), `${a} vs ${b}`).toBe(Math.sign(i - j));
          }
        }
      });
    });
  });

  it('never returns negative zero', () => {
    expect(Object.is(decCompare('-1', '-1.0'), 0)).toBe(true);
  });
});

describe('decFits', () => {
  it('checks integer and fraction digits', () => {
    expect(decFits('1234.56', 6, 2)).toBe(true);
    expect(decFits('12345.6', 6, 2)).toBe(false);
    expect(decFits('1.234', 6, 2)).toBe(false);
    expect(decFits('1.230', 6, 2)).toBe(true);
    expect(decFits('0.99', 2, 2)).toBe(true);
    expect(decFits('-1234.56', 6, 2)).toBe(true);
    expect(decFits('000123', 3, 0)).toBe(true);
    expect(decFits('12345', undefined, undefined)).toBe(true);
    expect(decFits('12345', 4, undefined)).toBe(false);
  });
});
