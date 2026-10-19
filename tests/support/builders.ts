// Synthetic test data builders. Every name, merchant and amount is invented.
import type { Account, Transaction, TransactionKind } from '../../src/domain/types';

let counter = 0;

export function account(id: string, kind: Account['kind']): Account {
  return { id, displayName: `Test ${kind} ${id}`, kind, institution: 'Example Bank', archived: false };
}

export function tx(
  overrides: Partial<Transaction> & { amountCents: number; categoryId?: string; kind?: TransactionKind },
): Transaction {
  const { categoryId = 'exp.uncategorized', ...rest } = overrides;
  counter += 1;
  return {
    id: `t${counter}`,
    accountId: 'acct.checking',
    statementIds: ['s1'],
    postedDate: '2026-03-10',
    originalDescription: 'EXAMPLE MERCHANT',
    merchant: 'Example Merchant',
    kind: 'purchase',
    classification: { categoryId, source: 'user', confidence: 1, reasons: [] },
    needsReview: false,
    dedupeKey: '',
    ...rest,
  };
}
