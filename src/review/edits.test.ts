// Reviewing and correcting transactions, on a small SYNTHETIC ledger.
import { describe, expect, it } from 'vitest';
import { summarize } from '../domain/calculations';
import type { Transaction } from '../domain/types';
import { emptyLedger, parseLedger, serializeLedger, type LedgerDocument } from '../storage/ledger';
import { isReadyToSort, looksRight, othersLike, setCategory, setName, setNote, upgradeLedger } from './edits';

let n = 0;
const options = () => ({ now: new Date('2026-04-02T12:00:00Z'), newId: () => `id-${++n}` });
const MARCH = { start: '2026-03-01', end: '2026-03-31' };

function tx(id: string, merchant: string, amountCents: number, extra: Partial<Transaction> = {}): Transaction {
  return {
    id,
    accountId: 'acct-checking',
    statementIds: [],
    postedDate: '2026-03-10',
    amountCents,
    originalDescription: `${merchant.toUpperCase()} #0412`,
    merchant,
    kind: amountCents < 0 ? 'purchase' : 'income',
    classification: { categoryId: amountCents < 0 ? 'exp.uncategorized' : 'inc.uncategorized', source: 'heuristic', confidence: 0, reasons: [] },
    needsReview: true,
    dedupeKey: id,
    ...extra,
  };
}

function ledgerWith(transactions: Transaction[]): LedgerDocument {
  const ledger = emptyLedger();
  ledger.accounts.push({ id: 'acct-checking', displayName: 'Checking', kind: 'checking', institution: '', archived: false });
  ledger.transactions.push(...transactions);
  return ledger;
}
const find = (ledger: LedgerDocument, id: string) => ledger.transactions.find((t) => t.id === id)!;
const valid = (ledger: LedgerDocument) => parseLedger(serializeLedger(ledger));

describe('choosing a category', () => {
  const base = () =>
    ledgerWith([
      tx('a', 'Main St Market', -4_210),
      tx('b', 'Main St Market', -1_999),
      tx('c', 'Main St Market', -650, { classification: { categoryId: 'exp.shopping', source: 'user', confidence: 1, reasons: [] }, needsReview: false }),
      tx('d', 'Main St Market', 1_000), // money in: a different direction
      tx('e', 'Corner Cafe', -500),
    ]);

  it('changes only that transaction unless the person asks for more', () => {
    const { ledger, othersChanged } = setCategory(base(), 'a', 'exp.groceries', { ...options(), alsoOthers: false });
    expect(othersChanged).toBe(0);
    expect(find(ledger, 'a')).toMatchObject({ needsReview: false, classification: { categoryId: 'exp.groceries', source: 'user' } });
    expect(find(ledger, 'b').classification.categoryId).toBe('exp.uncategorized');
    expect(ledger.rules).toEqual([]);
    valid(ledger);
  });

  it('counts exactly which others "also apply" would change: same name, same direction, not set by hand', () => {
    expect(othersLike(base(), 'a').map((t) => t.id)).toEqual(['b']);
  });

  it('applies to those others only when asked, and remembers it for future imports', () => {
    const { ledger, othersChanged } = setCategory(base(), 'a', 'exp.groceries', { ...options(), alsoOthers: true });
    expect(othersChanged).toBe(1);
    expect(find(ledger, 'b')).toMatchObject({ needsReview: false, classification: { categoryId: 'exp.groceries', source: 'rule' } });
    expect(find(ledger, 'c').classification).toMatchObject({ categoryId: 'exp.shopping', source: 'user' }); // never overwritten
    expect(find(ledger, 'd').classification.categoryId).toBe('inc.uncategorized');
    expect(find(ledger, 'e').classification.categoryId).toBe('exp.uncategorized');
    expect(ledger.rules).toHaveLength(1);
    expect(ledger.rules[0]).toMatchObject({ match: { field: 'merchant', mode: 'equals', text: 'Main St Market', direction: 'out' }, set: { categoryId: 'exp.groceries' } });
    valid(ledger);
  });

  it('a second "also apply" for the same name updates the remembered choice instead of adding another', () => {
    const first = setCategory(base(), 'a', 'exp.groceries', { ...options(), alsoOthers: true }).ledger;
    const second = setCategory(first, 'b', 'exp.dining', { ...options(), alsoOthers: true }).ledger;
    expect(second.rules).toHaveLength(1);
    expect(second.rules[0]!.set.categoryId).toBe('exp.dining');
  });

  it('spending chosen for something marked as a transfer makes it count, and a transfer category stops it counting', () => {
    const transfer = tx('t', 'Online Transfer', -50_000, {
      kind: 'transfer',
      transferGroupId: 'g1',
      classification: { categoryId: 'xfer.internal', source: 'heuristic', confidence: 0.9, reasons: [] },
      needsReview: false,
    });
    const asSpending = setCategory(ledgerWith([transfer]), 't', 'exp.housing', { ...options(), alsoOthers: false }).ledger;
    expect(find(asSpending, 't')).toMatchObject({ kind: 'purchase' });
    expect(find(asSpending, 't').transferGroupId).toBeUndefined();
    expect(summarize(asSpending.transactions, asSpending.categories, MARCH).expenseCents).toBe(50_000);

    const back = setCategory(asSpending, 't', 'xfer.internal', { ...options(), alsoOthers: false }).ledger;
    expect(find(back, 't').kind).toBe('transfer');
    expect(summarize(back.transactions, back.categories, MARCH).expenseCents).toBe(0);
  });

  it('a refund put in a spending category reduces that spending', () => {
    const ledger = ledgerWith([tx('p', 'Shoe Shop', -6_000), tx('r', 'Shoe Shop', 2_000)]);
    let next = setCategory(ledger, 'p', 'exp.shopping', { ...options(), alsoOthers: false }).ledger;
    next = setCategory(next, 'r', 'exp.shopping', { ...options(), alsoOthers: false }).ledger;
    expect(find(next, 'r').kind).toBe('refund');
    expect(summarize(next.transactions, next.categories, MARCH).expenseCents).toBe(4_000);
  });
});

describe('other corrections', () => {
  it('"Looks right" keeps the category and takes it off the pile', () => {
    const pay = tx('p', 'Payroll Example Employer', 300_000, {
      classification: { categoryId: 'inc.employment', source: 'heuristic', confidence: 0.5, reasons: [] },
    });
    const ledger = looksRight(ledgerWith([pay]), 'p');
    expect(find(ledger, 'p')).toMatchObject({ needsReview: false, classification: { categoryId: 'inc.employment', source: 'user' } });
    expect(isReadyToSort(find(ledger, 'p'))).toBe(false);
  });

  it('renaming changes the name only; the statement\'s own text is never edited', () => {
    const ledger = setName(ledgerWith([tx('a', 'MAIN ST MKT', -100)]), 'a', '  Main St Market ');
    expect(find(ledger, 'a')).toMatchObject({ merchant: 'Main St Market', originalDescription: 'MAIN ST MKT #0412' });
    expect(setName(ledger, 'a', '   ')).toEqual(ledger); // an empty name is ignored
  });

  it('a note can be added and cleared', () => {
    const withNote = setNote(ledgerWith([tx('a', 'Main St Market', -100)]), 'a', 'Birthday cake');
    expect(find(withNote, 'a').note).toBe('Birthday cake');
    expect(find(setNote(withNote, 'a', ''), 'a')).not.toHaveProperty('note');
  });

  it('"ready to sort" means Uncategorized or flagged', () => {
    expect(isReadyToSort(tx('a', 'X', -1))).toBe(true);
    expect(isReadyToSort(tx('b', 'X', -1, { needsReview: false, classification: { categoryId: 'exp.groceries', source: 'heuristic', confidence: 0.7, reasons: [] } }))).toBe(false);
    expect(isReadyToSort(tx('c', 'X', -1, { needsReview: false }))).toBe(true); // still Uncategorized
  });
});

describe('opening a household saved by an earlier version', () => {
  it('adds the built-in guesses only where the app itself left something Uncategorized', () => {
    const ledger = ledgerWith([
      tx('a', 'Example Pharmacy', -1_899, { originalDescription: 'EXAMPLE PHARMACY' }),
      tx('b', 'Example Pharmacy', -500, {
        originalDescription: 'EXAMPLE PHARMACY',
        classification: { categoryId: 'exp.uncategorized', source: 'user', confidence: 1, reasons: [] },
        needsReview: false,
      }),
      tx('c', 'Example Outfitters', -12_000, { originalDescription: 'EXAMPLE OUTFITTERS' }),
    ]);
    const upgraded = upgradeLedger(ledger);
    expect(find(upgraded, 'a')).toMatchObject({ needsReview: false, classification: { categoryId: 'exp.health', source: 'heuristic' } });
    expect(find(upgraded, 'b').classification).toMatchObject({ categoryId: 'exp.uncategorized', source: 'user' });
    expect(find(upgraded, 'c').classification.categoryId).toBe('exp.uncategorized');
    valid(upgraded);
  });

  it('keeps every total by category exactly the same under the new names', () => {
    const ledger = ledgerWith([
      tx('a', 'Rent', -150_000, { classification: { categoryId: 'exp.housing.rent_mortgage', source: 'user', confidence: 1, reasons: [] }, needsReview: false }),
      tx('b', 'Electric', -9_000, { classification: { categoryId: 'exp.housing.utilities', source: 'user', confidence: 1, reasons: [] }, needsReview: false }),
      tx('c', 'Pay', 300_000, { classification: { categoryId: 'inc.employment', source: 'user', confidence: 1, reasons: [] }, needsReview: false }),
    ]);
    const before = summarize(ledger.transactions, ledger.categories, MARCH);
    const upgraded = upgradeLedger(ledger);
    const after = summarize(upgraded.transactions, upgraded.categories, MARCH);
    expect([after.incomeCents, after.expenseCents]).toEqual([before.incomeCents, before.expenseCents]);
    // Utilities now counts under Bills & Utilities rather than Home; the amounts are unchanged.
    expect(after.expenseByCategory.map((c) => [c.categoryId, c.totalCents])).toEqual([
      ['exp.housing', 150_000],
      ['exp.bills', 9_000],
    ]);
  });

  it('changes nothing when already up to date', () => {
    const current = upgradeLedger(ledgerWith([tx('a', 'Example Outfitters', -100, { originalDescription: 'EXAMPLE OUTFITTERS' })]));
    expect(upgradeLedger(current)).toBe(current);
  });
});

describe('tidier names', () => {
  it('names nobody changed get today\'s tidier form; names the person changed are kept', () => {
    const ledger = ledgerWith([
      tx('a', 'Atm Withdrawal 123 Example St', -10_000, { originalDescription: 'ATM WITHDRAWAL 123 EXAMPLE ST' }),
      tx('b', 'Our cash', -2_000, { originalDescription: 'ATM WITHDRAWAL 9 EXAMPLE ST' }),
      tx('c', 'Transfer To Savings Xxxx7310', -500, { originalDescription: 'TRANSFER TO SAVINGS XXXX7310' }),
    ]);
    const upgraded = upgradeLedger(ledger);
    expect(upgraded.transactions.map((t) => t.merchant)).toEqual(['ATM Withdrawal 123 Example St', 'Our cash', 'Transfer To Savings XXXX7310']);
  });
});
