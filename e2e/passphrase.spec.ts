// Passphrase flow in the browser preview, which uses the memory-only stand-in
// with the same rules as the Mac app's encrypted vault. All values are synthetic.
import { expect, test } from '@playwright/test';

const PASSPHRASE = 'synthetic test passphrase';

test('setup refuses short and mismatched passphrases, then creates the household', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Choose a household passphrase' })).toBeVisible();
  await expect(page.getByText("If it's forgotten, the data can't be recovered")).toBeVisible();

  const passphrase = page.getByLabel('Passphrase', { exact: true });
  const again = page.getByLabel('Type it again');
  const create = page.getByRole('button', { name: 'Create household' });

  await passphrase.fill('too short');
  await again.fill('too short');
  await create.click();
  await expect(page.getByRole('alert')).toContainText('at least 12 characters');

  await passphrase.fill(PASSPHRASE);
  await again.fill(PASSPHRASE + ' typo');
  await create.click();
  await expect(page.getByRole('alert')).toContainText("don't match");

  await again.fill(PASSPHRASE);
  await create.click();
  await expect(page.getByText('Example with made-up numbers')).toBeVisible();
  await expect(page.getByText('Browser preview: nothing is saved')).toBeVisible();
});

test('lock, a wrong passphrase is refused, the right one unlocks', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await page.getByLabel('Type it again').fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Create household' }).click();

  await page.getByRole('button', { name: 'Lock' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await expect(page.getByText('Example with made-up numbers')).toHaveCount(0);

  const field = page.getByLabel('Household passphrase');
  await field.fill('definitely the wrong one');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('alert')).toContainText("didn't open it");
  await expect(field).toHaveValue('');

  await field.fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByText('Example with made-up numbers')).toBeVisible();
});

test('passphrases are never put in the URL or page title', async ({ page }) => {
  await page.goto('/');
  const before = page.url();
  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await page.getByLabel('Type it again').fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Create household' }).click();
  await expect(page.getByText('Example with made-up numbers')).toBeVisible();
  expect(page.url()).toBe(before);
  expect(await page.title()).not.toContain(PASSPHRASE);
});
