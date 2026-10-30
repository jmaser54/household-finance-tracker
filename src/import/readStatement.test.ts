// Reads the SYNTHETIC statement PDFs (tests/fixtures/synthetic) with the real
// pdf.js legacy build, exactly as the app does, and checks every row.
import { readFileSync } from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import type { PdfJs } from './pdfText';
import { readStatement, type FileOutcome } from './readStatement';

const read = (name: string) =>
  readStatement(new Uint8Array(readFileSync(`tests/fixtures/synthetic/${name}`)), pdfjs as unknown as PdfJs);

const parsed = async (name: string) => {
  const outcome = await read(name);
  if (outcome.status !== 'parsed') throw new Error(`${name}: ${outcome.status}`);
  if (outcome.statements.length !== 1) throw new Error(`${name}: ${outcome.statements.length} accounts`);
  return outcome.statements[0]!;
};

const rows = (statement: Awaited<ReturnType<typeof parsed>>) =>
  statement.transactions.map((t) => [t.postedDate, t.description, t.amountCents]);

describe('checking statement with Withdrawals / Deposits / Balance columns', () => {
  it('reads every row with the right sign, across two pages', async () => {
    const s = await parsed('checking-2026-03.pdf');
    expect(s).toMatchObject({ accountKind: 'checking', last4: '4821', periodStart: '2026-03-01', periodEnd: '2026-03-31' });
    expect(rows(s)).toEqual([
      ['2026-03-01', 'PAYROLL EXAMPLE EMPLOYER INC DIRECT DEP', 310_000],
      ['2026-03-02', 'EXAMPLE GROCER #12 PURCHASE', -8_423],
      ['2026-03-03', 'SAMPLE COFFEE CO', -450],
      ['2026-03-03', 'SAMPLE COFFEE CO', -450],
      ['2026-03-05', 'ONLINE TRANSFER TO SAVINGS XXXX7310', -50_000],
      ['2026-03-08', 'ATM WITHDRAWAL 123 EXAMPLE ST', -10_000],
      ['2026-03-10', 'EXAMPLE UTILITY CO AUTOPAY REF 000123 ACCOUNT SERVICES', -12_045],
      ['2026-03-15', 'PAYROLL EXAMPLE EMPLOYER INC DIRECT DEP', 310_000],
      ['2026-03-18', 'PAYMENT TO EXAMPLE CARD ENDING 5512', -123_456],
      ['2026-03-20', 'MOBILE DEPOSIT', 25_000],
      ['2026-03-22', 'EXAMPLE PHARMACY', -1_899],
      ['2026-03-28', 'MONTHLY SERVICE FEE', -500],
      ['2026-03-31', 'EXAMPLE STREAMING', -1_549],
    ]);
    expect(s.validation.status).toBe('verified');
    expect(s.unreadLines).toEqual([]);
    expect(s.transactions.every((t) => t.flags.length === 0)).toBe(true);
  });

  it('flags a statement whose balances do not add up', async () => {
    const s = await parsed('checking-balance-mismatch.pdf');
    expect(s.validation.status).toBe('failed');
    expect(s.validation.checks[0]).toMatchObject({ passed: false });
  });
});

describe('savings statement with one signed Amount column', () => {
  it('reads signed amounts and a written-out period', async () => {
    const s = await parsed('savings-2026-03.pdf');
    expect(s).toMatchObject({ accountKind: 'savings', last4: '7310', periodStart: '2026-03-01', periodEnd: '2026-03-31' });
    expect(rows(s)).toEqual([
      ['2026-03-05', 'TRANSFER FROM CHECKING XXXX4821', 50_000],
      ['2026-03-31', 'INTEREST PAID', 821],
    ]);
    expect(s.validation.status).toBe('verified');
  });
});

describe('credit card statement with sections and two dates', () => {
  it('treats purchases as money out and payments/returns as money in', async () => {
    const s = await parsed('card-2026-03.pdf');
    expect(s).toMatchObject({ accountKind: 'credit_card', last4: '5512', periodStart: '2026-03-01', periodEnd: '2026-03-31' });
    expect(s.transactions.map((t) => [t.transactionDate, t.postedDate, t.description, t.amountCents])).toEqual([
      ['2026-03-19', '2026-03-19', 'PAYMENT - THANK YOU', 123_456],
      ['2026-03-24', '2026-03-25', 'EXAMPLE OUTFITTERS RETURN', 4_000],
      ['2026-03-02', '2026-03-03', 'SAMPLE COFFEE CO', -525],
      ['2026-03-12', '2026-03-13', 'EXAMPLE OUTFITTERS', -12_000],
      ['2026-03-20', '2026-03-21', 'EXAMPLE RESTAURANT', -6_410],
      ['2026-03-28', '2026-03-29', 'EXAMPLE GAS STATION', -4_137],
    ]);
    expect(s.validation.status).toBe('verified');
  });

  it('places dates in the right year when a statement spans New Year', async () => {
    const s = await parsed('card-2025-12.pdf');
    expect(s).toMatchObject({ periodStart: '2025-12-16', periodEnd: '2026-01-15' });
    expect(s.transactions.map((t) => t.postedDate)).toEqual(['2025-12-21', '2026-01-06']);
  });
});

describe('layouts found on real statements (synthetic copies)', () => {
  it('a combined checking and savings statement becomes two accounts, each verified on its own', async () => {
    const outcome = await read('combined-checking-savings-2026-03.pdf');
    if (outcome.status !== 'parsed') throw new Error(outcome.status);
    const [checking, savings] = outcome.statements;
    expect(outcome.statements).toHaveLength(2);
    expect(checking).toMatchObject({ accountKind: 'checking', last4: '4821', periodStart: '2026-03-01', periodEnd: '2026-03-31', section: { index: 0, of: 2 } });
    expect(rows(checking!)).toEqual([
      ['2026-03-01', 'PAYROLL EXAMPLE EMPLOYER INC DIRECT DEP', 310_000],
      ['2026-03-02', 'DEBIT CARD PURCHASE 5313 EXAMPLE GROCER', -8_423],
      ['2026-03-04', 'SAMPLE COFFEE CO', -450],
      ['2026-03-05', 'ONLINE TRANSFER TO SAVINGS XXXX7310', -50_000],
      ['2026-03-09', 'EXAMPLE UTILITY CO AUTOPAY', -12_045],
      ['2026-03-12', 'PAYMENT TO EXAMPLE CARD ENDING 5512', -60_000],
      ['2026-03-15', 'PAYROLL EXAMPLE EMPLOYER INC DIRECT DEP', 310_000],
      ['2026-03-18', 'ATM WITHDRAWAL 123 EXAMPLE ST', -6_000],
      ['2026-03-22', 'EXAMPLE PHARMACY', -1_899],
      ['2026-03-30', 'EXAMPLE STREAMING', -1_549],
    ]);
    expect(checking!.validation.status).toBe('verified');
    expect(savings).toMatchObject({ accountKind: 'savings', last4: '7310', openingBalanceCents: 1_000_000, closingBalanceCents: 1_050_821, section: { index: 1, of: 2 } });
    expect(rows(savings!)).toEqual([
      ['2026-03-05', 'ONLINE TRANSFER FROM CHECKING XXXX4821', 50_000],
      ['2026-03-31', 'INTEREST PAID', 821],
    ]);
    expect(savings!.validation.status).toBe('verified');
  });

  it('a combined statement with an unlabelled period line on every page and "CHECKING SUMMARY" / "SAVINGS SUMMARY" headings', async () => {
    const outcome = await read('combined-summaries-2026-03.pdf');
    if (outcome.status !== 'parsed') throw new Error(outcome.status);
    const [checking, savings] = outcome.statements;
    expect(outcome.statements).toHaveLength(2);
    expect(checking).toMatchObject({ accountKind: 'checking', last4: '4821', periodStart: '2026-03-01', periodEnd: '2026-03-31', openingBalanceCents: 320_000, closingBalanceCents: 846_483 });
    expect(rows(checking!)).toEqual([
      ['2026-03-02', 'EXAMPLE GROCER', -6_412],
      ['2026-03-06', 'TRANSFER TO SAVINGS', -25_000],
      ['2026-03-13', 'PAYROLL EXAMPLE EMPLOYER INC', 285_000],
      ['2026-03-20', 'EXAMPLE PHARMACY', -2_275],
      ['2026-03-27', 'PAYROLL EXAMPLE EMPLOYER INC', 285_000],
      ['2026-03-30', 'EXAMPLE UTILITY CO', -9_830],
    ]);
    expect(savings).toMatchObject({ accountKind: 'savings', last4: '7310', openingBalanceCents: 640_000, closingBalanceCents: 665_512 });
    expect(rows(savings!)).toEqual([
      ['2026-03-06', 'TRANSFER FROM CHECKING', 25_000],
      ['2026-03-31', 'INTEREST PAID', 512],
    ]);
    for (const s of outcome.statements) {
      expect(s.validation.status).toBe('verified');
      expect(s.validation.checks.every((c) => c.passed !== false)).toBe(true);
    }
    // The period line masks exactly as on the household's statements.
    expect(outcome.diagnostics).toContain('  p1  MONTH NUMBER NUMBER through MONTH NUMBER NUMBER');
  });

  it('a card with its period as closing date plus days, totals in headings and an undated interest line', async () => {
    const s = await parsed('card-closing-date-totals-2026-04.pdf');
    expect(s).toMatchObject({ accountKind: 'credit_card', last4: '9046', periodStart: '2026-03-16', periodEnd: '2026-04-13', periodSource: 'closing_date_and_cycle_days' });
    expect(s.transactions.map((t) => [t.postedDate, t.description, t.amountCents, t.flags])).toEqual([
      ['2026-03-20', 'PAYMENT THANK YOU', 125_000, []],
      ['2026-03-17', 'EXAMPLE GROCER', -18_240, []],
      ['2026-03-30', 'EXAMPLE HARDWARE', -9_500, []],
      ['2026-04-03', 'EXAMPLE OUTFITTERS RETURN', 3_500, []],
      ['2026-04-13', 'INTEREST CHARGE ON PURCHASES', -1_427, ['date_assigned']],
    ]);
    expect(s.unreadLines).toEqual([]);
    expect(s.validation.status).toBe('verified');
  });

  it('a card with its period label and dates on separate lines and bare section headings', async () => {
    const s = await parsed('card-bare-headings-2026-04.pdf');
    expect(s).toMatchObject({ accountKind: 'credit_card', last4: '2208', periodStart: '2026-03-14', periodEnd: '2026-04-13' });
    expect(rows(s)).toEqual([
      ['2026-03-25', 'AUTOPAY PAYMENT RECEIVED', 40_000],
      ['2026-03-18', 'SAMPLE COFFEE CO', -650],
      ['2026-04-01', 'EXAMPLE BOOKSTORE', -2_399],
    ]);
    expect(s.validation.status).toBe('verified');
  });

  it('a checking statement with a worded period and dated balance rows, from a bank named "Savings and Loan"', async () => {
    const s = await parsed('checking-worded-period-2026-03.pdf');
    expect(s).toMatchObject({ accountKind: 'checking', last4: '6617', periodStart: '2026-03-01', periodEnd: '2026-03-31', openingBalanceCents: 180_000 });
    expect(rows(s)).toEqual([
      ['2026-03-03', 'EXAMPLE GROCER', -5_210],
      ['2026-03-14', 'PAYROLL EXAMPLE EMPLOYER INC DIRECT DEP', 220_000],
      ['2026-03-27', 'CHECK 1042', -30_000],
    ]);
    expect(s.validation.status).toBe('verified');
  });
});

describe('files that are not readable statements', () => {
  it('recognises a scanned (image-only) PDF and does not guess', async () => {
    expect(await read('scanned-image-only.pdf')).toEqual({ status: 'scanned' });
  });

  it('reports a text PDF with no statement as unsupported, with masked diagnostics', async () => {
    const outcome = await read('not-a-statement-letter.pdf');
    expect(outcome.status).toBe('unsupported');
    const diagnostics = (outcome as Extract<FileOutcome, { status: 'unsupported' }>).diagnostics.join('\n');
    expect(diagnostics).not.toMatch(/Example|customer|terms/i);
    expect(diagnostics).toContain('TEXT');
  });

  it('rejects a file that is not a PDF, an empty file, and a damaged PDF', async () => {
    const pdfjsLike = pdfjs as unknown as PdfJs;
    expect(await readStatement(new TextEncoder().encode('just some text'), pdfjsLike)).toEqual({ status: 'not_pdf' });
    expect(await readStatement(new Uint8Array(), pdfjsLike)).toEqual({ status: 'not_pdf' });
    const real = new Uint8Array(readFileSync('tests/fixtures/synthetic/checking-2026-03.pdf'));
    const damaged = real.slice(0, 400);
    expect((await readStatement(damaged, pdfjsLike)).status).toMatch(/unreadable|unsupported|scanned/);
  });
});

describe('masked diagnostics never reveal values', () => {
  it('hides every date, amount, number and merchant word of a real layout', async () => {
    const outcome = await read('checking-2026-03.pdf');
    const text = (outcome as Extract<FileOutcome, { status: 'parsed' }>).diagnostics.join('\n');
    expect(text).toContain('DATE TEXT');
    expect(text).toMatch(/AMOUNT/);
    for (const secret of ['4821', '2,500.00', 'PAYROLL', 'GROCER', '03/01', 'EXAMPLE']) expect(text).not.toContain(secret);
  });

  it.each([
    ['combined-checking-savings-2026-03.pdf', ['4821', '7310', '5313', '5512', '2,500.00', '7,296.34', 'PAYROLL', 'GROCER', 'Everyday', 'Example', '03/31/2026']],
    ['card-closing-date-totals-2026-04.pdf', ['9046', '1,312.50', '1,250.00', '14.27', '21.49', 'GROCER', 'Rewards', '04/13/2026', '29']],
    ['combined-summaries-2026-03.pdf', ['4821', '7310', '3,200.00', '8,464.83', '6,400.00', 'Jordan', 'Casey', 'Hometown', 'GROCER', 'March', '2026']],
    ['card-bare-headings-2026-04.pdf', ['2208', '400.00', 'AUTOPAY', 'BOOKSTORE', 'Travel', 'March', 'April', '2026']],
  ])('%s: the facts about how it was read contain no values', async (name, secrets) => {
    const outcome = await read(name);
    const text = (outcome as Extract<FileOutcome, { status: 'parsed' }>).diagnostics.join('\n');
    expect(text).toMatch(/Statement 1: /);
    for (const secret of secrets) expect(text).not.toContain(secret);
  });

  it('a statement with no period lists the lines that might hold it, masked', async () => {
    const outcome = await read('not-a-statement-letter.pdf');
    const text = (outcome as Extract<FileOutcome, { status: 'unsupported' }>).diagnostics.join('\n');
    expect(text).toContain('Statement period not found');
    expect(text).not.toMatch(/Example|customer|terms/i);
  });
});

describe('works without features Safari lacks', () => {
  it('reads a statement when streams are not async-iterable (as in Safari / the Mac app window)', async () => {
    const proto = ReadableStream.prototype as unknown as Record<symbol, unknown>;
    const original = proto[Symbol.asyncIterator];
    proto[Symbol.asyncIterator] = undefined;
    try {
      const s = await parsed('savings-2026-03.pdf');
      expect(s.transactions).toHaveLength(2);
      expect(s.validation.status).toBe('verified');
    } finally {
      proto[Symbol.asyncIterator] = original;
    }
  });
});
