import { describe, expect, it } from 'vitest';
import { tx } from '../../tests/support/builders';
import { allocate, LedgerIntegrityError, summarize } from './calculations';
import { DEFAULT_CATEGORIES } from './categories';

const MARCH = { start: '2026-03-01', end: '2026-03-31' };
const categories = new Map(DEFAULT_CATEGORIES.map((c) => [c.id, c]));
const run = (...transactions: ReturnType<typeof tx>[]) => summarize(transactions, DEFAULT_CATEGORIES, MARCH);

describe('financial definitions (PROJECT_PRINCIPLES.md §10)', () => {
  it('counts purchases as spending', () => {
    const s = run(tx({ amountCents: -4_250, categoryId: 'exp.groceries' }));
    expect(s.expenseCents).toBe(4_250);
    expect(s.incomeCents).toBe(0);
    expect(s.netCashFlowCents).toBe(-4_250);
  });

  it('counts a credit-card purchase as spending when charged, and its payment as neither', () => {
    const s = run(
      tx({ accountId: 'acct.card', amountCents: -12_000, categoryId: 'exp.dining', postedDate: '2026-03-05' }),
      // Paying the card bill: out of checking, onto the card.
      tx({ accountId: 'acct.checking', amountCents: -12_000, kind: 'card_payment', categoryId: 'xfer.card_payment', postedDate: '2026-03-25' }),
      tx({ accountId: 'acct.card', amountCents: 12_000, kind: 'card_payment', categoryId: 'xfer.card_payment', postedDate: '2026-03-25' }),
    );
    expect(s.expenseCents).toBe(12_000);
    expect(s.incomeCents).toBe(0);
    expect(s.excludedTransactionIds).toHaveLength(2);
  });

  it('excludes a card payment even if it was miscategorized as spending', () => {
    const s = run(tx({ amountCents: -50_000, kind: 'card_payment', categoryId: 'exp.shopping' }));
    expect(s.expenseCents).toBe(0);
  });

  it('treats transfers between our own accounts, including into savings, as neither income nor spending', () => {
    const s = run(
      tx({ accountId: 'acct.checking', amountCents: -100_000, kind: 'transfer', categoryId: 'xfer.internal' }),
      tx({ accountId: 'acct.savings', amountCents: 100_000, kind: 'transfer', categoryId: 'xfer.internal' }),
    );
    expect(s).toMatchObject({ incomeCents: 0, expenseCents: 0, netCashFlowCents: 0 });
  });

  it('combines both spouses’ pay into one Employment Income category, separate from family gifts', () => {
    const s = run(
      tx({ accountId: 'acct.checking.a', amountCents: 310_000, kind: 'income', categoryId: 'inc.employment' }),
      tx({ accountId: 'acct.checking.b', amountCents: 285_000, kind: 'income', categoryId: 'inc.employment' }),
      tx({ amountCents: 50_000, kind: 'income', categoryId: 'inc.family_gifts' }),
    );
    expect(s.incomeCents).toBe(645_000);
    expect(s.incomeByCategory).toEqual([
      expect.objectContaining({ categoryId: 'inc.employment', totalCents: 595_000 }),
      expect.objectContaining({ categoryId: 'inc.family_gifts', totalCents: 50_000 }),
    ]);
  });

  it('lets a linked refund reduce its original spending category instead of adding income', () => {
    const s = run(
      tx({ amountCents: -8_000, categoryId: 'exp.shopping' }),
      tx({ amountCents: 3_000, kind: 'refund', categoryId: 'exp.shopping', refundOfTransactionId: 'x' }),
    );
    expect(s.expenseCents).toBe(5_000);
    expect(s.incomeCents).toBe(0);
  });

  it('counts an unlinked refund the user accepted as Refunds & Reimbursements income', () => {
    const s = run(tx({ amountCents: 2_500, kind: 'refund', categoryId: 'inc.refunds' }));
    expect(s.incomeByCategory).toEqual([expect.objectContaining({ categoryId: 'inc.refunds', totalCents: 2_500 })]);
  });

  it('counts a cash withdrawal as Cash / Untracked Cash Spending without explanation', () => {
    const s = run(tx({ amountCents: -20_000, kind: 'cash_withdrawal', categoryId: 'exp.cash' }));
    expect(s.expenseByCategory).toEqual([expect.objectContaining({ categoryId: 'exp.cash', totalCents: 20_000 })]);
  });

  it('splits a cash withdrawal across categories', () => {
    const s = run(
      tx({
        amountCents: -20_000,
        kind: 'cash_withdrawal',
        categoryId: 'exp.cash',
        splits: [
          { categoryId: 'exp.gifts_giving', amountCents: -15_000, note: 'Birthday gift' },
          { categoryId: 'exp.cash', amountCents: -5_000 },
        ],
      }),
    );
    expect(s.expenseCents).toBe(20_000);
    expect(s.expenseByCategory.map((c) => [c.categoryId, c.totalCents])).toEqual([
      ['exp.gifts_giving', 15_000],
      ['exp.cash', 5_000],
    ]);
  });

  it('rejects splits that do not add up exactly', () => {
    const bad = tx({
      amountCents: -20_000,
      splits: [
        { categoryId: 'exp.cash', amountCents: -10_000 },
        { categoryId: 'exp.groceries', amountCents: -9_999 },
      ],
    });
    expect(() => allocate(bad, categories)).toThrow(LedgerIntegrityError);
  });

  it('rejects fractional cents and unknown categories', () => {
    expect(() => allocate(tx({ amountCents: -10.5 }), categories)).toThrow(LedgerIntegrityError);
    expect(() => allocate(tx({ amountCents: -100, categoryId: 'nope' }), categories)).toThrow(LedgerIntegrityError);
  });

  it('computes net cash flow as income minus spending, which differs from a balance change', () => {
    // Checking balance falls by 1,000.00 + 300.00 = 1,300.00 but only the 300.00 is spending.
    const s = run(
      tx({ amountCents: 400_000, kind: 'income', categoryId: 'inc.employment' }),
      tx({ amountCents: -30_000, categoryId: 'exp.groceries' }),
      tx({ amountCents: -100_000, kind: 'transfer', categoryId: 'xfer.internal' }),
      tx({ accountId: 'acct.savings', amountCents: 100_000, kind: 'transfer', categoryId: 'xfer.internal' }),
    );
    expect(s.netCashFlowCents).toBe(370_000);
  });

  it('only includes transactions posted inside the period', () => {
    const s = run(
      tx({ amountCents: -1_000, categoryId: 'exp.groceries', postedDate: '2026-02-28' }),
      tx({ amountCents: -2_000, categoryId: 'exp.groceries', postedDate: '2026-03-01' }),
      tx({ amountCents: -4_000, categoryId: 'exp.groceries', postedDate: '2026-03-31' }),
      tx({ amountCents: -8_000, categoryId: 'exp.groceries', postedDate: '2026-04-01' }),
    );
    expect(s.expenseCents).toBe(6_000);
  });

  it('rolls subcategories into their parent and keeps totals traceable to transactions', () => {
    const rent = tx({ amountCents: -200_000, categoryId: 'exp.housing.rent_mortgage' });
    const power = tx({ amountCents: -9_000, categoryId: 'exp.housing.utilities' });
    const s = run(rent, power);
    expect(s.expenseByCategory).toEqual([
      { categoryId: 'exp.housing', totalCents: 209_000, transactionIds: [rent.id, power.id] },
    ]);
  });

  it('measures how much lands in catch-all categories', () => {
    const s = run(
      tx({ amountCents: -7_500, categoryId: 'exp.groceries' }),
      tx({ amountCents: -2_000, categoryId: 'exp.other' }),
      tx({ amountCents: -500, categoryId: 'exp.uncategorized', needsReview: true }),
    );
    expect(s.catchAllExpenseShare).toBeCloseTo(0.25);
    expect(s.needsReviewCount).toBe(1);
  });

  it('handles an empty period', () => {
    expect(run()).toMatchObject({ incomeCents: 0, expenseCents: 0, netCashFlowCents: 0, catchAllExpenseShare: 0 });
  });
});
