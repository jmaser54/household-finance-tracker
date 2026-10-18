import { expect, test } from '@playwright/test';

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
  await expect(page.getByText('Example with made-up numbers')).toBeVisible();
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
  await page.getByText('Add your statements').click();
  expect(page.url()).toBe(before);
});
