// Verifies every shipped script parses in the oldest engine the app supports
// (scripts/engine-floor.mjs). Each file is compiled twice with Vite's own
// compiler: once leaving syntax as is and once for the engine floor. Any
// difference is syntax that engine lacks; for example class static blocks,
// which made pdf.js fail to load on macOS Monterey ("Unexpected token").
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { transformWithOxc } from 'vite';
import { ENGINE_FLOOR } from './engine-floor.mjs';

const ASSETS = join('dist', 'assets');
const files = readdirSync(ASSETS).filter((f) => /\.m?js$/.test(f));
const failures = [];
if (files.length === 0) failures.push('no scripts in dist/assets; run `npm run build` first');

for (const file of files) {
  const source = readFileSync(join(ASSETS, file), 'utf8');
  const asIs = await transformWithOxc(source, file, { target: 'esnext' });
  const lowered = await transformWithOxc(source, file, { target: ENGINE_FLOOR });
  if (asIs.code !== lowered.code) {
    const at = firstDifference(asIs.code, lowered.code);
    failures.push(`${file} uses syntax ${ENGINE_FLOOR} lacks, near: ${JSON.stringify(asIs.code.slice(Math.max(0, at - 40), at + 40))}`);
  }
}

if (failures.length) {
  console.error(`Engine syntax check FAILED (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`Engine syntax check passed (${files.length} scripts parse in ${ENGINE_FLOOR}).`);

function firstDifference(a, b) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return i;
}
