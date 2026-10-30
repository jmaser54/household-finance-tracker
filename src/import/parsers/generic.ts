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
 *
 * A combined statement is split into its accounts first (accounts.ts); each
 * is read and reconciled on its own.
 */
import { addDays } from '../../domain/dates';
import { MoneyParseError, parseAmountToCents, sumCents, type Cents } from '../../domain/money';
import type { AccountKind, IsoDate, StatementValidation } from '../../domain/types';
import type { PdfText, TextLine, TextPiece } from '../pdfText';
import { findAccountKind, findLast4, splitAccounts, type AccountSection } from './accounts';
import { findPeriod, holdsRange, parseFullDate, type Period, type PeriodSource } from './period';
import type {
  ParsedStatement,
  ParsedTransaction,
  ParseOutcome,
  RowFlag,
  SetAsideKind,
  SignSource,
  StatementParser,
  UnreadContext,
  UnreadReason,
} from './types';

const NUMERIC_DATE = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const AMOUNT = /^\(?[-+]?\$?\s?-?[\d,]*\d\.\d{2}\)?(?:\s?-|\s?CR|\s?DR)?$/i;

type ColumnType = 'debit' | 'credit' | 'amount' | 'balance';
interface Column {
  type: ColumnType;
  x0: number;
  x1: number;
}

const DEBIT_COLUMN = /^(withdrawals?|debits?|subtractions|money out|paid out|charges|checks)$/;
const CREDIT_COLUMN = /^(deposits?|credits?|additions|money in|paid in)$/;

/**
 * A column label's type. Combined and decorated labels count when every part
 * agrees: "Withdrawals/Debits", "Checks & Debits", "Debits ($)", "Credits (+)",
 * "Debit Amount". A label mixing both directions ("Debits/Credits") is none.
 */
function columnType(label: string): ColumnType | null {
  const t = label
    .toLowerCase()
    .replace(/\((\$|-|\+|usd)\)|\$/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^(running |daily |ending daily )?balance$/.test(t)) return 'balance';
  if (/^amount$/.test(t)) return 'amount';
  const parts = t
    .split(/\s*(?:\/|&|,|\band\b)\s*/)
    .map((part) => part.replace(/\bamount\b/, '').trim())
    .filter(Boolean);
  if (parts.length === 0 || parts.length > 3) return null;
  if (parts.every((part) => DEBIT_COLUMN.test(part))) return 'debit';
  if (parts.every((part) => CREDIT_COLUMN.test(part))) return 'credit';
  return null;
}

// Section headings. On a bank statement a heading names its section anywhere
// in a short line with no figures; one that prints a figure (its total) must be
// exactly a known heading. On a card, headings must be exactly a known heading.
const CREDIT_SECTION = /\b(deposits|additions|credits|money in|interest (paid|earned))\b/i;
const DEBIT_SECTION =
  /\b(withdrawals|subtractions|debits|purchases|checks paid|fees|interest charged|money out|electronic payments|card transactions|cash advances|payments)\b/i;
const BANK_HEADING =
  /^((electronic |other |atm and debit card )?(deposits?|additions|credits|withdrawals?|subtractions|debits|transactions)( and (other )?(deposits|additions|credits|withdrawals|subtractions|debits))?|checks( paid)?|(service )?fees( and charges)?|electronic payments)$/;
/** On a card, payments, credits, refunds and returns all lower the balance owed. */
const CARD_CREDIT_WORDS = /\b(payments?|credits?|refunds?|returns?)\b/i;
const CARD_CREDIT_HEADING =/^(payments?|(other )?credits?|refunds?|returns?)( (and )?(other )?(payments?|credits?|adjustments|refunds?|returns?))*$/;
const CARD_DEBIT_HEADING =
  /^((new |other )?(purchases?|charges)|(other )?debits|fees( charged)?|interest( charged| charges?)?|cash advances?|balance transfers?)( (and )?(other )?(purchases?|charges|debits|adjustments|fees( charged)?|interest( charged)?|cash advances?|balance transfers?))*$/;

/** Undated lines that are charges (interest, fees): added on the closing date and flagged. */
const UNDATED_CHARGE = /\b(interest|fees?|finance charge|late charge|annual fee)\b/i;
/** …but not a summary of interest or fees ("Interest earned this period", "Fees this year"). */
const NOT_A_CHARGE = /\b(earned|paid|yield|rate|this (period|year|cycle|statement)|to date|summary|total)\b/i;

// Lines recognised as not transactions (SetAsideKind). Each pattern is specific;
// anything else with an amount is still reported unread.
const PAGE_LINE = /\bpage \d+( of \d+)?\b/i;
const BALANCE_SUMMARY = /\b(average|avg|minimum|min|maximum|lowest|highest|ledger|collected|available|daily)\b.*\bbalance\b/i;
const INTEREST_SUMMARY =
  /\b(interest|fees?) (earned|paid|credited|charged)\b.*\b(this|period|year|cycle|to date|ytd)\b|\bannual percentage yield\b|\bAPY\b/i;
const SECTION_SUMMARY =
  /\b(deposits|withdrawals|credits|debits|checks|payments|purchases|additions|subtractions|transactions)\b.*\b\d+\s+(items?|transactions?)\b/i;
const REWARDS_SUMMARY = /\b(rewards?|points|cash ?back|miles)\b/i;
/** The minimum-payment warning table on card statements, and sentences addressed to the reader. */
const DISCLOSURE = /\bonly the minimum payment\b|\bpay(ing)? off\b|\bestimated total\b|\b\d+\s+(years?|months?)\b/i;
const SENTENCE_WORDS = /\b(you|your|we|our|if|may|will|please)\b/i;
const isSentence = (text: string) => text.split(/\s+/).length >= 7 && SENTENCE_WORDS.test(text);
const DAILY_BALANCE_HEADING = /\b(daily (ending |ledger |closing )?balances?|balance summary|daily balance summary)\b/i;
/** Undated lines that are summaries, not transactions: interest-rate tables and year-to-date totals. */
const SUMMARY_LINE = /\d%|\bAPR\b|\b(19|20)\d{2}\b|year[- ]to[- ]date|\bYTD\b/i;

const OPENING_LABEL = /^(beginning|opening|previous|starting) balance\b/i;
const CLOSING_LABEL = /^(ending|closing|new) balance\b/i;

// ---- Small parsing helpers ----------------------------------------------------

/** A row date token ("03/05", "03/05/26", "2026-03-05"), placed within the period. */
function parseRowDate(token: string, period: Period): IsoDate | null {
  const full = NUMERIC_DATE.exec(token)?.[3] || ISO_DATE.test(token) ? parseFullDate(token) : null;
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
    const candidate = parseFullDate(`${month}/${day}/${year}`);
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

const signed = (amount: PrintedAmount): Cents =>
  amount.marker === 'negative' || amount.marker === 'credit' ? -amount.absCents : amount.absCents;

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
    rest.pop();
    // A sign or currency symbol printed as its own piece just before it: "-  100.00", "$ 100.00".
    const before = rest[rest.length - 1];
    if (before && /^(-|−|–|\$|-\$|\+)$/.test(before.text.trim()) && last.x0 - before.x1 <= 20 && !/^-|^\(/.test(last.text)) {
      rest.pop();
      amounts.unshift({ text: `${before.text.trim().replace(/[−–]/, '-')}${last.text}`, x0: before.x0, x1: last.x1 });
    } else {
      amounts.unshift(last);
    }
  }
  return { amounts, rest };
}

/** A line made only of date and amount pairs ("03/02 900.00 03/09 1,240.00"), as in a daily balance table. */
function datePairs(text: string): { token: string; cents: Cents }[] | null {
  const tokens = text.trim().split(/\s+/);
  if (tokens.length < 2 || tokens.length % 2 !== 0) return null;
  const pairs: { token: string; cents: Cents }[] = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const amount = isDateToken(tokens[i]!) && isAmount(tokens[i + 1]!) ? readAmount(tokens[i + 1]!) : null;
    if (!amount) return null;
    pairs.push({ token: tokens[i]!, cents: signed(amount) });
  }
  return pairs;
}

function findHeader(line: TextLine): Column[] | null {
  if (!line.pieces.some((p) => /\bdate\b/i.test(p.text))) return null;
  const columns: Column[] = [];
  for (const piece of line.pieces) {
    const type = columnType(piece.text);
    if (type) columns.push({ type, x0: piece.x0, x1: piece.x1 });
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

/** A section heading, and whether its rows are money in or out. `text` excludes any printed total. */
function sectionHeading(text: string, isCard: boolean, hasFigure: boolean): 'credit' | 'debit' | null {
  const t = text
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\(\s*\d+\s*\)|\(continued\)|\bcontinued\b|[,:.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t === '' || t.split(' ').length > 7) return null;
  if (isCard) {
    if (CARD_CREDIT_HEADING.test(t)) return 'credit';
    if (CARD_DEBIT_HEADING.test(t)) return 'debit';
    // Without a figure, a short line naming a section still starts it, as before.
    if (hasFigure || /\d/.test(text)) return null;
    if (CARD_CREDIT_WORDS.test(t)) return 'credit';
    if (DEBIT_SECTION.test(t)) return 'debit';
    return null;
  }
  if (hasFigure ? !BANK_HEADING.test(t) : /\d/.test(text)) return null;
  if (CREDIT_SECTION.test(t)) return 'credit';
  if (DEBIT_SECTION.test(t)) return 'debit';
  return null;
}

function labelledAmount(lines: TextLine[], label: RegExp): Cents | undefined {
  for (const line of lines) {
    if (!label.test(line.text)) continue;
    const piece = [...line.pieces].reverse().find((p) => isAmount(p.text));
    const amount = piece && readAmount(piece.text);
    if (amount) return signed(amount);
  }
  return undefined;
}

// ---- Reading one account ------------------------------------------------------

interface SectionTotal {
  printedCents: Cents;
  rows: (ParsedTransaction & { printedBalance?: Cents })[];
}

interface ReadAccount {
  statement: Omit<ParsedStatement, 'parserId' | 'parserVersion' | 'section'>;
  score: number;
}

function readAccount(all: TextLine[], section: AccountSection, period: Period, periodSource: PeriodSource): ReadAccount {
  const lines = section.lines.map((i) => all[i]!);
  const firstHeader = lines.findIndex((line) => findHeader(line) !== null);
  const metadataLines = firstHeader >= 0 ? lines.slice(0, firstHeader) : lines.slice(0, 15);
  const metadata = metadataLines.map((l) => l.text).join('\n');
  const accountKind: AccountKind | undefined = section.kind ?? findAccountKind(metadata);
  const last4 = section.last4 ?? findLast4(metadata, accountKind);
  let openingBalanceCents = labelledAmount(metadataLines, OPENING_LABEL);
  let closingBalanceCents = labelledAmount(metadataLines, CLOSING_LABEL);
  const isCard = accountKind === 'credit_card';

  let columns: Column[] = [];
  let inTable = false;
  let section_: 'credit' | 'debit' | null = null;
  let sectionTotal: SectionTotal | null = null;
  const sectionTotals: SectionTotal[] = [];
  /** Rows whose sign is unknown since the last printed balance (see settleByBalance). */
  let pending: { row: ParsedTransaction; absCents: Cents }[] = [];
  /** Every row read with no sign marker, in a single Amount column (see signedColumnConvention). */
  const unmarkedInAmountColumn: { row: ParsedTransaction; absCents: Cents }[] = [];
  let negativeInAmountColumn = false;
  let previousBalance: Cents | undefined = isCard ? undefined : openingBalanceCents;
  let descriptionX = Infinity;
  const transactions: (ParsedTransaction & { printedBalance?: Cents })[] = [];
  const unreadLines: number[] = [];
  const unreadReasons: UnreadReason[] = [];
  const signSources: Partial<Record<SignSource, number>> = {};
  const unreadContext: (UnreadContext & { at: number })[] = [];
  const setAside: { line: number; kind: SetAsideKind }[] = [];
  /** Daily balances printed in a balance table, checked against the transactions after reading. */
  const dailyBalances: { token: string; cents: Cents }[] = [];
  let inDailyBalances = false;
  const putAside = (lineIndex: number, kind: SetAsideKind) => setAside.push({ line: section.lines[lineIndex]!, kind });
  const amountsAllInBalanceColumn = (amounts: TextPiece[]) =>
    columns.length > 0 && amounts.length > 0 && amounts.every((piece) => columnFor(piece, columns)?.type === 'balance');
  const unread = (lineIndex: number, reason: UnreadReason, amounts: TextPiece[] = []) => {
    unreadLines.push(section.lines[lineIndex]!);
    unreadReasons.push(reason);
    unreadContext.push({
      at: lineIndex,
      amountColumns: amounts.map((piece) => (columns.length ? (columnFor(piece, columns)?.type ?? 'none') : 'none')),
      position: 'before_rows',
      section: section_ ?? 'none',
    });
  };

  lines.forEach((line, index) => {
    const header = findHeader(line);
    const describes = line.pieces.some((p) => /description|transaction|details/i.test(p.text));
    // "Date  Balance  Date  Balance" of a daily balance table doesn't replace the transaction columns;
    // a header with a description column starts a transaction table again.
    if (header && inDailyBalances && !describes) return;
    if (header) {
      inDailyBalances = false;
      columns = header;
      inTable = true;
      // A section heading printed on the line just above the column header
      // ("DEPOSITS AND ADDITIONS", then "Date  Description  Amount") applies to the rows below.
      const above = lines[index - 1];
      const aboveIsHeading =
        above && !isDateToken(above.pieces[0]?.text.split(/\s+/)[0] ?? '') && trailingAmounts(above.pieces).amounts.length === 0;
      section_ = aboveIsHeading ? sectionHeading(above.text, isCard, false) : null;
      sectionTotal = null;
      const description = line.pieces.find((p) => /description|transaction|details/i.test(p.text));
      if (description) descriptionX = description.x0;
      return;
    }
    if (!inTable && transactions.length === 0 && !isDateToken(line.pieces[0]?.text.split(/\s+/)[0] ?? '')) return;
    if (/^(total|subtotal)\b/i.test(line.text)) return;

    const { dates, rest: afterDates } = leadingDates(line.pieces);
    const { amounts, rest: middle } = trailingAmounts(afterDates);
    const description = middle.map((p) => p.text).join(' ').trim();

    // Page footers and headers ("03/31/2026  Page 2 of 3", the period repeated atop a page).
    if (amounts.length === 0 && (PAGE_LINE.test(line.text) || holdsRange(line.text))) {
      if (dates.length > 0 || PAGE_LINE.test(line.text)) putAside(index, 'page_header_or_footer');
      return;
    }
    // A daily balance table: only dates and balances ("03/02  900.00  03/09  1,240.00").
    const pairs = datePairs(line.text);
    if (pairs && (pairs.length > 1 || inDailyBalances || amountsAllInBalanceColumn(amounts))) {
      dailyBalances.push(...pairs);
      putAside(index, 'daily_balance');
      return;
    }

    // Balance lines inside the table ("Beginning balance", dated or not) are not transactions.
    if (OPENING_LABEL.test(description) || CLOSING_LABEL.test(description)) {
      const last = amounts[amounts.length - 1];
      const amount = last && readAmount(last.text);
      if (amount && OPENING_LABEL.test(description) && openingBalanceCents === undefined) {
        openingBalanceCents = signed(amount);
        if (!isCard && transactions.length === 0) previousBalance = openingBalanceCents;
      }
      if (amount && CLOSING_LABEL.test(description) && closingBalanceCents === undefined) closingBalanceCents = signed(amount);
      return;
    }

    if (dates.length === 0) {
      if (amounts.length === 0) {
        // The second line of the previous row's description (indented under
        // the description column), or else a section heading.
        const previous = transactions[transactions.length - 1];
        if (previous && line.pieces[0]!.x0 >= descriptionX - 2 && line.page === all[previous.line]!.page) {
          previous.description += ` ${line.text}`;
          return;
        }
        const heading = sectionHeading(description, isCard, false);
        if (heading) {
          section_ = heading;
          sectionTotal = null;
        }
        if (DAILY_BALANCE_HEADING.test(line.text)) inDailyBalances = true;
        return;
      }
      // A heading that prints its section's total, e.g. "Payments and Other Credits -1,234.56".
      const heading = amounts.length === 1 ? sectionHeading(description, isCard, true) : null;
      const printedTotal = heading ? readAmount(amounts[0]!.text) : null;
      if (heading && printedTotal) {
        section_ = heading;
        sectionTotal = { printedCents: printedTotal.absCents, rows: [] };
        sectionTotals.push(sectionTotal);
        return;
      }
      if (!inTable) return;
      if (BALANCE_SUMMARY.test(description)) return putAside(index, 'balance_summary');
      if (INTEREST_SUMMARY.test(description)) return putAside(index, 'interest_or_fee_summary');
      if (SECTION_SUMMARY.test(description)) return putAside(index, 'section_summary');
      if (REWARDS_SUMMARY.test(description)) return putAside(index, 'rewards_summary');
      if (DISCLOSURE.test(description) || isSentence(description)) return putAside(index, 'explanatory_text');
      if (SUMMARY_LINE.test(description)) return putAside(index, 'rate_or_year_to_date');
      if (amounts.every((a) => readAmount(a.text)?.absCents === 0)) return putAside(index, 'zero_amounts'); // "Fee waived 0.00"
      if (amounts.length === 1 && description !== '' && UNDATED_CHARGE.test(description) && !NOT_A_CHARGE.test(description)) {
        addRow(index, period.end, null, description, amounts, ['date_assigned']);
        return;
      }
      unread(index, 'no_date', amounts);
      return;
    }

    // Rows: dates first, amounts last, a description in between.
    const posted = parseRowDate(dates.length === 2 ? dates[1]! : dates[0]!, period);
    const transactionDate = dates.length === 2 ? parseRowDate(dates[0]!, period) : null;
    if (!posted || amounts.length === 0 || description === '') {
      if (amounts.length > 0 || inTable) {
        unread(index, !posted ? 'date_not_in_period' : amounts.length === 0 ? 'no_amount' : 'no_description', amounts);
      }
      return;
    }
    addRow(index, posted, transactionDate, description, amounts, []);
  });

  function addRow(index: number, posted: IsoDate, transactionDate: IsoDate | null, description: string, amounts: TextPiece[], flags: RowFlag[]) {
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
      unread(index, 'bad_amount', amounts);
      return;
    }

    let sign: 1 | -1 | null = null;
    let source: SignSource | null = null;
    if (amountColumn?.type === 'debit') [sign, source] = [-1, 'column'];
    else if (amountColumn?.type === 'credit') [sign, source] = [1, 'column'];
    else if (isCard && (printed.marker === 'negative' || printed.marker === 'credit')) [sign, source] = [1, 'marker'];
    else if (isCard && printed.marker === 'debit') [sign, source] = [-1, 'marker'];
    else if (!isCard && (printed.marker === 'negative' || printed.marker === 'debit')) [sign, source] = [-1, 'marker'];
    else if (!isCard && (printed.marker === 'positive' || printed.marker === 'credit')) [sign, source] = [1, 'marker'];
    else if (section_) [sign, source] = [section_ === 'credit' ? 1 : -1, 'section'];
    else if (isCard) [sign, source] = [-1, 'card_rule'];
    if (source) signSources[source] = (signSources[source] ?? 0) + 1;

    const rowFlags: RowFlag[] = [...flags];
    if (posted < addDays(period.start, -3) || posted > addDays(period.end, 3)) rowFlags.push('date_outside_period');
    const row: ParsedTransaction & { printedBalance?: Cents } = {
      line: section.lines[index]!,
      postedDate: posted,
      ...(transactionDate ? { transactionDate } : {}),
      description,
      amountCents: sign === null ? null : sign * printed.absCents,
      flags: rowFlags,
      ...(printedBalance !== undefined ? { printedBalance } : {}),
    };
    transactions.push(row);
    (sectionTotal as SectionTotal | null)?.rows.push(row);
    if (sign === null) pending.push({ row, absCents: printed.absCents });
    if (!isCard && (amountColumn === null || amountColumn.type === 'amount')) {
      if (printed.marker === 'negative') negativeInAmountColumn = true;
      if (printed.marker === 'none') unmarkedInAmountColumn.push({ row, absCents: printed.absCents });
    }

    if (printedBalance !== undefined && previousBalance !== undefined && !isCard) {
      // previousBalance already includes every known row since the last printed balance except this one.
      if (pending.length) settleByBalance(printedBalance - previousBalance - (sign === null ? 0 : row.amountCents!));
      else if (previousBalance + row.amountCents! !== printedBalance) rowFlags.push('running_balance_mismatch');
    }
    if (printedBalance !== undefined) {
      previousBalance = printedBalance;
      pending = [];
    } else if (row.amountCents !== null && previousBalance !== undefined) {
      previousBalance += row.amountCents;
    }
    for (const p of pending) if (!p.row.flags.includes('ambiguous_sign')) p.row.flags.push('ambiguous_sign');
  }

  /**
   * The printed running balance moved by `change` over the rows since the last
   * printed balance, some of whose signs are unknown (a balance printed only on
   * a day's last row). If exactly one choice of in/out for those rows gives
   * that change, it is the one printed. If several choices fit, they stay
   * unknown; if none fits, the row is flagged as disagreeing with the running
   * balance. Nothing is guessed.
   */
  function settleByBalance(target: Cents) {
    const solutions: number[] = [];
    if (pending.length <= 12) {
      for (let mask = 0; mask < 1 << pending.length; mask++) {
        const total = pending.reduce((sum, p, i) => sum + (mask & (1 << i) ? p.absCents : -p.absCents), 0);
        if (total === target) solutions.push(mask);
        if (solutions.length > 1) break;
      }
    }
    if (solutions.length === 1) {
      pending.forEach((p, i) => {
        p.row.amountCents = solutions[0]! & (1 << i) ? p.absCents : -p.absCents;
        p.row.flags = p.row.flags.filter((f) => f !== 'ambiguous_sign');
        signSources.running_balance = (signSources.running_balance ?? 0) + 1;
      });
      pending = [];
    } else if (solutions.length === 0 && pending.length <= 12) {
      // No choice of in/out matches the printed balance: something was misread.
      transactions[transactions.length - 1]!.flags.push('running_balance_mismatch');
    }
  }

  // The statement's own convention for a single Amount column on a bank
  // account: when it prints a minus on money going out, an amount printed
  // without one in that same column is money coming in. Used only for rows no
  // other evidence settled; the balances must still reconcile to verify.
  if (negativeInAmountColumn) {
    for (const { row, absCents } of unmarkedInAmountColumn) {
      if (row.amountCents !== null) continue;
      row.amountCents = absCents;
      row.flags = row.flags.filter((f) => f !== 'ambiguous_sign');
      signSources.signed_column = (signSources.signed_column ?? 0) + 1;
    }
  }

  // Where each unread line sits relative to the rows, for the diagnostics.
  const rowAt = transactions.map((t) => section.lines.indexOf(t.line));
  for (const context of unreadContext) {
    const before = rowAt.filter((r) => r < context.at).length;
    context.position = before === 0 ? 'before_rows' : before === rowAt.length ? 'after_rows' : 'between_rows';
  }

  // Each printed daily balance must equal the opening balance plus every row up to that day.
  let dailyBalancesAgree: boolean | null = null;
  if (dailyBalances.length && openingBalanceCents !== undefined && !isCard && transactions.every((t) => t.amountCents !== null)) {
    dailyBalancesAgree = dailyBalances.every(({ token, cents }) => {
      const day = parseRowDate(token, period);
      if (!day) return false;
      const upToDay = sumCents(transactions.filter((t) => t.postedDate <= day).map((t) => t.amountCents!));
      return openingBalanceCents! + upToDay === cents;
    });
  }

  const validation = validate(transactions, {
    openingBalanceCents,
    closingBalanceCents,
    isCard,
    unreadLines,
    sectionTotals,
    oneAccount: balancesOfOneAccount(lines),
    dailyBalancesAgree,
    hasDailyBalances: dailyBalances.length > 0,
  });
  return {
    statement: {
      ...(accountKind ? { accountKind } : {}),
      ...(last4 ? { last4 } : {}),
      periodStart: period.start,
      periodEnd: period.end,
      ...(openingBalanceCents !== undefined ? { openingBalanceCents } : {}),
      ...(closingBalanceCents !== undefined ? { closingBalanceCents } : {}),
      transactions: transactions.map(({ printedBalance: _balance, ...rest }) => rest),
      unreadLines,
      unreadReasons,
      unreadContext: unreadContext.map(({ at: _at, ...context }) => context),
      excludedLines: unreadLines.map((i) => all[i]!.text),
      setAside,
      validation,
      periodSource,
      signSources,
    },
    score: validation.status === 'verified' ? 1 : validation.status === 'failed' ? 0.3 : 0.6,
  };
}

// ---- The parser ---------------------------------------------------------------

export const genericParser: StatementParser = {
  id: 'generic-table',
  version: 2,
  parse(text: PdfText): ParseOutcome {
    const { lines } = text;
    const document = findPeriod(lines);
    const { preamble, sections } = splitAccounts(lines);

    const read: ReadAccount[] = [];
    for (const section of sections) {
      // A combined statement may print each account's own period; else the document's applies.
      const own = sections.length > 1 ? findPeriod(section.lines.map((i) => lines[i]!)) : null;
      const found = own?.period ? own : document;
      if (!found.period) {
        return {
          ok: false,
          reason: 'no_period',
          periodCandidates: document.candidates,
          sections: sections.map((s) => ({ ...(s.kind ? { kind: s.kind } : {}), line: s.lines[0]! })),
        };
      }
      read.push(readAccount(lines, section, found.period, found.source!));
    }

    // A transaction-like row outside every account section can't be placed: never silently dropped.
    const strays = preamble.filter((i) => {
      const { dates } = leadingDates(lines[i]!.pieces);
      return dates.length > 0 && trailingAmounts(lines[i]!.pieces).amounts.length > 0;
    });
    if (strays.length && read[0]) {
      read[0].statement.unreadLines.push(...strays);
      read[0].statement.unreadReasons.push(...strays.map((): UnreadReason => 'outside_any_account'));
      read[0].statement.unreadContext.push(...strays.map(() => null));
      read[0].statement.excludedLines.push(...strays.map((i) => lines[i]!.text));
      read[0].statement.validation = revalidate(read[0].statement);
      read[0].score = Math.min(read[0].score, 0.6);
    }

    if (read.every((r) => r.statement.transactions.length === 0)) return { ok: false, reason: 'no_transactions' };
    const statements: ParsedStatement[] = read.map((r, index) => ({
      parserId: this.id,
      parserVersion: this.version,
      ...r.statement,
      ...(read.length > 1 ? { section: { index, of: read.length } } : {}),
    }));
    return { ok: true, statements, score: read.reduce((sum, r) => sum + r.score, 0) / read.length };
  },
};

/** Validation again after unread lines were added: they can only make it weaker. */
function revalidate(statement: ReadAccount['statement']): StatementValidation {
  const checks = statement.validation.checks.map((c) => (c.label === EVERY_ROW_READ ? { ...c, passed: false } : c));
  return { status: statusOf(checks), checks };
}

const BALANCES_ADD_UP = 'Opening balance plus activity equals closing balance';
const EVERY_ROW_READ = 'Every row was read';
const ONE_ACCOUNT = "Only one account's balances on this statement";
const DAILY_BALANCES = 'Every daily balance printed agrees with the transactions';
/** A failure of any of these means the statement doesn't add up. */
const RECONCILIATION_CHECKS = new Set([
  BALANCES_ADD_UP,
  'Every row agrees with the running balance',
  'Each section adds up to the total printed in its heading',
  ONE_ACCOUNT,
  DAILY_BALANCES,
]);

/**
 * "Verified" only when the opening balance plus the activity read was
 * actually compared with the closing balance and matched, and every row was
 * read. If that comparison couldn't be made, the statement is "unverified",
 * whatever else passed.
 */
function statusOf(checks: StatementValidation['checks']): StatementValidation['status'] {
  if (checks.some((c) => RECONCILIATION_CHECKS.has(c.label) && c.passed === false)) return 'failed';
  if (checks.find((c) => c.label === BALANCES_ADD_UP)?.passed !== true) return 'unverified';
  return checks.find((c) => c.label === EVERY_ROW_READ)?.passed === true ? 'verified' : 'partially_verified';
}

/**
 * Whether the balance lines in this account section belong to one account:
 * every opening balance printed is the same amount, as is every closing
 * balance, and no balance line lists several amounts (as an all-accounts
 * summary does). Null when no balance line is printed. Catches two accounts
 * that weren't split apart, so they can never be reconciled together.
 */
function balancesOfOneAccount(lines: TextLine[]): boolean | null {
  const opening = new Set<Cents>();
  const closing = new Set<Cents>();
  let several = false;
  for (const line of lines) {
    const { rest } = leadingDates(line.pieces);
    const { amounts, rest: middle } = trailingAmounts(rest);
    const label = middle.map((p) => p.text).join(' ').trim();
    const isOpening = OPENING_LABEL.test(label);
    if ((!isOpening && !CLOSING_LABEL.test(label)) || amounts.length === 0) continue;
    if (amounts.length > 1 && !(amounts.length === 2 && leadingDates(line.pieces).dates.length > 0)) several = true;
    const amount = readAmount(amounts[amounts.length - 1]!.text);
    if (amount) (isOpening ? opening : closing).add(signed(amount));
  }
  if (opening.size + closing.size === 0 && !several) return null;
  return !several && opening.size <= 1 && closing.size <= 1;
}

function validate(
  transactions: ParsedTransaction[],
  facts: {
    openingBalanceCents: Cents | undefined;
    closingBalanceCents: Cents | undefined;
    isCard: boolean;
    unreadLines: number[];
    sectionTotals: SectionTotal[];
    oneAccount: boolean | null;
    dailyBalancesAgree: boolean | null;
    hasDailyBalances: boolean;
  },
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
    checks.push({ label: BALANCES_ADD_UP, passed: balancesMatch });
  } else {
    checks.push({ label: 'Opening and closing balances printed on the statement', passed: null });
  }
  const runningMismatch = transactions.some((t) => t.flags.includes('running_balance_mismatch'));
  const runningChecked = !facts.isCard && transactions.some((t) => (t as { printedBalance?: Cents }).printedBalance !== undefined);
  checks.push({ label: 'Every row agrees with the running balance', passed: runningMismatch ? false : runningChecked ? true : null });

  // Each section heading that prints a total must equal the rows read under it,
  // so a row missed, counted twice or put in the wrong section is caught.
  let totalsMatch: boolean | null = null;
  if (facts.sectionTotals.length) {
    const rowsKnown = facts.sectionTotals.every((s) => s.rows.every((r) => r.amountCents !== null));
    // A heading's total is printed either net (returns subtracted from purchases) or as the sum of its rows.
    totalsMatch = rowsKnown
      ? facts.sectionTotals.every(
          (s) =>
            Math.abs(sumCents(s.rows.map((r) => r.amountCents!))) === s.printedCents ||
            sumCents(s.rows.map((r) => Math.abs(r.amountCents!))) === s.printedCents,
        )
      : null;
    checks.push({ label: 'Each section adds up to the total printed in its heading', passed: totalsMatch });
  }
  checks.push({ label: ONE_ACCOUNT, passed: facts.oneAccount });
  if (facts.hasDailyBalances) checks.push({ label: DAILY_BALANCES, passed: facts.dailyBalancesAgree });
  checks.push({ label: EVERY_ROW_READ, passed: facts.unreadLines.length === 0 && allKnown });
  return { status: statusOf(checks), checks };
}
