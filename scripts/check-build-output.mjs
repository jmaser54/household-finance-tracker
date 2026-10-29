// Verifies the production build in dist/ keeps the privacy boundary:
//  - the shipped index.html carries the strict Content-Security-Policy
//  - no file references an external origin that code could load or call
//  - no source maps, PDFs, backups or other data files are published
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const DIST = 'dist';
const REQUIRED_CSP_DIRECTIVES = [
  "default-src 'none'",
  "script-src 'self'",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
];
// Strings that look like URLs but are inert identifiers, not network targets.
const ALLOWED_URL_PREFIXES = ['http://www.w3.org/', 'https://www.w3.org/'];

// Reviewed one by one (Phase D) and allowed ONLY inside the bundled pdf.js
// files. None is contacted: they are license links, XML namespace names that
// pdf.js compares as strings, and fake URLs that the core-js polyfills parse
// to test the browser's URL support. A new URL after a pdf.js upgrade fails
// this check until it has been reviewed and added here.
const PDFJS_FILES = /^assets\/(pdf\.worker\.min|pdfjsApp)-[\w-]+\.m?js$/;
const PDFJS_REVIEWED_URLS = new Set([
  // License links in comments.
  'http://www.apache.org/licenses/LICENSE-2.0',
  'https://github.com/zloirock/core-js/blob/v3.50.0/LICENSE',
  'https://github.com/zloirock/core-js',
  // core-js feature tests for the URL API (parsed, never fetched).
  'https://a', 'https://a/c%20d?a=1&c=3', 'https://a@b', 'https://тест', 'https://a#б', 'https://x',
  'http://${e}', 'http://example.com', 'https://foo.bar',
  // XML namespace identifiers for XFA forms and XMP metadata.
  'http://www.xfa.org/schema/xci/', 'http://www.xfa.org/schema/xfa-connection-set/', 'http://www.xfa.org/schema/xfa-data/',
  'http://www.xfa.org/schema/xfa-form/', 'http://www.xfa.org/schema/xfa-locale-set/', 'http://www.xfa.org/schema/xfa-source-set/',
  'http://www.xfa.org/schema/xfa-template/', 'http://www.xfa.org/schema/xdc/', 'http://www.xfa.org/schema/xfa-data/1.0/',
  'http://ns.adobe.com/xdp/pdf/', 'http://ns.adobe.com/xdp/', 'http://ns.adobe.com/xfdf/', 'http://ns.adobe.com/xmpmeta/',
]);
const ALLOWED_EXTENSIONS = new Set(['.html', '.js', '.css', '.svg', '.png', '.ico', '.webmanifest', '.woff2', '.mjs']);

const failures = [];
const files = walk(DIST);
if (files.length === 0) failures.push('dist/ is empty; run `npm run build` first');

for (const file of files) {
  const rel = relative(DIST, file);
  const ext = extname(file).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) failures.push(`unexpected file type published: ${rel}`);
  if (ext === '.map') failures.push(`source map published: ${rel}`);
  if (!['.html', '.js', '.mjs', '.css', '.svg', '.webmanifest'].includes(ext)) continue;

  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/(?:https?:|wss?:)\/\/[^\s"'`)<>\\]+/g)) {
    const url = match[0];
    const reviewedPdfJsString = PDFJS_FILES.test(rel) && PDFJS_REVIEWED_URLS.has(url);
    if (!reviewedPdfJsString && !ALLOWED_URL_PREFIXES.some((prefix) => url.startsWith(prefix))) {
      failures.push(`external URL in ${rel}: ${url}`);
    }
  }
  if (/\/\/[#@]\s*sourceMappingURL=/.test(text)) failures.push(`sourceMappingURL reference in ${rel}`);
}

const html = safeRead(join(DIST, 'index.html'));
const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1];
if (!csp) {
  failures.push('index.html has no Content-Security-Policy meta tag');
} else {
  for (const directive of REQUIRED_CSP_DIRECTIVES) {
    if (!csp.includes(directive)) failures.push(`CSP is missing \`${directive}\``);
  }
  if (/unsafe-inline|unsafe-eval|\*/.test(csp)) failures.push('CSP contains unsafe-inline, unsafe-eval or a wildcard');
}
if (!/<meta name="referrer" content="no-referrer"/.test(html)) failures.push('index.html is missing no-referrer');
if (/<script(?![^>]*\bsrc=)[^>]*>/.test(html)) failures.push('index.html contains an inline script');

if (failures.length) {
  console.error(`Build output privacy check FAILED (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`Build output privacy check passed (${files.length} files).`);

function walk(dir) {
  try {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  } catch {
    return [];
  }
}

function safeRead(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
