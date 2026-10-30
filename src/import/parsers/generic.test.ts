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

describe('combined statements whose headings name only the account type', () => {
  const RANGE = 'March 1, 2026 through March 31, 2026';
  const build = (checkingHead: string[], savingsHead: string[], savingsEnding = '$5,010.00') =>
    doc([
      'Example Community Bank',
      RANGE,
      ...checkingHead,
      labelled('Beginning balance on March 1, 2026', '$1,000.00'),
      labelled('Ending balance on March 31, 2026', '$900.00'),
      [['Date', 40], ['Description', 90], at('Amount', 480), at('Balance', 560)],
      [['03/05', 40], ['EXAMPLE GROCER', 90], at('-100.00', 480), at('900.00', 560)],
      'page',
      RANGE,
      ...savingsHead,
      labelled('Beginning balance on March 1, 2026', '$5,000.00'),
      labelled('Ending balance on March 31, 2026', savingsEnding),
      [['Date', 40], ['Description', 90], at('Amount', 480), at('Balance', 560)],
      [['03/31', 40], ['INTEREST PAID', 90], at('10.00', 480), at('5,010.00', 560)],
    ]);
  const read = (d: ReturnType<typeof doc>) => {
    const outcome = genericParser.parse(d);
    if (!outcome.ok) throw new Error(outcome.reason);
    return outcome.statements.map((s) => [s.accountKind, s.last4, s.validation.status]);
  };

  it.each([
    ['summary headings, number on a later line', ['Checking Summary', 'Account number 000012344821'], ['Savings Summary', 'Account number 000012347310']],
    ['summary headings with the number on them', ['Everyday Checking Summary  Account XXXXXX4821'], ['Everyday Savings Summary  Account XXXXXX7310']],
    ['name heading, number on the next line', ['Everyday Checking', 'Account number XXXXXX4821'], ['Everyday Savings', 'Account number XXXXXX7310']],
    ['summary heading, then the name and number', ['CHECKING SUMMARY', 'Everyday Checking', 'Account number XXXXXX4821'], ['SAVINGS SUMMARY', 'Everyday Savings', 'Account number XXXXXX7310']],
    ['name and number in separate pieces', ['Everyday Checking   XXXXXX4821'], ['Everyday Savings   XXXXXX7310']],
  ])('%s: two accounts, each verified', (_name, checkingHead, savingsHead) => {
    expect(read(build(checkingHead, savingsHead))).toEqual([
      ['checking', '4821', 'verified'],
      ['savings', '7310', 'verified'],
    ]);
  });

  it.each([
    ['"CHECKING SUMMARY" with no number', ['CHECKING SUMMARY'], ['SAVINGS SUMMARY']],
    ['"Checking Account Summary" with no number', ['Checking Account Summary'], ['Savings Account Summary']],
  ])('%s: still two accounts, each verified, with no number to match', (_name, checkingHead, savingsHead) => {
    expect(read(build(checkingHead, savingsHead))).toEqual([
      ['checking', undefined, 'verified'],
      ['savings', undefined, 'verified'],
    ]);
  });

  it('the number printed after the balances is found within each section', () => {
    const section = (heading: string, opening: string, ending: string, number: string, row: Piece[]): (string | Piece[])[] => [
      heading,
      labelled('Beginning balance on March 1, 2026', opening),
      labelled('Ending balance on March 31, 2026', ending),
      `Account number: XXXXXXXX${number}`,
      [['Date', 40], ['Description', 90], at('Amount', 480), at('Balance', 560)],
      row,
    ];
    const d = doc([
      'Example Community Bank',
      RANGE,
      ...section('CHECKING SUMMARY', '$1,000.00', '$900.00', '4821', [['03/05', 40], ['EXAMPLE GROCER', 90], at('-100.00', 480), at('900.00', 560)]),
      ...section('SAVINGS SUMMARY', '$5,000.00', '$5,010.00', '7310', [['03/31', 40], ['INTEREST PAID', 90], at('10.00', 480), at('5,010.00', 560)]),
    ]);
    expect(read(d)).toEqual([
      ['checking', '4821', 'verified'],
      ['savings', '7310', 'verified'],
    ]);
  });

  it('two accounts that could not be split are failed, never reconciled together', () => {
    const d = build(['Details for your Primary Checking'], ['Details for your Primary Savings']);
    const outcome = genericParser.parse(d);
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.statements).toHaveLength(1);
    const s = outcome.statements[0]!;
    expect(s.validation.checks).toContainEqual({ label: "Only one account's balances on this statement", passed: false });
    expect(s.validation.status).toBe('failed');
  });

  it('an all-accounts balance line listing several amounts in one account is failed', () => {
    const s = one([
      'Everyday Checking   Account number XXXXXX4821',
      'Statement period 03/01/2026 to 03/31/2026',
      [['Beginning balance', 40], at('1,000.00', 480), at('5,000.00', 560)],
      labelled('Ending balance', '900.00'),
      BANK_HEADER,
      out('03/05', 'EXAMPLE GROCER', '100.00', '900.00'),
    ]);
    expect(s.validation.status).toBe('failed');
  });

  it('when no period is found, the account sections found are still reported', () => {
    const d = doc([
      'Example Community Bank',
      'CHECKING SUMMARY',
      labelled('Beginning balance', '$1,000.00'),
      labelled('Ending balance', '$900.00'),
      'SAVINGS SUMMARY',
      labelled('Beginning balance', '$5,000.00'),
      labelled('Ending balance', '$5,010.00'),
    ]);
    expect(genericParser.parse(d)).toMatchObject({ ok: false, reason: 'no_period', sections: [{ kind: 'checking', line: 1 }, { kind: 'savings', line: 4 }] });
  });
});

describe('"verified" only when the balances were actually reconciled', () => {
  const statement = (balances: Piece[][], rows: Piece[][]) =>
    one([
      'Everyday Checking   Account number XXXXXX4821',
      'Statement period 03/01/2026 to 03/31/2026',
      ...balances,
      [['Date', 40], ['Description', 90], at('Amount', 480)],
      ...rows,
    ]);
  const row = (text: string, amount: string): Piece[] => [['03/02', 40], [text, 90], at(amount, 480)];

  it('no printed balances: unverified, even though every row was read', () => {
    const s = statement([], [row('EXAMPLE GROCER', '-100.00')]);
    expect(s.unreadLines).toEqual([]);
    expect(s.validation.status).toBe('unverified');
  });

  it('only an opening balance: unverified', () => {
    expect(statement([labelled('Beginning balance', '1,000.00')], [row('EXAMPLE GROCER', '-100.00')]).validation.status).toBe('unverified');
  });

  it('a row whose sign is unknown, so the balances could not be compared: unverified, not partially verified', () => {
    const s = statement([labelled('Beginning balance', '1,000.00'), labelled('Ending balance', '900.00')], [row('EXAMPLE GROCER', '100.00')]);
    expect(s.validation.checks).toContainEqual({ label: 'Opening balance plus activity equals closing balance', passed: null });
    expect(s.validation.status).toBe('unverified');
  });

  it('balances that add up but an unread line: partially verified, never verified', () => {
    const s = statement(
      [labelled('Beginning balance', '1,000.00'), labelled('Ending balance', '900.00')],
      [row('EXAMPLE GROCER', '-100.00'), [['NOTE WITH AN AMOUNT', 90], at('-3.00', 480)]],
    );
    expect(s.validation.status).toBe('partially_verified');
  });

  it('a stray row outside every account section: never verified', () => {
    const outcome = genericParser.parse(
      doc([
        'Statement Period: 03/01/2026 through 03/31/2026',
        [['03/02', 40], ['STRAY ROW', 90], at('5.00', 400)],
        'Everyday Checking - Account ending in 4821',
        labelled('Beginning Balance', '1,000.00'),
        labelled('Ending Balance', '900.00'),
        [['Date', 40], ['Description', 90], at('Amount', 480)],
        [['03/05', 40], ['EXAMPLE GROCER', 90], at('-100.00', 480)],
        'Everyday Savings - Account ending in 7310',
        labelled('Beginning Balance', '10.00'),
        labelled('Ending Balance', '10.00'),
      ]),
    );
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.statements[0]!.validation.status).not.toBe('verified');
  });
});

describe('money in or out: evidence the statement prints, read in more layouts', () => {
  const top = (ending = '1,150.00'): (string | Piece[])[] => [
    'Everyday Checking   Account number XXXXXX4821',
    'Statement period 03/01/2026 to 03/31/2026',
    labelled('Beginning balance', '1,000.00'),
    labelled('Ending balance', ending),
  ];
  const AMOUNT_HEADER: Piece[] = [['Date', 40], ['Description', 90], at('Amount', 480)];
  const BALANCE_HEADER: Piece[] = [['Date', 40], ['Description', 90], at('Amount', 480), at('Balance', 560)];
  const row = (date: string, text: string, amount: string, balance?: string): Piece[] =>
    [[date, 40], [text, 90], at(amount, 480), ...(balance ? [at(balance, 560)] : [])] as Piece[];

  it('a section heading printed above its own column header gives the rows their direction', () => {
    const s = one([
      ...top(),
      'DEPOSITS AND ADDITIONS',
      AMOUNT_HEADER,
      row('03/01', 'PAYROLL EXAMPLE EMPLOYER', '250.00'),
      [['Total Deposits and Additions', 40], at('$250.00', 480)],
      'ELECTRONIC WITHDRAWALS',
      AMOUNT_HEADER,
      row('03/05', 'EXAMPLE UTILITY CO', '100.00'),
      [['Total Electronic Withdrawals', 40], at('$100.00', 480)],
    ]);
    expect(amounts(s)).toEqual([25_000, -10_000]);
    expect(s.signSources).toEqual({ section: 2 });
    expect(s.validation.status).toBe('verified');
  });

  it('a column header with no heading just above it starts with no section', () => {
    const s = one([...top(), 'DEPOSITS AND ADDITIONS', [['Daily summary', 40]], AMOUNT_HEADER, row('03/01', 'PAYROLL EXAMPLE EMPLOYER', '250.00')]);
    expect(amounts(s)).toEqual([null]);
  });

  it.each([
    ['Withdrawals/Debits', 'Deposits/Credits'],
    ['Checks & Debits', 'Deposits & Credits'],
    ['Debits ($)', 'Credits ($)'],
    ['Debit Amount', 'Credit Amount'],
    ['Withdrawals (-)', 'Deposits (+)'],
  ])('combined or decorated column labels: "%s" and "%s"', (debit, credit) => {
    const s = one([
      ...top(),
      [['Date', 40], ['Description', 90], at(debit, 400), at(credit, 480)],
      [['03/01', 40], ['PAYROLL EXAMPLE EMPLOYER', 90], at('250.00', 480)],
      [['03/05', 40], ['EXAMPLE UTILITY CO', 90], at('100.00', 400)],
    ]);
    expect(amounts(s)).toEqual([25_000, -10_000]);
    expect(s.signSources).toEqual({ column: 2 });
    expect(s.validation.status).toBe('verified');
  });

  it('a label naming both directions is not a direction', () => {
    const s = one([
      ...top(),
      [['Date', 40], ['Description', 90], at('Debits/Credits', 480)],
      [['03/01', 40], ['PAYROLL EXAMPLE EMPLOYER', 90], at('250.00', 480)],
    ]);
    expect(amounts(s)).toEqual([null]);
  });

  it('a minus sign printed apart from its amount', () => {
    const s = one([...top('900.00'), AMOUNT_HEADER, [['03/05', 40], ['EXAMPLE UTILITY CO', 90], ['-', 440], at('100.00', 480)]]);
    expect(amounts(s)).toEqual([-10_000]);
    expect(s.transactions[0]!.description).toBe('EXAMPLE UTILITY CO');
  });

  it('a single Amount column that marks money out with a minus: unmarked amounts are money in', () => {
    const s = one([...top(), AMOUNT_HEADER, row('03/01', 'PAYROLL EXAMPLE EMPLOYER', '250.00'), row('03/05', 'EXAMPLE UTILITY CO', '-100.00')]);
    expect(amounts(s)).toEqual([25_000, -10_000]);
    expect(s.signSources).toEqual({ marker: 1, signed_column: 1 });
    expect(s.validation.status).toBe('verified');
  });

  it('…but not when the column never prints a minus: those rows stay unknown', () => {
    const s = one([...top(), AMOUNT_HEADER, row('03/01', 'PAYROLL EXAMPLE EMPLOYER', '250.00'), row('03/05', 'EXAMPLE UTILITY CO', '100.00')]);
    expect(amounts(s)).toEqual([null, null]);
    expect(s.validation.status).toBe('unverified');
  });

  it('…and never on a card, where an unmarked amount follows the card rule', () => {
    const s = one([...cardTop('0.00', '40.00'), CARD_HEADER, cardRow('02/20', 'EXAMPLE GROCER', '50.00'), cardRow('02/22', 'EXAMPLE RETURN', '-10.00')]);
    expect(amounts(s)).toEqual([-5_000, 1_000]);
  });

  it('a running balance printed only on the last row of each day settles every row when only one choice fits', () => {
    const s = one([
      ...top(),
      BALANCE_HEADER,
      row('03/01', 'PAYROLL EXAMPLE EMPLOYER', '250.00'),
      row('03/01', 'EXAMPLE COFFEE', '10.00', '1,240.00'),
      row('03/05', 'EXAMPLE UTILITY CO', '90.00', '1,150.00'),
    ]);
    expect(amounts(s)).toEqual([25_000, -1_000, -9_000]);
    expect(s.signSources).toEqual({ running_balance: 3 });
    expect(s.validation.status).toBe('verified');
  });

  it('…but leaves them unknown when more than one choice fits', () => {
    // +10 -10 and -10 +10 both leave the balance unchanged.
    const s = one([
      ...top('1,000.00'),
      BALANCE_HEADER,
      row('03/01', 'EXAMPLE REFUND', '10.00'),
      row('03/01', 'EXAMPLE COFFEE', '10.00', '1,000.00'),
    ]);
    expect(amounts(s)).toEqual([null, null]);
    expect(s.validation.status).toBe('unverified');
  });

  it('…and flags the row when no choice fits the printed balance', () => {
    const s = one([
      ...top('1,237.00'),
      BALANCE_HEADER,
      row('03/01', 'PAYROLL EXAMPLE EMPLOYER', '250.00'),
      row('03/01', 'EXAMPLE COFFEE', '10.00', '1,237.00'),
    ]);
    expect(s.transactions[1]!.flags).toContain('running_balance_mismatch');
    expect(s.validation.status).toBe('failed');
  });
});

describe('lines that are not transactions are recognised, listed and never counted', () => {
  const statement = (extra: (string | Piece[] | 'page')[], ending = '850.00', where: 'middle' | 'end' = 'end') => {
    const head: (string | Piece[] | 'page')[] = [
      'Everyday Checking   Account number XXXXXX4821',
      'Statement period 03/01/2026 to 03/31/2026',
      labelled('Beginning balance', '1,000.00'),
      labelled('Ending balance', ending),
      BANK_HEADER,
      out('03/02', 'EXAMPLE GROCER', '100.00', '900.00'),
    ];
    const last = [out('03/20', 'EXAMPLE PHARMACY', '50.00', '850.00')];
    return one(where === 'middle' ? [...head, ...extra, ...last] : [...head, ...last, ...extra]);
  };
  const kinds = (s: ParsedStatement) => s.setAside.map((a) => a.kind);

  it.each([
    ['a dated page footer', ['page', [['03/31/2026', 40], ['Page 2 of 3', 300]]], 'page_header_or_footer'],
    ['the numeric period repeated atop a page', ['page', [['03/01/2026 - 03/31/2026', 40]]], 'page_header_or_footer'],
    ['an average daily balance', [labelled('Average daily balance', '912.50')], 'balance_summary'],
    ['a minimum balance', [labelled('Minimum balance this period', '850.00')], 'balance_summary'],
    ['interest earned this period', [labelled('Interest earned this period', '1.23')], 'interest_or_fee_summary'],
    ['interest paid this year', [labelled('Interest paid this year', '4.56')], 'interest_or_fee_summary'],
    ['a fee table of zeros', [[['Overdraft fees', 40], at('$0.00', 400), at('$0.00', 480)]], 'zero_amounts'],
  ] as [string, (string | Piece[] | 'page')[], string][])('%s', (_name, extra, kind) => {
    const s = statement(extra, '850.00', extra[0] === 'page' ? 'middle' : 'end');
    expect(s.unreadLines).toEqual([]);
    expect(kinds(s)).toEqual([kind]);
    expect(s.transactions).toHaveLength(2);
    expect(s.validation.status).toBe('verified');
  });

  it('a page footer is never joined onto the last row\'s description', () => {
    const s = statement([[['Page 1 of 2', 300]]]);
    expect(s.transactions[1]!.description).toBe('EXAMPLE PHARMACY');
    expect(kinds(s)).toEqual(['page_header_or_footer']);
  });

  it('a daily balance table is set aside and checked against the transactions', () => {
    const s = statement(['DAILY ENDING BALANCE', [['Date', 40], at('Balance', 200)], [['03/02', 40], at('900.00', 200)], [['03/20', 40], at('850.00', 200)]]);
    expect(kinds(s)).toEqual(['daily_balance', 'daily_balance']);
    expect(s.validation.checks).toContainEqual({ label: 'Every daily balance printed agrees with the transactions', passed: true });
    expect(s.validation.status).toBe('verified');
  });

  it('a daily balance table with several days on a line is never read as a transaction', () => {
    const s = statement(['Daily Balance Summary', [['03/02', 40], at('900.00', 150), ['03/20', 200], at('850.00', 310)]]);
    expect(s.transactions).toHaveLength(2);
    expect(kinds(s)).toEqual(['daily_balance']);
    expect(s.validation.status).toBe('verified');
  });

  it('a transaction table after a daily balance table is read normally', () => {
    const s = one([
      'Everyday Checking   Account number XXXXXX4821',
      'Statement period 03/01/2026 to 03/31/2026',
      labelled('Beginning balance', '1,000.00'),
      labelled('Ending balance', '850.00'),
      BANK_HEADER,
      out('03/02', 'EXAMPLE GROCER', '100.00', '900.00'),
      'DAILY ENDING BALANCE',
      [['Date', 40], at('Balance', 200)],
      [['03/02', 40], at('900.00', 200)],
      'page',
      BANK_HEADER,
      out('03/20', 'EXAMPLE PHARMACY', '50.00', '850.00'),
    ]);
    expect(amounts(s)).toEqual([-10_000, -5_000]);
    expect(s.validation.status).toBe('verified');
  });

  it('a daily balance that disagrees with the transactions fails the statement', () => {
    const s = statement(['DAILY ENDING BALANCE', [['03/02', 40], at('900.00', 150), ['03/20', 200], at('860.00', 310)]]);
    expect(s.validation.checks).toContainEqual({ label: 'Every daily balance printed agrees with the transactions', passed: false });
    expect(s.validation.status).toBe('failed');
  });

  it('an interest summary is never added as an undated interest charge', () => {
    const s = one([
      ...cardTop('500.00', '550.00'),
      CARD_HEADER,
      cardRow('02/22', 'EXAMPLE GROCER', '50.00'),
      [['Interest charged this period', 160], at('12.34', 560)],
    ]);
    expect(s.transactions).toHaveLength(1);
    expect(s.validation.status).toBe('verified');
  });

  it.each([
    ['a section summary with an item count', [labelled('Deposits and other credits 3 items', '5,700.00')], 'section_summary'],
    ['a cash back summary', [labelled('Cash back earned this period', '$5.21')], 'rewards_summary'],
    ['a rewards balance', [labelled('Rewards balance', '$45.10')], 'rewards_summary'],
    ['a minimum payment warning row', [[['Only the minimum payment', 40], ['14 years', 300], at('$7,845.10', 560)]], 'explanatory_text'],
    ['an explanatory sentence ending in an amount', [labelled('If you are late, you may have to pay a late fee of up to', '$41.00')], 'explanatory_text'],
  ] as [string, Piece[][], string][])('%s is recognised as not a transaction', (_name, extra, kind) => {
    const s = statement(extra);
    expect(s.unreadLines).toEqual([]);
    expect(kinds(s)).toEqual([kind]);
    expect(s.transactions).toHaveLength(2);
    expect(s.validation.status).toBe('verified');
  });

  it('lines that could be transactions stay unread, with where they sit', () => {
    const s = statement([[['Check 1042', 40], ['03/27', 120], at('300.00', 400)], labelled('Monthly service charge', '12.00')]);
    expect(s.unreadReasons).toEqual(['no_date', 'no_date']);
    expect(s.unreadContext).toEqual([
      { amountColumns: ['debit'], position: 'after_rows', section: 'none' },
      { amountColumns: ['balance'], position: 'after_rows', section: 'none' },
    ]);
    expect(s.validation.status).toBe('partially_verified');
    // The person sees exactly what was left out, on this Mac.
    expect(s.excludedLines).toEqual(['Check 1042 03/27 300.00', 'Monthly service charge 12.00']);
  });

  it('a statement with excluded lines is never verified, and never imported as such', () => {
    const s = statement([labelled('Monthly service charge', '12.00')]);
    expect(s.validation.checks).toContainEqual({ label: 'Every row was read', passed: false });
    expect(s.validation.status).not.toBe('verified');
  });

  it('a transaction wrongly taken for a summary would fail the balance check, not pass', () => {
    // The 50.00 withdrawal is printed as an "average balance" style line: set aside, so the balances can't add up.
    const s = one([
      'Everyday Checking   Account number XXXXXX4821',
      'Statement period 03/01/2026 to 03/31/2026',
      labelled('Beginning balance', '1,000.00'),
      labelled('Ending balance', '850.00'),
      BANK_HEADER,
      out('03/02', 'EXAMPLE GROCER', '100.00', '900.00'),
      [['Average daily balance', 40], at('50.00', 400)],
    ]);
    expect(s.validation.status).toBe('failed');
  });
});
