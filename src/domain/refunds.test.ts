import { describe, expect, it } from 'vitest';
import { tx } from '../../tests/support/builders';
import { findRefundOriginal } from './refunds';

describe('findRefundOriginal', () => {
  const purchase = tx({ amountCents: -6_000, merchant: 'Example Outfitters', categoryId: 'exp.shopping', postedDate: '2026-03-01' });

  it('links a full refund to its purchase and adopts its category', () => {
    const refund = tx({ amountCents: 6_000, kind: 'refund', merchant: 'example outfitters', postedDate: '2026-03-15' });
    expect(findRefundOriginal(refund, [purchase])).toEqual({
      status: 'linked',
      originalId: purchase.id,
      categoryId: 'exp.shopping',
      exactAmount: true,
    });
  });

  it('links a partial refund when there is one plausible purchase', () => {
    const refund = tx({ amountCents: 2_000, kind: 'refund', merchant: 'Example Outfitters', postedDate: '2026-03-15' });
    expect(findRefundOriginal(refund, [purchase])).toMatchObject({ status: 'linked', exactAmount: false });
  });

  it('prefers the exact-amount purchase on the same account', () => {
    const other = tx({ amountCents: -9_000, merchant: 'Example Outfitters', postedDate: '2026-03-02' });
    const refund = tx({ amountCents: 6_000, merchant: 'Example Outfitters', postedDate: '2026-03-15' });
    expect(findRefundOriginal(refund, [purchase, other])).toMatchObject({ status: 'linked', originalId: purchase.id });
  });

  it('reports ambiguity instead of guessing between equal candidates', () => {
    const twin = tx({ amountCents: -6_000, merchant: 'Example Outfitters', postedDate: '2026-03-05' });
    const refund = tx({ amountCents: 6_000, merchant: 'Example Outfitters', postedDate: '2026-03-15' });
    expect(findRefundOriginal(refund, [purchase, twin])).toEqual({ status: 'ambiguous', candidateIds: [purchase.id, twin.id] });
  });

  it('leaves refunds unmatched when the purchase is missing, too old, later, or smaller', () => {
    const refund = (merchant: string, postedDate: string, amountCents = 6_000) =>
      tx({ amountCents, merchant, postedDate });
    expect(findRefundOriginal(refund('Other Store', '2026-03-15'), [purchase]).status).toBe('unmatched');
    expect(findRefundOriginal(refund('Example Outfitters', '2026-08-01'), [purchase]).status).toBe('unmatched');
    expect(findRefundOriginal(refund('Example Outfitters', '2026-02-20'), [purchase]).status).toBe('unmatched');
    expect(findRefundOriginal(refund('Example Outfitters', '2026-03-15', 7_000), [purchase]).status).toBe('unmatched');
  });

  it('never treats an outflow as a refund', () => {
    expect(findRefundOriginal(tx({ amountCents: -6_000, merchant: 'Example Outfitters' }), [purchase]).status).toBe('unmatched');
  });
});
