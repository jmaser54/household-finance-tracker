import type { Cents } from '../../domain/money';
import type { AccountKind, IsoDate, StatementValidation } from '../../domain/types';
import type { PdfText } from '../pdfText';

/** Why a row needs a closer look. Fixed codes only; never data. */
export type RowFlag =
  /** Couldn't tell whether money came in or went out; the row is not added. */
  | 'ambiguous_sign'
  /** Posted date falls outside the statement period. */
  | 'date_outside_period'
  /** The statement's running balance disagrees with this row. */
  | 'running_balance_mismatch';

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
  validation: StatementValidation;
}

export type ParseFailure =
  /** No statement period could be found, so dates cannot be placed. */
  | 'no_period'
  /** No transaction table was recognised. */
  | 'no_transactions';

export type ParseOutcome = { ok: true; statement: ParsedStatement; score: number } | { ok: false; reason: ParseFailure };

/** Statement layouts are read by modular parsers behind this interface. */
export interface StatementParser {
  id: string;
  version: number;
  parse(text: PdfText): ParseOutcome;
}
