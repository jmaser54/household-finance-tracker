import { expect, test, type Page } from '@playwright/test';

const PASSPHRASE = 'synthetic test passphrase';

async function createHousehold(page: Page) {
  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await page.getByLabel('Type it again').fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Create household' }).click();
  await expect(page.getByText('Example with made-up numbers')).toBeVisible();
}

test('the app loads only its own static files and makes no other requests', async ({ page, baseURL }) => {
  const requests: string[] = [];
  const cspViolations: string[] = [];
  const consoleMessages: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  page.on('console', (message) => consoleMessages.push(`${message.type()}: ${message.text()}`));
  await page.exposeFunction('reportCspViolation', (directive: string) => cspViolations.push(directive));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      (window as unknown as { reportCspViolation: (d: string) => void }).reportCspViolation(event.violatedDirective);
    });
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Our Household Money' })).toBeVisible();
  await createHousehold(page);
  await page.waitForLoadState('networkidle');

  const origin = new URL(baseURL!).origin;
  const foreign = requests.filter((url) => new URL(url).origin !== origin);
  expect(foreign).toEqual([]);
  expect(cspViolations).toEqual([]);
  expect(consoleMessages).toEqual([]);
});

test('the Content-Security-Policy blocks outbound connections from page scripts', async ({ page }) => {
  await page.goto('/');
  const outcome = await page.evaluate(async () => {
    const violations: string[] = [];
    document.addEventListener('securitypolicyviolation', (event) => violations.push(event.effectiveDirective));
    let sent = false;
    try {
      await fetch('https://example.com/should-be-blocked', { mode: 'no-cors' });
      sent = true;
    } catch {
      // expected
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { sent, violations };
  });
  // Blocked by the policy itself, not by a missing network.
  expect(outcome).toEqual({ sent: false, violations: ['connect-src'] });
});

test('the CSP also blocks same-origin requests, so data cannot be smuggled to the host', async ({ page }) => {
  await page.goto('/');
  const outcome = await page.evaluate(async () => {
    const violations: string[] = [];
    document.addEventListener('securitypolicyviolation', (event) => violations.push(event.effectiveDirective));
    let sent = false;
    try {
      await fetch('./anything');
      sent = true;
    } catch {
      // expected
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { sent, violations };
  });
  // Blocked by the policy itself, not by a missing network.
  expect(outcome).toEqual({ sent: false, violations: ['connect-src'] });
});

test('the URL never changes while using the page', async ({ page }) => {
  await page.goto('/');
  const before = page.url();
  await createHousehold(page);
  await page.getByText('Add your statements').click();
  await page.getByRole('button', { name: 'Lock' }).click();
  expect(page.url()).toBe(before);
});
