/**
 * Built-in starting guesses for spending categories, from words in a
 * purchase's description. Deliberately conservative: only words that on
 * their own say what kind of spending it is. Shops that sell many kinds of
 * things (supercentres, department stores, general online marketplaces
 * other than Amazon) are left out, so their purchases stay Uncategorized and
 * ready to sort rather than being confidently wrong. Matching is on whole
 * words, and the first matching entry wins, so more specific entries come
 * first ("UBER EATS" before "UBER").
 *
 * Generic and local: no household data, nothing looked up anywhere.
 */
import type { Id } from '../domain/types';

interface Guess {
  pattern: RegExp;
  categoryId: Id;
  /** Plain-language reason shown with the guess. */
  label: string;
}

const words = (list: string) => new RegExp(`\\b(${list})\\b`, 'i');

const GUESSES: Guess[] = [
  // Specific before general
  { pattern: words('UBER EATS|DOORDASH|GRUBHUB|POSTMATES'), categoryId: 'exp.dining', label: 'a food delivery service' },
  { pattern: words('PETSMART|PETCO|VETERINARY|ANIMAL HOSPITAL'), categoryId: 'exp.pets', label: 'a pet store or vet' },

  { pattern: words('GROCERY|GROCERIES|GROCER|SUPERMARKET|SAFEWAY|KROGER|TRADER JOE|WHOLE FOODS|ALDI|PUBLIX|WEGMANS'), categoryId: 'exp.groceries', label: 'a grocery store' },
  { pattern: words('RESTAURANT|PIZZA|PIZZERIA|STARBUCKS|MCDONALD|CHIPOTLE'), categoryId: 'exp.dining', label: 'a restaurant or café' },
  { pattern: words('GAS STATION|SHELL OIL|CHEVRON|EXXON|EXXONMOBIL|PARKING|TOLLWAY|LYFT|UBER'), categoryId: 'exp.transport', label: 'gas, parking or rides' },
  { pattern: words('UTILITY|UTILITIES|ELECTRIC|NETFLIX|SPOTIFY|HULU|COMCAST|XFINITY|VERIZON|T-MOBILE'), categoryId: 'exp.bills', label: 'a bill or subscription' },
  { pattern: words('PHARMACY|WALGREENS|CVS|DENTAL|DENTIST|MEDICAL|HOSPITAL'), categoryId: 'exp.health', label: 'a pharmacy or doctor' },
  { pattern: words('HARDWARE|HOME DEPOT|LOWES|MORTGAGE'), categoryId: 'exp.housing', label: 'a home or hardware store' },
  { pattern: words('AMAZON|AMZN'), categoryId: 'exp.shopping', label: 'an online store' },
  { pattern: words('CINEMA|CINEMAS|MOVIE THEATER|MOVIE THEATRE'), categoryId: 'exp.entertainment', label: 'a cinema' },
  { pattern: words('AIRLINES|AIRLINE|HOTEL|HOTELS|AIRBNB|MARRIOTT|HILTON'), categoryId: 'exp.travel', label: 'a hotel or airline' },
  { pattern: words('DONATION|CHARITY'), categoryId: 'exp.gifts_giving', label: 'a donation' },
];

/** A spending category guessed from the description, or null if no entry is a confident match. */
export function guessSpendingCategory(description: string): { categoryId: Id; reason: string } | null {
  for (const guess of GUESSES) {
    if (guess.pattern.test(description)) return { categoryId: guess.categoryId, reason: `The name looks like ${guess.label}` };
  }
  return null;
}
