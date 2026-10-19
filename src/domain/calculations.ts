/**
 * Income, spending and net cash flow, implementing PROJECT_PRINCIPLES.md §10.
 *
 * Pure functions over plain data: no storage, no UI, no network. Every total
 * is traceable to the transaction ids that produced it.
 */
import { CATCH_ALL_CATEGORY_IDS } from './categories';
import { inRange, type DateRange } from './dates';
import { sumCents, type Cents } from './money';
import type { Category, Id, Split, Transaction } from './types';

/** Thrown when data violates an invariant that calculations depend on. */
export class LedgerIntegrityError extends Error {
  constructor(
    message: string,
    readonly transactionId?: Id,
  ) {
    super(message);
    this.name = 'LedgerIntegrityError';
  }
}

/** Kinds that move money between our own accounts. Never income or spending. */
const NEVER_RECOGNIZED = new Set<Transaction['kind']>(['transfer', 'card_payment']);

export type Recognition = 'income' | 'expense' | 'excluded';

/** One categorized slice of a transaction (the whole amount, or one split). */
export interface Allocation {
  transactionId: Id;
  categoryId: Id;
  recognition: Recognition;
  /**
   * Contribution to its total, as a positive-means-more number:
   * - income: money received is positive (a payroll reversal is negative);
   * - expense: money spent is positive (a linked refund is negative, reducing spending);
   * - excluded: the signed household amount, for reference only.
   */
  amountCents: Cents;
}

export function validateSplits(transaction: Transaction): void {
  const splits = transaction.splits;
  if (!splits) return;
  if (splits.length === 0) throw new LedgerIntegrityError('A split needs at least one part', transaction.id);
  for (const split of splits) {
    if (!Number.isInteger(split.amountCents)) {
      throw new LedgerIntegrityError('Split amounts must be whole cents', transaction.id);
    }
  }
  if (sumCents(splits.map((s) => s.amountCents)) !== transaction.amountCents) {
    throw new LedgerIntegrityError('Split parts must add up exactly to the transaction amount', transaction.id);
  }
}

/** Breaks a transaction into its recognized allocations. */
export function allocate(transaction: Transaction, categories: ReadonlyMap<Id, Category>): Allocation[] {
  if (!Number.isInteger(transaction.amountCents)) {
    throw new LedgerIntegrityError('Amounts must be whole cents', transaction.id);
  }
  validateSplits(transaction);
  const parts: Pick<Split, 'categoryId' | 'amountCents'>[] = transaction.splits ?? [
    { categoryId: transaction.classification.categoryId, amountCents: transaction.amountCents },
  ];

  return parts.map((part) => {
    const category = categories.get(part.categoryId);
    if (!category) throw new LedgerIntegrityError('Transaction refers to an unknown category', transaction.id);

    let recognition: Recognition;
    if (NEVER_RECOGNIZED.has(transaction.kind) || category.kind === 'transfer') recognition = 'excluded';
    else recognition = category.kind;

    const amountCents =
      recognition === 'expense' ? -part.amountCents : part.amountCents; // household sign → "spent" sign
    return { transactionId: transaction.id, categoryId: part.categoryId, recognition, amountCents };
  });
}

export interface CategoryTotal {
  categoryId: Id;
  totalCents: Cents;
  transactionIds: Id[];
}

export interface PeriodSummary {
  range: DateRange;
  /** Recognized income. */
  incomeCents: Cents;
  /** Recognized spending, net of linked refunds. */
  expenseCents: Cents;
  /** incomeCents − expenseCents. Not a change in any account balance. */
  netCashFlowCents: Cents;
  /** Rolled up to top-level categories, largest first. */
  incomeByCategory: CategoryTotal[];
  expenseByCategory: CategoryTotal[];
  /** Transfers and card payments, shown for transparency but never totalled into income or spending. */
  excludedTransactionIds: Id[];
  /** Share of spending/income sitting in Other or Uncategorized (0..1). */
  catchAllExpenseShare: number;
  catchAllIncomeShare: number;
  needsReviewCount: number;
}

/**
 * Summarizes a period. Transactions are placed by posted date, the date the
 * charge or deposit appears on the statement, which makes every number
 * traceable to statement lines (card purchases count when charged, not when
 * the card bill is paid).
 */
export function summarize(
  transactions: readonly Transaction[],
  categoryList: readonly Category[],
  range: DateRange,
): PeriodSummary {
  const categories = new Map(categoryList.map((c) => [c.id, c]));
  const topLevel = (id: Id) => categories.get(id)?.parentId ?? id;

  const income = new Map<Id, CategoryTotal>();
  const expense = new Map<Id, CategoryTotal>();
  const excluded: Id[] = [];
  let needsReviewCount = 0;

  for (const transaction of transactions) {
    if (!inRange(transaction.postedDate, range)) continue;
    if (transaction.needsReview) needsReviewCount++;
    for (const allocation of allocate(transaction, categories)) {
      if (allocation.recognition === 'excluded') {
        if (!excluded.includes(transaction.id)) excluded.push(transaction.id);
        continue;
      }
      const bucket = allocation.recognition === 'income' ? income : expense;
      const key = topLevel(allocation.categoryId);
      const total = bucket.get(key) ?? { categoryId: key, totalCents: 0, transactionIds: [] };
      total.totalCents += allocation.amountCents;
      if (!total.transactionIds.includes(transaction.id)) total.transactionIds.push(transaction.id);
      bucket.set(key, total);
    }
  }

  const sorted = (bucket: Map<Id, CategoryTotal>) =>
    [...bucket.values()].sort((a, b) => b.totalCents - a.totalCents || a.categoryId.localeCompare(b.categoryId));
  const incomeByCategory = sorted(income);
  const expenseByCategory = sorted(expense);
  const incomeCents = sumCents(incomeByCategory.map((c) => c.totalCents));
  const expenseCents = sumCents(expenseByCategory.map((c) => c.totalCents));

  return {
    range,
    incomeCents,
    expenseCents,
    netCashFlowCents: incomeCents - expenseCents,
    incomeByCategory,
    expenseByCategory,
    excludedTransactionIds: excluded,
    catchAllExpenseShare: catchAllShare(expenseByCategory, expenseCents),
    catchAllIncomeShare: catchAllShare(incomeByCategory, incomeCents),
    needsReviewCount,
  };
}

function catchAllShare(totals: CategoryTotal[], whole: Cents): number {
  if (whole <= 0) return 0;
  const caught = sumCents(totals.filter((t) => CATCH_ALL_CATEGORY_IDS.has(t.categoryId)).map((t) => t.totalCents));
  return Math.max(0, caught) / whole;
}

/** Above this share, catch-all categories are surfaced as a quality problem to fix. */
export const CATCH_ALL_WARNING_SHARE = 0.1;
