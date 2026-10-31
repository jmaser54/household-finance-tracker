/**
 * Reviewing and correcting transactions (PROJECT_PRINCIPLES.md §11):
 * choosing a category, renaming, notes, and the explicit choice to apply a
 * category to the other transactions with the same name. Every function is
 * pure and returns a new ledger; the caller saves it.
 *
 * - A person's own choice (source "user") is never overwritten by anything.
 * - Applying a category to others is always an explicit choice. It changes
 *   only transactions with the same name and direction that the person
 *   hasn't set themselves, and is remembered as a rule for future imports.
 * - The original statement description is never edited.
 */
import { refreshBuiltInCategories, UNCATEGORIZED_IDS } from '../domain/categories';
import type { CategorizationRule, Category, Id, Transaction, TransactionKind } from '../domain/types';
import { legacyMerchantFrom, merchantFrom } from '../import/classify';
import { guessSpendingCategory } from '../import/merchantGuesses';
import type { LedgerDocument } from '../storage/ledger';

export interface EditOptions {
  now: Date;
  newId: () => Id;
}

/** Waiting for the person: not yet in a category, or flagged for a closer look. */
export function isReadyToSort(t: Transaction): boolean {
  return t.needsReview || UNCATEGORIZED_IDS.has(t.classification.categoryId);
}

const direction = (t: Pick<Transaction, 'amountCents'>): 'in' | 'out' => (t.amountCents < 0 ? 'out' : 'in');
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * What a transaction is, once it is in `category`: choosing spending or
 * income for something marked as a transfer makes it count, and choosing a
 * transfer category makes it stop counting. A compatible kind is kept.
 */
export function kindFor(t: Pick<Transaction, 'kind' | 'amountCents'>, category: Category): TransactionKind {
  const movement = t.kind === 'transfer' || t.kind === 'card_payment';
  if (category.kind === 'transfer') return category.id === 'xfer.card_payment' ? 'card_payment' : 'transfer';
  if (category.kind === 'expense') {
    if (!movement && t.kind !== 'income' && t.kind !== 'interest') return t.kind;
    if (t.amountCents >= 0) return 'refund';
    return category.id === 'exp.fees' ? 'fee' : category.id === 'exp.cash' ? 'cash_withdrawal' : 'purchase';
  }
  if (!movement && (t.kind === 'income' || t.kind === 'interest' || t.kind === 'refund')) return t.kind;
  return category.id === 'inc.interest' ? 'interest' : category.id === 'inc.refunds' ? 'refund' : 'income';
}

function placeIn(t: Transaction, category: Category, classification: Transaction['classification']): Transaction {
  const kind = kindFor(t, category);
  const next: Transaction = { ...t, kind, classification, needsReview: false };
  // No longer a movement between accounts: it stands on its own.
  if (kind !== 'transfer' && kind !== 'card_payment') delete next.transferGroupId;
  return next;
}

/** The other transactions "apply to others" would change: same name and direction, not set by hand. */
export function othersLike(ledger: LedgerDocument, transactionId: Id): Transaction[] {
  const t = ledger.transactions.find((x) => x.id === transactionId);
  if (!t) return [];
  return ledger.transactions.filter(
    (x) => x.id !== t.id && sameName(x.merchant, t.merchant) && direction(x) === direction(t) && x.classification.source !== 'user',
  );
}

/**
 * Puts one transaction in a category, as the person's own choice. With
 * `alsoOthers`, the same category goes to `othersLike` and is remembered for
 * future imports. Returns the new ledger and how many others changed.
 */
export function setCategory(
  ledger: LedgerDocument,
  transactionId: Id,
  categoryId: Id,
  options: EditOptions & { alsoOthers: boolean },
): { ledger: LedgerDocument; othersChanged: number } {
  const category = ledger.categories.find((c) => c.id === categoryId);
  const t = ledger.transactions.find((x) => x.id === transactionId);
  if (!category || !t) return { ledger, othersChanged: 0 };

  let rules = ledger.rules;
  let rule: CategorizationRule | undefined;
  const others = options.alsoOthers ? new Set(othersLike(ledger, transactionId).map((x) => x.id)) : new Set<Id>();
  if (options.alsoOthers) {
    const match = { field: 'merchant' as const, mode: 'equals' as const, text: t.merchant.trim(), direction: direction(t) };
    const existing = rules.find(
      (r) => r.match.field === 'merchant' && r.match.mode === 'equals' && sameName(r.match.text, match.text) && r.match.direction === match.direction,
    );
    rule = existing
      ? { ...existing, set: { ...existing.set, categoryId } }
      : { id: options.newId(), match, set: { categoryId }, origin: 'user_correction', createdAt: options.now.toISOString() };
    rules = existing ? rules.map((r) => (r.id === existing.id ? rule! : r)) : [...rules, rule];
  }

  const transactions = ledger.transactions.map((x) => {
    if (x.id === t.id) {
      return placeIn(x, category, { categoryId, source: 'user', confidence: 1, reasons: ['You chose this'] });
    }
    if (rule && others.has(x.id)) {
      return placeIn(x, category, {
        categoryId,
        source: 'rule',
        confidence: 0.9,
        ruleId: rule.id,
        reasons: [`You chose ${category.name} for every "${t.merchant.trim()}"`],
      });
    }
    return x;
  });
  return { ledger: { ...ledger, transactions, rules }, othersChanged: others.size };
}

/** "Looks right": keeps the category the app chose and takes it off the to-sort pile. */
export function looksRight(ledger: LedgerDocument, transactionId: Id): LedgerDocument {
  return {
    ...ledger,
    transactions: ledger.transactions.map((x) =>
      x.id === transactionId
        ? { ...x, needsReview: false, classification: { ...x.classification, source: 'user', confidence: 1, reasons: ['You confirmed this'] } }
        : x,
    ),
  };
}

/** Renames this transaction only. The statement's own description is kept as it was. */
export function setName(ledger: LedgerDocument, transactionId: Id, name: string): LedgerDocument {
  const trimmed = name.trim();
  return {
    ...ledger,
    transactions: ledger.transactions.map((x) => (x.id === transactionId && trimmed ? { ...x, merchant: trimmed } : x)),
  };
}

export function setNote(ledger: LedgerDocument, transactionId: Id, note: string): LedgerDocument {
  const trimmed = note.trim();
  return {
    ...ledger,
    transactions: ledger.transactions.map((x) => {
      if (x.id !== transactionId) return x;
      const { note: _old, ...rest } = x;
      return trimmed ? { ...rest, note: trimmed } : rest;
    }),
  };
}

/** The rule (if any) that puts a new transaction with this name and amount in a category. */
export function ruleFor(rules: readonly CategorizationRule[], merchant: string, amountCents: number): CategorizationRule | undefined {
  return rules.find(
    (r) =>
      r.set.categoryId !== undefined &&
      r.match.field === 'merchant' &&
      r.match.mode === 'equals' &&
      sameName(r.match.text, merchant) &&
      (r.match.direction === undefined || r.match.direction === direction({ amountCents })),
  );
}

/**
 * Brings a just-opened household up to date with this version: the current
 * built-in category list, and the built-in starting guesses for purchases
 * that were imported before the guesses existed and are still Uncategorized
 * by the app's own first pass, and today's tidier names ("ATM", not "Atm")
 * for names nobody has changed. Nothing the person set, and nothing set by
 * one of their rules, is touched. Returns the same ledger if nothing changed.
 */
export function upgradeLedger(ledger: LedgerDocument): LedgerDocument {
  const categories = refreshBuiltInCategories(ledger.categories);
  let changed = categories !== ledger.categories;
  const transactions = ledger.transactions.map((original) => {
    let t = original;
    // A name still exactly as an earlier version tidied it was never changed by the person.
    const tidy = merchantFrom(t.originalDescription);
    if (t.merchant !== tidy && t.merchant === legacyMerchantFrom(t.originalDescription)) {
      t = { ...t, merchant: tidy };
      changed = true;
    }
    if (t.classification.source !== 'heuristic' && t.classification.source !== 'default') return t;
    if (t.kind !== 'purchase' || t.amountCents >= 0 || t.classification.categoryId !== 'exp.uncategorized') return t;
    const guess = guessSpendingCategory(t.originalDescription);
    if (!guess) return t;
    changed = true;
    return {
      ...t,
      needsReview: false,
      classification: { categoryId: guess.categoryId, source: 'heuristic' as const, confidence: 0.7, reasons: [guess.reason] },
    };
  });
  return changed ? { ...ledger, categories, transactions } : ledger;
}
