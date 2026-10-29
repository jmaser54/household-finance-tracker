import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { confirmRestore, createHousehold, makeBackup, openBackup, openHousehold } from '../storage/household';
import type { LedgerDocument } from '../storage/ledger';
import { defaultBackend, type VaultBackend } from '../storage/vault';
import { RestoreScreen } from './Backup';
import { Landing } from './Landing';
import { messageFor } from './messages';
import { useIdleLock } from './useIdleLock';
import { NoticeScreen, SetupScreen, UnlockScreen } from './VaultScreens';

type Ready = {
  name: 'ready';
  ledger: LedgerDocument;
  recoveredFromPrevious: boolean;
  restored?: { passphraseChanged: boolean };
};

type Screen =
  | { name: 'loading' }
  | { name: 'setup' }
  | { name: 'unlock' }
  | Ready
  /** `from` is where Cancel returns to: the setup screen, or the open household. */
  | { name: 'restore'; from: { name: 'setup' } | Ready }
  | { name: 'already_open' }
  | { name: 'problem'; code: string };

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unexpected';
}

export function App({ backend: provided }: { backend?: VaultBackend }) {
  const backend = useMemo(() => provided ?? defaultBackend(), [provided]);
  const [screen, setScreen] = useState<Screen>({ name: 'loading' });
  const [restoring, setRestoring] = useState<LedgerDocument | null>(null);

  useEffect(() => {
    backend
      .status()
      .then((status) =>
        setScreen(
          status === 'none' ? { name: 'setup' } : status === 'already_open' ? { name: 'already_open' } : { name: 'unlock' },
        ),
      )
      .catch((error) => setScreen({ name: 'problem', code: errorCode(error) }));
  }, [backend]);

  const create = async (passphrase: string) => {
    try {
      const ledger = await createHousehold(backend, passphrase);
      setScreen({ name: 'ready', ledger, recoveredFromPrevious: false });
      return null;
    } catch (error) {
      return messageFor(errorCode(error));
    }
  };

  const unlock = async (passphrase: string) => {
    try {
      const opened = await openHousehold(backend, passphrase);
      setScreen({ name: 'ready', ...opened });
      return null;
    } catch (error) {
      return messageFor(errorCode(error));
    }
  };

  const lock = useCallback(async () => {
    await backend.lock().catch(() => undefined);
    // In the Mac app, reloading discards every decrypted value held by the page.
    if (backend.persistent) window.location.reload();
    else setScreen({ name: 'unlock' });
  }, [backend]);

  const backup = async (ready: Ready) => {
    try {
      const ledger = await makeBackup(backend, ready.ledger);
      setScreen({ ...ready, ledger });
      return { ok: true as const };
    } catch (error) {
      const code = errorCode(error);
      return { ok: false as const, message: code === 'cancelled' ? null : messageFor(code) };
    }
  };

  const openRestore = async (passphrase: string) => {
    try {
      const opened = await openBackup(backend, passphrase);
      setRestoring(opened.ledger);
      return { summary: opened.summary };
    } catch (error) {
      const code = errorCode(error);
      return { error: messageFor(code, 'backup') };
    }
  };

  const confirm = async () => {
    if (!restoring) return messageFor('no_pending_restore');
    try {
      const { ledger, passphraseChanged } = await confirmRestore(backend, restoring);
      setRestoring(null);
      setScreen({ name: 'ready', ledger, recoveredFromPrevious: false, restored: { passphraseChanged } });
      return null;
    } catch (error) {
      return messageFor(errorCode(error), 'backup');
    }
  };

  const cancelRestore = async (from: { name: 'setup' } | Ready) => {
    setRestoring(null);
    await backend.restoreCancel().catch(() => undefined);
    setScreen(from);
  };

  // Auto-lock also covers the restore screen once a household is open.
  useIdleLock(screen.name === 'ready' || (screen.name === 'restore' && screen.from.name === 'ready'), lock);

  switch (screen.name) {
    case 'loading':
      return <main class="vault-screen" aria-busy="true" />;
    case 'setup':
      return <SetupScreen onCreate={create} onRestoreInstead={() => setScreen({ name: 'restore', from: { name: 'setup' } })} />;
    case 'unlock':
      return <UnlockScreen onUnlock={unlock} />;
    case 'restore':
      return (
        <RestoreScreen
          replacing={screen.from.name === 'ready'}
          onOpen={openRestore}
          onConfirm={confirm}
          onCancel={() => cancelRestore(screen.from)}
        />
      );
    case 'already_open':
      return <NoticeScreen title="Already open" message={messageFor('already_open')} />;
    case 'problem':
      return <NoticeScreen title="Something went wrong" message={messageFor(screen.code)} />;
    case 'ready':
      return (
        <Landing
          onLock={lock}
          backups={{
            lastBackupAt: screen.ledger.settings.lastBackupAt,
            onBackup: () => backup(screen),
            onRestore: () => setScreen({ name: 'restore', from: screen }),
          }}
          notices={
            <>
              {!backend.persistent && (
                <p class="notice" role="status">
                  Browser preview: nothing is saved. Saving works only in the Mac app.
                </p>
              )}
              {screen.recoveredFromPrevious && (
                <p class="notice notice-warning" role="alert">
                  The latest save couldn't be read, so the previous saved version was opened.
                </p>
              )}
              {screen.restored && (
                <p class="notice notice-success" role="status">
                  Restored from your backup.
                  {screen.restored.passphraseChanged &&
                    ' From now on, unlock with the passphrase you used for the restore.'}
                </p>
              )}
            </>
          }
        />
      );
  }
}
