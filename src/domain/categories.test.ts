import { describe, expect, it } from 'vitest';
import { CATCH_ALL_CATEGORY_IDS, DEFAULT_CATEGORIES, refreshBuiltInCategories } from './categories';
import type { Category } from './types';

const byId = new Map(DEFAULT_CATEGORIES.map((c) => [c.id, c]));
const visible = (kind: Category['kind']) => DEFAULT_CATEGORIES.filter((c) => c.kind === kind && !c.hidden).map((c) => c.name);

describe('the category list', () => {
  it('has unique ids', () => {
    expect(byId.size).toBe(DEFAULT_CATEGORIES.length);
  });

  it('shows the household\'s plain-English spending list, plus Uncategorized', () => {
    expect(visible('expense')).toEqual([
      'Home', 'Bills & Utilities', 'Groceries', 'Eating Out', 'Transportation', 'Shopping', 'Health',
      'Entertainment', 'Travel', 'Pets', 'Gifts & Giving', 'Fees', 'Cash', 'Other', 'Uncategorized',
    ]);
  });

  it('shows money coming in separately, with one Paychecks category for both of us, apart from Gifts', () => {
    expect(visible('income')).toEqual(['Paychecks', 'Gifts', 'Refunds', 'Interest', 'Other Income', 'Uncategorized']);
    expect(byId.get('inc.employment')?.name).toBe('Paychecks');
    expect(byId.get('inc.family_gifts')?.name).toBe('Gifts');
  });

  it('keeps transfers apart: card payments and moves between our accounts are not spending', () => {
    expect(byId.get('xfer.card_payment')?.kind).toBe('transfer');
    expect(byId.get('xfer.internal')?.kind).toBe('transfer');
  });

  it('keeps every earlier built-in id, hiding the ones not in the list so they can come back', () => {
    for (const id of ['exp.childcare_school', 'exp.kids', 'exp.insurance', 'exp.personal', 'exp.taxes']) {
      expect(byId.get(id), id).toMatchObject({ kind: 'expense', hidden: true });
      expect(byId.get(id)?.parentId, id).toBeUndefined();
    }
    expect(byId.get('exp.childcare_school')?.prominent).toBe(true);
  });

  it('folds subcategories into a visible parent of the same kind, one level deep', () => {
    for (const category of DEFAULT_CATEGORIES) {
      if (!category.parentId) continue;
      const parent = byId.get(category.parentId);
      expect(category.hidden, category.id).toBe(true);
      expect(parent?.hidden, category.id).toBeFalsy();
      expect(parent?.parentId, category.id).toBeUndefined();
      expect(parent?.kind, category.id).toBe(category.kind);
    }
    expect(byId.get('exp.housing.utilities')?.parentId).toBe('exp.bills');
  });

  it('marks only real categories as catch-alls', () => {
    for (const id of CATCH_ALL_CATEGORY_IDS) expect(byId.has(id), id).toBe(true);
  });
});

describe('refreshing an existing household\'s built-in categories', () => {
  // As saved by earlier versions: older names, Utilities under Housing.
  const older: Category[] = [
    { id: 'exp.housing', name: 'Housing', kind: 'expense', builtIn: true },
    { id: 'exp.housing.utilities', name: 'Utilities', kind: 'expense', parentId: 'exp.housing', builtIn: true },
    { id: 'exp.childcare_school', name: 'Childcare & School', kind: 'expense', builtIn: true, prominent: true },
    { id: 'inc.employment', name: 'Employment Income', kind: 'income', builtIn: true },
    { id: 'custom.1', name: 'Our own', kind: 'expense', builtIn: false },
  ];

  it('updates names, grouping and visibility by id, adds missing built-ins and keeps the household\'s own', () => {
    const refreshed = refreshBuiltInCategories(older);
    const get = (id: string) => refreshed.find((c) => c.id === id);
    expect(get('exp.housing')?.name).toBe('Home');
    expect(get('exp.housing.utilities')?.parentId).toBe('exp.bills');
    expect(get('exp.childcare_school')).toMatchObject({ hidden: true, prominent: true });
    expect(get('inc.employment')?.name).toBe('Paychecks');
    expect(get('custom.1')).toEqual(older[4]);
    for (const c of DEFAULT_CATEGORIES) expect(get(c.id), c.id).toBeDefined();
  });

  it('changes nothing when already current', () => {
    const current = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
    expect(refreshBuiltInCategories(current)).toBe(current);
  });
});
