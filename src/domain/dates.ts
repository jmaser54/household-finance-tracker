import type { IsoDate } from './types';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date in "YYYY-MM-DD" form (rejects 2026-02-30). */
export function isIsoDate(value: string): value is IsoDate {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function toDayNumber(date: IsoDate): number {
  if (!isIsoDate(date)) throw new RangeError('Invalid calendar date');
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

/** Whole days from `a` to `b` (positive when b is later). Time-zone independent. */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return toDayNumber(b) - toDayNumber(a);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return new Date((toDayNumber(date) + days) * 86_400_000).toISOString().slice(0, 10);
}

/** Inclusive date range. */
export interface DateRange {
  start: IsoDate;
  end: IsoDate;
}

export function inRange(date: IsoDate, range: DateRange): boolean {
  // ISO dates compare correctly as strings once validated.
  return isIsoDate(date) && date >= range.start && date <= range.end;
}

/** The inclusive overlap of two ranges, or null when they do not overlap. */
export function overlap(a: DateRange, b: DateRange): DateRange | null {
  const start = a.start > b.start ? a.start : b.start;
  const end = a.end < b.end ? a.end : b.end;
  return start <= end ? { start, end } : null;
}
