import { emptyLedger, parseLedger, serializeLedger, type LedgerDocument } from './ledger';
import type { VaultBackend } from './vault';

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
