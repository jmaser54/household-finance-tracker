// Generates the SYNTHETIC statement PDFs in tests/fixtures/synthetic/.
// Every bank, merchant, account number and amount here is invented. These
// files mimic common statement *layouts* (column tables, signed amounts,
// card sections) so the importer can be tested without real statements.
//
//   node scripts/generate-synthetic-statements.mjs          write the files
//   node scripts/generate-synthetic-statements.mjs --check  fail if out of date
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const OUT = 'tests/fixtures/synthetic';
const FIXED_DATE = new Date('2026-01-01T00:00:00Z');

const money = (cents, { sign = false, cr = false } = {}) => {
  const abs = Math.abs(cents);
  const text = `${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
  if (cr && cents < 0) return `${text} CR`;
  if (sign && cents < 0) return `-${text}`;
  return text;
};

async function makePdf(build) {
  const doc = await PDFDocument.create();
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  doc.setProducer('household-finance-tracker synthetic fixtures');
  doc.setCreator('household-finance-tracker synthetic fixtures');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page;
  const api = {
    newPage() {
      page = doc.addPage([612, 792]);
    },
    text(x, y, value, { size = 9, isBold = false, align = 'left' } = {}) {
      const f = isBold ? bold : font;
      const width = f.widthOfTextAtSize(value, size);
      page.drawText(value, { x: align === 'right' ? x - width : x, y, size, font: f, color: rgb(0.1, 0.1, 0.1) });
    },
    box(x, y, w, h) {
      page.drawRectangle({ x, y, width: w, height: h, color: rgb(0.6, 0.6, 0.6) });
    },
  };
  await build(api);
  return doc.save({ useObjectStreams: false });
}

// ---- Layout 1: checking, Withdrawals / Deposits / Balance columns ----------
function checking({ start, end, openingCents, rows, endingOverrideCents, title = 'Example Community Bank' }) {
  return makePdf((p) => {
    let balance = openingCents;
    const withBalance = rows.map((row) => ({ ...row, balance: (balance += row.cents) }));
    const ending = endingOverrideCents ?? balance;
    const perPage = 8;
    for (let pageIndex = 0; pageIndex * perPage < withBalance.length || pageIndex === 0; pageIndex++) {
      p.newPage();
      let y = 750;
      if (pageIndex === 0) {
        p.text(50, y, title, { size: 14, isBold: true });
        p.text(50, (y -= 18), 'Everyday Checking');
        p.text(50, (y -= 14), 'Account Number: XXXXXX4821');
        p.text(50, (y -= 14), `Statement Period: ${start} - ${end}`);
        p.text(50, (y -= 22), 'Beginning Balance');
        p.text(560, y, `$${money(openingCents)}`, { align: 'right' });
        p.text(50, (y -= 14), 'Ending Balance');
        p.text(560, y, `$${money(ending)}`, { align: 'right' });
        y -= 26;
      } else {
        p.text(50, y, `${title} - Everyday Checking (continued)`, { isBold: true });
        y -= 26;
      }
      p.text(50, y, 'Date', { isBold: true });
      p.text(95, y, 'Description', { isBold: true });
      p.text(400, y, 'Withdrawals', { isBold: true, align: 'right' });
      p.text(480, y, 'Deposits', { isBold: true, align: 'right' });
      p.text(560, y, 'Balance', { isBold: true, align: 'right' });
      y -= 16;
      for (const row of withBalance.slice(pageIndex * perPage, (pageIndex + 1) * perPage)) {
        p.text(50, y, row.date);
        p.text(95, y, row.description);
        p.text(row.cents < 0 ? 400 : 480, y, money(row.cents), { align: 'right' });
        p.text(560, y, money(row.balance), { align: 'right' });
        for (const more of row.more ?? []) {
          y -= 12;
          p.text(105, y, more);
        }
        y -= 14;
      }
      const isLast = (pageIndex + 1) * perPage >= withBalance.length;
      if (isLast) {
        const out = rows.filter((r) => r.cents < 0).reduce((s, r) => s + r.cents, 0);
        const inn = rows.filter((r) => r.cents > 0).reduce((s, r) => s + r.cents, 0);
        p.text(95, (y -= 6), 'Total Withdrawals', { isBold: true });
        p.text(400, y, money(out), { align: 'right' });
        p.text(95, (y -= 14), 'Total Deposits', { isBold: true });
        p.text(480, y, money(inn), { align: 'right' });
      }
      p.text(500, 40, `Page ${pageIndex + 1} of ${Math.ceil(withBalance.length / perPage)}`);
    }
  });
}

const CHECKING_MARCH = [
  { date: '03/01', description: 'PAYROLL EXAMPLE EMPLOYER INC DIRECT DEP', cents: 310_000 },
  { date: '03/02', description: 'EXAMPLE GROCER #12 PURCHASE', cents: -8_423 },
  { date: '03/03', description: 'SAMPLE COFFEE CO', cents: -450 },
  { date: '03/03', description: 'SAMPLE COFFEE CO', cents: -450 },
  { date: '03/05', description: 'ONLINE TRANSFER TO SAVINGS XXXX7310', cents: -50_000 },
  { date: '03/08', description: 'ATM WITHDRAWAL 123 EXAMPLE ST', cents: -10_000 },
  { date: '03/10', description: 'EXAMPLE UTILITY CO AUTOPAY', cents: -12_045, more: ['REF 000123 ACCOUNT SERVICES'] },
  { date: '03/15', description: 'PAYROLL EXAMPLE EMPLOYER INC DIRECT DEP', cents: 310_000 },
  { date: '03/18', description: 'PAYMENT TO EXAMPLE CARD ENDING 5512', cents: -123_456 },
  { date: '03/20', description: 'MOBILE DEPOSIT', cents: 25_000 },
  { date: '03/22', description: 'EXAMPLE PHARMACY', cents: -1_899 },
  { date: '03/28', description: 'MONTHLY SERVICE FEE', cents: -500 },
  { date: '03/31', description: 'EXAMPLE STREAMING', cents: -1_549 },
];

const CHECKING_APRIL = [
  { date: '03/31', description: 'EXAMPLE STREAMING', cents: -1_549 },
  { date: '04/01', description: 'PAYROLL EXAMPLE EMPLOYER INC DIRECT DEP', cents: 310_000 },
  { date: '04/04', description: 'EXAMPLE GROCER #12 PURCHASE', cents: -9_210 },
  { date: '04/15', description: 'PAYROLL EXAMPLE EMPLOYER INC DIRECT DEP', cents: 310_000 },
  { date: '04/20', description: 'EXAMPLE HARDWARE', cents: -4_377 },
];

const marchEnding = 250_000 + CHECKING_MARCH.reduce((s, r) => s + r.cents, 0);

// ---- Layout 2: savings, one signed Amount column + Balance ------------------
function savings() {
  return makePdf((p) => {
    p.newPage();
    let y = 750;
    const opening = 1_000_000;
    const rows = [
      { date: '03/05', description: 'TRANSFER FROM CHECKING XXXX4821', cents: 50_000 },
      { date: '03/31', description: 'INTEREST PAID', cents: 821 },
    ];
    let balance = opening;
    p.text(50, y, 'Example Savings Union', { size: 14, isBold: true });
    p.text(50, (y -= 18), 'High Yield Savings - Account ending in 7310');
    p.text(50, (y -= 14), 'For the period March 1, 2026 through March 31, 2026');
    p.text(50, (y -= 22), 'Opening Balance');
    p.text(560, y, `$${money(opening)}`, { align: 'right' });
    const closing = opening + rows.reduce((s, r) => s + r.cents, 0);
    p.text(50, (y -= 14), 'Closing Balance');
    p.text(560, y, `$${money(closing)}`, { align: 'right' });
    y -= 26;
    p.text(50, y, 'Date', { isBold: true });
    p.text(95, y, 'Transaction', { isBold: true });
    p.text(480, y, 'Amount', { isBold: true, align: 'right' });
    p.text(560, y, 'Balance', { isBold: true, align: 'right' });
    y -= 16;
    for (const row of rows) {
      balance += row.cents;
      p.text(50, y, row.date);
      p.text(95, y, row.description);
      p.text(480, y, (row.cents > 0 ? '+' : '') + money(row.cents, { sign: true }), { align: 'right' });
      p.text(560, y, money(balance), { align: 'right' });
      y -= 14;
    }
  });
}

// ---- Layout 3: credit card, sections, transaction + posting dates ----------
function card({ start, end, previousCents, credits, purchases }) {
  return makePdf((p) => {
    p.newPage();
    let y = 750;
    const charged = purchases.reduce((s, r) => s + r.cents, 0);
    const credited = credits.reduce((s, r) => s + r.cents, 0);
    const newBalance = previousCents - credited + charged;
    p.text(50, y, 'Example Rewards Card', { size: 14, isBold: true });
    p.text(50, (y -= 18), 'Credit Card Statement - Card ending in 5512');
    p.text(50, (y -= 14), `Opening/Closing Date ${start} - ${end}`);
    p.text(50, (y -= 14), 'Credit Limit $5,000.00     Minimum Payment Due $25.00     Payment Due Date 04/25/26');
    p.text(50, (y -= 22), 'Previous Balance');
    p.text(560, y, `$${money(previousCents)}`, { align: 'right' });
    p.text(50, (y -= 14), 'New Balance');
    p.text(560, y, `$${money(newBalance)}`, { align: 'right' });
    y -= 26;
    p.text(50, y, 'Trans Date', { isBold: true });
    p.text(110, y, 'Post Date', { isBold: true });
    p.text(170, y, 'Description', { isBold: true });
    p.text(560, y, 'Amount', { isBold: true, align: 'right' });
    y -= 18;
    const section = (heading, rows, negative) => {
      p.text(50, y, heading, { isBold: true });
      y -= 14;
      for (const row of rows) {
        p.text(50, y, row.trans);
        p.text(110, y, row.post);
        p.text(170, y, row.description);
        p.text(560, y, (negative ? '-' : '') + money(row.cents), { align: 'right' });
        y -= 14;
      }
      y -= 8;
    };
    section('Payments and Other Credits', credits, true);
    section('Purchases', purchases, false);
    p.text(170, y, 'Total fees charged in this period', { isBold: true });
    p.text(560, y, '$0.00', { align: 'right' });
  });
}

// ---- Layout 4: combined checking + savings in one PDF -------------------------
// An "all accounts" summary, a debit-card notice, then one section per account,
// each with its own balances and table; checking continues onto page 2.
function combined() {
  return makePdf((p) => {
    const checkingOpening = 250_000;
    const checkingRows = [
      { date: '03/01', description: 'PAYROLL EXAMPLE EMPLOYER INC DIRECT DEP', cents: 310_000 },
      { date: '03/02', description: 'DEBIT CARD PURCHASE 5313 EXAMPLE GROCER', cents: -8_423 },
      { date: '03/04', description: 'SAMPLE COFFEE CO', cents: -450 },
      { date: '03/05', description: 'ONLINE TRANSFER TO SAVINGS XXXX7310', cents: -50_000 },
      { date: '03/09', description: 'EXAMPLE UTILITY CO AUTOPAY', cents: -12_045 },
      { date: '03/12', description: 'PAYMENT TO EXAMPLE CARD ENDING 5512', cents: -60_000 },
      { date: '03/15', description: 'PAYROLL EXAMPLE EMPLOYER INC DIRECT DEP', cents: 310_000 },
      { date: '03/18', description: 'ATM WITHDRAWAL 123 EXAMPLE ST', cents: -6_000 },
      { date: '03/22', description: 'EXAMPLE PHARMACY', cents: -1_899 },
      { date: '03/30', description: 'EXAMPLE STREAMING', cents: -1_549 },
    ];
    const savingsOpening = 1_000_000;
    const savingsRows = [
      { date: '03/05', description: 'ONLINE TRANSFER FROM CHECKING XXXX4821', cents: 50_000 },
      { date: '03/31', description: 'INTEREST PAID', cents: 821 },
    ];
    const checkingEnding = checkingOpening + checkingRows.reduce((s, r) => s + r.cents, 0);
    const savingsEnding = savingsOpening + savingsRows.reduce((s, r) => s + r.cents, 0);

    const header = (y) => {
      p.text(50, y, 'Date', { isBold: true });
      p.text(95, y, 'Description', { isBold: true });
      p.text(400, y, 'Withdrawals', { isBold: true, align: 'right' });
      p.text(480, y, 'Deposits', { isBold: true, align: 'right' });
      p.text(560, y, 'Balance', { isBold: true, align: 'right' });
      return y - 16;
    };
    let balance;
    const rowsOut = (y, rows) => {
      for (const row of rows) {
        balance += row.cents;
        p.text(50, y, row.date);
        p.text(95, y, row.description);
        p.text(row.cents < 0 ? 400 : 480, y, money(row.cents), { align: 'right' });
        p.text(560, y, money(balance), { align: 'right' });
        y -= 14;
      }
      return y;
    };

    p.newPage();
    let y = 750;
    p.text(50, y, 'Example Community Bank', { size: 14, isBold: true });
    p.text(50, (y -= 18), 'Combined Statement of Accounts');
    p.text(50, (y -= 14), 'Statement Period: 03/01/2026 through 03/31/2026');
    p.text(50, (y -= 14), 'Your Debit Card ending in 5313 now works at more ATMs.');
    p.text(50, (y -= 22), 'Account Summary', { isBold: true });
    p.text(50, (y -= 14), 'Everyday Checking XXXXXX4821');
    p.text(560, y, `$${money(checkingEnding)}`, { align: 'right' });
    p.text(50, (y -= 14), 'Everyday Savings XXXXXX7310');
    p.text(560, y, `$${money(savingsEnding)}`, { align: 'right' });

    p.text(50, (y -= 30), 'Everyday Checking - Account ending in 4821', { isBold: true });
    p.text(50, (y -= 16), 'Beginning Balance');
    p.text(560, y, `$${money(checkingOpening)}`, { align: 'right' });
    p.text(50, (y -= 14), 'Ending Balance');
    p.text(560, y, `$${money(checkingEnding)}`, { align: 'right' });
    y = header(y - 22);
    balance = checkingOpening;
    rowsOut(y, checkingRows.slice(0, 6));
    p.text(500, 40, 'Page 1 of 2');

    p.newPage();
    y = 750;
    p.text(50, y, 'Everyday Checking - Account ending in 4821 (continued)', { isBold: true });
    y = header(y - 22);
    y = rowsOut(y, checkingRows.slice(6));
    p.text(95, (y -= 6), 'Total Withdrawals', { isBold: true });
    p.text(400, y, money(checkingRows.filter((r) => r.cents < 0).reduce((s, r) => s + r.cents, 0)), { align: 'right' });

    p.text(50, (y -= 34), 'Everyday Savings - Account ending in 7310', { isBold: true });
    p.text(50, (y -= 16), 'Beginning Balance');
    p.text(560, y, `$${money(savingsOpening)}`, { align: 'right' });
    p.text(50, (y -= 14), 'Ending Balance');
    p.text(560, y, `$${money(savingsEnding)}`, { align: 'right' });
    y = header(y - 22);
    balance = savingsOpening;
    rowsOut(y, savingsRows);
    p.text(500, 40, 'Page 2 of 2');
  });
}

// ---- Layout 5: card, period from closing date + days in cycle ---------------
// Section headings that print their totals, unmarked payments, an interest line
// with no date, an interest-rate table and year-to-date totals.
function cardWithTotals() {
  return makePdf((p) => {
    const previous = 131_250;
    const credits = [{ trans: '03/20', post: '03/20', description: 'PAYMENT THANK YOU', cents: 125_000 }];
    const purchases = [
      { trans: '03/16', post: '03/17', description: 'EXAMPLE GROCER', cents: 18_240 },
      { trans: '03/29', post: '03/30', description: 'EXAMPLE HARDWARE', cents: 9_500 },
      { trans: '04/02', post: '04/03', description: 'EXAMPLE OUTFITTERS RETURN', cents: -3_500 },
    ];
    const interest = 1_427;
    const purchaseTotal = purchases.reduce((s, r) => s + r.cents, 0); // net of the return, as printed
    const newBalance = previous - 125_000 + purchases.reduce((s, r) => s + r.cents, 0) + interest;
    p.newPage();
    let y = 750;
    p.text(50, y, 'Example Rewards Card', { size: 14, isBold: true });
    p.text(50, (y -= 18), 'Account number ending in 9046');
    p.text(50, (y -= 14), 'Statement Closing Date 04/13/2026');
    p.text(300, y, 'Days in Billing Cycle 29');
    p.text(50, (y -= 14), 'Payment Due Date 05/08/2026');
    p.text(300, y, 'Minimum Payment Due $35.00');
    p.text(50, (y -= 14), 'Credit Limit $8,000.00');
    p.text(50, (y -= 22), 'Previous Balance');
    p.text(560, y, `$${money(previous)}`, { align: 'right' });
    p.text(50, (y -= 14), 'New Balance');
    p.text(560, y, `$${money(newBalance)}`, { align: 'right' });
    y -= 26;
    p.text(50, y, 'Trans Date', { isBold: true });
    p.text(110, y, 'Post Date', { isBold: true });
    p.text(170, y, 'Description', { isBold: true });
    p.text(560, y, 'Amount', { isBold: true, align: 'right' });
    y -= 18;
    p.text(50, y, 'Payments and Other Credits', { isBold: true });
    p.text(560, y, `-$${money(125_000)}`, { align: 'right' });
    for (const row of credits) {
      y -= 14;
      p.text(50, y, row.trans);
      p.text(110, y, row.post);
      p.text(170, y, row.description);
      p.text(560, y, money(row.cents), { align: 'right' });
    }
    y -= 22;
    p.text(50, y, 'Purchases and Adjustments', { isBold: true });
    p.text(560, y, `$${money(purchaseTotal)}`, { align: 'right' });
    for (const row of purchases) {
      y -= 14;
      p.text(50, y, row.trans);
      p.text(110, y, row.post);
      p.text(170, y, row.description);
      p.text(560, y, money(row.cents, { sign: true }), { align: 'right' });
    }
    y -= 22;
    p.text(50, y, 'Fees Charged', { isBold: true });
    p.text(560, y, '$0.00', { align: 'right' });
    y -= 22;
    p.text(50, y, 'Interest Charged', { isBold: true });
    p.text(560, y, `$${money(interest)}`, { align: 'right' });
    p.text(170, (y -= 14), 'INTEREST CHARGE ON PURCHASES');
    p.text(560, y, money(interest), { align: 'right' });
    y -= 22;
    p.text(170, y, 'Total fees charged in 2026', { isBold: true });
    p.text(560, y, '$0.00', { align: 'right' });
    p.text(170, (y -= 14), 'Total interest charged in 2026', { isBold: true });
    p.text(560, y, `$${money(interest)}`, { align: 'right' });
    y -= 26;
    p.text(50, y, 'Interest Charge Calculation', { isBold: true });
    p.text(50, (y -= 14), 'Type of Balance');
    p.text(200, y, 'Annual Percentage Rate (APR)');
    p.text(470, y, 'Balance Subject to Interest Rate');
    p.text(50, (y -= 14), 'Purchases');
    p.text(200, y, '21.49% (v)');
    p.text(470, y, '$1,103.20', { align: 'right' });
    p.text(560, y, money(interest), { align: 'right' });
    p.text(50, (y -= 14), 'Cash Advances');
    p.text(200, y, '27.99% (v)');
    p.text(470, y, '$0.00', { align: 'right' });
    p.text(560, y, '0.00', { align: 'right' });
  });
}

// ---- Layout 6: card, period label and dates on separate lines, bare headings --
function cardBareHeadings() {
  return makePdf((p) => {
    const previous = 40_000;
    const payment = 40_000;
    const purchases = [
      { date: '03/18', description: 'SAMPLE COFFEE CO', cents: 650 },
      { date: '04/01', description: 'EXAMPLE BOOKSTORE', cents: 2_399 },
    ];
    const newBalance = previous - payment + purchases.reduce((s, r) => s + r.cents, 0);
    p.newPage();
    let y = 750;
    p.text(50, y, 'Example Travel Card', { size: 14, isBold: true });
    p.text(50, (y -= 18), 'Card Number XXXX XXXX XXXX 2208');
    p.text(50, (y -= 14), 'Billing Period');
    p.text(50, (y -= 14), 'March 14 - April 13, 2026');
    p.text(50, (y -= 14), 'Minimum Payment Due $25.00');
    p.text(50, (y -= 22), 'Previous Balance');
    p.text(560, y, `$${money(previous)}`, { align: 'right' });
    p.text(50, (y -= 14), 'New Balance');
    p.text(560, y, `$${money(newBalance)}`, { align: 'right' });
    y -= 26;
    p.text(50, y, 'Date', { isBold: true });
    p.text(110, y, 'Description', { isBold: true });
    p.text(560, y, 'Amount', { isBold: true, align: 'right' });
    p.text(50, (y -= 18), 'PAYMENTS', { isBold: true });
    p.text(50, (y -= 14), '03/25');
    p.text(110, y, 'AUTOPAY PAYMENT RECEIVED');
    p.text(560, y, money(payment), { align: 'right' });
    p.text(50, (y -= 22), 'PURCHASES', { isBold: true });
    for (const row of purchases) {
      p.text(50, (y -= 14), row.date);
      p.text(110, y, row.description);
      p.text(560, y, money(row.cents), { align: 'right' });
    }
  });
}

// ---- Layout 7: checking, "beginning ... and ending ..." period, dated balance rows --
function checkingWordedPeriod() {
  return makePdf((p) => {
    const opening = 180_000;
    const rows = [
      { date: '03/03', description: 'EXAMPLE GROCER', cents: -5_210 },
      { date: '03/14', description: 'PAYROLL EXAMPLE EMPLOYER INC DIRECT DEP', cents: 220_000 },
      { date: '03/27', description: 'CHECK 1042', cents: -30_000 },
    ];
    let balance = opening;
    p.newPage();
    let y = 750;
    p.text(50, y, 'Example Savings and Loan', { size: 14, isBold: true });
    p.text(50, (y -= 18), 'Basic Checking   Account number: ***6617');
    p.text(50, (y -= 14), 'For the period beginning March 1, 2026 and ending March 31, 2026');
    y -= 26;
    p.text(50, y, 'Date', { isBold: true });
    p.text(95, y, 'Description', { isBold: true });
    p.text(480, y, 'Amount', { isBold: true, align: 'right' });
    p.text(560, y, 'Balance', { isBold: true, align: 'right' });
    p.text(50, (y -= 16), '03/01');
    p.text(95, y, 'Beginning Balance');
    p.text(560, y, money(opening), { align: 'right' });
    for (const row of rows) {
      balance += row.cents;
      p.text(50, (y -= 14), row.date);
      p.text(95, y, row.description);
      p.text(480, y, money(row.cents, { sign: true }), { align: 'right' });
      p.text(560, y, money(balance), { align: 'right' });
    }
    p.text(50, (y -= 14), '03/31');
    p.text(95, y, 'Ending Balance');
    p.text(560, y, money(balance), { align: 'right' });
  });
}

// ---- Layout 8: combined statement with "CHECKING SUMMARY" / "SAVINGS SUMMARY" --
// The period is printed alone on a line, unlabelled, on every page; each
// account's number appears only after its balances; signed Amount column.
function combinedSummaries() {
  return makePdf((p) => {
    const period = 'March 1, 2026 through March 31, 2026';
    const checkingOpening = 320_000;
    const checkingRows = [
      { date: '03/02', description: 'EXAMPLE GROCER', cents: -6_412 },
      { date: '03/06', description: 'TRANSFER TO SAVINGS', cents: -25_000 },
      { date: '03/13', description: 'PAYROLL EXAMPLE EMPLOYER INC', cents: 285_000 },
      { date: '03/20', description: 'EXAMPLE PHARMACY', cents: -2_275 },
      { date: '03/27', description: 'PAYROLL EXAMPLE EMPLOYER INC', cents: 285_000 },
      { date: '03/30', description: 'EXAMPLE UTILITY CO', cents: -9_830 },
    ];
    const savingsOpening = 640_000;
    const savingsRows = [
      { date: '03/06', description: 'TRANSFER FROM CHECKING', cents: 25_000 },
      { date: '03/31', description: 'INTEREST PAID', cents: 512 },
    ];
    const sum = (rows, test) => rows.filter((r) => test(r.cents)).reduce((s, r) => s + r.cents, 0);
    const checkingEnding = checkingOpening + sum(checkingRows, () => true);
    const savingsEnding = savingsOpening + sum(savingsRows, () => true);
    let balance;
    const header = (y) => {
      p.text(50, y, 'Date', { isBold: true });
      p.text(95, y, 'Description', { isBold: true });
      p.text(480, y, 'Amount', { isBold: true, align: 'right' });
      p.text(560, y, 'Balance', { isBold: true, align: 'right' });
      return y - 16;
    };
    const rowsOut = (y, rows) => {
      for (const row of rows) {
        balance += row.cents;
        p.text(50, y, row.date);
        p.text(95, y, row.description);
        p.text(480, y, money(row.cents, { sign: true }), { align: 'right' });
        p.text(560, y, money(balance), { align: 'right' });
        y -= 14;
      }
      return y;
    };
    const summary = (y, title, opening, rows, ending, number) => {
      p.text(50, y, title, { size: 11, isBold: true });
      p.text(50, (y -= 16), 'Beginning balance on March 1, 2026');
      p.text(560, y, `$${money(opening)}`, { align: 'right' });
      p.text(50, (y -= 14), 'Deposits and other credits');
      p.text(560, y, `$${money(sum(rows, (c) => c > 0))}`, { align: 'right' });
      p.text(50, (y -= 14), 'Withdrawals and other debits');
      p.text(560, y, `-$${money(sum(rows, (c) => c < 0))}`, { align: 'right' });
      p.text(50, (y -= 14), 'Ending balance on March 31, 2026');
      p.text(560, y, `$${money(ending)}`, { align: 'right' });
      p.text(50, (y -= 16), `Account number: XXXXXXXX${number}`);
      return y - 22;
    };

    p.newPage();
    let y = 750;
    p.text(50, y, 'Example Hometown Bank', { size: 14, isBold: true });
    p.text(50, (y -= 16), period);
    p.text(50, (y -= 14), 'Jordan and Casey Example');
    p.text(50, (y -= 22), 'Your accounts at a glance', { isBold: true });
    p.text(50, (y -= 14), 'Beginning balance');
    p.text(470, y, money(checkingOpening), { align: 'right' });
    p.text(560, y, money(savingsOpening), { align: 'right' });
    y = summary(y - 30, 'CHECKING SUMMARY', checkingOpening, checkingRows, checkingEnding, '4821');
    y = header(y);
    balance = checkingOpening;
    rowsOut(y, checkingRows.slice(0, 4));
    p.text(500, 40, 'Page 1 of 2');

    p.newPage();
    y = 750;
    p.text(50, y, 'Example Hometown Bank', { size: 14, isBold: true });
    p.text(50, (y -= 16), period);
    y = header(y - 26);
    y = rowsOut(y, checkingRows.slice(4));
    y = summary(y - 26, 'SAVINGS SUMMARY', savingsOpening, savingsRows, savingsEnding, '7310');
    y = header(y);
    balance = savingsOpening;
    rowsOut(y, savingsRows);
    p.text(500, 40, 'Page 2 of 2');
  });
}

// ---- Not statements ---------------------------------------------------------
function scanned() {
  return makePdf((p) => {
    p.newPage();
    for (let i = 0; i < 30; i++) p.box(50, 740 - i * 20, 300 + ((i * 37) % 200), 10);
  });
}

function letter() {
  return makePdf((p) => {
    p.newPage();
    p.text(50, 740, 'Example Community Bank', { size: 14, isBold: true });
    p.text(50, 710, 'Dear customer,');
    p.text(50, 694, 'We are updating our terms and conditions. No action is needed.');
    p.text(50, 678, 'Thank you for banking with us.');
  });
}

const FIXTURES = {
  'checking-2026-03.pdf': () => checking({ start: '03/01/2026', end: '03/31/2026', openingCents: 250_000, rows: CHECKING_MARCH }),
  'checking-2026-04.pdf': () =>
    checking({ start: '03/31/2026', end: '04/30/2026', openingCents: marchEnding + 1_549, rows: CHECKING_APRIL }),
  'checking-balance-mismatch.pdf': () =>
    checking({ start: '05/01/2026', end: '05/31/2026', openingCents: 100_000, endingOverrideCents: 95_000, rows: [
      { date: '05/02', description: 'EXAMPLE GROCER #12 PURCHASE', cents: -2_500 },
      { date: '05/09', description: 'EXAMPLE PHARMACY', cents: -1_000 },
    ] }),
  'savings-2026-03.pdf': savings,
  'card-2026-03.pdf': () =>
    card({
      start: '03/01/26',
      end: '03/31/26',
      previousCents: 123_456,
      credits: [
        { trans: '03/19', post: '03/19', description: 'PAYMENT - THANK YOU', cents: 123_456 },
        { trans: '03/24', post: '03/25', description: 'EXAMPLE OUTFITTERS RETURN', cents: 4_000 },
      ],
      purchases: [
        { trans: '03/02', post: '03/03', description: 'SAMPLE COFFEE CO', cents: 525 },
        { trans: '03/12', post: '03/13', description: 'EXAMPLE OUTFITTERS', cents: 12_000 },
        { trans: '03/20', post: '03/21', description: 'EXAMPLE RESTAURANT', cents: 6_410 },
        { trans: '03/28', post: '03/29', description: 'EXAMPLE GAS STATION', cents: 4_137 },
      ],
    }),
  'card-2025-12.pdf': () =>
    card({
      start: '12/16/25',
      end: '01/15/26',
      previousCents: 0,
      credits: [],
      purchases: [
        { trans: '12/20', post: '12/21', description: 'EXAMPLE GIFT SHOP', cents: 4_999 },
        { trans: '01/05', post: '01/06', description: 'EXAMPLE BOOKSTORE', cents: 2_250 },
      ],
    }),
  'combined-checking-savings-2026-03.pdf': combined,
  'card-closing-date-totals-2026-04.pdf': cardWithTotals,
  'card-bare-headings-2026-04.pdf': cardBareHeadings,
  'checking-worded-period-2026-03.pdf': checkingWordedPeriod,
  'combined-summaries-2026-03.pdf': combinedSummaries,
  'scanned-image-only.pdf': scanned,
  'not-a-statement-letter.pdf': letter,
};

const check = process.argv.includes('--check');
let stale = 0;
for (const [name, build] of Object.entries(FIXTURES)) {
  const bytes = Buffer.from(await build());
  const path = `${OUT}/${name}`;
  if (check) {
    let current = Buffer.alloc(0);
    try {
      current = readFileSync(path);
    } catch {
      // missing
    }
    const same = createHash('sha256').update(current).digest('hex') === createHash('sha256').update(bytes).digest('hex');
    if (!same) {
      stale++;
      console.error(`out of date: ${path}`);
    }
  } else {
    writeFileSync(path, bytes);
    console.log(`wrote ${path} (${bytes.length} bytes)`);
  }
}
if (stale) {
  console.error('Run: node scripts/generate-synthetic-statements.mjs');
  process.exit(1);
}
if (check) console.log(`Synthetic fixtures are up to date (${Object.keys(FIXTURES).length} files).`);
