// Seeing and sorting transactions, with SYNTHETIC statements only.
import { expect, test, type Page } from '@playwright/test';

const PASSPHRASE = 'synthetic test passphrase';

async function householdWith(page: Page, files: string[]) {
  await page.goto('/');
  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await page.getByLabel('Type it again').fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Create household' }).click();
  await expect(page.getByText('Example with made-up numbers')).toBeVisible();
  await page.getByTestId('statement-input').setInputFiles(files.map((f) => `tests/fixtures/synthetic/${f}`));
  await expect(page.getByText('Reading…')).toHaveCount(0, { timeout: 20_000 });
  await page.getByRole('button', { name: /^Add \d+ transactions$/ }).click();
  await expect(page.getByRole('heading', { name: 'Your money' })).toBeVisible();
}

const row = (page: Page, name: string) => page.locator('.transaction-row', { hasText: name });
const panel = (page: Page) => page.getByRole('complementary', { name: 'Transaction details' });

test('home shows the scoreboard, and the list shows, finds and filters every transaction', async ({ page }) => {
  await householdWith(page, ['checking-2026-03.pdf', 'card-2026-03.pdf']);
  // The example with made-up numbers is gone once there is real data.
  await expect(page.getByText('Example with made-up numbers')).toHaveCount(0);
  await expect(page.locator('.money-card')).toContainText('19transactions from 2 statements');
  await page.getByRole('button', { name: 'See your transactions' }).click();

  await expect(page.locator('.transaction-row')).toHaveCount(19);
  await expect(page.getByRole('heading', { name: 'Tuesday, March 31, 2026' })).toBeVisible();
  // Built-in guesses are conservative; transfers and card payments look quieter and say so.
  await expect(row(page, 'Example Pharmacy')).toContainText('Health');
  await expect(row(page, 'Example Outfitters').first()).toContainText('Uncategorized');
  await expect(row(page, 'Online Transfer To Savings')).toContainText('Moved between your accounts');
  await expect(row(page, 'Payroll Example Employer Inc Direct Dep').first()).toContainText('+$3,100.00');

  await page.getByPlaceholder('Search names or amounts').fill('pharmacy');
  await expect(page.locator('.transaction-row')).toHaveCount(1);
  await page.getByPlaceholder('Search names or amounts').fill('18.99');
  await expect(page.locator('.transaction-row')).toHaveCount(1);
  await page.getByPlaceholder('Search names or amounts').fill('');

  await page.getByRole('combobox', { name: 'Category' }).selectOption({ label: 'Health' });
  await expect(page.locator('.transaction-row')).toHaveCount(1);
  await page.getByRole('combobox', { name: 'Category' }).selectOption({ label: 'All categories' });
  await page.getByRole('combobox', { name: 'Account' }).selectOption({ label: 'Credit card ending 5512' });
  await expect(page.locator('.transaction-row')).toHaveCount(6);
});

test('a category changes only the one transaction unless "also use my choice" is ticked', async ({ page }) => {
  await householdWith(page, ['checking-2026-03.pdf', 'card-2026-03.pdf']);
  await page.getByRole('button', { name: 'See your transactions' }).click();
  const coffee = row(page, 'Sample Coffee Co');
  await expect(coffee).toHaveCount(3);

  await coffee.first().click();
  const also = panel(page).getByLabel(/Also use my choice for the 2 other "Sample Coffee Co" transactions/);
  await expect(also).not.toBeChecked();
  await panel(page).getByRole('button', { name: 'Eating Out' }).click();
  await expect(coffee.filter({ hasText: 'Eating Out' })).toHaveCount(1);
  await expect(coffee.filter({ hasText: 'Uncategorized' })).toHaveCount(2);

  await coffee.filter({ hasText: 'Uncategorized' }).first().click();
  await panel(page).getByLabel(/Also use my choice for the 1 other "Sample Coffee Co" transaction,/).check();
  await panel(page).getByRole('button', { name: 'Eating Out' }).click();
  await expect(coffee.filter({ hasText: 'Eating Out' })).toHaveCount(3);
});

test('renaming keeps the statement\'s own text, notes stick, and transfers can be made to count', async ({ page }) => {
  await householdWith(page, ['checking-2026-03.pdf']);
  await page.getByRole('button', { name: 'See your transactions' }).click();

  await row(page, 'Example Utility').click();
  await expect(panel(page)).toContainText('From your statement: EXAMPLE UTILITY CO AUTOPAY REF 000123 ACCOUNT SERVICES');
  await panel(page).getByLabel('Name').fill('Power company');
  await panel(page).getByLabel('Note').fill('Winter bill');
  await panel(page).getByRole('button', { name: 'Close' }).click();
  await expect(row(page, 'Power company')).toContainText('Bills & Utilities');
  await row(page, 'Power company').click();
  await expect(panel(page).getByLabel('Note')).toHaveValue('Winter bill');
  await expect(panel(page)).toContainText('EXAMPLE UTILITY CO AUTOPAY');
  await page.keyboard.press('Escape');

  await row(page, 'Online Transfer To Savings').click();
  await panel(page).getByRole('button', { name: 'Home' }).click();
  await expect(panel(page)).toContainText('This now counts as spending.');
  await expect(row(page, 'Online Transfer To Savings')).not.toContainText('Moved between your accounts');
});

test('sorting: each choice opens the next one waiting, until all are sorted', async ({ page }) => {
  await householdWith(page, ['card-2025-12.pdf']);
  await expect(page.locator('.money-card')).toContainText('2ready to sort');
  await page.getByRole('button', { name: 'Sort them now' }).click();
  await expect(page.getByRole('button', { name: /Only ready to sort/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.transaction-row')).toHaveCount(2);

  await row(page, 'Example Bookstore').click();
  await panel(page).getByRole('button', { name: 'Shopping' }).click();
  await expect(panel(page)).toContainText('From your statement: EXAMPLE GIFT SHOP'); // the next one opened by itself
  await panel(page).getByRole('button', { name: 'Gifts & Giving' }).click();
  await expect(page.getByText('All sorted — nice work!')).toBeVisible();

  await page.getByRole('button', { name: '← Home' }).click();
  await expect(page.locator('.money-card')).toContainText('0ready to sort');
});
