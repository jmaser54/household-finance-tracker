import { describe, expect, it } from 'vitest';
import { formatExact, formatRounded, MoneyParseError, parseAmountToCents, sumCents } from './money';

describe('parseAmountToCents', () => {
  it.each([
    ['0.00', 0],
    ['12', 1200],
    ['12.5', 1250],
    ['12.05', 1205],
    ['1,234.56', 123456],
    ['$1,234.56', 123456],
    ['-12.00', -1200],
    ['-$12.00', -1200],
    ['$-12.00', -1200],
    ['(12.00)', -1200],
    ['($1,000.00)', -100000],
    ['12.00-', -1200],
    ['12.00 CR', 1200],
    ['12.00 DR', -1200],
    ['12.00cr', 1200],
    ['+7.10', 710],
    ['  45.99  ', 4599],
  ])('parses %j as %d cents', (input, expected) => {
    expect(parseAmountToCents(input)).toBe(expected);
  });

  it.each(['', 'abc', '12.345', '1,23.00', '12..00', '--12.00', '(12.00)-', '-12.00 DR', '1 234.00', '$'])(
    'rejects ambiguous or malformed input %j instead of guessing',
    (input) => {
      expect(() => parseAmountToCents(input)).toThrow(MoneyParseError);
    },
  );

  it('does not echo the input amount in the error message', () => {
    try {
      parseAmountToCents('9,87.65');
      expect.unreachable();
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('9,87.65');
    }
  });

  it('avoids floating-point drift', () => {
    expect(parseAmountToCents('0.29')).toBe(29);
    expect(parseAmountToCents('1.15')).toBe(115);
    expect(parseAmountToCents('4.35')).toBe(435);
  });
});

describe('sumCents', () => {
  it('adds exactly where floats would drift', () => {
    expect(sumCents([10, 20])).toBe(30); // 0.1 + 0.2
    expect(sumCents(Array.from({ length: 1000 }, () => 1))).toBe(1000);
  });

  it('rejects non-integer values', () => {
    expect(() => sumCents([1.5])).toThrow(TypeError);
  });
});

describe('formatting', () => {
  it('formats exact amounts with cents', () => {
    expect(formatExact(123456)).toBe('$1,234.56');
    expect(formatExact(-1200)).toBe('-$12.00');
  });

  it('formats summary amounts as whole dollars', () => {
    expect(formatRounded(123456)).toBe('$1,235');
    expect(formatRounded(123449)).toBe('$1,234');
    expect(formatRounded(-150)).toBe('-$2');
    expect(formatRounded(-49)).toBe('$0');
  });
});
