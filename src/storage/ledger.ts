/**
 * The household ledger as one document: what is encrypted and saved on the
 * Mac (docs/ARCHITECTURE.md §8). Validated whenever it is read or written so
 * damaged or inconsistent data is reported, never silently used.
 */
import { validateSplits } from '../domain/calculations';
import { DEFAULT_CATEGORIES } from '../domain/categories';
import {
  SCHEMA_VERSION,
  type Account,
  type CategorizationRule,
  type Category,
  type HouseholdSettings,
  type Statement,
  type Transaction,
} from '../domain/types';

export interface LedgerDocument {
  schemaVersion: number;
  accounts: Account[];
  statements: Statement[];
  transactions: Transaction[];
  categories: Category[];
  rules: CategorizationRule[];
  settings: HouseholdSettings;
}

export type LedgerFormatErrorCode = 'not_json' | 'newer_version' | 'invalid_shape' | 'broken_reference';

export class LedgerFormatError extends Error {
  constructor(readonly code: LedgerFormatErrorCode) {
    // Fixed message only: never include ledger content.
    super(`Ledger format problem: ${code}`);
    this.name = 'LedgerFormatError';
  }
}

export function emptyLedger(): LedgerDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    accounts: [],
    statements: [],
    transactions: [],
    categories: DEFAULT_CATEGORIES.map((category) => ({ ...category })),
    rules: [],
    settings: { householdName: '', reviewThreshold: 0.8 },
  };
}

export function serializeLedger(ledger: LedgerDocument): string {
  validateLedger(ledger);
  return JSON.stringify(ledger);
}

export function parseLedger(json: string): LedgerDocument {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new LedgerFormatError('not_json');
  }
  if (!isObject(value) || typeof value.schemaVersion !== 'number' || !Number.isInteger(value.schemaVersion)) {
    throw new LedgerFormatError('invalid_shape');
  }
  if (value.schemaVersion > SCHEMA_VERSION) throw new LedgerFormatError('newer_version');
  if (value.schemaVersion < 1) throw new LedgerFormatError('invalid_shape');
  const ledger = value as unknown as LedgerDocument;
  validateLedger(ledger);
  return ledger;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateLedger(ledger: LedgerDocument): void {
  const lists = [ledger.accounts, ledger.statements, ledger.transactions, ledger.categories, ledger.rules];
  if (!lists.every(Array.isArray) || !isObject(ledger.settings)) throw new LedgerFormatError('invalid_shape');
  if (typeof ledger.settings.reviewThreshold !== 'number') throw new LedgerFormatError('invalid_shape');
  for (const list of lists) {
    if (!list.every((item) => isObject(item) && typeof item.id === 'string')) throw new LedgerFormatError('invalid_shape');
    if (new Set(list.map((item) => item.id)).size !== list.length) throw new LedgerFormatError('invalid_shape');
  }

  const accountIds = new Set(ledger.accounts.map((a) => a.id));
  const categoryIds = new Set(ledger.categories.map((c) => c.id));
  const statementIds = new Set(ledger.statements.map((s) => s.id));
  for (const category of ledger.categories) {
    if (category.parentId !== undefined && !categoryIds.has(category.parentId)) throw new LedgerFormatError('broken_reference');
  }
  for (const statement of ledger.statements) {
    if (!accountIds.has(statement.accountId)) throw new LedgerFormatError('broken_reference');
  }
  for (const transaction of ledger.transactions) {
    if (!accountIds.has(transaction.accountId)) throw new LedgerFormatError('broken_reference');
    if (!Array.isArray(transaction.statementIds) || !transaction.statementIds.every((id) => statementIds.has(id))) {
      throw new LedgerFormatError('broken_reference');
    }
    if (!Number.isInteger(transaction.amountCents)) throw new LedgerFormatError('invalid_shape');
    const categoriesUsed = [transaction.classification?.categoryId, ...(transaction.splits ?? []).map((s) => s.categoryId)];
    if (!categoriesUsed.every((id) => typeof id === 'string' && categoryIds.has(id))) {
      throw new LedgerFormatError('broken_reference');
    }
    try {
      validateSplits(transaction);
    } catch {
      throw new LedgerFormatError('invalid_shape');
    }
  }
}
