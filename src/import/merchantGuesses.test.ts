// Built-in starting guesses: conservative by design.
import { describe, expect, it } from 'vitest';
import { guessSpendingCategory } from './merchantGuesses';

const guess = (d: string) => guessSpendingCategory(d)?.categoryId ?? null;

describe('conservative built-in guesses', () => {
  it.each([
    ['EXAMPLE GROCER #12 PURCHASE', 'exp.groceries'],
    ['SAFEWAY 1234', 'exp.groceries'],
    ['EXAMPLE RESTAURANT', 'exp.dining'],
    ['UBER EATS 8005551234', 'exp.dining'],
    ['UBER TRIP HELP.UBER.COM', 'exp.transport'],
    ['EXAMPLE GAS STATION', 'exp.transport'],
    ['EXAMPLE UTILITY CO AUTOPAY', 'exp.bills'],
    ['NETFLIX.COM', 'exp.bills'],
    ['EXAMPLE PHARMACY', 'exp.health'],
    ['EXAMPLE HARDWARE', 'exp.housing'],
    ['AMAZON MKTPL*AB12', 'exp.shopping'],
    ['EXAMPLE ANIMAL HOSPITAL', 'exp.pets'],
    ['EXAMPLE AIRLINES 0012345', 'exp.travel'],
  ])('%s → %s', (description, categoryId) => {
    expect(guess(description)).toBe(categoryId);
  });

  it.each([
    'WALMART SUPERCENTER',
    'TARGET 00012345',
    'SAMPLE COFFEE CO',
    'EXAMPLE OUTFITTERS',
    'EXAMPLE BAKERY',
    'EXAMPLE VET CLINIC',
    'MOBILE DEPOSIT',
    'CLEARWATER TRADING',
    'EXAMPLE MARKETPLACE',
    'EXAMPLE ELECTRONICS',
  ])('leaves "%s" Uncategorized rather than guessing', (description) => {
    expect(guess(description)).toBeNull();
  });

  it('gives a plain-language reason', () => {
    expect(guessSpendingCategory('EXAMPLE PHARMACY')?.reason).toBe('The name looks like a pharmacy or doctor');
  });
});
