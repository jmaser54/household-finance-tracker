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
    if (!ALLOWED_URL_PREFIXES.some((prefix) => url.startsWith(prefix))) {
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
