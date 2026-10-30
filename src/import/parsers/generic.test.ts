// The generic statement reader on SYNTHETIC text layouts: account type and
// number, combined statements, card sections, undated charges, and checks
// that reconciliation can't pass when rows are missed, misread or doubled.
import { describe, expect, it } from 'vitest';
import { genericParser } from './generic';
import { at, doc, type Piece } from './testDoc';
import type { ParsedStatement } from './types';

const statements = (rows: Parameters<typeof doc>[0]): ParsedStatement[] => {
  const outcome = genericParser.parse(doc(rows));
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.statements;
};
const one = (rows: Parameters<typeof doc>[0]) => {
  const all = statements(rows);
  expect(all).toHaveLength(1);
  return all[0]!;
};
const amounts = (s: ParsedStatement) => s.transactions.map((t) => t.amountCents);

// Bank table: Date | Description | Withdrawals | Deposits | Balance
const BANK_HEADER: Piece[] = [['Date', 40], ['Description', 90], at('Withdrawals', 400), at('Deposits', 480), at('Balance', 560)];
const out = (date: string, text: string, amount: string, balance: string): Piece[] => [[date, 40], [text, 90], at(amount, 400), at(balance, 560)];
const inn = (date: string, text: string, amount: string, balance: string): Piece[] => [[date, 40], [text, 90], at(amount, 480), at(balance, 560)];
const labelled = (label: string, amount: string): Piece[] => [[label, 40], at(amount, 560)];

// Card table: Trans Date | Post Date | Description | Amount
const CARD_HEADER: Piece[] = [['Trans Date', 40], ['Post Date', 100], ['Description', 160], at('Amount', 560)];
const cardRow = (date: string, text: string, amount: string): Piece[] => [[date, 40], [date, 100], [text, 160], at(amount, 560)];
const heading = (text: string, total?: string): Piece[] => (total ? [[text, 40], at(total, 560)] : [[text, 40]]);
const cardTop = (previous: string, next: string) => [
  'Example Rewards Card',
  'Account number ending in 9046',
  'Billing cycle 02/14/2026 - 03/13/2026',
  'Minimum Payment Due $25.00   Payment Due Date 04/08/2026',
  labelled('Previous Balance', previous),
  labelled('New Balance', next),
];

describe('account type and number', () => {
  it('a checking statement that mentions a debit card is checking, with the account number, not the card number', () => {
    const s = one([
      'Example Community Bank',
      'Everyday Checking   Account number XXXXXX4821',
      'Statement period 03/01/2026 to 03/31/2026',
      'Your Debit Card ending in 5313 now has contactless payments.',
      labelled('Beginning Balance', '1,000.00'),
      labelled('Ending Balance', '900.00'),
      BANK_HEADER,
      out('03/05', 'DEBIT CARD PURCHASE 5313 EXAMPLE GROCER', '100.00', '900.00'),
    ]);
    expect(s).toMatchObject({ accountKind: 'checking', last4: '4821' });
    expect(s.validation.status).toBe('verified');
  });

  it('a bank whose name contains "Savings" can still issue a checking account', () => {
    const s = one([
      'Example Savings Bank',
      'Basic Checking   Account number ***6617',
      'Statement period 03/01/2026 to 03/31/2026',
      labelled('Beginning Balance', '1,000.00'),
      labelled('Ending Balance', '900.00'),
      BANK_HEADER,
      out('03/05', 'EXAMPLE GROCER', '100.00', '900.00'),
    ]);
    expect(s.accountKind).toBe('checking');
  });

  it('wording only a card statement prints makes it a credit card', () => {
    expect(one([...cardTop('0.00', '50.00'), CARD_HEADER, cardRow('02/20', 'EXAMPLE GROCER', '50.00')]).accountKind).toBe('credit_card');
  });

  it('leaves the type unknown rather than guessing when checking and savings are both named', () => {
    const s = one([
      'Example Bank   Checking and savings accounts are FDIC insured',
      'Statement period 03/01/2026 to 03/31/2026',
      BANK_HEADER,
      out('03/05', 'EXAMPLE GROCER', '100.00', '900.00'),
    ]);
    expect(s.accountKind).toBeUndefined();
  });
});

describe('a combined checking and savings statement', () => {
  const combined = (savingsEnding: string) => [
    'Example Community Bank',
    'Statement Period: 03/01/2026 through 03/31/2026',
    'Your Debit Card ending in 5313 now works at more ATMs.',
    'Account Summary',
    labelled('Everyday Checking XXXXXX4821', '$900.00'),
    labelled('Everyday Savings XXXXXX7310', '$5,010.00'),
    'Everyday Checking - Account ending in 4821',
    labelled('Beginning Balance', '$1,000.00'),
    labelled('Ending Balance', '$900.00'),
    BANK_HEADER,
    out('03/05', 'ONLINE TRANSFER TO SAVINGS XXXX7310', '100.00', '900.00'),
    'page' as const,
    'Everyday Savings - Account ending in 7310',
    labelled('Beginning Balance', '$4,900.00'),
    labelled('Ending Balance', savingsEnding),
    BANK_HEADER,
    inn('03/05', 'ONLINE TRANSFER FROM CHECKING XXXX4821', '100.00', '5,000.00'),
    inn('03/31', 'INTEREST PAID', '10.00', '5,010.00'),
  ];

  it('gives one statement per account, each with its own number, balances and rows', () => {
    const [checking, savings] = statements(combined('$5,010.00'));
    expect(checking).toMatchObject({ accountKind: 'checking', last4: '4821', openingBalanceCents: 100_000, closingBalanceCents: 90_000, section: { index: 0, of: 2 } });
    expect(amounts(checking!)).toEqual([-10_000]);
    expect(checking!.validation.status).toBe('verified');
    expect(savings).toMatchObject({ accountKind: 'savings', last4: '7310', openingBalanceCents: 490_000, closingBalanceCents: 501_000, section: { index: 1, of: 2 } });
    expect(amounts(savings!)).toEqual([10_000, 1_000]);
    expect(savings!.validation.status).toBe('verified');
  });

  it("reconciles each account on its own: one account's mismatch never affects the other", () => {
    const [checking, savings] = statements(combined('$5,020.00'));
    expect(checking!.validation.status).toBe('verified');
    expect(savings!.validation.status).toBe('failed');
  });

  it('joins an account continued on a later page', () => {
    const s = statements([
      'Statement Period: 03/01/2026 through 03/31/2026',
      'Everyday Checking - Account ending in 4821',
      labelled('Beginning Balance', '1,000.00'),
      labelled('Ending Balance', '850.00'),
      BANK_HEADER,
      out('03/05', 'EXAMPLE GROCER', '100.00', '900.00'),
      'page',
      'Everyday Checking - Account ending in 4821 (continued)',
      BANK_HEADER,
      out('03/09', 'EXAMPLE PHARMACY', '50.00', '850.00'),
      'Everyday Savings - Account ending in 7310',
      labelled('Beginning Balance', '10.00'),
      labelled('Ending Balance', '10.00'),
    ]);
    expect(s).toHaveLength(2);
    expect(amounts(s[0]!)).toEqual([-10_000, -5_000]);
    expect(s[0]!.validation.status).toBe('verified');
    expect(s[1]!.transactions).toEqual([]);
  });

  it('never drops a dated row printed outside every account section', () => {
    const [checking] = statements([
      'Statement Period: 03/01/2026 through 03/31/2026',
      [['03/02', 40], ['STRAY ROW', 90], at('5.00', 400)],
      ...combined('$5,010.00').slice(3),
    ]);
    expect(checking!.unreadReasons).toContain('outside_any_account');
    expect(checking!.validation.status).not.toBe('verified');
  });

  it('is not split by a note that mentions another account', () => {
    const s = one([
      'Everyday Checking - Account ending in 4821',
      'Statement period 03/01/2026 to 03/31/2026',
      labelled('Beginning Balance', '1,000.00'),
      labelled('Ending Balance', '900.00'),
      'Overdraft protection: Savings ending 7310',
      BANK_HEADER,
      out('03/05', 'EXAMPLE GROCER', '100.00', '900.00'),
      'Linked Savings Account ending 7310 keeps overdrafts covered.',
    ]);
    expect(s).toMatchObject({ accountKind: 'checking', last4: '4821' });
    expect(s.validation.status).toBe('verified');
  });

  it('is not split by a transfer description that names the other account', () => {
    const s = one([
      'Everyday Checking   Account number XXXXXX4821',
      'Statement period 03/01/2026 to 03/31/2026',
      labelled('Beginning Balance', '1,000.00'),
      labelled('Ending Balance', '900.00'),
      BANK_HEADER,
      out('03/05', 'ONLINE TRANSFER', '100.00', '900.00'),
      [['TO SAVINGS ACCOUNT XXXX7310', 100]],
    ]);
    expect(s.transactions[0]!.description).toBe('ONLINE TRANSFER TO SAVINGS ACCOUNT XXXX7310');
  });
});

describe('card sections', () => {
  it('a heading that prints its total starts the section and is checked against its rows', () => {
    const s = one([
      ...cardTop('500.00', '250.00'),
      CARD_HEADER,
      heading('Payments and Other Credits', '-$300.00'),
      cardRow('02/20', 'PAYMENT THANK YOU', '300.00'),
      heading('Purchases and Adjustments', '$50.00'),
      cardRow('02/22', 'EXAMPLE GROCER', '50.00'),
    ]);
    expect(amounts(s)).toEqual([30_000, -5_000]);
    expect(s.unreadLines).toEqual([]);
    expect(s.signSources).toEqual({ section: 2 });
    expect(s.validation.status).toBe('verified');
    expect(s.validation.checks).toContainEqual({ label: 'Each section adds up to the total printed in its heading', passed: true });
  });

  it('a bare "PAYMENTS" heading makes unmarked payments credits', () => {
    const s = one([
      ...cardTop('500.00', '250.00'),
      CARD_HEADER,
      heading('PAYMENTS'),
      cardRow('02/20', 'AUTOPAY PAYMENT RECEIVED', '300.00'),
      heading('PURCHASES'),
      cardRow('02/22', 'EXAMPLE GROCER', '50.00'),
    ]);
    expect(amounts(s)).toEqual([30_000, -5_000]);
    expect(s.validation.status).toBe('verified');
  });

  it('a "net" purchases total, with returns subtracted, is accepted', () => {
    const s = one([
      ...cardTop('0.00', '40.00'),
      CARD_HEADER,
      heading('Purchases and Adjustments', '$40.00'),
      cardRow('02/22', 'EXAMPLE OUTFITTERS', '50.00'),
      cardRow('02/25', 'EXAMPLE OUTFITTERS RETURN', '-10.00'),
    ]);
    expect(amounts(s)).toEqual([-5_000, 1_000]);
    expect(s.validation.status).toBe('verified');
  });

  it('interest-rate tables and year-to-date totals are not transactions or unread lines', () => {
    const s = one([
      ...cardTop('0.00', '50.00'),
      CARD_HEADER,
      cardRow('02/22', 'EXAMPLE GROCER', '50.00'),
      [['Total fees charged in 2026', 160], at('$0.00', 560)],
      [['Interest charged in 2026', 160], at('$0.00', 560)],
      'Interest Charge Calculation',
      [['Purchases', 40], ['21.49% (v)', 200], at('$1,103.20', 470), at('0.00', 560)],
      [['Cash Advances', 40], ['27.99% (v)', 200], at('$0.00', 470), at('0.00', 560)],
    ]);
    expect(s.transactions).toHaveLength(1);
    expect(s.unreadLines).toEqual([]);
    expect(s.validation.status).toBe('verified');
  });
});

describe('undated interest and fee lines', () => {
  const card = (interestLine: Piece[]) => [
    ...cardTop('500.00', '562.34'),
    CARD_HEADER,
    cardRow('02/22', 'EXAMPLE GROCER', '50.00'),
    heading('Interest Charged'),
    interestLine,
  ];

  it('are added on the closing date, flagged as an assigned date, with the printed description and amount', () => {
    const s = one(card([['INTEREST CHARGE ON PURCHASES', 160], at('12.34', 560)]));
    expect(s.transactions[1]).toMatchObject({
      postedDate: '2026-03-13',
      description: 'INTEREST CHARGE ON PURCHASES',
      amountCents: -1_234,
      flags: ['date_assigned'],
    });
    expect(s.transactions[1]).not.toHaveProperty('transactionDate');
    expect(s.validation.status).toBe('verified');
  });

  it('an undated zero-amount line ("fee waived") is not a transaction', () => {
    const s = one([...cardTop('500.00', '550.00'), CARD_HEADER, cardRow('02/22', 'EXAMPLE GROCER', '50.00'), [['ANNUAL FEE WAIVED', 160], at('0.00', 560)]]);
    expect(s.transactions).toHaveLength(1);
    expect(s.unreadLines).toEqual([]);
  });

  it('an undated line that is not interest or a fee is reported unread, not added', () => {
    const s = one(card([['ADJUSTMENT', 160], at('12.34', 560)]));
    expect(s.transactions).toHaveLength(1);
    expect(s.unreadReasons).toEqual(['no_date']);
    expect(s.validation.status).toBe('failed');
  });
});

describe('reconciliation cannot pass when rows are missed, misread or doubled', () => {
  const bank = (rows: Piece[][], ending = '850.00') =>
    one([
      'Everyday Checking   Account number XXXXXX4821',
      'Statement period 03/01/2026 to 03/31/2026',
      labelled('Beginning Balance', '1,000.00'),
      labelled('Ending Balance', ending),
      [['Date', 40], ['Description', 90], at('Amount', 480)],
      ...rows,
    ]);
  const row = (date: string, text: string, amount: string): Piece[] => [[date, 40], [text, 90], at(amount, 480)];

  it('a statement whose rows add up is verified', () => {
    expect(bank([row('03/02', 'EXAMPLE GROCER', '-100.00'), row('03/09', 'EXAMPLE PHARMACY', '-50.00')]).validation.status).toBe('verified');
  });

  it('a row that could not be read stops verification', () => {
    const s = bank([row('03/02', 'EXAMPLE GROCER', '-100.00'), [['EXAMPLE PHARMACY', 90], at('-50.00', 480)]]);
    expect(s.unreadReasons).toEqual(['no_date']);
    expect(s.validation.status).toBe('failed');
  });

  it('a row printed twice is caught by the balances', () => {
    const s = bank([row('03/02', 'EXAMPLE GROCER', '-100.00'), row('03/02', 'EXAMPLE GROCER', '-100.00'), row('03/09', 'EXAMPLE PHARMACY', '-50.00')]);
    expect(s.validation.status).toBe('failed');
  });

  it('a payment read as a purchase is caught by the section totals even if the balances happened to agree', () => {
    const s = one([
      ...cardTop('500.00', '850.00'),
      CARD_HEADER,
      heading('Payments and Other Credits', '-$300.00'),
      heading('Purchases', '$50.00'),
      cardRow('02/20', 'PAYMENT THANK YOU', '300.00'),
      cardRow('02/22', 'EXAMPLE GROCER', '50.00'),
    ]);
    expect(amounts(s)).toEqual([-30_000, -5_000]);
    expect(s.validation.checks).toContainEqual({ label: 'Opening balance plus activity equals closing balance', passed: true });
    expect(s.validation.status).toBe('failed');
  });

  it('a row with no sign evidence is never counted', () => {
    const s = one([
      'Everyday Checking   Account number XXXXXX4821',
      'Statement period 03/01/2026 to 03/31/2026',
      labelled('Beginning Balance', '1,000.00'),
      labelled('Ending Balance', '900.00'),
      [['Date', 40], ['Description', 90], at('Amount', 480)],
      row('03/02', 'EXAMPLE GROCER', '100.00'),
    ]);
    expect(s.transactions[0]).toMatchObject({ amountCents: null, flags: ['ambiguous_sign'] });
    expect(s.validation.status).not.toBe('verified');
  });
});

describe('balance lines inside the table', () => {
  it('dated "Beginning Balance" and "Ending Balance" rows give the balances and are not transactions', () => {
    const s = one([
      'Basic Checking   Account number ***6617',
      'For the period beginning March 1, 2026 and ending March 31, 2026',
      [['Date', 40], ['Description', 90], at('Amount', 480), at('Balance', 560)],
      [['03/01', 40], ['Beginning Balance', 90], at('1,000.00', 560)],
      [['03/03', 40], ['EXAMPLE GROCER', 90], at('-100.00', 480), at('900.00', 560)],
      [['03/31', 40], ['Ending Balance', 90], at('900.00', 560)],
    ]);
    expect(s).toMatchObject({ openingBalanceCents: 100_000, closingBalanceCents: 90_000 });
    expect(amounts(s)).toEqual([-10_000]);
    expect(s.validation.status).toBe('verified');
    expect(s.validation.checks).toContainEqual({ label: 'Every row agrees with the running balance', passed: true });
  });
});
