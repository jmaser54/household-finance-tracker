/**
 * Finds a statement's period from dates printed on it, never guessed
 * (PROJECT_PRINCIPLES.md §7). In order of preference:
 *  1. a printed range, "Statement period 03/01/2026 - 03/31/2026", in the
 *     common date styles, with its label on the line or the line before;
 *  2. a printed opening date and closing date ("Opening Date", "Closing Date");
 *  3. a printed closing date and "Days in billing cycle", as on some cards:
 *     the start is the closing date minus the days, plus one.
 * Anything else is "no period", and the statement is not read.
 */
import { addDays, isIsoDate } from '../../domain/dates';
import type { IsoDate } from '../../domain/types';
import type { TextLine } from '../pdfText';

export interface Period {
  start: IsoDate;
  end: IsoDate;
}

/** How the period was found, for the masked diagnostics. Fixed codes only. */
export type PeriodSource = 'range' | 'opening_and_closing_dates' | 'closing_date_and_cycle_days';

/** Long enough for quarterly savings statements. */
const MAX_PERIOD_DAYS = 100;

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const SEPARATOR = '\\s*(?:-|–|—|\\bto\\b|\\bthrough\\b|\\bthru\\b|\\band\\b)\\s*';

/** Full dates in the styles statements print, each with its year. */
const FULL_DATE = new RegExp(
  [
    '\\b\\d{1,2}[/-]\\d{1,2}[/-](?:\\d{4}|\\d{2})\\b', // 03/01/2026, 03-01-26
    '\\b\\d{4}-\\d{2}-\\d{2}\\b', // 2026-03-01
    `\\b${MONTH} \\d{1,2},? \\d{4}\\b`, // March 1, 2026
    `\\b\\d{1,2} ${MONTH},? \\d{4}\\b`, // 1 March 2026
  ].join('|'),
  'gi',
);

/** "March 1 - March 31, 2026" and "March 1 - 31, 2026": the year printed once, at the end. */
const RANGE_YEAR_ONCE = new RegExp(`\\b(${MONTH}) (\\d{1,2})${SEPARATOR}(?:(${MONTH}) )?(\\d{1,2}),? (\\d{4})\\b`, 'i');

const RANGE_LABEL = /\b(period|statement|dates?|cycle|opening|closing|from|for|beginning|covering)\b/i;
const OPENING_DATE = /\b(opening|beginning|start(?:ing)?|from) date\b/i;
const CLOSING_DATE = /\b(closing|ending|end|statement) date\b/i;
const CYCLE_DAYS = /\bdays in (?:the )?(?:billing )?(?:cycle|period)\b\D{0,10}(\d{1,2})\b/i;

function iso(year: number, month: number, day: number): IsoDate | null {
  const value = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isIsoDate(value) ? value : null;
}

function monthNumber(name: string): number {
  return MONTH_NAMES.indexOf(name.slice(0, 3).toLowerCase()) + 1;
}

/** Parses one full date in any of the FULL_DATE styles (month first for numeric dates, as in the US). */
export function parseFullDate(text: string): IsoDate | null {
  const t = text.trim().replace(/,/g, '').replace(/\./g, '');
  let m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})$/.exec(t);
  if (m) return iso(m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]), Number(m[1]), Number(m[2]));
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^([a-z]{3,9}) (\d{1,2}) (\d{4})$/i.exec(t);
  if (m && monthNumber(m[1]!) > 0) return iso(Number(m[3]), monthNumber(m[1]!), Number(m[2]));
  m = /^(\d{1,2}) ([a-z]{3,9}) (\d{4})$/i.exec(t);
  if (m && monthNumber(m[2]!) > 0) return iso(Number(m[3]), monthNumber(m[2]!), Number(m[1]));
  return null;
}

function datesIn(text: string): IsoDate[] {
  return [...text.matchAll(FULL_DATE)].map((m) => parseFullDate(m[0])).filter((d): d is IsoDate => d !== null);
}

/** A range on one piece of text: two full dates with a separator between them, or the year printed once. */
function rangeIn(text: string): Period | null {
  const matches = [...text.matchAll(FULL_DATE)];
  for (let i = 0; i + 1 < matches.length; i++) {
    const a = matches[i]!;
    const b = matches[i + 1]!;
    const between = text.slice(a.index! + a[0].length, b.index!);
    // "03/01/2026 - 03/31/2026", "March 1, 2026 through March 31, 2026", "beginning ... and ending ...".
    if (!new RegExp(`^${SEPARATOR}(?:(?:ending|closing|end)(?: on)?\\s*)?$`, 'i').test(between)) continue;
    const start = parseFullDate(a[0]);
    const end = parseFullDate(b[0]);
    if (start && end && start <= end && end <= addDays(start, MAX_PERIOD_DAYS)) return { start, end };
  }
  const once = RANGE_YEAR_ONCE.exec(text);
  if (once) {
    const startMonth = monthNumber(once[1]!);
    const endMonth = once[3] ? monthNumber(once[3]) : startMonth;
    const year = Number(once[5]);
    // "December 16 - January 15, 2026": the start is in the year before.
    const start = iso(startMonth > endMonth ? year - 1 : year, startMonth, Number(once[2]));
    const end = iso(year, endMonth, Number(once[4]));
    if (start && end && start <= end && end <= addDays(start, MAX_PERIOD_DAYS)) return { start, end };
  }
  return null;
}

export interface PeriodResult {
  period: Period | null;
  source?: PeriodSource;
  /** Lines that looked like they might hold the period, for the masked diagnostics. */
  candidates: { line: number; dates: number }[];
}

/**
 * Searches lines (in order) for the period. `limit` keeps the search to the
 * top of a statement, where the period is printed, away from transactions.
 */
export function findPeriod(lines: TextLine[], limit = 80): PeriodResult {
  const top = lines.slice(0, limit);
  const candidates: { line: number; dates: number }[] = [];
  const note = (index: number, text: string) => {
    const dates = datesIn(text).length + (RANGE_YEAR_ONCE.test(text) ? 2 : 0);
    if (RANGE_LABEL.test(text) || dates > 0) candidates.push({ line: index, dates });
  };

  // 1. A printed range, labelled on its own line or the line before.
  for (let i = 0; i < top.length; i++) {
    const text = top[i]!.text;
    note(i, text);
    const labelled = RANGE_LABEL.test(text) || (i > 0 && RANGE_LABEL.test(top[i - 1]!.text) && datesIn(top[i - 1]!.text).length === 0);
    if (!labelled) continue;
    const range = rangeIn(text);
    if (range) return { period: range, source: 'range', candidates };
  }

  // 2 and 3. Separately printed dates.
  let opening: IsoDate | undefined;
  let closing: IsoDate | undefined;
  let cycleDays: number | undefined;
  for (let i = 0; i < top.length; i++) {
    const text = top[i]!.text;
    const next = top[i + 1]?.text ?? '';
    const valueFor = (label: RegExp) => {
      const at = text.search(label);
      if (at < 0) return undefined;
      // The date after the label, on the same line or, failing that, the next line.
      return datesIn(text.slice(at))[0] ?? (datesIn(text).length === 0 ? datesIn(next)[0] : undefined);
    };
    opening ??= valueFor(OPENING_DATE);
    if (!/\bdue date\b/i.test(text)) closing ??= valueFor(CLOSING_DATE);
    const days = CYCLE_DAYS.exec(text);
    if (days && cycleDays === undefined) cycleDays = Number(days[1]);
  }
  if (opening && closing && opening <= closing && closing <= addDays(opening, MAX_PERIOD_DAYS)) {
    return { period: { start: opening, end: closing }, source: 'opening_and_closing_dates', candidates };
  }
  if (closing && cycleDays && cycleDays >= 20 && cycleDays <= 40) {
    return { period: { start: addDays(closing, -(cycleDays - 1)), end: closing }, source: 'closing_date_and_cycle_days', candidates };
  }
  return { period: null, candidates };
}
