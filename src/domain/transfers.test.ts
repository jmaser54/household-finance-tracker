import { describe, expect, it } from 'vitest';
import { account, tx } from '../../tests/support/builders';
import { matchTransfers } from './transfers';

const accounts = [
  account('acct.checking', 'checking'),
  account('acct.savings', 'savings'),
  account('acct.card', 'credit_card'),
  account('acct.checking2', 'checking'),
];

describe('matchTransfers', () => {
  it('pairs a checking-to-savings transfer', () => {
    const out = tx({ accountId: 'acct.checking', amountCents: -50_000, originalDescription: 'ONLINE TRANSFER TO SAVINGS 1234', postedDate: '2026-03-03' });
    const into = tx({ accountId: 'acct.savings', amountCents: 50_000, originalDescription: 'TRANSFER FROM CHECKING', postedDate: '2026-03-03' });
    const { proposals, ambiguous } = matchTransfers([out, into], accounts);
    expect(ambiguous).toEqual([]);
    expect(proposals).toEqual([expect.objectContaining({ outflowId: out.id, inflowId: into.id, kind: 'transfer', confident: true })]);
  });

  it('pairs a credit-card payment, even a few days apart', () => {
    const out = tx({ accountId: 'acct.checking', amountCents: -123_456, originalDescription: 'EXAMPLE CARD AUTOPAY', postedDate: '2026-03-20' });
    const into = tx({ accountId: 'acct.card', amountCents: 123_456, originalDescription: 'PAYMENT - THANK YOU', postedDate: '2026-03-22' });
    expect(matchTransfers([out, into], accounts).proposals).toEqual([
      expect.objectContaining({ kind: 'card_payment', confident: true }),
    ]);
  });

  it('does not pair across too wide a gap or within the same account', () => {
    const out = tx({ accountId: 'acct.checking', amountCents: -5_000, postedDate: '2026-03-01' });
    const late = tx({ accountId: 'acct.savings', amountCents: 5_000, postedDate: '2026-03-12' });
    const same = tx({ accountId: 'acct.checking', amountCents: 5_000, postedDate: '2026-03-01' });
    expect(matchTransfers([out, late, same], accounts).proposals).toEqual([]);
  });

  it('marks coincidental equal amounts without supporting evidence as not confident', () => {
    const purchase = tx({ accountId: 'acct.checking', amountCents: -5_000, originalDescription: 'EXAMPLE HARDWARE' });
    const deposit = tx({ accountId: 'acct.savings', amountCents: 5_000, originalDescription: 'MOBILE DEPOSIT' });
    expect(matchTransfers([purchase, deposit], accounts).proposals).toEqual([expect.objectContaining({ confident: false })]);
  });

  it('leaves ambiguous pairings for review instead of guessing', () => {
    const out = tx({ accountId: 'acct.checking', amountCents: -10_000, originalDescription: 'TRANSFER' });
    const a = tx({ accountId: 'acct.savings', amountCents: 10_000, originalDescription: 'TRANSFER' });
    const b = tx({ accountId: 'acct.checking2', amountCents: 10_000, originalDescription: 'TRANSFER' });
    const result = matchTransfers([out, a, b], accounts);
    expect(result.proposals).toEqual([]);
    expect(result.ambiguous).toEqual([{ transactionId: out.id, candidateIds: [a.id, b.id] }]);
  });

  it('does not let two outflows claim the same inflow', () => {
    const out1 = tx({ accountId: 'acct.checking', amountCents: -10_000, originalDescription: 'TRANSFER' });
    const out2 = tx({ accountId: 'acct.checking2', amountCents: -10_000, originalDescription: 'TRANSFER' });
    const into = tx({ accountId: 'acct.savings', amountCents: 10_000, originalDescription: 'TRANSFER' });
    const result = matchTransfers([out1, out2, into], accounts);
    expect(result.proposals).toEqual([]);
    expect(result.ambiguous.map((a) => a.transactionId)).toEqual([out1.id, out2.id]);
  });

  it('skips transactions already paired', () => {
    const out = tx({ accountId: 'acct.checking', amountCents: -10_000, transferGroupId: 'g1' });
    const into = tx({ accountId: 'acct.savings', amountCents: 10_000, transferGroupId: 'g1' });
    expect(matchTransfers([out, into], accounts).proposals).toEqual([]);
  });
});
