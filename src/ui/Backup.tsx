import { useState } from 'preact/hooks';
import type { BackupSummary } from '../storage/household';
import { Header } from './Header';

export function formatDay(iso: string): string {
  const date = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

/** On the welcome screen: when the last backup was made, and the two actions. */
export function BackupCard({
  lastBackupAt,
  onBackup,
  onRestore,
}: {
  lastBackupAt?: string | undefined;
  onBackup: () => Promise<{ ok: true } | { ok: false; message: string | null }>;
  onRestore: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const backup = async () => {
    setBusy(true);
    setResult(null);
    const outcome = await onBackup();
    setBusy(false);
    if (outcome.ok) {
      setResult({
        ok: true,
        text: 'Backup saved and checked. Keep it somewhere safe, like a USB drive. To restore it, you will need your household passphrase.',
      });
    } else if (outcome.message) {
      setResult({ ok: false, text: outcome.message });
    }
  };

  return (
    <section class="backup-card" aria-labelledby="backup-heading" data-section="backups">
      <h2 id="backup-heading">Backups</h2>
      <p class={lastBackupAt ? 'backup-when' : 'backup-when backup-never'}>
        {lastBackupAt ? `Last backup: ${formatDay(lastBackupAt)}` : 'No backup yet.'}
      </p>
      <p class="hint">
        A backup is an encrypted copy of your household's records. It's how you get them back if this Mac is lost,
        replaced or damaged.
      </p>
      <div class="button-row">
        <button type="button" class="primary-button" onClick={backup} disabled={busy}>
          {busy ? 'Saving backup…' : 'Make a backup'}
        </button>
        <button type="button" class="secondary-button" onClick={onRestore} disabled={busy}>
          Restore from a backup
        </button>
      </div>
      {result && (
        <p class={result.ok ? 'form-success' : 'form-error'} role={result.ok ? 'status' : 'alert'}>
          {result.text}
        </p>
      )}
    </section>
  );
}

type OpenResult = { summary: BackupSummary } | { error: string };

/** Restore in two steps; nothing is replaced until the final confirmation. */
export function RestoreScreen({
  replacing,
  onOpen,
  onConfirm,
  onCancel,
}: {
  /** True when household data already exists on this Mac and will be replaced. */
  replacing: boolean;
  onOpen: (passphrase: string) => Promise<OpenResult>;
  onConfirm: () => Promise<string | null>;
  onCancel: () => void;
}) {
  const [passphrase, setPassphrase] = useState('');
  const [summary, setSummary] = useState<BackupSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const choose = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await onOpen(passphrase);
    setBusy(false);
    if ('summary' in result) setSummary(result.summary);
    else setError(result.error);
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    const problem = await onConfirm();
    setBusy(false);
    if (problem) setError(problem);
  };

  return (
    <main class="vault-screen">
      <Header />
      {summary === null ? (
        <form class="vault-card" data-screen="restore-choose" onSubmit={choose}>
          <h2>Restore from a backup</h2>
          <p>
            <strong>Step 1 of 2.</strong> Enter the household passphrase that was in use when the backup was made, then
            choose the backup file.
          </p>
          <label>
            Household passphrase
            <input
              type="password"
              autocomplete="current-password"
              value={passphrase}
              onInput={(e) => setPassphrase(e.currentTarget.value)}
              disabled={busy}
              required
            />
          </label>
          <p class="hint">Nothing is replaced yet. You'll see what the backup contains first.</p>
          {error && (
            <p class="form-error" role="alert">
              {error}
            </p>
          )}
          <div class="button-row">
            <button type="submit" class="primary-button" disabled={busy || passphrase === ''}>
              {busy ? 'Opening…' : 'Choose backup file…'}
            </button>
            <button type="button" class="secondary-button" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <section class="vault-card" data-screen="restore-confirm">
          <h2>Restore this backup?</h2>
          <p>
            <strong>Step 2 of 2.</strong> The backup opened and passed its checks. It contains:
          </p>
          <ul class="summary-list">
            <li>
              {summary.accounts} {summary.accounts === 1 ? 'account' : 'accounts'}
            </li>
            <li>
              {summary.transactions} {summary.transactions === 1 ? 'transaction' : 'transactions'}
              {summary.firstDate && summary.lastDate
                ? `, from ${formatDay(summary.firstDate)} to ${formatDay(summary.lastDate)}`
                : ''}
            </li>
            <li>{summary.backedUpAt ? `Backed up on ${formatDay(summary.backedUpAt)}` : 'Backup date unknown'}</li>
          </ul>
          {replacing ? (
            <p class="warning">
              <strong>This replaces all household data currently on this Mac</strong> with the backup. A copy of the
              current data is kept on this Mac, but it can't be reopened from the app yet.
            </p>
          ) : (
            <p class="hint">This becomes the household data on this Mac.</p>
          )}
          <p class="hint">Afterwards, unlock the app with the passphrase you just entered.</p>
          {error && (
            <p class="form-error" role="alert">
              {error}
            </p>
          )}
          <div class="button-row">
            <button type="button" class={replacing ? 'danger-button' : 'primary-button'} onClick={confirm} disabled={busy}>
              {busy ? 'Restoring…' : replacing ? 'Replace my current data' : 'Restore this backup'}
            </button>
            <button type="button" class="secondary-button" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
          </div>
        </section>
      )}
    </main>
  );
}
