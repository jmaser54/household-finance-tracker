// End to end on SYNTHETIC statements: read PDF -> review plan -> apply ->
// the existing calculations. Checks the financial rules survive importing.
import { readFileSync } from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { beforeAll, describe, expect, it } from 'vitest';
import { summarize } from '../domain/calculations';
import { emptyLedger, parseLedger, serializeLedger, type LedgerDocument } from '../storage/ledger';
import type { ParsedStatement } from './parsers/types';
import type { PdfJs } from './pdfText';
import { setCategory } from '../review/edits';
import { applyImport, planStatements, suggestAccount, type StatementInput } from './plan';
import { readStatement } from './readStatement';

const files = [
  'checking-2026-03.pdf',
  'savings-2026-03.pdf',
  'card-2026-03.pdf',
  'checking-2026-04.pdf',
  'card-closing-date-totals-2026-04.pdf',
  'checking-ambiguous-lines-2026-03.pdf',
] as const;
const inputs = new Map<string, StatementInput>();
/** The accounts of the combined statement, in file order. */
let combined: StatementInput[] = [];

beforeAll(async () => {
  const read = (name: string) => readStatement(new Uint8Array(readFileSync(`tests/fixtures/synthetic/${name}`)), pdfjs as unknown as PdfJs);
  for (const name of files) {
    const outcome = await read(name);
    if (outcome.status !== 'parsed' || outcome.statements.length !== 1) throw new Error(name);
    inputs.set(name, { fileName: name, sha256: `sha-${name}`, statement: outcome.statements[0]! });
  }
  const name = 'combined-checking-savings-2026-03.pdf';
  const outcome = await read(name);
  if (outcome.status !== 'parsed') throw new Error(name);
  combined = outcome.statements.map((statement) => ({ fileName: name, sha256: 'sha-combined', statement }));
});

let counter = 0;
const options = () => ({ now: new Date('2026-04-02T12:00:00Z'), newId: () => `id-${++counter}` });

function importInto(ledger: LedgerDocument, names: string[]) {
  const chosen = names.map((name, i) => {
    const input = inputs.get(name)!;
    return { input, account: suggestAccount(ledger, input.statement, i) };
  });
  const drafts = planStatements(ledger, chosen);
  const result = applyImport(ledger, drafts, options());
  // The result must be a valid ledger that the app can save.
  parseLedger(serializeLedger(result.ledger));
  return { drafts, ...result };
}

const MARCH = { start: '2026-03-01', end: '2026-03-31' };
const find = (ledger: LedgerDocument, text: string) => ledger.transactions.filter((t) => t.originalDescription.includes(text));

describe('importing a month of synthetic statements', () => {
  it('adds every row and keeps the financial definitions', () => {
    const { ledger, added, statements } = importInto(emptyLedger(), ['checking-2026-03.pdf', 'savings-2026-03.pdf', 'card-2026-03.pdf']);
    expect(statements).toBe(3);
    expect(ledger.accounts.map((a) => [a.kind, a.last4])).toEqual([
      ['checking', '4821'],
      ['savings', '7310'],
      ['credit_card', '5512'],
    ]);
    expect(added).toBe(13 + 2 + 6);

    // Transfer checking -> savings: both sides paired, neither income nor spending.
    const [toSavings, fromChecking] = [find(ledger, 'TRANSFER TO SAVINGS')[0]!, find(ledger, 'TRANSFER FROM CHECKING')[0]!];
    expect(toSavings.kind).toBe('transfer');
    expect(toSavings.transferGroupId).toBeDefined();
    expect(toSavings.transferGroupId).toBe(fromChecking.transferGroupId);

    // Card payment from checking and the matching credit on the card: not spending.
    const [payment, received] = [find(ledger, 'PAYMENT TO EXAMPLE CARD')[0]!, find(ledger, 'PAYMENT - THANK YOU')[0]!];
    expect([payment.kind, received.kind]).toEqual(['card_payment', 'card_payment']);
    expect(payment.transferGroupId).toBe(received.transferGroupId);

    // Cash withdrawal needs no explanation.
    expect(find(ledger, 'ATM WITHDRAWAL')[0]).toMatchObject({ kind: 'cash_withdrawal', needsReview: false, classification: { categoryId: 'exp.cash' } });
    // Savings interest is income.
    expect(find(ledger, 'INTEREST PAID')[0]).toMatchObject({ kind: 'interest', classification: { categoryId: 'inc.interest' } });
    // Pay is suggested but never assumed: it is flagged for confirmation.
    expect(find(ledger, 'PAYROLL')[0]).toMatchObject({ kind: 'income', needsReview: true, classification: { categoryId: 'inc.employment' } });
    expect(find(ledger, 'MOBILE DEPOSIT')[0]).toMatchObject({ needsReview: true, classification: { categoryId: 'inc.uncategorized' } });
    // The card return is linked to its purchase and reduces that spending.
    const purchase = find(ledger, 'EXAMPLE OUTFITTERS').find((t) => t.amountCents < 0)!;
    const refund = find(ledger, 'OUTFITTERS RETURN')[0]!;
    expect(refund).toMatchObject({ kind: 'refund', refundOfTransactionId: purchase.id });
    expect(refund.classification.categoryId).toBe(purchase.classification.categoryId);
    // Two identical coffees on the same day are both kept.
    expect(find(ledger, 'SAMPLE COFFEE CO').filter((t) => t.accountId === toSavings.accountId)).toHaveLength(2);
    // Original descriptions are kept exactly; merchants are tidied separately.
    expect(find(ledger, 'EXAMPLE GROCER')[0]).toMatchObject({ originalDescription: 'EXAMPLE GROCER #12 PURCHASE', merchant: 'Example Grocer #12' });

    // The existing calculations, unchanged, on the imported data.
    const summary = summarize(ledger.transactions, ledger.categories, MARCH);
    expect(summary.incomeCents).toBe(310_000 * 2 + 25_000 + 821);
    const checkingSpending = 8_423 + 450 + 450 + 10_000 + 12_045 + 1_899 + 500 + 1_549;
    const cardSpending = 525 + 12_000 + 6_410 + 4_137 - 4_000;
    expect(summary.expenseCents).toBe(checkingSpending + cardSpending);
    expect(summary.netCashFlowCents).toBe(summary.incomeCents - summary.expenseCents);
    expect(summary.excludedTransactionIds).toHaveLength(4);
  });

  it('adds nothing when the same statement file is imported again', () => {
    const first = importInto(emptyLedger(), ['checking-2026-03.pdf']);
    const again = importInto(first.ledger, ['checking-2026-03.pdf']);
    expect(again.drafts[0]!.alreadyImported).toBe(true);
    expect(again.drafts[0]!.rows.every((r) => !r.include)).toBe(true);
    expect(again.added).toBe(0);
    expect(again.ledger.transactions).toHaveLength(first.ledger.transactions.length);
    expect(again.ledger.statements).toHaveLength(1);
  });

  it('detects the overlapping day when the next month is imported later', () => {
    const march = importInto(emptyLedger(), ['checking-2026-03.pdf']);
    const april = importInto(march.ledger, ['checking-2026-04.pdf']);
    const rows = april.drafts[0]!.rows;
    expect(rows.map((r) => r.status)).toEqual(['duplicate', 'new', 'new', 'new', 'new']);
    expect(april.added).toBe(4);
    expect(april.ledger.accounts).toHaveLength(1);
    // The overlapping line is recorded once, as appearing on both statements.
    const streaming = find(april.ledger, 'EXAMPLE STREAMING');
    expect(streaming).toHaveLength(1);
    expect(streaming[0]!.statementIds).toHaveLength(2);
  });

  it('handles two months uploaded at once, sharing one new account', () => {
    const both = importInto(emptyLedger(), ['checking-2026-03.pdf', 'checking-2026-04.pdf']);
    expect(both.ledger.accounts).toHaveLength(1);
    expect(both.drafts[1]!.rows[0]!.status).toBe('duplicate');
    expect(both.added).toBe(13 + 4);
  });

  it('never adds a row whose sign could not be determined, and never drops one silently', () => {
    const statement: ParsedStatement = {
      ...inputs.get('checking-2026-03.pdf')!.statement,
      transactions: [
        { line: 1, postedDate: '2026-03-02', description: 'MYSTERY ITEM', amountCents: null, flags: ['ambiguous_sign'] },
        { line: 2, postedDate: '2026-03-03', description: 'EXAMPLE GROCER', amountCents: -1_000, flags: [] },
      ],
    };
    const ledger = emptyLedger();
    const drafts = planStatements(ledger, [{ input: { fileName: 'x.pdf', sha256: 'x', statement }, account: suggestAccount(ledger, statement, 0) }]);
    expect(drafts[0]!.rows.map((r) => [r.status, r.include])).toEqual([
      ['unusable', false],
      ['new', true],
    ]);
    expect(applyImport(ledger, drafts, options()).added).toBe(1);
  });

  it('suggests the existing account with the same last four digits', () => {
    const march = importInto(emptyLedger(), ['checking-2026-03.pdf']);
    const suggestion = suggestAccount(march.ledger, inputs.get('checking-2026-04.pdf')!.statement, 0);
    expect(suggestion).toEqual({ type: 'existing', accountId: march.ledger.accounts[0]!.id });
  });

  it('never changes a classification the person corrected', () => {
    const checking = importInto(emptyLedger(), ['checking-2026-03.pdf']);
    const corrected = find(checking.ledger, 'TRANSFER TO SAVINGS')[0]!;
    corrected.kind = 'purchase';
    corrected.classification = { categoryId: 'exp.gifts_giving', source: 'user', confidence: 1, reasons: [] };
    const withSavings = importInto(checking.ledger, ['savings-2026-03.pdf']);
    const after = withSavings.ledger.transactions.find((t) => t.id === corrected.id)!;
    expect(after).toMatchObject({ kind: 'purchase', classification: { categoryId: 'exp.gifts_giving', source: 'user' } });
    expect(after.transferGroupId).toBeUndefined();
  });

  it('builds nothing until applied: planning leaves the ledger untouched', () => {
    const ledger = emptyLedger();
    const before = serializeLedger(ledger);
    planStatements(ledger, [{ input: inputs.get('card-2026-03.pdf')!, account: suggestAccount(ledger, inputs.get('card-2026-03.pdf')!.statement, 0) }]);
    expect(serializeLedger(ledger)).toBe(before);
  });
});

describe('a combined statement and undated charges', () => {
  const importCombined = (ledger: LedgerDocument) => {
    const drafts = planStatements(ledger, combined.map((input, i) => ({ input, account: suggestAccount(ledger, input.statement, i) })));
    const result = applyImport(ledger, drafts, options());
    parseLedger(serializeLedger(result.ledger));
    return { drafts, ...result };
  };

  it('one PDF adds two accounts, each with its own statement and rows, and pairs the transfer between them', () => {
    const { ledger, statements, added } = importCombined(emptyLedger());
    expect(statements).toBe(2);
    expect(added).toBe(10 + 2);
    expect(ledger.accounts.map((a) => [a.kind, a.last4])).toEqual([
      ['checking', '4821'],
      ['savings', '7310'],
    ]);
    expect(ledger.statements.map((s) => [s.fileSha256, s.fileSection, s.validation.status])).toEqual([
      ['sha-combined', 0, 'verified'],
      ['sha-combined', 1, 'verified'],
    ]);
    const [checking, savings] = ledger.accounts;
    expect(ledger.transactions.filter((t) => t.accountId === checking!.id)).toHaveLength(10);
    expect(ledger.transactions.filter((t) => t.accountId === savings!.id)).toHaveLength(2);
    const [toSavings, fromChecking] = [find(ledger, 'TRANSFER TO SAVINGS')[0]!, find(ledger, 'TRANSFER FROM CHECKING')[0]!];
    expect(toSavings.kind).toBe('transfer');
    expect(toSavings.transferGroupId).toBe(fromChecking.transferGroupId);
    // Neither side of the transfer is income or spending.
    const excluded = summarize(ledger.transactions, ledger.categories, MARCH).excludedTransactionIds;
    expect(excluded).toEqual(expect.arrayContaining([toSavings.id, fromChecking.id]));
  });

  it('importing the same combined PDF again adds nothing to either account', () => {
    const first = importCombined(emptyLedger());
    const again = importCombined(first.ledger);
    expect(again.drafts.map((d) => d.alreadyImported)).toEqual([true, true]);
    expect(again.added).toBe(0);
  });

  it('an undated interest line is added on the closing date, marked for review with the reason', () => {
    const { drafts, ledger } = importInto(emptyLedger(), ['card-closing-date-totals-2026-04.pdf']);
    const row = drafts[0]!.rows.find((r) => r.transaction.description === 'INTEREST CHARGE ON PURCHASES')!;
    expect(row.status).toBe('check');
    expect(row.reasons).toContain("No date was printed for this line, so the statement's closing date was used");
    const interest = find(ledger, 'INTEREST CHARGE ON PURCHASES')[0]!;
    expect(interest).toMatchObject({ postedDate: '2026-04-13', amountCents: -1_427, needsReview: true, kind: 'fee' });
    // The card payment and the return keep their meanings.
    expect(find(ledger, 'PAYMENT THANK YOU')[0]!.kind).toBe('card_payment');
    expect(find(ledger, 'OUTFITTERS RETURN')[0]!.kind).toBe('refund');
  });
});

describe('a statement that reconciles with lines excluded', () => {
  it('is imported with every extracted row, recorded with its status and how many lines were left out', () => {
    const { ledger, added, statements } = importInto(emptyLedger(), ['checking-ambiguous-lines-2026-03.pdf']);
    expect(statements).toBe(1);
    expect(added).toBe(4);
    expect(ledger.statements[0]).toMatchObject({ excludedLineCount: 2, validation: { status: 'partially_verified' } });
  });

  it('importing it again adds nothing (duplicate detection unchanged)', () => {
    const first = importInto(emptyLedger(), ['checking-ambiguous-lines-2026-03.pdf']);
    const again = importInto(first.ledger, ['checking-ambiguous-lines-2026-03.pdf']);
    expect(again.added).toBe(0);
  });
});

describe('choices the person made carry into the next import', () => {
  it('a remembered "use this for every …" choice categorises new transactions with that name', () => {
    const first = importInto(emptyLedger(), ['checking-2026-03.pdf']);
    const grocer = find(first.ledger, 'EXAMPLE GROCER')[0]!;
    const chosen = setCategory(first.ledger, grocer.id, 'exp.shopping', { now: new Date('2026-04-02T12:00:00Z'), newId: () => `id-${++counter}`, alsoOthers: true }).ledger;
    const next = importInto(chosen, ['checking-2026-04.pdf']);
    const april = find(next.ledger, 'EXAMPLE GROCER').find((t) => t.postedDate.startsWith('2026-04'))!;
    expect(april).toMatchObject({ needsReview: false, classification: { categoryId: 'exp.shopping', source: 'rule' } });
    // The built-in guess (Groceries) applies only where no choice was made.
    expect(find(first.ledger, 'EXAMPLE PHARMACY')[0]!.classification.categoryId).toBe('exp.health');
  });
});
