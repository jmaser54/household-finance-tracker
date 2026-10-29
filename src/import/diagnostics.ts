/**
 * Masked layout diagnostics: what the reader saw, with every value hidden, so
 * a statement that doesn't read correctly can be described without sharing it
 * (docs/ARCHITECTURE.md §10). Shown on screen only; never stored or sent.
 */
import type { TextLine } from './pdfText';

/** Layout words that say nothing about the household and help describe a format. */
const LAYOUT_WORDS = new Set(
  [
    'account', 'activity', 'additions', 'amount', 'balance', 'beginning', 'card', 'checking', 'checks', 'closing',
    'credit', 'credits', 'date', 'debit', 'debits', 'deposits', 'description', 'details', 'due', 'ending', 'fees',
    'interest', 'minimum', 'new', 'of', 'opening', 'other', 'page', 'paid', 'payment', 'payments', 'period',
    'post', 'posted', 'posting', 'previous', 'purchases', 'running', 'savings', 'statement', 'subtractions',
    'summary', 'total', 'trans', 'transaction', 'transactions', 'withdrawals',
  ],
);

const DATE = /^(\d{1,2}\/\d{1,2}(\/\d{2,4})?|\d{4}-\d{2}-\d{2})$/;
const AMOUNT = /^\(?[-+]?\$?-?[\d,]*\d\.\d{2}\)?(-|CR|DR)?$/i;

export function maskToken(token: string): string {
  const bare = token.replace(/[:,]$/, '');
  if (DATE.test(bare)) return 'DATE';
  if (AMOUNT.test(bare)) return 'AMOUNT';
  if (/\d/.test(bare)) return 'NUMBER';
  if (LAYOUT_WORDS.has(bare.toLowerCase())) return bare.toLowerCase();
  return 'TEXT';
}

/** "03/05 EXAMPLE GROCER 45.67" -> "DATE TEXT TEXT AMOUNT". Repeated TEXT is shortened to "TEXT×n". */
export function maskLine(line: TextLine): string {
  const tokens = line.text.split(/\s+/).filter(Boolean).map(maskToken);
  const out: string[] = [];
  for (const token of tokens) {
    const last = out[out.length - 1];
    const repeat = last?.match(/^TEXT(?:×(\d+))?$/);
    if (token === 'TEXT' && repeat) out[out.length - 1] = `TEXT×${Number(repeat[1] ?? 1) + 1}`;
    else out.push(token);
  }
  return out.join(' ');
}

export function maskedLayout(lines: TextLine[], limit = 40): string[] {
  return lines.slice(0, limit).map((line) => `p${line.page}  ${maskLine(line)}`);
}
