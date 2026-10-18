// Fails if any tracked or staged file looks like private financial data.
// Real statements, backups and exports must never enter source control.
// The only PDFs allowed are synthetic fixtures under tests/fixtures/synthetic/.
import { execFileSync } from 'node:child_process';

const SYNTHETIC_DIR = 'tests/fixtures/synthetic/';
const FORBIDDEN = [
  { pattern: /\.pdf$/i, allowUnder: SYNTHETIC_DIR, reason: 'PDF outside the synthetic fixtures folder' },
  { pattern: /\.hhbackup(\.json)?$/i, reason: 'app backup file' },
  { pattern: /backup.*\.json$/i, reason: 'possible backup export' },
  { pattern: /\.(csv|ofx|qfx|qif|xlsx?)$/i, reason: 'financial export format' },
  { pattern: /(^|\/)(private|statements|real-data)\//i, reason: 'private data folder' },
  { pattern: /(^|\/)\.env(\.|$)/, reason: 'environment/credentials file' },
];

const output = execFileSync('git', ['ls-files', '--cached', '-z'], { encoding: 'utf8' });
const files = output.split('\0').filter(Boolean);
const failures = [];
for (const file of files) {
  for (const rule of FORBIDDEN) {
    if (rule.pattern.test(file) && !(rule.allowUnder && file.startsWith(rule.allowUnder))) {
      failures.push(`${file}: ${rule.reason}`);
    }
  }
}

if (failures.length) {
  console.error('Repository hygiene check FAILED. These files must not be committed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`Repository hygiene check passed (${files.length} tracked files).`);
