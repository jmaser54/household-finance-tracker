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
  return outcome.statement;
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
