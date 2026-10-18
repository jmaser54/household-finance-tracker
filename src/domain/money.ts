/**
 * Money is stored and calculated as integer cents. Floating-point dollars are
 * never used for arithmetic, so totals are exact and reproducible.
 */
export type Cents = number;

export class MoneyParseError extends Error {
  constructor(reason: string) {
    // Deliberately does not include the input text: amounts are financial data
    // and error messages can end up on screen or in a bug report.
    super(`Could not read amount: ${reason}`);
    this.name = 'MoneyParseError';
  }
}

const AMOUNT_PATTERN = /^(\d{1,3}(,\d{3})*|\d+)(\.\d{1,2})?$/;

/**
 * Parses an amount as printed on a statement into signed integer cents.
 *
 * Accepts "1,234.56", "$1,234.56", "-12.00", "(12.00)", "12.00-", "12.00 CR",
 * "12.00 DR". Rejects anything ambiguous rather than guessing, because a
 * silently wrong amount is worse than a flagged one.
 *
 * Sign returned here is the sign *as printed*. Converting it to the household
 * perspective (money in vs. money out) is the parser's job, since banks and
 * card issuers print signs differently.
 */
export function parseAmountToCents(input: string): Cents {
  let text = input.trim().replace(/\s+/g, ' ');
  if (text === '') throw new MoneyParseError('empty');

  let negative = false;
  const flip = () => {
    if (negative) throw new MoneyParseError('more than one sign marker');
    negative = true;
  };

  if (/^\(.*\)$/.test(text)) {
    flip();
    text = text.slice(1, -1).trim();
  }
  const suffix = /\s?(CR|DR)$/i.exec(text);
  if (suffix) {
    // CR/DR are kept as a sign *marker*; DR is negative, CR positive.
    if (suffix[1]!.toUpperCase() === 'DR') flip();
    text = text.slice(0, suffix.index).trim();
  }
  if (text.endsWith('-')) {
    flip();
    text = text.slice(0, -1).trim();
  }
  if (text.startsWith('-')) {
    flip();
    text = text.slice(1).trim();
  } else if (text.startsWith('+')) {
    text = text.slice(1).trim();
  }
  if (text.startsWith('$')) text = text.slice(1).trim();
  if (text.startsWith('-')) {
    flip();
    text = text.slice(1).trim();
  }

  if (!AMOUNT_PATTERN.test(text)) throw new MoneyParseError('unrecognized format');

  const [whole, fraction = ''] = text.replace(/,/g, '').split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw new MoneyParseError('out of range');
  return negative ? -cents : cents;
}

export function sumCents(values: Iterable<Cents>): Cents {
  let total = 0;
  for (const value of values) {
    if (!Number.isInteger(value)) throw new TypeError('sumCents requires integer cents');
    total += value;
  }
  if (!Number.isSafeInteger(total)) throw new RangeError('total out of range');
  return total;
}

const exactFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
});
const roundedFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

/** Exact amount, for transaction lists and review screens: "$1,234.56". */
export function formatExact(cents: Cents): string {
  return exactFormatter.format(cents / 100);
}

/**
 * Rounded amount for summaries: "$1,235". Rounds half away from zero on the
 * integer cents so display never disagrees with the exact total by more than
 * fifty cents.
 */
export function formatRounded(cents: Cents): string {
  const dollars = Math.sign(cents) * Math.round(Math.abs(cents) / 100);
  return roundedFormatter.format(dollars === 0 ? 0 : dollars);
}
