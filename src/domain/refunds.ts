/**
 * Links refunds to the purchases they reverse (PROJECT_PRINCIPLES.md §10.8).
 * A linked refund takes the purchase's spending category, reducing spending.
 * An unlinked refund is flagged for review and never becomes ordinary income.
 */
import { daysBetween } from './dates';
import type { Id, Transaction } from './types';

type RefundInput = Pick<
  Transaction,
  'id' | 'accountId' | 'postedDate' | 'amountCents' | 'merchant' | 'kind' | 'classification'
>;

export type RefundLink =
  | { status: 'linked'; originalId: Id; categoryId: Id; exactAmount: boolean }
  | { status: 'ambiguous'; candidateIds: Id[] }
  | { status: 'unmatched' };

/** Default lookback for the original purchase. */
export const REFUND_LOOKBACK_DAYS = 120;

export function findRefundOriginal(
  refund: RefundInput,
  history: readonly RefundInput[],
  lookbackDays = REFUND_LOOKBACK_DAYS,
): RefundLink {
  if (refund.amountCents <= 0) return { status: 'unmatched' };
  const merchant = refund.merchant.trim().toUpperCase();
  if (!merchant) return { status: 'unmatched' };

  const candidates = history.filter((purchase) => {
    if (purchase.id === refund.id || purchase.amountCents >= 0) return false;
    if (purchase.merchant.trim().toUpperCase() !== merchant) return false;
    const age = daysBetween(purchase.postedDate, refund.postedDate);
    return age >= 0 && age <= lookbackDays && -purchase.amountCents >= refund.amountCents;
  });

  // An exact-amount match on the same account is the strongest evidence.
  const exact = candidates.filter((p) => -p.amountCents === refund.amountCents);
  const sameAccountExact = exact.filter((p) => p.accountId === refund.accountId);
  for (const pool of [sameAccountExact, exact, candidates]) {
    if (pool.length === 1) {
      const original = pool[0]!;
      return {
        status: 'linked',
        originalId: original.id,
        categoryId: original.classification.categoryId,
        exactAmount: -original.amountCents === refund.amountCents,
      };
    }
    if (pool.length > 1) return { status: 'ambiguous', candidateIds: pool.map((p) => p.id) };
  }
  return { status: 'unmatched' };
}
