/**
 * Which account a statement (or each part of a combined statement) is for:
 * its type and the last four digits of its number. Only the last four digits
 * are ever kept (PROJECT_PRINCIPLES.md §5).
 *
 * A combined statement (e.g. checking and savings in one PDF) is split into
 * one section per account, each read and reconciled on its own, so that no
 * line or balance of one account can affect another's.
 */
import type { AccountKind } from '../../domain/types';
import type { TextLine } from '../pdfText';

/** Lines about a debit, ATM or check card belong to a bank account, not a credit card. */
const BANK_CARD_MENTION = /\b(debit|atm|check|cash|bank|visa debit|mastercard debit) card\b/i;
/** Wording only a credit-card statement prints. */
const CARD_STATEMENT = /\b(minimum payment|credit limit|available credit|credit line|payment due date|credit card statement|cash advance limit)\b/i;
const WEAK_CARD = /\b(credit card|card ending|card number)\b/i;

const AMOUNT_TOKEN = /\(?[-+]?\$?\s?-?[\d,]*\d\.\d{2}\)?(?:\s?-|\s?CR|\s?DR)?(?=\s|$)/i;
const LEADING_DATE = /^\s*(\d{1,2}\/\d{1,2}(\/\d{2,4})?|\d{4}-\d{2}-\d{2})\b/;
const BALANCE_LINE = /\b(beginning|opening|previous|starting|ending|closing|new) balance\b/i;
const BANK_KIND = /\b(checking|savings|money market)\b/i;
/** Words that make a line a transaction description rather than an account heading. */
const TRANSACTION_WORDS = /\b(transfer|xfer|to|from|payment|pmt|deposit|withdrawal|online|mobile|interest paid)\b/i;

/** The lines that describe the account, with bank-card mentions removed. */
function withoutBankCardLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !BANK_CARD_MENTION.test(line))
    .join('\n');
}

/** Institution names, not account types: "Example Savings Bank", "… Savings and Loan". */
const INSTITUTION = /\bsavings (bank|and loan|& loan|institution)\b|\bsavings association\b/gi;

function bankKind(text: string): AccountKind | undefined {
  const t = text.replace(INSTITUTION, ' ');
  const savings = /\b(savings|money market)\b/i.test(t);
  const checking = /\bchecking\b/i.test(t);
  if (savings && !checking) return 'savings';
  if (checking && !savings) return 'checking';
  return undefined;
}

export function findAccountKind(text: string): AccountKind | undefined {
  const t = withoutBankCardLines(text);
  if (CARD_STATEMENT.test(t)) return 'credit_card';
  // The line naming the account number says which account this is; else the whole text, if unambiguous.
  const numbered = t.split('\n').filter((line) => findLast4(line) !== undefined);
  const kind = bankKind(numbered.join('\n')) ?? bankKind(t);
  if (kind) return kind;
  // Both named and nothing says which: left unknown for the person to choose, not guessed.
  if (/\b(savings|money market|checking)\b/i.test(t.replace(INSTITUTION, ' '))) return undefined;
  if (WEAK_CARD.test(t)) return 'credit_card';
  return undefined;
}

/** Only the last four digits of an account or card number are ever kept; an account number is preferred to a card's. */
export function findLast4(text: string, kind?: AccountKind): string | undefined {
  const t = kind === 'credit_card' ? text : withoutBankCardLines(text);
  const patterns = [
    /\baccount\b[^\n\d]{0,30}?(?:ending in|ending|number|no\.?|#)\s*:?\s*(?:[x*•.\-\s]*?)(\d[\d\s-]{2,})/i,
    /[x*•]{3,}[\s-]*(\d{4})\b/i,
    // "Primary Account: 000000004821"
    /\baccount\s*:\s*(?:[x*•.\-\s]*?)(\d[\d\s-]{3,})/i,
    /\bcard\b[^\n\d]{0,30}?(?:ending in|ending|number|no\.?|#)\s*:?\s*(?:[x*•.\-\s]*?)(\d[\d\s-]{2,})/i,
  ];
  for (const pattern of patterns) {
    const digits = pattern.exec(t)?.[1]?.replace(/\D/g, '');
    if (digits && digits.length >= 4) return digits.slice(-4);
  }
  return undefined;
}

export interface AccountSection {
  kind?: AccountKind;
  last4?: string;
  /** Indexes into PdfText.lines, in order. */
  lines: number[];
}

/**
 * A heading that names only the account type, with no number: "Checking
 * Summary", "SAVINGS ACCOUNT ACTIVITY", "Everyday Checking Account". Up to
 * three words of name before the type; nothing but a section word after it.
 */
const TYPE_HEADING =
  /^(?:[a-z][a-z'&-]*\s+){0,3}(checking|savings|money market)(?:\s+account)?(?:\s+(?:summary|activity|details|transactions|transaction history|statement))?(?:\s*\(continued\))?$/i;

/**
 * An account heading: a line naming a checking or savings account, with no
 * date or amount on it, so neither a transaction row nor a line of an "all
 * accounts" summary table. Its number is on the line or the next one, if
 * printed there; a heading naming only the type has none (`last4` undefined).
 */
function headingAt(lines: TextLine[], i: number): { kind: AccountKind; last4?: string } | null {
  const text = lines[i]!.text;
  if (text.length > 120 || LEADING_DATE.test(text) || AMOUNT_TOKEN.test(text)) return null;
  const match = BANK_KIND.exec(text);
  const kind = match?.[1]?.toLowerCase();
  if (!kind || TRANSACTION_WORDS.test(text) || BANK_CARD_MENTION.test(text)) return null;
  // A heading starts with the account's name ("Everyday Checking - …"), not a note
  // that mentions another account ("Overdraft protection: Savings ending 7310").
  const before = text.slice(0, match!.index);
  if (before.includes(':') || before.trim().split(/\s+/).filter(Boolean).length > 3) return null;
  let last4 = findLast4(text);
  const next = lines[i + 1];
  if (!last4 && next && !LEADING_DATE.test(next.text) && !AMOUNT_TOKEN.test(next.text) && !BANK_KIND.test(next.text)) {
    last4 = findLast4(next.text);
  }
  const type: AccountKind = kind === 'checking' ? 'checking' : 'savings';
  if (last4) return { kind: type, last4 };
  return TYPE_HEADING.test(text.trim()) ? { kind: type } : null;
}

/**
 * Splits a statement into its accounts. A statement for one account (the
 * usual case) is returned whole. Lines before the first account heading are
 * returned as `preamble` (the bank's name, the period, a summary of all
 * accounts) and belong to no account.
 */
export function splitAccounts(lines: TextLine[]): { preamble: number[]; sections: AccountSection[] } {
  const headings: { at: number; kind: AccountKind; last4?: string }[] = [];
  lines.forEach((_, i) => {
    const heading = headingAt(lines, i);
    if (heading) headings.push({ at: i, ...heading });
  });
  // A type-only heading ("Checking Summary") belongs to the one numbered account
  // of that type, if the statement names exactly one; otherwise it stands for
  // its type alone, and its number is looked for inside its section.
  for (const heading of headings) {
    if (heading.last4) continue;
    const numbers = new Set(headings.filter((h) => h.kind === heading.kind && h.last4).map((h) => h.last4));
    if (numbers.size === 1) heading.last4 = [...numbers][0]!;
  }
  const identities = new Set(headings.map((h) => `${h.kind}:${h.last4 ?? ''}`));
  const all = lines.map((_, i) => i);
  if (identities.size < 2) return { preamble: [], sections: [{ lines: all }] };

  // Each heading starts a run of lines; runs for the same account (e.g. "continued" pages) are joined.
  const byIdentity = new Map<string, AccountSection>();
  headings.forEach((heading, n) => {
    const end = headings[n + 1]?.at ?? lines.length;
    const key = `${heading.kind}:${heading.last4 ?? ''}`;
    const section = byIdentity.get(key) ?? { kind: heading.kind, ...(heading.last4 ? { last4: heading.last4 } : {}), lines: [] };
    for (let i = heading.at; i < end; i++) section.lines.push(i);
    byIdentity.set(key, section);
  });
  // Each account of a combined statement prints its own balances. A heading
  // without them (e.g. a mention in a notice) is not an account section; its
  // lines go back to the preamble.
  const hasContent = (section: AccountSection) =>
    section.lines.some((i) => {
      const text = lines[i]!.text;
      return AMOUNT_TOKEN.test(text) && BALANCE_LINE.test(text);
    });
  const sections = [...byIdentity.values()].filter(hasContent);
  if (sections.length < 2) return { preamble: [], sections: [{ lines: all }] };
  const owned = new Set(sections.flatMap((s) => s.lines));
  return { preamble: all.filter((i) => !owned.has(i)), sections };
}
