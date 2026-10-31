/**
 * First-pass classification of imported transactions, following the
 * financial definitions in PROJECT_PRINCIPLES.md §10–§11. It is deliberately
 * cautious: anything uncertain is flagged for review, money arriving is never
 * assumed to be employment income, and card payments and transfers are only
 * marked as such (not spending) when the statement says so. Transfer pairing
 * and refund linking happen afterwards (plan.ts), using src/domain.
 */
import type { AccountKind, Id, TransactionKind } from '../domain/types';
import { guessSpendingCategory } from './merchantGuesses';

export interface FirstPass {
  kind: TransactionKind;
  categoryId: Id;
  confidence: number;
  reasons: string[];
  needsReview: boolean;
}

const CASH = /\b(ATM|CASH WITHDRAWAL|CASH WDL|WITHDRAWAL CASH)\b/i;
const CARD_PAYMENT_FROM_BANK =
  /\b(card payment|credit card|crd pmt|payment to .*\b(card|visa|mastercard|amex|discover)\b|\bcard ending\b.*payment|payment.*\bcard ending\b)/i;
const PAYMENT_ON_CARD = /\b(payment|pmt|autopay|auto pay|thank you)\b/i;
const TRANSFER = /\b(transfer|xfer|trnsfr|to savings|from savings|to checking|from checking)\b/i;
const FEE = /\b(fee|interest charge)\b/i;
const INTEREST_EARNED = /\b(interest (paid|earned|credit|payment)|^interest$)/i;
const PAY = /\b(payroll|direct dep|salary)\b/i;

export function classify(transaction: { amountCents: number; description: string }, accountKind: AccountKind): FirstPass {
  const { amountCents: amount, description: d } = transaction;
  const pass = (kind: TransactionKind, categoryId: Id, confidence: number, reasons: string[], needsReview: boolean): FirstPass => ({
    kind,
    categoryId,
    confidence,
    reasons,
    needsReview,
  });

  if (amount < 0 && CASH.test(d)) return pass('cash_withdrawal', 'exp.cash', 0.9, ['Cash withdrawal'], false);

  if (accountKind === 'credit_card') {
    if (amount > 0 && PAYMENT_ON_CARD.test(d)) {
      return pass('card_payment', 'xfer.card_payment', 0.8, ['Payment received on the card (not income)'], false);
    }
    if (amount > 0) return pass('refund', 'inc.refunds', 0.3, ['Credit on the card: probably a refund'], true);
    if (FEE.test(d)) return pass('fee', 'exp.fees', 0.7, ['Card fee or interest charge'], false);
    return purchase(d);
  }

  if (amount < 0) {
    if (CARD_PAYMENT_FROM_BANK.test(d)) {
      return pass('card_payment', 'xfer.card_payment', 0.7, ['Looks like a credit card payment (not spending)'], true);
    }
    if (TRANSFER.test(d)) return pass('transfer', 'xfer.internal', 0.6, ['Looks like a transfer between our accounts'], true);
    if (FEE.test(d)) return pass('fee', 'exp.fees', 0.7, ['Bank fee'], false);
    return purchase(d);
  }

  if (INTEREST_EARNED.test(d)) return pass('interest', 'inc.interest', 0.9, ['Interest paid by the bank'], false);
  if (TRANSFER.test(d)) return pass('transfer', 'xfer.internal', 0.6, ['Looks like a transfer between our accounts'], true);
  if (PAY.test(d)) {
    return pass('income', 'inc.employment', 0.5, ['Description mentions pay: please confirm it is employment income'], true);
  }
  return pass('income', 'inc.uncategorized', 0, ['Money in: choose what it was (pay, gift, refund…)'], true);
}

/** Money going out on a purchase: a conservative built-in guess, or Uncategorized and ready to sort. */
function purchase(description: string): FirstPass {
  const guess = guessSpendingCategory(description);
  if (guess) return { kind: 'purchase', categoryId: guess.categoryId, confidence: 0.7, reasons: [guess.reason], needsReview: false };
  return { kind: 'purchase', categoryId: 'exp.uncategorized', confidence: 0, reasons: ['Choose a category'], needsReview: true };
}

/** A friendlier merchant label; the original description is always kept too. */
export function merchantFrom(description: string): string {
  const cleaned = description
    .replace(/\b(purchase|return|refund|pos|debit card|recurring|autopay)\b/gi, ' ')
    .replace(/\b(ref|id|conf)\s*#?\s*\w*\d\w*/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const label = cleaned === '' ? description.trim() : cleaned;
  // Words become "Title Case"; abbreviations and anything with a digit stay as printed ("ATM", "XXXX7310", "#12").
  return label
    .split(' ')
    .map((word) => (/\d/.test(word) || ABBREVIATIONS.has(word.toUpperCase()) ? word : word.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase())))
    .join(' ');
}

const ABBREVIATIONS = new Set(['ATM', 'ACH', 'CVS', 'USA', 'LLC', 'BP', 'AT&T', 'TV', 'DMV', 'IRS', 'HOA', 'PPD', 'WEB']);

/** How earlier versions tidied names, to recognise a name nobody has changed (see upgradeLedger). */
export function legacyMerchantFrom(description: string): string {
  const cleaned = description
    .replace(/\b(purchase|return|refund|pos|debit card|recurring|autopay)\b/gi, ' ')
    .replace(/\b(ref|id|conf)\s*#?\s*\w*\d\w*/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const label = cleaned === '' ? description.trim() : cleaned;
  return label.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase());
}
