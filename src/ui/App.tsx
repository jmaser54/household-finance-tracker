import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { createHousehold, openHousehold } from '../storage/household';
import type { LedgerDocument } from '../storage/ledger';
import { defaultBackend, type VaultBackend } from '../storage/vault';
import { Landing } from './Landing';
import { messageFor } from './messages';
import { useIdleLock } from './useIdleLock';
import { NoticeScreen, SetupScreen, UnlockScreen } from './VaultScreens';

type Screen =
  | { name: 'loading' }
  | { name: 'setup' }
  | { name: 'unlock' }
  | { name: 'ready'; ledger: LedgerDocument; recoveredFromPrevious: boolean }
  | { name: 'already_open' }
  | { name: 'problem'; code: string };

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unexpected';
}

export function App({ backend: provided }: { backend?: VaultBackend }) {
  const backend = useMemo(() => provided ?? defaultBackend(), [provided]);
  const [screen, setScreen] = useState<Screen>({ name: 'loading' });

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

  useIdleLock(screen.name === 'ready', lock);

  switch (screen.name) {
    case 'loading':
      return <main class="vault-screen" aria-busy="true" />;
    case 'setup':
      return <SetupScreen onCreate={create} />;
    case 'unlock':
      return <UnlockScreen onUnlock={unlock} />;
    case 'already_open':
      return <NoticeScreen title="Already open" message={messageFor('already_open')} />;
    case 'problem':
      return <NoticeScreen title="Something went wrong" message={messageFor(screen.code)} />;
    case 'ready':
      return (
        <Landing
          onLock={lock}
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
            </>
          }
        />
      );
  }
}
