import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, inRange, isIsoDate, overlap } from './dates';

describe('dates', () => {
  it('validates real calendar dates only', () => {
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('2026-3-1')).toBe(false);
    expect(isIsoDate('03/01/2026')).toBe(false);
  });

  it('counts days across month, year and DST boundaries', () => {
    expect(daysBetween('2026-01-31', '2026-02-01')).toBe(1);
    expect(daysBetween('2025-12-31', '2026-01-01')).toBe(1);
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2);
    expect(daysBetween('2026-03-09', '2026-03-07')).toBe(-2);
    expect(addDays('2026-02-27', 3)).toBe('2026-03-02');
  });

  it('rejects invalid dates instead of guessing', () => {
    expect(() => daysBetween('2026-02-30', '2026-03-01')).toThrow(RangeError);
    expect(inRange('2026-02-30', { start: '2026-01-01', end: '2026-12-31' })).toBe(false);
  });

  it('computes inclusive overlaps', () => {
    expect(overlap({ start: '2026-01-15', end: '2026-02-14' }, { start: '2026-02-01', end: '2026-02-28' })).toEqual({
      start: '2026-02-01',
      end: '2026-02-14',
    });
    expect(overlap({ start: '2026-01-01', end: '2026-01-31' }, { start: '2026-01-31', end: '2026-02-28' })).toEqual({
      start: '2026-01-31',
      end: '2026-01-31',
    });
    expect(overlap({ start: '2026-01-01', end: '2026-01-30' }, { start: '2026-01-31', end: '2026-02-28' })).toBeNull();
  });
});
