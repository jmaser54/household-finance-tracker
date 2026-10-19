import { describe, expect, it } from 'vitest';
import type { Statement } from './types';
import {
  dedupeKey,
  findStatementOverlaps,
  normalizeDescription,
  planDeduplication,
  type ExistingTransaction,
} from './dedupe';

const line = (id: string, postedDate: string, amountCents: number, description = 'EXAMPLE CAFE #12'): ExistingTransaction => ({
  id,
  accountId: 'acct.card',
  postedDate,
  amountCents,
  originalDescription: description,
});

const statement = (id: string, start: string, end: string, sha = `sha-${id}`, accountId = 'acct.card'): Statement => ({
  id,
  accountId,
  periodStart: start,
  periodEnd: end,
  fileSha256: sha,
  parserId: 'synthetic',
  parserVersion: 1,
  transactionCount: 0,
  validation: { status: 'verified', checks: [] },
  importedAt: '2026-04-01T00:00:00Z',
  importBatchId: 'b1',
});

const covered = (start: string, end: string) => new Map([['acct.card', [{ start, end }]]]);

describe('normalizeDescription', () => {
  it('ignores case and spacing but nothing else', () => {
    expect(normalizeDescription('  Example   cafe #12 ')).toBe('EXAMPLE CAFE #12');
    expect(normalizeDescription('EXAMPLE CAFE #12')).not.toBe(normalizeDescription('EXAMPLE CAFE #13'));
  });

  it('builds keys that differ by account, date and amount', () => {
    const base = line('a', '2026-03-01', -450);
    expect(dedupeKey(base)).not.toBe(dedupeKey({ ...base, accountId: 'other' }));
    expect(dedupeKey(base)).not.toBe(dedupeKey({ ...base, postedDate: '2026-03-02' }));
    expect(dedupeKey(base)).not.toBe(dedupeKey({ ...base, amountCents: -451 }));
  });
});

describe('findStatementOverlaps', () => {
  const existing = [statement('jan', '2026-01-01', '2026-01-31', 'sha-jan'), statement('feb', '2026-02-01', '2026-02-28')];

  it('recognises the very same file imported again', () => {
    expect(
      findStatementOverlaps({ accountId: 'acct.card', periodStart: '2026-01-01', periodEnd: '2026-01-31', fileSha256: 'sha-jan' }, existing),
    ).toEqual([{ type: 'same_file', statementId: 'jan' }]);
  });

  it('reports overlapping periods for the same account only', () => {
    const incoming = { accountId: 'acct.card', periodStart: '2026-01-15', periodEnd: '2026-02-14', fileSha256: 'new' };
    expect(findStatementOverlaps(incoming, existing)).toEqual([
      { type: 'overlapping_period', statementId: 'jan', range: { start: '2026-01-15', end: '2026-01-31' } },
      { type: 'overlapping_period', statementId: 'feb', range: { start: '2026-02-01', end: '2026-02-14' } },
    ]);
    expect(findStatementOverlaps({ ...incoming, accountId: 'acct.other' }, existing)).toEqual([]);
  });

  it('reports nothing for the next month', () => {
    expect(
      findStatementOverlaps({ accountId: 'acct.card', periodStart: '2026-03-01', periodEnd: '2026-03-31', fileSha256: 'x' }, existing),
    ).toEqual([]);
  });
});

describe('planDeduplication', () => {
  it('adds nothing when the same statement lines are imported again', () => {
    const existing = [line('e1', '2026-03-02', -450), line('e2', '2026-03-05', -9_999, 'EXAMPLE GROCER')];
    const plan = planDeduplication(existing.map(({ id: _id, ...rest }) => rest), existing, covered('2026-03-01', '2026-03-31'));
    expect(plan.map((v) => v.status)).toEqual(['duplicate', 'duplicate']);
  });

  it('keeps two genuine identical purchases on the same day (multiset matching)', () => {
    const existing = [line('e1', '2026-03-02', -450)];
    const incoming = [line('x', '2026-03-02', -450), line('y', '2026-03-02', -450)];
    const plan = planDeduplication(incoming, existing, covered('2026-03-01', '2026-03-31'));
    expect(plan.map((v) => v.status)).toEqual(['duplicate', 'new_in_covered_period']);
  });

  it('treats lines outside already-imported periods as new, even if identical to old ones', () => {
    const existing = [line('e1', '2026-03-02', -450)];
    const plan = planDeduplication([line('x', '2026-04-02', -450)], existing, covered('2026-03-01', '2026-03-31'));
    expect(plan).toEqual([{ status: 'new', candidate: expect.anything() }]);
  });

  it('handles a statement that overlaps the end of the previous one', () => {
    const existing = [line('e1', '2026-03-30', -1_000), line('e2', '2026-03-31', -2_000)];
    const incoming = [line('a', '2026-03-31', -2_000), line('b', '2026-04-01', -3_000)];
    const plan = planDeduplication(incoming, existing, covered('2026-03-01', '2026-03-31'));
    expect(plan.map((v) => v.status)).toEqual(['duplicate', 'new']);
  });

  it('flags a near-match (same amount, date shifted) for review instead of merging it', () => {
    const existing = [line('e1', '2026-03-02', -450)];
    const plan = planDeduplication([line('x', '2026-03-03', -450)], existing, covered('2026-03-01', '2026-03-31'));
    expect(plan).toEqual([{ status: 'new_in_covered_period', candidate: expect.anything(), possibleMatchIds: ['e1'] }]);
  });

  it('never drops a candidate: output has one verdict per input, in order', () => {
    const incoming = Array.from({ length: 25 }, (_, i) => line(`n${i}`, '2026-03-10', -100 * (i % 3)));
    const plan = planDeduplication(incoming, [], covered('2026-03-01', '2026-03-31'));
    expect(plan).toHaveLength(25);
    expect(plan.map((v) => v.candidate)).toEqual(incoming);
  });

  it('dedupes overlapping statements within one batch when applied in sequence', () => {
    // Batch with two statements whose periods overlap; the second is planned
    // against the ledger plus the first statement's accepted lines.
    const first = [line('a1', '2026-03-28', -700), line('a2', '2026-03-31', -800)];
    const second = [line('b1', '2026-03-31', -800), line('b2', '2026-04-02', -900)];
    const afterFirst = planDeduplication(first, [], new Map());
    const accepted = afterFirst.filter((v) => v.status !== 'duplicate').map((v) => v.candidate);
    const plan = planDeduplication(second, accepted, covered('2026-03-01', '2026-03-31'));
    expect(plan.map((v) => v.status)).toEqual(['duplicate', 'new']);
  });
});
