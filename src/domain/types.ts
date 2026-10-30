/**
 * Household ledger data model (schema version 1, draft).
 *
 * Read PROJECT_PRINCIPLES.md §6 (financial definitions) and
 * docs/ARCHITECTURE.md ("Data model") before changing anything here. Every
 * persisted shape is part of the backup format, so changes need a schema
 * version bump and a migration.
 *
 * Sign convention, used everywhere: amounts are signed integer cents from the
 * household's point of view. Negative = money leaving the household or debt
 * increasing (a purchase, a card charge, a withdrawal). Positive = money
 * arriving or debt decreasing (a paycheck, a refund, a card payment received).
 * Parsers translate each issuer's printed signs into this convention.
 */
import type { Cents } from './money';

export const SCHEMA_VERSION = 1;

/** ISO calendar date, "YYYY-MM-DD". No times or time zones. */
export type IsoDate = string;

/** Opaque random identifier (crypto.randomUUID()). Never derived from financial data. */
export type Id = string;

export type AccountKind = 'checking' | 'savings' | 'credit_card';

export interface Account {
  id: Id;
  /** User-chosen label such as "Julia's checking". A setting, not hardcoded. */
  displayName: string;
  kind: AccountKind;
  /** Free-text institution name shown in the UI. */
  institution: string;
  /**
   * Last four digits only, used to match statements to accounts. Full account
   * numbers are never stored; parsers must discard them after matching.
   */
  last4?: string;
  /** Which parser normally reads this account's statements. */
  parserId?: string;
  /** Hidden from pickers when closed, but its history is kept. */
  archived: boolean;
}

export type CategoryKind =
  /** Counts toward recognized expenses. */
  | 'expense'
  /** Counts toward recognized income. */
  | 'income'
  /** Movement between the household's own accounts. Never income or expense. */
  | 'transfer';

export interface Category {
  id: Id;
  name: string;
  kind: CategoryKind;
  /** Optional one-level hierarchy. Reports roll subcategories into parents. */
  parentId?: Id;
  /** Built-in categories cannot be deleted (they can be renamed or hidden). */
  builtIn: boolean;
  /** Shown prominently on the dashboard even when small (e.g. Childcare & School). */
  prominent?: boolean;
  hidden?: boolean;
}

/**
 * What a transaction *is*, independent of which category it lands in. Drives
 * the financial definitions: transfers and card payments are excluded from
 * income and expense totals no matter how they are categorized.
 */
export type TransactionKind =
  | 'purchase'
  | 'refund'
  | 'income'
  | 'transfer'
  | 'card_payment'
  | 'cash_withdrawal'
  | 'fee'
  | 'interest'
  | 'adjustment'
  | 'unknown';

export type ClassificationSource =
  /** Set by the user on this transaction. Always wins; never overwritten by imports. */
  | 'user'
  /** From an editable merchant/transaction rule (usually learned from a correction). */
  | 'rule'
  /** From built-in heuristics (keywords, recurrence, account context). */
  | 'heuristic'
  /** Nothing matched. */
  | 'default';

export interface Classification {
  categoryId: Id;
  source: ClassificationSource;
  /** 0..1. Below the review threshold the transaction is flagged for review. */
  confidence: number;
  ruleId?: Id;
  /** Short, plain-language reasons shown in the review screen. */
  reasons: string[];
}

/** Splits must sum exactly to the transaction amount. */
export interface Split {
  categoryId: Id;
  amountCents: Cents;
  note?: string;
}

export interface Transaction {
  id: Id;
  accountId: Id;
  /** Statement(s) this transaction appeared on; more than one when periods overlap. */
  statementIds: Id[];
  postedDate: IsoDate;
  transactionDate?: IsoDate;
  amountCents: Cents;
  /** Exactly as extracted from the statement, never edited. */
  originalDescription: string;
  /** Normalized merchant label (editable, mergeable). */
  merchant: string;
  kind: TransactionKind;
  classification: Classification;
  /** Optional split across categories, e.g. part of a cash withdrawal. */
  splits?: Split[];
  /** Links both sides of an internal transfer or card payment. */
  transferGroupId?: Id;
  /** For refunds: the original purchase this refund offsets, when identified. */
  refundOfTransactionId?: Id;
  needsReview: boolean;
  note?: string;
  /** Stable key used by duplicate detection; see docs/ARCHITECTURE.md. */
  dedupeKey: string;
}

export type ValidationStatus = 'verified' | 'partially_verified' | 'unverified' | 'failed';

export interface StatementValidation {
  status: ValidationStatus;
  /** Plain-language checks, e.g. "Opening + activity = closing balance". */
  checks: { label: string; passed: boolean | null }[];
}

export interface Statement {
  id: Id;
  accountId: Id;
  periodStart: IsoDate;
  periodEnd: IsoDate;
  openingBalanceCents?: Cents;
  closingBalanceCents?: Cents;
  /** SHA-256 of the PDF bytes, to recognise the same file imported twice. The PDF itself is not stored. */
  fileSha256: string;
  /**
   * For a PDF holding several accounts (e.g. checking and savings), which
   * account section of the file this statement is, counting from 0.
   */
  fileSection?: number;
  parserId: string;
  parserVersion: number;
  transactionCount: number;
  validation: StatementValidation;
  importedAt: string;
  importBatchId: Id;
}

/**
 * Imports are staged separately from the ledger. Nothing in a batch touches
 * accounts, transactions or rules until the user confirms it, and confirmation
 * is applied in a single IndexedDB transaction.
 */
export type ImportBatchStatus = 'staged' | 'committed' | 'discarded';

export type RuleMatchField = 'description' | 'merchant';

export interface CategorizationRule {
  id: Id;
  match: {
    field: RuleMatchField;
    /** Case-insensitive substring or exact match; no user-supplied regular expressions. */
    mode: 'contains' | 'equals';
    text: string;
    accountId?: Id;
    direction?: 'in' | 'out';
    minCents?: Cents;
    maxCents?: Cents;
  };
  set: {
    merchant?: string;
    categoryId?: Id;
    kind?: TransactionKind;
  };
  /** Rules learned from corrections outrank built-in heuristics. */
  origin: 'user_correction' | 'user_created';
  createdAt: string;
}

export interface HouseholdSettings {
  householdName: string;
  /** Below this confidence a transaction is flagged for review. */
  reviewThreshold: number;
  lastBackupAt?: string;
}
