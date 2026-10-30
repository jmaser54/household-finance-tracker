// Statement-import failure diagnosis, with SYNTHETIC PDFs only. Each test
// recreates one possible cause of "This PDF couldn't be opened" and checks the
// technical details name the right step, without any statement contents.
import { expect, test, type Page } from '@playwright/test';

const PASSPHRASE = 'synthetic test passphrase';
const SYNTHETIC_VALUES = ['TRANSFER FROM CHECKING', 'INTEREST PAID', '7310', '10,000.00', '03/05', 'Example Savings'];

async function createHousehold(page: Page) {
  await page.goto('/');
  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await page.getByLabel('Type it again').fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Create household' }).click();
  await expect(page.getByText('Example with made-up numbers')).toBeVisible();
}

async function importAndReadDetails(page: Page, files: string[]) {
  await page.getByTestId('statement-input').setInputFiles(files.map((f) => `tests/fixtures/synthetic/${f}`));
  await expect(page.getByText('Reading…')).toHaveCount(0, { timeout: 20_000 });
  const panels = page.locator('[data-technical-details]');
  await expect(panels).toHaveCount(files.length);
  await panels.first().getByText('Technical details (no statement contents)').click();
  return panels;
}

test('without WebCrypto (an insecure context), the details say the fingerprint step failed', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined, configurable: true });
  });
  await createHousehold(page);
  const panels = await importAndReadDetails(page, ['savings-2026-03.pdf', 'card-2026-03.pdf']);
  await expect(page.getByText("This PDF couldn't be opened. It may be damaged.")).toHaveCount(2);
  await expect(panels.first()).toHaveAttribute('data-technical-details', 'fingerprint');
  const text = await panels.first().locator('pre').innerText();
  expect(text).toContain('[fingerprint]');
  expect(text).toContain('WebCrypto no');
  for (const value of SYNTHETIC_VALUES) expect(text).not.toContain(value);
});

test('when the file cannot be read from disk, the details say the reading-file step failed', async ({ page }) => {
  await page.addInitScript(() => {
    Blob.prototype.arrayBuffer = () => Promise.reject(new DOMException('The operation was denied.', 'NotReadableError'));
  });
  await createHousehold(page);
  const panels = await importAndReadDetails(page, ['savings-2026-03.pdf']);
  await expect(panels.first()).toHaveAttribute('data-technical-details', 'reading-file');
  const text = await panels.first().locator('pre').innerText();
  expect(text).toContain('Error: NotReadableError');
  expect(text).not.toContain('File: about');
});

test('encrypted, object-stream and linearized PDFs import in the browser too', async ({ page }) => {
  await createHousehold(page);
  const files = [
    'aes256-owner-password.pdf',
    'aes128-owner-password.pdf',
    'rc4-128-owner-password.pdf',
    'object-streams.pdf',
    'linearized.pdf',
    'linearized-object-streams-aes256.pdf',
  ];
  await page.getByTestId('statement-input').setInputFiles(files.map((f) => `tests/fixtures/synthetic/structure/${f}`));
  await expect(page.getByText('Reading…')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator('[data-file-status="parsed"]')).toHaveCount(files.length);
  await expect(page.locator('[data-technical-details]')).toHaveCount(0);
});

test('statements import when the page and worker lack the built-ins macOS Monterey WebKit lacks', async ({ page }) => {
  // Remove them in the page and, by rewriting the worker script as it is
  // served, in pdf.js's worker too, before any app code runs.
  const removal = `delete Promise.withResolvers; delete ArrayBuffer.prototype.transferToFixedLength;`;
  let workerRewritten = false;
  await page.addInitScript(removal);
  await page.route(/\/assets\/pdfjsWorker-[\w-]+\.js$/, async (route) => {
    const response = await route.fetch();
    workerRewritten = true;
    await route.fulfill({ response, body: `${removal}\n${await response.text()}` });
  });
  await createHousehold(page);
  expect(await page.evaluate(() => typeof (Promise as unknown as { withResolvers?: unknown }).withResolvers)).toBe('undefined');
  const files = ['checking-2026-03.pdf', 'card-2026-03.pdf', 'structure/aes256-owner-password.pdf'];
  await page.getByTestId('statement-input').setInputFiles(files.map((f) => `tests/fixtures/synthetic/${f}`));
  await expect(page.getByText('Reading…')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator('[data-file-status="parsed"]')).toHaveCount(files.length);
  expect(workerRewritten).toBe(true);
  // pdf.js ran in its worker, not silently in the page.
  expect(await page.evaluate(() => 'pdfjsWorker' in globalThis)).toBe(false);
});
