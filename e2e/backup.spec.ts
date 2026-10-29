// Backup and restore screens in the browser preview. The memory-only stand-in
// treats "the chosen file" as the last backup made on the page. Synthetic data.
import { expect, test, type Page } from '@playwright/test';

const PASSPHRASE = 'synthetic test passphrase';

async function createHousehold(page: Page) {
  await page.goto('/');
  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await page.getByLabel('Type it again').fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Create household' }).click();
  await expect(page.getByText('Example with made-up numbers')).toBeVisible();
}

test('make a backup, then restore it with a clear confirmation', async ({ page }) => {
  await createHousehold(page);
  const backups = page.locator('[data-section="backups"]');
  await expect(backups.getByText('No backup yet.')).toBeVisible();

  await backups.getByRole('button', { name: 'Make a backup' }).click();
  await expect(backups.getByRole('status')).toContainText('Backup saved and checked');
  await expect(backups.getByText(/^Last backup: /)).toBeVisible();

  await backups.getByRole('button', { name: 'Restore from a backup' }).click();
  await expect(page.getByRole('heading', { name: 'Restore from a backup' })).toBeVisible();

  const field = page.getByLabel('Household passphrase');
  await field.fill('definitely the wrong one');
  await page.getByRole('button', { name: 'Choose backup file…' }).click();
  await expect(page.getByRole('alert')).toContainText("didn't open this backup");

  await field.fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Choose backup file…' }).click();
  await expect(page.getByRole('heading', { name: 'Restore this backup?' })).toBeVisible();
  await expect(page.getByText('0 accounts')).toBeVisible();
  await expect(page.getByText('This replaces all household data currently on this Mac')).toBeVisible();

  // Cancel goes back with nothing changed.
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('Example with made-up numbers')).toBeVisible();
  await expect(page.getByText('Restored from your backup')).toHaveCount(0);

  // Now restore for real.
  await page.getByRole('button', { name: 'Restore from a backup' }).click();
  await page.getByLabel('Household passphrase').fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Choose backup file…' }).click();
  await page.getByRole('button', { name: 'Replace my current data' }).click();
  await expect(page.getByText('Restored from your backup.')).toBeVisible();
  await expect(page.locator('[data-section="backups"]').getByText(/^Last backup: /)).toBeVisible();
});

test('on a new Mac, restore is offered instead of creating a household', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Restore from a backup instead' }).click();
  await expect(page.getByRole('heading', { name: 'Restore from a backup' })).toBeVisible();
  await page.getByLabel('Household passphrase').fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Choose backup file…' }).click();
  // No backup exists in this fresh page, so this behaves like closing the file panel.
  await expect(page.getByRole('alert')).toContainText('No file was chosen');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('heading', { name: 'Choose a household passphrase' })).toBeVisible();
});
