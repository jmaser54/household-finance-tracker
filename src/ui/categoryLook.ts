/**
 * How each category looks: an icon and a warm colour from the app's palette
 * (a hue; the stylesheet turns it into a soft badge in light and dark mode).
 * Subcategories and hidden categories borrow their parent's look.
 */
import type { Category, Id } from '../domain/types';

interface Look {
  icon: string;
  hue: number;
}

const LOOKS: Record<Id, Look> = {
  'exp.housing': { icon: '🏠', hue: 28 },
  'exp.bills': { icon: '💡', hue: 48 },
  'exp.groceries': { icon: '🛒', hue: 110 },
  'exp.dining': { icon: '🍔', hue: 12 },
  'exp.transport': { icon: '🚗', hue: 205 },
  'exp.shopping': { icon: '🛍️', hue: 320 },
  'exp.health': { icon: '🩺', hue: 175 },
  'exp.entertainment': { icon: '🎬', hue: 270 },
  'exp.travel': { icon: '✈️', hue: 195 },
  'exp.pets': { icon: '🐾', hue: 35 },
  'exp.gifts_giving': { icon: '🎁', hue: 345 },
  'exp.fees': { icon: '🧾', hue: 0 },
  'exp.cash': { icon: '💵', hue: 130 },
  'exp.other': { icon: '📦', hue: 40 },
  'exp.uncategorized': { icon: '❔', hue: 220 },
  'exp.childcare_school': { icon: '🎒', hue: 55 },
  'exp.kids': { icon: '🧸', hue: 300 },
  'exp.insurance': { icon: '☂️', hue: 230 },
  'exp.personal': { icon: '💈', hue: 290 },
  'exp.taxes': { icon: '🏛️', hue: 215 },
  'inc.employment': { icon: '💼', hue: 125 },
  'inc.family_gifts': { icon: '🎁', hue: 345 },
  'inc.refunds': { icon: '↩️', hue: 160 },
  'inc.interest': { icon: '🌱', hue: 100 },
  'inc.other': { icon: '✨', hue: 50 },
  'inc.uncategorized': { icon: '❔', hue: 220 },
  'xfer.internal': { icon: '🔁', hue: 210 },
  'xfer.card_payment': { icon: '💳', hue: 210 },
};

const FALLBACK: Look = { icon: '•', hue: 40 };

/** The category a report or chip shows: subcategories fold into their parent. */
export function shownCategory(categories: readonly Category[], id: Id): Category | undefined {
  const category = categories.find((c) => c.id === id);
  return category?.parentId ? (categories.find((c) => c.id === category.parentId) ?? category) : category;
}

export function lookFor(id: Id | undefined): Look {
  return (id && LOOKS[id]) || FALLBACK;
}
