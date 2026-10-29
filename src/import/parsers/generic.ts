/**
 * A general reader for common text statement layouts: a transaction table
 * where each row starts with a date and ends with one or more amounts, as on
 * most checking, savings and credit-card statements. Bank-specific parsers can
 * be added alongside it (see registry.ts) when a real layout needs one.
 *
 * Rules (PROJECT_PRINCIPLES.md §7, §10): amounts are never guessed. Whether a
 * row is money in or out comes, in order, from its column (Withdrawals /
 * Deposits), a printed marker (minus, parentheses, CR/DR), the section it sits
 * in (e.g. "Purchases", "Payments and Other Credits"), the running balance,
 * and finally, on credit cards only, the convention that an unmarked amount
 * is a charge. A row with no evidence is flagged and not added.
 */
import { addDays, isIsoDate } from '../../domain/dates';
import { MoneyParseError, parseAmountToCents, sumCents, type Cents } from '../../domain/money';
import type { AccountKind, IsoDate, StatementValidation } from '../../domain/types';
import type { PdfText, TextLine, TextPiece } from '../pdfText';
import type { ParsedStatement, ParsedTransaction, ParseOutcome, RowFlag, StatementParser } from './types';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const NUMERIC_DATE = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const AMOUNT = /^\(?[-+]?\$?\s?-?[\d,]*\d\.\d{2}\)?(?:\s?-|\s?CR|\s?DR)?$/i;
const DATE_IN_TEXT = /\b(?:\d{1,2}\/\d{1,2}\/(?:\d{4}|\d{2})|\d{4}-\d{2}-\d{2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2},? \d{4})\b/gi;

type ColumnType = 'debit' | 'credit' | 'amount' | 'balance';
interface Column {
  type: ColumnType;
  x0: number;
  x1: number;
}

const COLUMN_LABELS: [RegExp, ColumnType][] = [
  [/^(running )?balance$/i, 'balance'],
  [/^(withdrawals?|debits?|subtractions|money out|charges)( \(-\))?$/i, 'debit'],
  [/^(deposits?|credits?|additions|money in)( \(\+\))?$/i, 'credit'],
  [/^amount( \(\$\))?$/i, 'amount'],
];

const CREDIT_SECTION = /\b(deposits|additions|credits|money in|interest (paid|earned))\b/i;
const DEBIT_SECTION =
  /\b(withdrawals|subtractions|debits|purchases|checks paid|fees|interest charged|money out|electronic payments|card transactions|cash advances)\b/i;

// ---- Small parsing helpers ----------------------------------------------------

function iso(year: number, month: number, day: number): IsoDate | null {
  const value = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isIsoDate(value) ? value : null;
}

/** Parses a full date ("03/01/2026", "03/01/26", "2026-03-01", "March 1, 2026"). */
export function parseFullDate(text: string): IsoDate | null {
  const t = text.trim().replace(/,/g, '');
  const numeric = NUMERIC_DATE.exec(t);
  if (numeric?.[3]) {
    const year = numeric[3].length === 2 ? 2000 + Number(numeric[3]) : Number(numeric[3]);
    return iso(year, Number(numeric[1]), Number(numeric[2]));
  }
  const isoMatch = ISO_DATE.exec(t);
  if (isoMatch) return iso(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
  const words = /^([a-z]{3,9})\.? (\d{1,2}) (\d{4})$/i.exec(t);
  if (words) {
    const month = MONTHS.indexOf(words[1]!.slice(0, 3).toLowerCase()) + 1;
    if (month > 0) return iso(Number(words[3]), month, Number(words[2]));
  }
  return null;
}

/** A row date token ("03/05", "03/05/26", "2026-03-05"), placed within the period. */
function parseRowDate(token: string, period: { start: IsoDate; end: IsoDate }): IsoDate | null {
  const full = parseFullDate(token);
  if (full) return full;
  const short = NUMERIC_DATE.exec(token);
  if (!short || short[3]) return null;
  const month = Number(short[1]);
  const day = Number(short[2]);
  const startYear = Number(period.start.slice(0, 4));
  const endYear = Number(period.end.slice(0, 4));
  // Choose the year that puts the date within (or nearest) the statement period.
  const from = addDays(period.start, -31);
  const to = addDays(period.end, 31);
  for (const year of new Set([endYear, startYear, endYear + 1, startYear - 1])) {
    const candidate = iso(year, month, day);
    if (candidate && candidate >= from && candidate <= to) return candidate;
  }
  return null;
}

function isDateToken(token: string): boolean {
  return NUMERIC_DATE.test(token) || ISO_DATE.test(token);
}

function isAmount(text: string): boolean {
  return AMOUNT.test(text.trim()) && /\d/.test(text);
}

interface PrintedAmount {
  absCents: Cents;
  /** "negative": minus, parentheses, trailing minus or CR/DR as printed. */
  marker: 'negative' | 'positive' | 'credit' | 'debit' | 'none';
}

function readAmount(text: string): PrintedAmount | null {
  const t = text.trim();
  let marker: PrintedAmount['marker'] = 'none';
  if (/CR$/i.test(t)) marker = 'credit';
  else if (/DR$/i.test(t)) marker = 'debit';
  else if (/^\(.*\)$/.test(t) || /^-|^\$-|-$/.test(t)) marker = 'negative';
  else if (/^\+/.test(t)) marker = 'positive';
  try {
    return { absCents: Math.abs(parseAmountToCents(t.replace(/^\+/, ''))), marker };
  } catch (error) {
    if (error instanceof MoneyParseError) return null;
    throw error;
  }
}

/** Splits leading date tokens from the first text pieces (e.g. "03/01 PAYROLL..." in one piece). */
function leadingDates(pieces: TextPiece[]): { dates: string[]; rest: TextPiece[] } {
  const dates: string[] = [];
  const rest: TextPiece[] = [];
  let collecting = true;
  for (const piece of pieces) {
    if (!collecting) {
      rest.push(piece);
      continue;
    }
    const words = piece.text.split(/\s+/);
    while (collecting && words.length && dates.length < 2 && isDateToken(words[0]!)) dates.push(words.shift()!);
    if (words.length) {
      collecting = false;
      rest.push({ ...piece, text: words.join(' ') });
    }
  }
  return { dates, rest };
}

/** Pulls amount pieces (up to three) off the right end of a line. */
function trailingAmounts(pieces: TextPiece[]): { amounts: TextPiece[]; rest: TextPiece[] } {
  const rest = [...pieces];
  const amounts: TextPiece[] = [];
  while (rest.length && amounts.length < 3) {
    const last = rest[rest.length - 1]!;
    // "1,234.56" followed by a separate "CR" piece.
    if (/^(CR|DR)$/i.test(last.text) && rest.length > 1 && isAmount(rest[rest.length - 2]!.text)) {
      const amount = rest[rest.length - 2]!;
      rest.splice(rest.length - 2, 2);
      amounts.unshift({ text: `${amount.text} ${last.text}`, x0: amount.x0, x1: last.x1 });
      continue;
    }
    if (!isAmount(last.text)) break;
    amounts.unshift(rest.pop()!);
  }
  return { amounts, rest };
}

function findHeader(line: TextLine): Column[] | null {
  if (!line.pieces.some((p) => /\bdate\b/i.test(p.text))) return null;
  const columns: Column[] = [];
  for (const piece of line.pieces) {
    const label = COLUMN_LABELS.find(([pattern]) => pattern.test(piece.text.trim()));
    if (label) columns.push({ type: label[1], x0: piece.x0, x1: piece.x1 });
  }
  return columns.length ? columns : null;
}

/** The column an amount sits under: overlapping first, else the nearest right edge. */
function columnFor(piece: TextPiece, columns: Column[]): Column | null {
  const overlapping = columns.filter((c) => piece.x1 >= c.x0 - 6 && piece.x0 <= c.x1 + 6);
  const pool = overlapping.length ? overlapping : columns;
  let best: Column | null = null;
  let bestDistance = Infinity;
  for (const column of pool) {
    const distance = Math.abs(column.x1 - piece.x1);
    if (distance < bestDistance) {
      best = column;
      bestDistance = distance;
    }
  }
  return best && bestDistance <= 45 ? best : null;
}

// ---- Statement details --------------------------------------------------------

function findPeriod(lines: TextLine[]): { start: IsoDate; end: IsoDate } | null {
  for (const line of lines) {
    if (!/(period|statement dates?|opening\/closing|closing date|billing cycle|from)/i.test(line.text)) continue;
    if (!/(-|–|—|\bto\b|\bthrough\b|\bthru\b)/i.test(line.text)) continue;
    const found = [...line.text.matchAll(DATE_IN_TEXT)].map((m) => parseFullDate(m[0])).filter((d): d is IsoDate => d !== null);
    if (found.length >= 2 && found[0]! <= found[1]!) return { start: found[0]!, end: found[1]! };
  }
  return null;
}

function labelledAmount(lines: TextLine[], label: RegExp): Cents | undefined {
  for (const line of lines) {
    if (!label.test(line.text)) continue;
    const piece = [...line.pieces].reverse().find((p) => isAmount(p.text));
    const amount = piece && readAmount(piece.text);
    if (amount) return amount.marker === 'negative' || amount.marker === 'credit' ? -amount.absCents : amount.absCents;
  }
  return undefined;
}

function findAccountKind(text: string): AccountKind | undefined {
  if (/credit card|minimum payment|credit limit|card ending/i.test(text)) return 'credit_card';
  if (/\bsavings\b/i.test(text)) return 'savings';
  if (/\bchecking\b/i.test(text)) return 'checking';
  return undefined;
}

/** Only the last four digits of an account or card number are ever kept. */
export function findLast4(text: string): string | undefined {
  const patterns = [
    /(?:account|card)[^\n\d]{0,30}?(?:ending in|ending|number|no\.?|#)\s*:?\s*(?:[x*•.\-\s]*?)(\d[\d\s-]{2,})/i,
    /[x*•]{3,}[\s-]*(\d{4})\b/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const digits = match?.[1]?.replace(/\D/g, '');
    if (digits && digits.length >= 4) return digits.slice(-4);
  }
  return undefined;
}

// ---- The parser ---------------------------------------------------------------

export const genericParser: StatementParser = {
  id: 'generic-table',
  version: 1,
  parse(text: PdfText): ParseOutcome {
    const { lines } = text;
    const period = findPeriod(lines);
    if (!period) return { ok: false, reason: 'no_period' };

    const firstHeader = lines.findIndex((line) => findHeader(line) !== null);
    const metadataLines = firstHeader >= 0 ? lines.slice(0, firstHeader) : lines.slice(0, 15);
    const metadata = metadataLines.map((l) => l.text).join('\n');
    const accountKind = findAccountKind(metadata);
    const last4 = findLast4(metadata);
    const openingBalanceCents = labelledAmount(metadataLines, /^(beginning|opening|previous|starting) balance\b/i);
    const closingBalanceCents = labelledAmount(metadataLines, /^(ending|closing|new) balance\b/i);
    const isCard = accountKind === 'credit_card';

    let columns: Column[] = [];
    let inTable = false;
    let section: 'credit' | 'debit' | null = null;
    let previousBalance: Cents | undefined = isCard ? undefined : openingBalanceCents;
    let descriptionX = Infinity;
    const transactions: (ParsedTransaction & { printedBalance?: Cents })[] = [];
    const unreadLines: number[] = [];

    lines.forEach((line, index) => {
      const header = findHeader(line);
      if (header) {
        columns = header;
        inTable = true;
        section = null;
        const description = line.pieces.find((p) => /description|transaction|details/i.test(p.text));
        if (description) descriptionX = description.x0;
        return;
      }
      if (!inTable && transactions.length === 0 && !isDateToken(line.pieces[0]?.text.split(/\s+/)[0] ?? '')) return;
      if (/^(total|subtotal)\b/i.test(line.text) || /^page \d+ (of \d+)?$/i.test(line.text)) return;

      const { dates, rest: afterDates } = leadingDates(line.pieces);
      const { amounts, rest: middle } = trailingAmounts(afterDates);
      const description = middle.map((p) => p.text).join(' ').trim();

      if (dates.length === 0) {
        if (amounts.length === 0) {
          // The second line of the previous row's description (indented under
          // the description column), or else a section heading.
          const previous = transactions[transactions.length - 1];
          if (previous && line.pieces[0]!.x0 >= descriptionX - 2 && line.page === lines[previous.line]!.page) {
            previous.description += ` ${line.text}`;
          } else if (CREDIT_SECTION.test(line.text) && !/\d/.test(line.text)) section = 'credit';
          else if (DEBIT_SECTION.test(line.text) && !/\d/.test(line.text)) section = 'debit';
        } else if (inTable) {
          unreadLines.push(index);
        }
        return;
      }

      // Rows: dates first, amounts last, a description in between.
      const posted = parseRowDate(dates.length === 2 ? dates[1]! : dates[0]!, period);
      const transactionDate = dates.length === 2 ? parseRowDate(dates[0]!, period) : null;
      if (!posted || amounts.length === 0 || description === '') {
        if (amounts.length > 0 || inTable) unreadLines.push(index);
        return;
      }

      let amountPiece: TextPiece | undefined;
      let amountColumn: Column | null = null;
      let printedBalance: Cents | undefined;
      for (const piece of amounts) {
        const column = columns.length ? columnFor(piece, columns) : null;
        if (column?.type === 'balance' || (!columns.length && amounts.length > 1 && piece === amounts[amounts.length - 1])) {
          const balance = readAmount(piece.text);
          if (balance) printedBalance = balance.marker === 'negative' ? -balance.absCents : balance.absCents;
        } else if (!amountPiece) {
          amountPiece = piece;
          amountColumn = column;
        }
      }
      const printed = amountPiece ? readAmount(amountPiece.text) : null;
      if (!printed) {
        unreadLines.push(index);
        return;
      }

      let sign: 1 | -1 | null = null;
      if (amountColumn?.type === 'debit') sign = -1;
      else if (amountColumn?.type === 'credit') sign = 1;
      else if (isCard && (printed.marker === 'negative' || printed.marker === 'credit')) sign = 1;
      else if (isCard && printed.marker === 'debit') sign = -1;
      else if (!isCard && (printed.marker === 'negative' || printed.marker === 'debit')) sign = -1;
      else if (!isCard && (printed.marker === 'positive' || printed.marker === 'credit')) sign = 1;
      else if (section) sign = section === 'credit' ? 1 : -1;
      else if (printedBalance !== undefined && previousBalance !== undefined) {
        if (previousBalance + printed.absCents === printedBalance) sign = 1;
        else if (previousBalance - printed.absCents === printedBalance) sign = -1;
      } else if (isCard) sign = -1;

      const flags: RowFlag[] = [];
      if (sign === null) flags.push('ambiguous_sign');
      const amountCents = sign === null ? null : sign * printed.absCents;
      if (posted < addDays(period.start, -3) || posted > addDays(period.end, 3)) flags.push('date_outside_period');
      if (amountCents !== null && printedBalance !== undefined && previousBalance !== undefined && !isCard) {
        if (previousBalance + amountCents !== printedBalance) flags.push('running_balance_mismatch');
      }
      if (printedBalance !== undefined) previousBalance = printedBalance;
      else if (amountCents !== null && previousBalance !== undefined) previousBalance += amountCents;

      transactions.push({
        line: index,
        postedDate: posted,
        ...(transactionDate ? { transactionDate } : {}),
        description,
        amountCents,
        flags,
        ...(printedBalance !== undefined ? { printedBalance } : {}),
      });
    });

    if (transactions.length === 0) return { ok: false, reason: 'no_transactions' };

    const validation = validate(transactions, { openingBalanceCents, closingBalanceCents, isCard, unreadLines });
    const statement: ParsedStatement = {
      parserId: this.id,
      parserVersion: this.version,
      ...(accountKind ? { accountKind } : {}),
      ...(last4 ? { last4 } : {}),
      periodStart: period.start,
      periodEnd: period.end,
      ...(openingBalanceCents !== undefined ? { openingBalanceCents } : {}),
      ...(closingBalanceCents !== undefined ? { closingBalanceCents } : {}),
      transactions: transactions.map(({ printedBalance: _balance, ...rest }) => rest),
      unreadLines,
      validation,
    };
    const score = validation.status === 'verified' ? 1 : validation.status === 'failed' ? 0.3 : 0.6;
    return { ok: true, statement, score };
  },
};

function validate(
  transactions: ParsedTransaction[],
  facts: { openingBalanceCents: Cents | undefined; closingBalanceCents: Cents | undefined; isCard: boolean; unreadLines: number[] },
): StatementValidation {
  const checks: StatementValidation['checks'] = [];
  const known = transactions.filter((t) => t.amountCents !== null);
  const allKnown = known.length === transactions.length;

  let balancesMatch: boolean | null = null;
  if (facts.openingBalanceCents !== undefined && facts.closingBalanceCents !== undefined) {
    if (allKnown) {
      const activity = sumCents(known.map((t) => t.amountCents!));
      // Bank: balance rises with money in. Card: the balance owed rises with charges.
      const expected = facts.isCard ? facts.openingBalanceCents - activity : facts.openingBalanceCents + activity;
      balancesMatch = expected === facts.closingBalanceCents;
    }
    checks.push({ label: 'Opening balance plus activity equals closing balance', passed: balancesMatch });
  } else {
    checks.push({ label: 'Opening and closing balances printed on the statement', passed: null });
  }
  const runningMismatch = transactions.some((t) => t.flags.includes('running_balance_mismatch'));
  checks.push({ label: 'Every row agrees with the running balance', passed: runningMismatch ? false : null });
  checks.push({ label: 'Every row was read', passed: facts.unreadLines.length === 0 && allKnown });

  const failed = balancesMatch === false || runningMismatch;
  const status = failed
    ? 'failed'
    : balancesMatch === true && facts.unreadLines.length === 0 && allKnown
      ? 'verified'
      : balancesMatch === true || facts.unreadLines.length === 0
        ? 'partially_verified'
        : 'unverified';
  return { status, checks };
}
