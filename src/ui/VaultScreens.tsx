import { useState } from 'preact/hooks';
import { isStrongEnough, MIN_PASSPHRASE_CHARS } from '../storage/vault';
import { Header } from './Header';
import { messageFor } from './messages';

type Submit = (passphrase: string) => Promise<string | null>;

/** First run: choose the household passphrase. */
export function SetupScreen({ onCreate }: { onCreate: Submit }) {
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: Event) => {
    event.preventDefault();
    if (!isStrongEnough(passphrase)) return setError(messageFor('weak_passphrase'));
    if (passphrase !== confirm) return setError("The two passphrases don't match.");
    setBusy(true);
    setError(await onCreate(passphrase));
    setBusy(false);
  };

  return (
    <main class="vault-screen">
      <Header />
      <form class="vault-card" data-screen="setup" onSubmit={submit}>
        <h2>Choose a household passphrase</h2>
        <p>Your household's money records are saved on this Mac, encrypted with this passphrase.</p>
        <label>
          Passphrase
          <input
            type="password"
            autocomplete="new-password"
            value={passphrase}
            onInput={(e) => setPassphrase(e.currentTarget.value)}
            disabled={busy}
            required
          />
        </label>
        <label>
          Type it again
          <input
            type="password"
            autocomplete="new-password"
            value={confirm}
            onInput={(e) => setConfirm(e.currentTarget.value)}
            disabled={busy}
            required
          />
        </label>
        <p class="hint">At least {MIN_PASSPHRASE_CHARS} characters. A few unrelated words are easy to remember and hard to guess.</p>
        <p class="warning">
          <strong>Write it down somewhere safe.</strong> If it's forgotten, the data can't be recovered by anyone.
        </p>
        {error && (
          <p class="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" class="primary-button" disabled={busy}>
          {busy ? 'Setting up…' : 'Create household'}
        </button>
      </form>
    </main>
  );
}

/** Saved data exists: unlock it. */
export function UnlockScreen({ onUnlock }: { onUnlock: Submit }) {
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    const problem = await onUnlock(passphrase);
    setBusy(false);
    if (problem) {
      setError(problem);
      setPassphrase('');
    }
  };

  return (
    <main class="vault-screen">
      <Header />
      <form class="vault-card" data-screen="unlock" onSubmit={submit}>
        <h2>Welcome back</h2>
        <label>
          Household passphrase
          <input
            type="password"
            autocomplete="current-password"
            value={passphrase}
            onInput={(e) => setPassphrase(e.currentTarget.value)}
            disabled={busy}
            autoFocus
            required
          />
        </label>
        {error && (
          <p class="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" class="primary-button" disabled={busy || passphrase === ''}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
      </form>
    </main>
  );
}

/** A message with no action other than what the text explains. */
export function NoticeScreen({ title, message }: { title: string; message: string }) {
  return (
    <main class="vault-screen">
      <Header />
      <section class="vault-card" data-screen="notice" role="alert">
        <h2>{title}</h2>
        <p>{message}</p>
      </section>
    </main>
  );
}
