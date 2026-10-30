// Statement-period wordings, on SYNTHETIC text. Every period comes from dates
// printed on the statement; when they aren't there, nothing is guessed.
import { describe, expect, it } from 'vitest';
import { findPeriod } from './period';
import { doc } from './testDoc';

const period = (...lines: string[]) => {
  const result = findPeriod(doc(lines).lines);
  return result.period ? { ...result.period, source: result.source } : null;
};

describe('a printed range', () => {
  it.each([
    ['Statement Period: 03/01/2026 - 03/31/2026', '2026-03-01', '2026-03-31'],
    ['Statement period 03/01/26 to 03/31/26', '2026-03-01', '2026-03-31'],
    ['Statement Dates 03-01-2026 thru 03-31-2026', '2026-03-01', '2026-03-31'],
    ['Statement period 2026-03-01 to 2026-03-31', '2026-03-01', '2026-03-31'],
    ['For the period March 1, 2026 through March 31, 2026', '2026-03-01', '2026-03-31'],
    ['For the period beginning March 1, 2026 and ending March 31, 2026', '2026-03-01', '2026-03-31'],
    ['Statement period: Mar. 1, 2026 – Mar. 31, 2026', '2026-03-01', '2026-03-31'],
    ['Statement period 1 March 2026 to 31 March 2026', '2026-03-01', '2026-03-31'],
    ['Billing cycle: March 14 - April 13, 2026', '2026-03-14', '2026-04-13'],
    ['Statement period March 1 - 31, 2026', '2026-03-01', '2026-03-31'],
    ['Billing period December 16 - January 15, 2026', '2025-12-16', '2026-01-15'],
    ['Opening/Closing Date 12/16/25 - 01/15/26', '2025-12-16', '2026-01-15'],
  ])('%s', (line, start, end) => {
    expect(period('Example Bank', line)).toEqual({ start, end, source: 'range' });
  });

  it('reads the dates on the line after their label', () => {
    expect(period('Statement Period', '03/01/2026 - 03/31/2026')).toMatchObject({ start: '2026-03-01', end: '2026-03-31' });
    expect(period('Billing Period', 'March 14 - April 13, 2026')).toMatchObject({ start: '2026-03-14', end: '2026-04-13' });
  });

  it('accepts a quarterly savings statement but not an implausibly long range', () => {
    expect(period('Statement period 01/01/2026 - 03/31/2026')).toMatchObject({ start: '2026-01-01', end: '2026-03-31' });
    expect(period('Statement period 01/01/2025 - 03/31/2026')).toBeNull();
  });
});

describe('separately printed dates', () => {
  it('uses an opening date and a closing date', () => {
    expect(period('Opening Date 02/14/2026', 'Closing Date 03/13/2026')).toEqual({
      start: '2026-02-14',
      end: '2026-03-13',
      source: 'opening_and_closing_dates',
    });
  });

  it('uses a closing date and the printed days in the billing cycle', () => {
    expect(period('Statement Closing Date 04/13/2026   Days in Billing Cycle 29', 'Payment Due Date 05/08/2026')).toEqual({
      start: '2026-03-16',
      end: '2026-04-13',
      source: 'closing_date_and_cycle_days',
    });
  });

  it('never uses the payment due date as the closing date', () => {
    expect(period('Payment Due Date 05/08/2026', 'Days in Billing Cycle 29')).toBeNull();
  });
});

describe('nothing is guessed', () => {
  it.each([
    [['Closing Date 03/13/2026']],
    [['Statement date 03/31/2026']],
    [['Statement period March 2026']],
    [['03/01/2026 - 03/31/2026']],
  ])('%j has no period', (lines) => {
    expect(period(...lines)).toBeNull();
  });

  it('reports which lines looked like they might hold the period, for the diagnostics', () => {
    const result = findPeriod(doc(['Example Bank', 'Statement period March 2026', 'Closing Date 03/13/2026']).lines);
    expect(result.candidates).toEqual([
      { line: 1, dates: 0 },
      { line: 2, dates: 1 },
    ]);
  });
});
