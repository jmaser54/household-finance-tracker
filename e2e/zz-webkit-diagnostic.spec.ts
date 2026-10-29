// TEMPORARY diagnostic for the WebKit import failure (synthetic data only).
import { test, type Page } from '@playwright/test';

test('diagnose import in this browser', async ({ page, browserName }) => {
  const notes: string[] = [];
  page.on('pageerror', (e) => notes.push(`pageerror: ${e.name}: ${e.message}`.slice(0, 300)));
  page.on('console', (m) => notes.push(`console ${m.type()}: ${m.text()}`.slice(0, 300)));
  await page.goto('/');
  notes.push(`secure=${await page.evaluate(() => window.isSecureContext)} subtle=${await page.evaluate(() => typeof crypto.subtle)}`);
  notes.push(`digest=${await page.evaluate(async () => {
    try { const d = await crypto.subtle.digest('SHA-256', new Uint8Array([1, 2, 3])); return 'ok ' + d.byteLength; } catch (e) { return 'err ' + String(e); }
  })}`);
  await page.getByLabel('Passphrase', { exact: true }).fill('synthetic test passphrase');
  await page.getByLabel('Type it again').fill('synthetic test passphrase');
  await page.getByRole('button', { name: 'Create household' }).click();
  await page.getByTestId('statement-input').setInputFiles(['tests/fixtures/synthetic/savings-2026-03.pdf']);
  await page.waitForTimeout(8000);
  const cards = await page.locator('.import-card').evaluateAll((els) =>
    els.map((e) => `${e.getAttribute('data-file-status')} | ${(e as HTMLElement).innerText.replace(/\s+/g, ' ').slice(0, 200)}`),
  );
  notes.push(...cards.map((c) => `card: ${c}`));
  notes.push(`pdf diag: ${await page.evaluate(() => String((globalThis as Record<string, unknown>).__TEMP_PDF_DIAG))}`);
  notes.push(`worker urls: ${await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name.split('/').pop()).filter((n) => /pdf/.test(n ?? '')).join(','))}`);
  console.log(`DIAG[${browserName}]\n  ${notes.join('\n  ')}`);
});
void (null as unknown as Page);
