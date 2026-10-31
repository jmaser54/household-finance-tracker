import type { Category } from './types';

/**
 * The category list, in plain English: one flat list of spending categories,
 * one of money coming in, and transfers kept apart (PROJECT_PRINCIPLES.md §11).
 *
 * Built-in ids never change, so transactions, rules and backups keep working.
 * Some built-in categories are hidden from pickers (`hidden`) but stay valid:
 * anything already in them keeps counting under them, and they can be shown
 * again later. Subcategories are hidden too; reports fold them into their
 * parent (e.g. Rent & Mortgage counts as Home).
 */
type Seed = Omit<Category, 'builtIn'>;

const expense = (id: string, name: string, extra: Partial<Seed> = {}): Seed => ({
  id,
  name,
  kind: 'expense',
  ...extra,
});
const income = (id: string, name: string, extra: Partial<Seed> = {}): Seed => ({ id, name, kind: 'income', ...extra });
const transfer = (id: string, name: string): Seed => ({ id, name, kind: 'transfer' });
const hidden = { hidden: true } as const;

const SEEDS: Seed[] = [
  // Spending, in the order shown
  expense('exp.housing', 'Home'),
  expense('exp.bills', 'Bills & Utilities'),
  expense('exp.groceries', 'Groceries'),
  expense('exp.dining', 'Eating Out'),
  expense('exp.transport', 'Transportation'),
  expense('exp.shopping', 'Shopping'),
  expense('exp.health', 'Health'),
  expense('exp.entertainment', 'Entertainment'),
  expense('exp.travel', 'Travel'),
  expense('exp.pets', 'Pets'),
  expense('exp.gifts_giving', 'Gifts & Giving'),
  expense('exp.fees', 'Fees'),
  expense('exp.cash', 'Cash'),
  expense('exp.other', 'Other'),
  expense('exp.uncategorized', 'Uncategorized'),

  // Folded into a parent above, hidden from pickers
  expense('exp.housing.rent_mortgage', 'Rent & Mortgage', { parentId: 'exp.housing', ...hidden }),
  expense('exp.housing.home', 'Home & Repairs', { parentId: 'exp.housing', ...hidden }),
  expense('exp.housing.utilities', 'Utilities', { parentId: 'exp.bills', ...hidden }),
  expense('exp.transport.fuel', 'Gas & Charging', { parentId: 'exp.transport', ...hidden }),
  expense('exp.transport.auto', 'Car Payment & Upkeep', { parentId: 'exp.transport', ...hidden }),
  expense('exp.transport.transit', 'Transit, Parking & Rides', { parentId: 'exp.transport', ...hidden }),

  // Not in the list for now; kept so they can come back (ids and data intact)
  expense('exp.childcare_school', 'Childcare & School', { prominent: true, ...hidden }),
  expense('exp.kids', 'Kids & Family', hidden),
  expense('exp.insurance', 'Insurance', hidden),
  expense('exp.personal', 'Personal Care', hidden),
  expense('exp.taxes', 'Taxes', hidden),

  // Money coming in, never mixed into the spending list
  income('inc.employment', 'Paychecks'),
  income('inc.family_gifts', 'Gifts'),
  income('inc.refunds', 'Refunds'),
  income('inc.interest', 'Interest'),
  income('inc.other', 'Other Income'),
  income('inc.uncategorized', 'Uncategorized'),

  // Movements between our own accounts: excluded from income and spending
  transfer('xfer.internal', 'Between your accounts'),
  transfer('xfer.card_payment', 'Credit card payment'),
];

export const DEFAULT_CATEGORIES: readonly Category[] = SEEDS.map((seed) => ({ ...seed, builtIn: true }));

/** Where something that couldn't be classified with confidence goes, by direction. */
export const UNCATEGORIZED_IDS: ReadonlySet<string> = new Set(['exp.uncategorized', 'inc.uncategorized']);

/**
 * Catch-all buckets. A large share of money landing here is a
 * categorization-quality problem to surface, not an acceptable outcome.
 */
export const CATCH_ALL_CATEGORY_IDS: ReadonlySet<string> = new Set([
  'exp.other',
  'exp.uncategorized',
  'inc.other',
  'inc.uncategorized',
]);

/**
 * Brings a household's built-in categories up to date with this version: the
 * current names, visibility and grouping, and any built-in category it lacks.
 * Ids are never changed and nothing is removed, so every transaction keeps
 * its category. Categories the household added itself are left alone.
 * Returns the same array when nothing changed.
 */
export function refreshBuiltInCategories(categories: readonly Category[]): Category[] {
  const seeds = new Map(DEFAULT_CATEGORIES.map((c) => [c.id, c]));
  let changed = false;
  const next = categories.map((category) => {
    const seed = category.builtIn ? seeds.get(category.id) : undefined;
    if (!seed) return category;
    const updated: Category = { ...seed };
    if (JSON.stringify(updated) !== JSON.stringify(category)) changed = true;
    return updated;
  });
  const present = new Set(categories.map((c) => c.id));
  for (const seed of DEFAULT_CATEGORIES) {
    if (!present.has(seed.id)) {
      next.push({ ...seed });
      changed = true;
    }
  }
  // Pickers follow the built-in order.
  const order = new Map(DEFAULT_CATEGORIES.map((c, i) => [c.id, i]));
  next.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
  return changed ? next : (categories as Category[]);
}
