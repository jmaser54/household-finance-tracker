import { genericParser } from './generic';
import type { ParseOutcome, StatementParser } from './types';
import type { PdfText } from '../pdfText';

/**
 * Registered statement parsers. A bank-specific parser goes before the
 * generic one; the parser whose result scores highest is used.
 */
export const PARSERS: readonly StatementParser[] = [genericParser];

export function parseWithBestParser(text: PdfText, parsers: readonly StatementParser[] = PARSERS): ParseOutcome {
  let best: ParseOutcome | null = null;
  for (const parser of parsers) {
    const outcome = parser.parse(text);
    if (outcome.ok && (!best || !best.ok || outcome.score > best.score)) best = outcome;
    else if (!best) best = outcome;
  }
  return best ?? { ok: false, reason: 'no_transactions' };
}
