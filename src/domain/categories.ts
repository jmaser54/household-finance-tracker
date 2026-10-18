import type { Category } from './types';

/**
 * Starting taxonomy: familiar top-level categories, a few subcategories where
 * they help, and income kept fully separate from spending. Users can rename,
 * hide and add categories; built-in ids are stable so rules and backups keep
 * working across versions.
 */
type Seed = Omit<Category, 'builtIn'>;

const expense = (id: string, name: string, extra: Partial<Seed> = {}): Seed => ({
  id,
  name,
  kind: 'expense',
  ...extra,
});
const income = (id: string, name: string): Seed => ({ id, name, kind: 'income' });
const transfer = (id: string, name: string): Seed => ({ id, name, kind: 'transfer' });

const SEEDS: Seed[] = [
  // Spending
  expense('exp.housing', 'Housing'),
  expense('exp.housing.rent_mortgage', 'Rent & Mortgage', { parentId: 'exp.housing' }),
  expense('exp.housing.utilities', 'Utilities', { parentId: 'exp.housing' }),
  expense('exp.housing.home', 'Home & Repairs', { parentId: 'exp.housing' }),
  expense('exp.groceries', 'Groceries'),
  expense('exp.dining', 'Dining & Takeout'),
  expense('exp.childcare_school', 'Childcare & School', { prominent: true }),
  expense('exp.kids', 'Kids & Family'),
  expense('exp.transport', 'Transportation'),
  expense('exp.transport.fuel', 'Gas & Charging', { parentId: 'exp.transport' }),
  expense('exp.transport.auto', 'Car Payment & Upkeep', { parentId: 'exp.transport' }),
  expense('exp.transport.transit', 'Transit, Parking & Rides', { parentId: 'exp.transport' }),
  expense('exp.health', 'Health & Medical'),
  expense('exp.insurance', 'Insurance'),
  expense('exp.bills', 'Phone, Internet & Subscriptions'),
  expense('exp.shopping', 'Shopping'),
  expense('exp.personal', 'Personal Care'),
  expense('exp.entertainment', 'Fun & Entertainment'),
  expense('exp.travel', 'Travel'),
  expense('exp.gifts_giving', 'Gifts & Donations'),
  expense('exp.pets', 'Pets'),
  expense('exp.fees', 'Fees & Interest Charges'),
  expense('exp.taxes', 'Taxes'),
  expense('exp.cash', 'Cash / Untracked Cash Spending'),
  expense('exp.other', 'Other Spending'),
  expense('exp.uncategorized', 'Uncategorized Spending'),

  // Incoming money, never mixed into the spending list
  income('inc.employment', 'Employment Income'),
  income('inc.family_gifts', 'Family Gifts'),
  income('inc.refunds', 'Refunds & Reimbursements'),
  income('inc.interest', 'Interest & Investment Income'),
  income('inc.other', 'Other Income'),
  income('inc.uncategorized', 'Uncategorized Income'),

  // Movements between our own accounts: excluded from income and spending
  transfer('xfer.internal', 'Between Our Accounts'),
  transfer('xfer.card_payment', 'Credit Card Payment'),
];

export const DEFAULT_CATEGORIES: readonly Category[] = SEEDS.map((seed) => ({ ...seed, builtIn: true }));

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
