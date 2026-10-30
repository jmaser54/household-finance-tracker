// CI only. Imports every SYNTHETIC statement in an older WebKit (Playwright
// 1.44 bundles WebKit 17.4, close to Safari 17.6 on macOS Monterey) to check
// the PDF reader works in the engine the household's Mac uses. Prints each
// file's result and, for failures, the technical details (no contents).
// Run with NODE_PATH pointing at a separate playwright@1.44.1 install.
const { webkit } = require('playwright');
const { readdirSync } = require('node:fs');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4180/';
const dir = 'tests/fixtures/synthetic';
const statements = ['checking-2026-03.pdf', 'checking-2026-04.pdf', 'savings-2026-03.pdf', 'card-2026-03.pdf', 'card-2025-12.pdf']
  .map((f) => `${dir}/${f}`)
  .concat(readdirSync(`${dir}/structure`).filter((f) => f.endsWith('.pdf') && !f.startsWith('requires-user')).map((f) => `${dir}/structure/${f}`));

(async () => {
  const browser = await webkit.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`.slice(0, 200)));
  await page.goto(BASE);
  console.log('Engine:', await page.evaluate(() => navigator.userAgent));
  console.log('Features:', JSON.stringify(await page.evaluate(() => ({
    urlParse: typeof URL.parse === 'function',
    promiseTry: typeof Promise.try === 'function',
    streamAsyncIteration: typeof ReadableStream.prototype[Symbol.asyncIterator] === 'function',
    secureContext: isSecureContext,
    webCrypto: typeof crypto.subtle?.digest === 'function',
  }))));
  await page.getByLabel('Passphrase', { exact: true }).fill('synthetic test passphrase');
  await page.getByLabel('Type it again').fill('synthetic test passphrase');
  await page.getByRole('button', { name: 'Create household' }).click();
  await page.getByText('Example with made-up numbers').waitFor();
  await page.getByTestId('statement-input').setInputFiles(statements);
  await page.waitForFunction(() => !document.body.textContent.includes('Reading…'), null, { timeout: 60_000 });
  const cards = await page.locator('.import-card').evaluateAll((els) =>
    els.map((e) => ({
      name: e.querySelector('h3')?.textContent,
      status: e.getAttribute('data-file-status'),
      details: e.querySelector('[data-technical-details] pre')?.textContent ?? '',
    })),
  );
  let ok = true;
  for (const card of cards) {
    console.log(`${card.status === 'parsed' ? 'OK  ' : 'FAIL'} ${card.name}: ${card.status}`);
    if (card.details) console.log(card.details.replace(/^/gm, '       '));
    if (card.status !== 'parsed') ok = false;
  }
  if (errors.length) console.log('Page errors:', errors);
  await browser.close();
  if (cards.length !== statements.length || !ok) {
    console.error(`Safari 17-era WebKit could not read ${cards.filter((c) => c.status !== 'parsed').length} of ${statements.length} statements.`);
    process.exit(1);
  }
  console.log(`Safari 17-era WebKit read all ${statements.length} synthetic statements.`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
