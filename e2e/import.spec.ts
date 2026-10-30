// Statement import in the browser preview, with SYNTHETIC PDFs only.
import { expect, test, type Page } from '@playwright/test';

const PASSPHRASE = 'synthetic test passphrase';
const fixture = (name: string) => `tests/fixtures/synthetic/${name}`;

async function createHousehold(page: Page) {
  await page.goto('/');
  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await page.getByLabel('Type it again').fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Create household' }).click();
  await expect(page.getByText('Example with made-up numbers')).toBeVisible();
}

async function choose(page: Page, names: string[]) {
  await page.getByTestId('statement-input').setInputFiles(names.map(fixture));
  await expect(page.getByRole('heading', { name: 'Check what we found' })).toBeVisible();
  await expect(page.getByText('Reading…')).toHaveCount(0, { timeout: 20_000 });
}

test('statements are read, reviewed and added without any network traffic', async ({ page, baseURL }) => {
  const requests: string[] = [];
  const violations: string[] = [];
  const consoleMessages: string[] = [];
  const workers: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('worker', (w) => workers.push(w.url()));
  page.on('console', (m) => consoleMessages.push(`${m.type()}: ${m.text()}`));
  await page.exposeFunction('reportCspViolation', (d: string) => violations.push(d));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      (window as unknown as { reportCspViolation: (d: string) => void }).reportCspViolation(e.violatedDirective);
    });
  });

  await createHousehold(page);
  await choose(page, ['checking-2026-03.pdf', 'savings-2026-03.pdf', 'card-2026-03.pdf']);

  // One card per statement, each recognised and checked against its balances.
  await expect(page.getByText('Checking ending 4821 · March 1, 2026 to March 31, 2026')).toBeVisible();
  await expect(page.getByText('Savings ending 7310', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('Credit card ending 5512', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('✓ Every line was read and the balances match the statement.')).toHaveCount(3);
  await expect(page.getByRole('cell', { name: 'PAYROLL EXAMPLE EMPLOYER INC DIRECT DEP' }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: '+$3,100.00' }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: '-$84.23' })).toBeVisible();

  await page.getByRole('button', { name: 'Add 21 transactions' }).click();
  await expect(page.getByText(/Added 21 transactions from 3 statements\./)).toBeVisible();

  // Adding the same files again adds nothing.
  await choose(page, ['checking-2026-03.pdf']);
  await expect(page.getByText('This statement was already added')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add 0 transactions' })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel' }).click();

  // The next month: its overlapping first day is recognised as already added.
  await choose(page, ['checking-2026-04.pdf']);
  await expect(page.getByText('This statement overlaps one already added')).toBeVisible();
  await expect(page.getByText('4 new · 1 already added')).toBeVisible();
  await page.getByRole('button', { name: 'Add 4 transactions' }).click();
  await expect(page.getByText(/Added 4 transactions from 1 statement\./)).toBeVisible();

  const origin = new URL(baseURL!).origin;
  expect(requests.filter((url) => new URL(url).origin !== origin)).toEqual([]);
  expect(violations).toEqual([]);
  expect(consoleMessages).toEqual([]);
  // pdf.js ran in its own worker. If the worker fails to start, pdf.js falls
  // back silently to the page itself, which hides a broken worker build.
  expect(workers.some((url) => /\/assets\/pdfjsWorker-[\w-]+\.js$/.test(url))).toBe(true);
  expect(await page.evaluate(() => 'pdfjsWorker' in globalThis)).toBe(false);
});

test('unreadable, scanned and unsupported PDFs are explained, never guessed', async ({ page }) => {
  await createHousehold(page);
  await choose(page, ['scanned-image-only.pdf', 'not-a-statement-letter.pdf']);
  await expect(page.getByText('This PDF is a scanned picture of a statement')).toBeVisible();
  await expect(page.getByText("We couldn't find the statement period in this PDF")).toBeVisible();
  // Masked diagnostics show structure only.
  await page.getByText('Show what the app saw (all values hidden)').click();
  const diagnostics = await page.locator('.diagnostics pre').innerText();
  expect(diagnostics).toContain('TEXT');
  expect(diagnostics).not.toMatch(/Example|customer|terms/i);
  await expect(page.getByRole('button', { name: 'Add 0 transactions' })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('Example with made-up numbers')).toBeVisible();
});

test('a statement whose balances do not add up is held back until confirmed', async ({ page }) => {
  await createHousehold(page);
  await choose(page, ['checking-balance-mismatch.pdf']);
  await expect(page.getByText("These transactions don't add up to the statement's balances.")).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add 0 transactions' })).toBeDisabled();
  await page.getByLabel("I've checked these transactions; add them anyway").check();
  await page.getByRole('button', { name: 'Add 2 transactions' }).click();
  await expect(page.getByText(/Added 2 transactions from 1 statement\./)).toBeVisible();
});

test('rows can be left out, and cancelling adds nothing', async ({ page }) => {
  await createHousehold(page);
  await choose(page, ['savings-2026-03.pdf']);
  await page.getByLabel('Add INTEREST PAID').uncheck();
  await expect(page.getByRole('button', { name: 'Add 1 transaction' })).toBeEnabled();
  await page.getByRole('button', { name: 'Cancel' }).click();
  // Nothing was added: the same file is not "already added".
  await choose(page, ['savings-2026-03.pdf']);
  await expect(page.getByText('This statement was already added')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add 2 transactions' })).toBeEnabled();
});

test('a combined checking and savings PDF is reviewed as two accounts; an undated interest line is flagged', async ({ page }) => {
  await createHousehold(page);
  await choose(page, ['combined-checking-savings-2026-03.pdf', 'card-closing-date-totals-2026-04.pdf']);
  await expect(page.getByRole('heading', { name: 'combined-checking-savings-2026-03.pdf · account 1 of 2' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'combined-checking-savings-2026-03.pdf · account 2 of 2' })).toBeVisible();
  await expect(page.getByText('Checking ending 4821 · March 1, 2026 to March 31, 2026')).toBeVisible();
  await expect(page.getByText('Savings ending 7310 · March 1, 2026 to March 31, 2026')).toBeVisible();
  await expect(page.getByText('Credit card ending 9046 · March 16, 2026 to April 13, 2026')).toBeVisible();
  await expect(page.locator('[data-validation="verified"]')).toHaveCount(3);
  await expect(page.getByText("No date was printed for this line, so the statement's closing date was used")).toBeVisible();

  await page.getByRole('button', { name: 'Add 17 transactions' }).click();
  await expect(page.getByText(/Added 17 transactions from 3 statements\./)).toBeVisible();

  // The same combined PDF again: both of its accounts are recognised as already added.
  await choose(page, ['combined-checking-savings-2026-03.pdf']);
  await expect(page.getByText('This statement was already added')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Add 0 transactions' })).toBeDisabled();
});

test('a combined statement with an unlabelled period and summary headings is two verified accounts', async ({ page }) => {
  await createHousehold(page);
  await choose(page, ['combined-summaries-2026-03.pdf']);
  await expect(page.getByText('Checking ending 4821 · March 1, 2026 to March 31, 2026')).toBeVisible();
  await expect(page.getByText('Savings ending 7310 · March 1, 2026 to March 31, 2026')).toBeVisible();
  await expect(page.locator('[data-validation="verified"]')).toHaveCount(2);
  await page.getByRole('button', { name: 'Add 8 transactions' }).click();
  await expect(page.getByText(/Added 8 transactions from 2 statements\./)).toBeVisible();
});
