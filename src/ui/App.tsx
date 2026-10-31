import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { confirmRestore, createHousehold, makeBackup, openBackup, openHousehold, saveHousehold } from '../storage/household';
import type { LedgerDocument } from '../storage/ledger';
import { defaultBackend, type VaultBackend } from '../storage/vault';
import { RestoreScreen } from './Backup';
import { ImportScreen } from './Import';
import type { ImportResult } from '../import/plan';
import { isReadyToSort, upgradeLedger } from '../review/edits';
import { Landing } from './Landing';
import { messageFor } from './messages';
import { createSaveQueue, type SaveState } from './saveQueue';
import { NO_FILTERS, TransactionsScreen, type Filters } from './Transactions';
import { useIdleLock } from './useIdleLock';
import { NoticeScreen, SetupScreen, UnlockScreen } from './VaultScreens';

type Ready = {
  name: 'ready';
  ledger: LedgerDocument;
  recoveredFromPrevious: boolean;
  restored?: { passphraseChanged: boolean };
  imported?: { added: number; statements: number; needsReview: number };
  /** Set while the transaction list is open. */
  transactions?: { filters: Filters };
};

/** Loads pdf.js (a separate bundled chunk) only when statements are added. */
const loadPdfJs = () => import('../import/pdfjsApp').then((m) => m.appPdfJs);

type Screen =
  | { name: 'loading' }
  | { name: 'setup' }
  | { name: 'unlock' }
  | Ready
  /** `from` is where Cancel returns to: the setup screen, or the open household. */
  | { name: 'restore'; from: { name: 'setup' } | Ready }
  | { name: 'import'; from: Ready; files: File[] }
  | { name: 'already_open' }
  | { name: 'problem'; code: string };

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unexpected';
}

export function App({ backend: provided }: { backend?: VaultBackend }) {
  const backend = useMemo(() => provided ?? defaultBackend(), [provided]);
  const [screen, setScreen] = useState<Screen>({ name: 'loading' });
  const [restoring, setRestoring] = useState<LedgerDocument | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  // Edits are shown at once and saved in the background, one save at a time.
  const saver = useMemo(() => createSaveQueue((ledger: LedgerDocument) => saveHousehold(backend, ledger), setSaveState), [backend]);

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
      setScreen({ name: 'ready', ...opened, ledger: upgradeLedger(opened.ledger) });
      return null;
    } catch (error) {
      return messageFor(errorCode(error));
    }
  };

  const lock = useCallback(async () => {
    await saver.flush().catch(() => undefined);
    await backend.lock().catch(() => undefined);
    // In the Mac app, reloading discards every decrypted value held by the page.
    if (backend.persistent) window.location.reload();
    else setScreen({ name: 'unlock' });
  }, [backend, saver]);

  const backup = async (ready: Ready) => {
    try {
      await saver.flush();
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
      setScreen({ name: 'ready', ledger: upgradeLedger(ledger), recoveredFromPrevious: false, restored: { passphraseChanged } });
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

  const confirmImport = async (result: ImportResult) => {
    try {
      await saver.flush();
      await saveHousehold(backend, result.ledger);
      setScreen({
        name: 'ready',
        ledger: result.ledger,
        recoveredFromPrevious: false,
        imported: { added: result.added, statements: result.statements, needsReview: result.needsReview },
      });
      return null;
    } catch (error) {
      return messageFor(errorCode(error));
    }
  };

  // Auto-lock also covers the restore and import screens once a household is open.
  useIdleLock(
    screen.name === 'ready' || screen.name === 'import' || (screen.name === 'restore' && screen.from.name === 'ready'),
    lock,
  );

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
    case 'import':
      return (
        <ImportScreen
          ledger={screen.from.ledger}
          files={screen.files}
          pdfjs={loadPdfJs}
          onCancel={() => setScreen(screen.from)}
          onConfirm={confirmImport}
        />
      );
    case 'already_open':
      return <NoticeScreen title="Already open" message={messageFor('already_open')} />;
    case 'problem':
      return <NoticeScreen title="Something went wrong" message={messageFor(screen.code)} />;
    case 'ready':
      if (screen.transactions) {
        return (
          <TransactionsScreen
            ledger={screen.ledger}
            saveState={saveState}
            initialFilters={screen.transactions.filters}
            onChange={(ledger) => {
              setScreen((current) => (current.name === 'ready' ? { ...current, ledger } : current));
              saver.schedule(ledger);
            }}
            onHome={() =>
              setScreen((current) => {
                if (current.name !== 'ready') return current;
                const { transactions: _list, ...home } = current;
                return home;
              })
            }
            onLock={lock}
          />
        );
      }
      return (
        <Landing
          money={{
            transactions: screen.ledger.transactions.length,
            statements: screen.ledger.statements.length,
            toSort: screen.ledger.transactions.filter(isReadyToSort).length,
          }}
          onTransactions={(onlyToSort) => {
            const { imported: _imported, restored: _restored, ...rest } = screen;
            setScreen({ ...rest, transactions: { filters: { ...NO_FILTERS, onlyToSort } } });
          }}
          onLock={lock}
          onStatements={(files) => setScreen({ name: 'import', from: screen, files })}
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
              {screen.imported && (
                <p class="notice notice-success" role="status">
                  Added {screen.imported.added} {screen.imported.added === 1 ? 'transaction' : 'transactions'} from{' '}
                  {screen.imported.statements} {screen.imported.statements === 1 ? 'statement' : 'statements'}.
                  {screen.imported.needsReview > 0 &&
                    ` ${screen.imported.needsReview} need a closer look later (for example, choosing a category).`}
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
