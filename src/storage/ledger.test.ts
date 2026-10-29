import { describe, expect, it } from 'vitest';
import { tx } from '../../tests/support/builders';
import { SCHEMA_VERSION } from '../domain/types';
import { emptyLedger, LedgerFormatError, parseLedger, serializeLedger, type LedgerDocument } from './ledger';

const withData = (): LedgerDocument => {
  const ledger = emptyLedger();
  ledger.accounts.push({ id: 'acct.checking', displayName: 'Test checking', kind: 'checking', institution: 'Example Bank', archived: false });
  ledger.statements.push({
    id: 's1', accountId: 'acct.checking', periodStart: '2026-03-01', periodEnd: '2026-03-31', fileSha256: 'x',
    parserId: 'synthetic', parserVersion: 1, transactionCount: 1, validation: { status: 'verified', checks: [] },
    importedAt: '2026-04-01T00:00:00Z', importBatchId: 'b1',
  });
  ledger.transactions.push(tx({ amountCents: -1_250, categoryId: 'exp.groceries' }));
  return ledger;
};

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as LedgerFormatError).code;
  }
  return 'no error';
};

describe('ledger document', () => {
  it('round-trips an empty ledger with the default categories', () => {
    const ledger = parseLedger(serializeLedger(emptyLedger()));
    expect(ledger.schemaVersion).toBe(SCHEMA_VERSION);
    expect(ledger.categories.some((c) => c.id === 'exp.childcare_school')).toBe(true);
  });

  it('round-trips a ledger with synthetic data exactly', () => {
    const ledger = withData();
    expect(parseLedger(serializeLedger(ledger))).toEqual(ledger);
  });

  it('rejects text that is not JSON', () => {
    expect(code(() => parseLedger('{"schemaVersion":1,'))).toBe('not_json');
  });

  it('refuses data from a newer version instead of guessing', () => {
    expect(code(() => parseLedger(JSON.stringify({ ...emptyLedger(), schemaVersion: SCHEMA_VERSION + 1 })))).toBe('newer_version');
  });

  it.each([
    ['missing lists', { schemaVersion: 1 }],
    ['an array', []],
    ['a fractional schema version', { ...emptyLedger(), schemaVersion: 1.5 }],
    ['schema version 0', { ...emptyLedger(), schemaVersion: 0 }],
    ['settings missing', { ...emptyLedger(), settings: null }],
  ])('rejects %s', (_label, value) => {
    expect(code(() => parseLedger(JSON.stringify(value)))).toBe('invalid_shape');
  });

  it('rejects duplicate ids', () => {
    const ledger = withData();
    ledger.transactions.push({ ...ledger.transactions[0]! });
    expect(code(() => serializeLedger(ledger))).toBe('invalid_shape');
  });

  it('rejects references to accounts, statements or categories that do not exist', () => {
    const noAccount = withData();
    noAccount.transactions[0]!.accountId = 'acct.missing';
    expect(code(() => serializeLedger(noAccount))).toBe('broken_reference');

    const noStatement = withData();
    noStatement.transactions[0]!.statementIds = ['s-missing'];
    expect(code(() => serializeLedger(noStatement))).toBe('broken_reference');

    const noCategory = withData();
    noCategory.transactions[0]!.classification.categoryId = 'cat.missing';
    expect(code(() => serializeLedger(noCategory))).toBe('broken_reference');
  });

  it('rejects fractional cents and splits that do not add up', () => {
    const fractional = withData();
    fractional.transactions[0]!.amountCents = -12.5;
    expect(code(() => serializeLedger(fractional))).toBe('invalid_shape');

    const badSplit = withData();
    badSplit.transactions[0]!.splits = [{ categoryId: 'exp.groceries', amountCents: -1_000 }];
    expect(code(() => serializeLedger(badSplit))).toBe('invalid_shape');
  });

  it('never puts ledger content in error messages', () => {
    const ledger = withData();
    ledger.transactions[0]!.accountId = 'acct.SECRET-MARKER';
    try {
      serializeLedger(ledger);
    } catch (error) {
      expect((error as Error).message).not.toContain('SECRET-MARKER');
    }
  });
});
