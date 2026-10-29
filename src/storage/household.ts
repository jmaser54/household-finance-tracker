import { emptyLedger, parseLedger, serializeLedger, type LedgerDocument } from './ledger';
import { VaultError, type VaultBackend } from './vault';

export interface OpenHousehold {
  ledger: LedgerDocument;
  recoveredFromPrevious: boolean;
}

/** Starts a new, empty household ledger protected by `passphrase`. */
export async function createHousehold(backend: VaultBackend, passphrase: string): Promise<LedgerDocument> {
  const ledger = emptyLedger();
  await backend.create(passphrase, serializeLedger(ledger));
  return ledger;
}

/**
 * Unlocks and validates the saved ledger. If it decrypts but is not a valid
 * ledger, the vault is locked again, so nothing can be saved over it.
 */
export async function openHousehold(backend: VaultBackend, passphrase: string): Promise<OpenHousehold> {
  const unlocked = await backend.unlock(passphrase);
  try {
    return { ledger: parseLedger(unlocked.ledger), recoveredFromPrevious: unlocked.recoveredFromPrevious };
  } catch (error) {
    await backend.lock();
    throw error;
  }
}

export async function saveHousehold(backend: VaultBackend, ledger: LedgerDocument): Promise<void> {
  await backend.save(serializeLedger(ledger));
}

/**
 * Makes an encrypted backup the person saves where they choose, then records
 * the time on the household data. Returns the updated ledger.
 */
export async function makeBackup(backend: VaultBackend, ledger: LedgerDocument, now = new Date()): Promise<LedgerDocument> {
  const stamped: LedgerDocument = { ...ledger, settings: { ...ledger.settings, lastBackupAt: now.toISOString() } };
  await backend.backupCreate(serializeLedger(stamped), localDate(now));
  await saveHousehold(backend, stamped);
  return stamped;
}

function localDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export interface BackupSummary {
  accounts: number;
  statements: number;
  transactions: number;
  firstDate?: string;
  lastDate?: string;
  backedUpAt?: string;
}

export function summarize(ledger: LedgerDocument): BackupSummary {
  const dates = ledger.transactions.map((t) => t.postedDate).sort();
  return {
    accounts: ledger.accounts.length,
    statements: ledger.statements.length,
    transactions: ledger.transactions.length,
    ...(dates.length ? { firstDate: dates[0]!, lastDate: dates[dates.length - 1]! } : {}),
    ...(ledger.settings.lastBackupAt ? { backedUpAt: ledger.settings.lastBackupAt } : {}),
  };
}

/**
 * Opens a backup the person picks and checks it fully before anything is
 * replaced. A backup that decrypts but is not a valid ledger (damaged
 * contents, or made by a newer version) is refused and forgotten.
 */
export async function openBackup(backend: VaultBackend, passphrase: string): Promise<{ ledger: LedgerDocument; summary: BackupSummary }> {
  const json = await backend.restoreOpen(passphrase);
  try {
    const ledger = parseLedger(json);
    return { ledger, summary: summarize(ledger) };
  } catch (error) {
    await backend.restoreCancel();
    throw error;
  }
}

/** Replaces the household data with the backup opened by `openBackup`. */
export async function confirmRestore(backend: VaultBackend, opened: LedgerDocument): Promise<{ ledger: LedgerDocument; passphraseChanged: boolean }> {
  const { passphraseChanged } = await backend.restoreCommit();
  return { ledger: opened, passphraseChanged };
}

export { VaultError };
