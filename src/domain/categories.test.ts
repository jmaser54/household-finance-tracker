import { describe, expect, it } from 'vitest';
import { CATCH_ALL_CATEGORY_IDS, DEFAULT_CATEGORIES } from './categories';

const byId = new Map(DEFAULT_CATEGORIES.map((c) => [c.id, c]));

describe('default category taxonomy', () => {
  it('has unique ids', () => {
    expect(byId.size).toBe(DEFAULT_CATEGORIES.length);
  });

  it('keeps Childcare & School as a prominent top-level spending category', () => {
    const childcare = byId.get('exp.childcare_school');
    expect(childcare).toMatchObject({ kind: 'expense', prominent: true });
    expect(childcare?.parentId).toBeUndefined();
  });

  it('has one combined Employment Income category, separate from Family Gifts', () => {
    const income = DEFAULT_CATEGORIES.filter((c) => c.kind === 'income').map((c) => c.name);
    expect(income).toEqual(
      expect.arrayContaining([
        'Employment Income',
        'Family Gifts',
        'Refunds & Reimbursements',
        'Interest & Investment Income',
        'Other Income',
      ]),
    );
    expect(income.filter((name) => /employment/i.test(name))).toHaveLength(1);
  });

  it('includes Cash / Untracked Cash Spending as spending', () => {
    expect(byId.get('exp.cash')?.kind).toBe('expense');
  });

  it('models card payments and internal transfers as transfers, not spending', () => {
    expect(byId.get('xfer.card_payment')?.kind).toBe('transfer');
    expect(byId.get('xfer.internal')?.kind).toBe('transfer');
  });

  it('only nests subcategories one level, under a parent of the same kind', () => {
    for (const category of DEFAULT_CATEGORIES) {
      if (!category.parentId) continue;
      const parent = byId.get(category.parentId);
      expect(parent, category.id).toBeDefined();
      expect(parent?.parentId, category.id).toBeUndefined();
      expect(parent?.kind, category.id).toBe(category.kind);
    }
  });

  it('marks only real categories as catch-alls', () => {
    for (const id of CATCH_ALL_CATEGORY_IDS) expect(byId.has(id), id).toBe(true);
  });
});
