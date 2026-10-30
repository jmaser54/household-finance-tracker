import type { Cents } from '../../domain/money';
import type { AccountKind, IsoDate, StatementValidation } from '../../domain/types';
import type { PdfText } from '../pdfText';
import type { PeriodSource } from './period';

/** Why a row needs a closer look. Fixed codes only; never data. */
export type RowFlag =
  /** Couldn't tell whether money came in or went out; the row is not added. */
  | 'ambiguous_sign'
  /** Posted date falls outside the statement period. */
  | 'date_outside_period'
  /** The statement's running balance disagrees with this row. */
  | 'running_balance_mismatch'
  /**
   * No date was printed (e.g. an interest or fee line on a card), so the
   * statement's closing date was used. Always needs review.
   */
  | 'date_assigned';

/** Where a row's money-in/money-out sign came from (masked diagnostics). Fixed codes only. */
export type SignSource =
  | 'column'
  | 'marker'
  | 'section'
  | 'running_balance'
  | 'card_rule'
  /** A single Amount column on a bank statement that marks money out with a minus: unmarked means money in. */
  | 'signed_column';

/** Why a line that looked like a transaction could not be read. Fixed codes only. */
export type UnreadReason =
  | 'no_date'
  | 'no_amount'
  | 'no_description'
  | 'bad_amount'
  | 'date_not_in_period'
  | 'outside_any_account';

export interface ParsedTransaction {
  /** Index of the source line in PdfText.lines, for diagnostics. */
  line: number;
  postedDate: IsoDate;
  transactionDate?: IsoDate;
  /** Exactly as printed (continuation lines joined with a space). */
  description: string;
  /** Household sign: negative = money out or debt up. Null when the sign is unknown. */
  amountCents: Cents | null;
  flags: RowFlag[];
}

export interface ParsedStatement {
  parserId: string;
  parserVersion: number;
  accountKind?: AccountKind;
  /** Only ever the last four digits. */
  last4?: string;
  periodStart: IsoDate;
  periodEnd: IsoDate;
  openingBalanceCents?: Cents;
  closingBalanceCents?: Cents;
  transactions: ParsedTransaction[];
  /** Lines inside the transaction table that look like transactions but could not be read. */
  unreadLines: number[];
  /** Why each of `unreadLines` could not be read, in the same order. */
  unreadReasons: UnreadReason[];
  validation: StatementValidation;
  /** How the period was found. */
  periodSource: PeriodSource;
  /** How many rows took their sign from each kind of evidence. */
  signSources: Partial<Record<SignSource, number>>;
  /**
   * For a combined statement (several accounts in one PDF): which account
   * section of the file this is, counting from 0, and how many there are.
   */
  section?: { index: number; of: number };
}

export type ParseFailure =
  /** No statement period could be found, so dates cannot be placed. */
  | 'no_period'
  /** No transaction table was recognised. */
  | 'no_transactions';

/**
 * One statement per account in the PDF (usually one). `periodCandidates`
 * (line indexes and how many dates each held) is for the masked diagnostics.
 */
export type ParseOutcome =
  | { ok: true; statements: ParsedStatement[]; score: number }
  | {
      ok: false;
      reason: ParseFailure;
      periodCandidates?: { line: number; dates: number }[];
      /** The account sections found (type and first line), even though reading stopped. */
      sections?: { kind?: AccountKind; line: number }[];
    };

/** Statement layouts are read by modular parsers behind this interface. */
export interface StatementParser {
  id: string;
  version: number;
  parse(text: PdfText): ParseOutcome;
}
