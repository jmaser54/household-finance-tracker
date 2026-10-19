/**
 * Finds both sides of money moving between the household's own accounts:
 * checking ↔ savings transfers and credit-card payments (PROJECT_PRINCIPLES.md §10).
 *
 * A pair is an outflow in one account and an equal inflow in another, within
 * a few days. Equal amounts alone are weak evidence (a $50 purchase and an
 * unrelated $50 deposit), so a pair is only "confident" when a description
 * or account context supports it. Ambiguous pairings go to review; nothing is
 * guessed.
 */
import { daysBetween } from './dates';
import type { Account, Id, Transaction } from './types';

const TRANSFER_HINT = /\b(TRANSFER|XFER|TRNSFR|TO SAVINGS|FROM SAVINGS|TO CHECKING|FROM CHECKING)\b/i;
const PAYMENT_HINT = /\b(PAYMENT|PMT|AUTOPAY|AUTO PAY|THANK YOU|EPAY|E-PAYMENT)\b/i;

type TransferInput = Pick<
  Transaction,
  'id' | 'accountId' | 'postedDate' | 'amountCents' | 'originalDescription' | 'kind' | 'transferGroupId'
>;

export interface TransferProposal {
  outflowId: Id;
  inflowId: Id;
  kind: 'transfer' | 'card_payment';
  confident: boolean;
  reasons: string[];
}

export interface TransferMatchResult {
  proposals: TransferProposal[];
  /** Outflows with more than one plausible counterpart (or contested inflows). Left unpaired for review. */
  ambiguous: { transactionId: Id; candidateIds: Id[] }[];
}

export function matchTransfers(
  transactions: readonly TransferInput[],
  accounts: readonly Account[],
  windowDays = 5,
): TransferMatchResult {
  const accountKind = new Map(accounts.map((a) => [a.id, a.kind]));
  const open = transactions.filter((t) => !t.transferGroupId && t.amountCents !== 0);
  const outflows = open.filter((t) => t.amountCents < 0);
  const inflows = open.filter((t) => t.amountCents > 0);

  const candidatesFor = (outflow: TransferInput) =>
    inflows.filter(
      (inflow) =>
        inflow.accountId !== outflow.accountId &&
        inflow.amountCents === -outflow.amountCents &&
        Math.abs(daysBetween(outflow.postedDate, inflow.postedDate)) <= windowDays,
    );

  // Count how many outflows want each inflow, so contested inflows are not paired arbitrarily.
  const demand = new Map<Id, number>();
  const options = new Map<Id, TransferInput[]>();
  for (const outflow of outflows) {
    const candidates = candidatesFor(outflow);
    options.set(outflow.id, candidates);
    for (const c of candidates) demand.set(c.id, (demand.get(c.id) ?? 0) + 1);
  }

  const proposals: TransferProposal[] = [];
  const ambiguous: TransferMatchResult['ambiguous'] = [];
  for (const outflow of outflows) {
    const candidates = options.get(outflow.id) ?? [];
    if (candidates.length === 0) continue;
    if (candidates.length > 1 || demand.get(candidates[0]!.id)! > 1) {
      ambiguous.push({ transactionId: outflow.id, candidateIds: candidates.map((c) => c.id) });
      continue;
    }
    const inflow = candidates[0]!;
    const isCardPayment = accountKind.get(inflow.accountId) === 'credit_card';
    const reasons: string[] = ['Same amount left one of our accounts and arrived in another'];
    const texts = [outflow.originalDescription, inflow.originalDescription];
    const hinted = texts.some((d) => TRANSFER_HINT.test(d) || PAYMENT_HINT.test(d));
    if (hinted) reasons.push('Description mentions a transfer or payment');
    const alreadyKinded = [outflow.kind, inflow.kind].some((k) => k === 'transfer' || k === 'card_payment');
    if (alreadyKinded) reasons.push('Statement marks it as a transfer or payment');
    if (isCardPayment) reasons.push('Money arrived on a credit card account');

    proposals.push({
      outflowId: outflow.id,
      inflowId: inflow.id,
      kind: isCardPayment ? 'card_payment' : 'transfer',
      confident: hinted || alreadyKinded,
      reasons,
    });
  }
  return { proposals, ambiguous };
}
