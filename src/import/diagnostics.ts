/**
 * Masked layout diagnostics: what the reader saw, with every value hidden, so
 * a statement that doesn't read correctly can be described without sharing it
 * (docs/ARCHITECTURE.md §10). Shown on screen only; never stored or sent.
 *
 * Dates, amounts and numbers become DATE, AMOUNT and NUMBER; month names
 * become MONTH (which month is hidden); any other word becomes TEXT unless it
 * is a layout word below, which says nothing about the household. The facts
 * added for each statement are fixed codes and counts, never values: not the
 * last four digits, not balances, not descriptions.
 */
import type { PdfText, TextLine } from './pdfText';
import type { ParsedStatement, ParseOutcome } from './parsers/types';

/** Layout words that say nothing about the household and help describe a format. */
const LAYOUT_WORDS = new Set([
  'account', 'activity', 'additions', 'adjustments', 'advance', 'advances', 'amount', 'and', 'apr', 'available',
  'balance', 'beginning', 'billing', 'card', 'cash', 'charge', 'charged', 'charges', 'checking', 'checks', 'closing',
  'credit', 'credits', 'cycle', 'date', 'dates', 'days', 'debit', 'debits', 'deposits', 'description', 'details',
  'due', 'ending', 'fee', 'fees', 'for', 'from', 'in', 'interest', 'limit', 'minimum', 'money', 'new', 'number', 'of',
  'opening', 'other', 'page', 'paid', 'payment', 'payments', 'period', 'post', 'posted', 'posting', 'previous',
  'purchases', 'refunds', 'returns', 'running', 'savings', 'statement', 'subtractions', 'summary', 'through', 'thru',
  'to', 'total', 'trans', 'transaction', 'transactions', 'withdrawals',
]);
const SEPARATORS = new Set(['-', '–', '—', '/', '&']);
const MONTH = /^(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?)\.?$/i;

const DATE = /^(\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?|\d{4}-\d{2}-\d{2})$/;
const AMOUNT = /^\(?[-+]?\$?-?[\d,]*\d\.\d{2}\)?(-|CR|DR)?$/i;

export function maskToken(token: string): string {
  const bare = token.replace(/[:,;]$/, '');
  if (DATE.test(bare)) return 'DATE';
  if (AMOUNT.test(bare)) return 'AMOUNT';
  if (/\d/.test(bare)) return 'NUMBER';
  if (SEPARATORS.has(bare)) return bare;
  if (MONTH.test(bare)) return 'MONTH';
  if (LAYOUT_WORDS.has(bare.toLowerCase())) return bare.toLowerCase();
  return 'TEXT';
}

/** "03/05 EXAMPLE GROCER 45.67" -> "DATE TEXT×2 AMOUNT". Repeated TEXT is shortened to "TEXT×n". */
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

const KIND_TEXT = { checking: 'checking', savings: 'savings', credit_card: 'credit card' } as const;

/** Fixed facts about how one statement was read. */
function statementFacts(text: PdfText, statement: ParsedStatement, number: number): string[] {
  const s = statement;
  const signs = Object.entries(s.signSources)
    .map(([source, count]) => `${source.replace('_', ' ')} ${count}`)
    .join(', ');
  const assigned = s.transactions.filter((t) => t.flags.includes('date_assigned')).length;
  const ambiguous = s.transactions.filter((t) => t.flags.includes('ambiguous_sign')).length;
  const out = [
    `Statement ${number}: ${s.accountKind ? KIND_TEXT[s.accountKind] : 'account type not found'}; ` +
      `account number ${s.last4 ? 'found' : 'not found'}; period from ${s.periodSource.replace(/_/g, ' ')}; ` +
      `opening balance ${s.openingBalanceCents === undefined ? 'not found' : 'found'}, closing balance ${s.closingBalanceCents === undefined ? 'not found' : 'found'}`,
    `  rows ${s.transactions.length}; sign from: ${signs || 'none'}; unknown sign ${ambiguous}; date assigned ${assigned}; unread ${s.unreadLines.length}`,
    `  checks: ${s.validation.checks.map((c) => `${c.label} = ${c.passed === null ? 'not checked' : c.passed ? 'yes' : 'no'}`).join('; ')}`,
  ];
  s.unreadLines.forEach((line, i) => {
    const l = text.lines[line];
    if (l) out.push(`  unread [${s.unreadReasons[i] ?? 'unknown'}] p${l.page}  ${maskLine(l)}`);
  });
  return out;
}

/** Everything the masked diagnostics show for one PDF. */
export function describeRead(text: PdfText, outcome: ParseOutcome): string[] {
  const out: string[] = [];
  if (outcome.ok) {
    out.push(
      outcome.statements.length > 1
        ? `Accounts found in this PDF: ${outcome.statements.length} (${outcome.statements.map((s) => (s.accountKind ? KIND_TEXT[s.accountKind] : 'unknown')).join(', ')})`
        : 'Accounts found in this PDF: 1 (not split)',
    );
    outcome.statements.forEach((s, i) => out.push(...statementFacts(text, s, i + 1)));
  } else if (outcome.periodCandidates) {
    const sections = outcome.sections ?? [];
    if (sections.length > 1) {
      out.push(`Account sections found: ${sections.length}. Their headings:`);
      for (const section of sections) {
        const l = text.lines[section.line];
        if (l) out.push(`  p${l.page} [${section.kind ? KIND_TEXT[section.kind] : 'unknown'}]  ${maskLine(l)}`);
      }
    } else {
      out.push('Account sections found: 1 (not split)');
    }
    out.push('Statement period not found. Lines that looked like they might hold it:');
    if (outcome.periodCandidates.length === 0) out.push('  (none)');
    for (const candidate of outcome.periodCandidates.slice(0, 20)) {
      const l = text.lines[candidate.line];
      if (l) out.push(`  p${l.page} [${candidate.dates} full ${candidate.dates === 1 ? 'date' : 'dates'}]  ${maskLine(l)}`);
    }
  }
  out.push('First lines:', ...maskedLayout(text.lines).map((l) => `  ${l}`));
  return out;
}
