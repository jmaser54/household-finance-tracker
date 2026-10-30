// CI only. Imports every SYNTHETIC statement in an older WebKit to check the
// PDF reader works in the engine the household's Mac uses (macOS Monterey;
// its built-in WebKit, used by apps, is older than the Safari app's). Prints
// each file's result and, for failures, the technical details (no contents).
// PW_DIR is a separate install of the Playwright version EXPECT_PLAYWRIGHT,
// loaded by explicit path (a bare require would find the project's newer
// Playwright first). Selectors stick to APIs old Playwright versions have.
const path = require('node:path');
const pwDir = path.join(process.env.PW_DIR, 'node_modules', 'playwright');
const { webkit } = require(pwDir);
const version = require(path.join(pwDir, 'package.json')).version;
if (version !== process.env.EXPECT_PLAYWRIGHT) throw new Error(`expected Playwright ${process.env.EXPECT_PLAYWRIGHT}, got ${version}`);
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
  const userAgent = await page.evaluate(() => navigator.userAgent);
  const engineVersion = /Version\/([\d.]+)/.exec(userAgent)?.[1] ?? 'unknown';
  console.log(`Playwright ${version}; engine:`, userAgent);
  console.log('Features:', JSON.stringify(await page.evaluate(() => ({
    urlParse: typeof URL.parse === 'function',
    promiseTry: typeof Promise.try === 'function',
    streamAsyncIteration: typeof ReadableStream.prototype[Symbol.asyncIterator] === 'function',
    secureContext: isSecureContext,
    webCrypto: typeof crypto.subtle?.digest === 'function',
    decompressionStream: typeof DecompressionStream === 'function',
  }))));
  await page.fill('input[type=password] >> nth=0', 'synthetic test passphrase');
  await page.fill('input[type=password] >> nth=1', 'synthetic test passphrase');
  await page.click('button:has-text("Create household")');
  await page.waitForSelector('text=Example with made-up numbers');
  await page.setInputFiles('[data-testid=statement-input]', statements);
  // Poll with evaluate: Playwright 1.44's waitForFunction uses eval, which the app's CSP blocks.
  for (let i = 0; ; i++) {
    const done = await page.evaluate((n) => document.querySelectorAll('.import-card').length === n && !document.body.textContent.includes('Reading…'), statements.length);
    if (done) break;
    if (i >= 120) throw new Error('timed out waiting for the import to finish');
    await new Promise((r) => setTimeout(r, 500));
  }
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
    console.error(`WebKit ${engineVersion} could not read ${cards.filter((c) => c.status !== 'parsed').length} of ${statements.length} statements.`);
    process.exit(1);
  }
  console.log(`WebKit ${engineVersion} read all ${statements.length} synthetic statements.`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
