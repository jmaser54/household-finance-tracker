// Fails if any tracked or staged file, or any file ever added in Git history,
// looks like private financial data. Deleting a file in a later commit does
// not remove it from history, so history is checked too (CI must fetch full
// history for this to be meaningful). Real statements, backups and exports
// must never enter source control. The only PDFs allowed are synthetic
// fixtures under tests/fixtures/synthetic/.
import { execFileSync } from 'node:child_process';

const SYNTHETIC_DIR = 'tests/fixtures/synthetic/';
const FORBIDDEN = [
  { pattern: /\.pdf$/i, allowUnder: SYNTHETIC_DIR, reason: 'PDF outside the synthetic fixtures folder' },
  { pattern: /\.hhbackup(\.json)?$/i, reason: 'app backup file' },
  { pattern: /\.hmbackup$/i, reason: 'Household Money backup file' },
  { pattern: /\.age$/i, reason: 'encrypted household data file' },
  { pattern: /backup.*\.json$/i, reason: 'possible backup export' },
  { pattern: /\.(csv|ofx|qfx|qif|xlsx?)$/i, reason: 'financial export format' },
  { pattern: /(^|\/)(private|statements|real-data)\//i, reason: 'private data folder' },
  { pattern: /(^|\/)\.env(\.|$)/, reason: 'environment/credentials file' },
];

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const tracked = git(['ls-files', '--cached', '-z']).split('\0').filter(Boolean);
let history = [];
try {
  history = git(['log', '--all', '--diff-filter=A', '--name-only', '--pretty=format:', '-z']).split('\0');
} catch {
  // A repository with no commits yet has no history to scan.
}
if (git(['rev-parse', '--is-shallow-repository']).trim() === 'true') {
  console.error('Repository hygiene check needs full history; fetch with depth 0.');
  process.exit(1);
}
const files = [...new Set([...tracked, ...history].map((f) => f.trim()).filter(Boolean))];
const failures = [];
for (const file of files) {
  for (const rule of FORBIDDEN) {
    if (rule.pattern.test(file) && !(rule.allowUnder && file.startsWith(rule.allowUnder))) {
      failures.push(`${file}: ${rule.reason}${tracked.includes(file) ? '' : ' (in Git history; removing it requires rewriting history)'}`);
    }
  }
}

if (failures.length) {
  console.error('Repository hygiene check FAILED. These files must not be committed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`Repository hygiene check passed (${tracked.length} tracked files, ${files.length} paths including history).`);
