/**
 * The window's view of the encrypted household data. In the Mac app this
 * calls the Rust commands in src-tauri/src/commands.rs, which hold the
 * passphrase and do all encryption and file writing. In a plain browser (UI
 * development and browser tests) a memory-only stand-in with the same rules
 * is used, and nothing is saved.
 */
import { invoke, isTauri } from '@tauri-apps/api/core';

/** Must match MIN_PASSPHRASE_CHARS in src-tauri/src/vault.rs. */
export const MIN_PASSPHRASE_CHARS = 12;

export type VaultStatus = 'none' | 'locked' | 'unlocked' | 'already_open';

export type VaultErrorCode =
  | 'no_vault'
  | 'vault_exists'
  | 'wrong_passphrase'
  | 'data_damaged'
  | 'excessive_work'
  | 'weak_passphrase'
  | 'too_large'
  | 'invalid_text'
  | 'read_failed'
  | 'write_failed'
  | 'locked'
  | 'already_open'
  | 'backup_unverified'
  | 'cancelled'
  | 'no_pending_restore'
  | 'unexpected';

const KNOWN_CODES = new Set<string>([
  'no_vault', 'vault_exists', 'wrong_passphrase', 'data_damaged', 'excessive_work', 'weak_passphrase',
  'too_large', 'invalid_text', 'read_failed', 'write_failed', 'locked', 'already_open',
  'backup_unverified', 'cancelled', 'no_pending_restore',
]);

export class VaultError extends Error {
  constructor(readonly code: VaultErrorCode) {
    super(`Vault error: ${code}`);
    this.name = 'VaultError';
  }
}

export interface Unlocked {
  ledger: string;
  recoveredFromPrevious: boolean;
}

export interface VaultBackend {
  /** False for the browser stand-in, which keeps nothing after the page closes. */
  readonly persistent: boolean;
  status(): Promise<VaultStatus>;
  create(passphrase: string, ledger: string): Promise<void>;
  unlock(passphrase: string): Promise<Unlocked>;
  save(ledger: string): Promise<void>;
  lock(): Promise<void>;
  /** Asks where to save, writes an encrypted backup (household passphrase), and checks it. */
  backupCreate(ledger: string, date: string): Promise<void>;
  /** Asks which backup to open and decrypts it with `passphrase`. Replaces nothing. */
  restoreOpen(passphrase: string): Promise<string>;
  /** Replaces the household data with the opened backup. True if the passphrase changed. */
  restoreCommit(): Promise<{ passphraseChanged: boolean }>;
  restoreCancel(): Promise<void>;
}

export function isStrongEnough(passphrase: string): boolean {
  return [...passphrase].length >= MIN_PASSPHRASE_CHARS && passphrase.trim() !== '';
}

function toVaultError(error: unknown): VaultError {
  return new VaultError(typeof error === 'string' && KNOWN_CODES.has(error) ? (error as VaultErrorCode) : 'unexpected');
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw toVaultError(error);
  }
}

export function tauriBackend(): VaultBackend {
  return {
    persistent: true,
    status: () => call<VaultStatus>('vault_status'),
    create: (passphrase, ledger) => call<void>('vault_create', { passphrase, ledger }),
    unlock: async (passphrase) => {
      const [ledger, recoveredFromPrevious] = await call<[string, boolean]>('vault_unlock', { passphrase });
      return { ledger, recoveredFromPrevious };
    },
    save: (ledger) => call<void>('vault_save', { ledger }),
    lock: () => call<void>('vault_lock'),
    backupCreate: (ledger, date) => call<void>('backup_create', { ledger, date }),
    restoreOpen: (passphrase) => call<string>('restore_open', { passphrase }),
    restoreCommit: async () => ({ passphraseChanged: await call<boolean>('restore_commit') }),
    restoreCancel: () => call<void>('restore_cancel'),
  };
}

/**
 * Browser stand-in: same rules and errors as the real vault, memory only.
 * "Choosing a backup file" picks the last backup made in this page, or
 * cancels if there is none.
 */
export function memoryBackend(): VaultBackend {
  let saved: { passphrase: string; ledger: string } | null = null;
  let unlocked = false;
  let lastBackup: { passphrase: string; ledger: string } | null = null;
  let pending: { passphrase: string; ledger: string } | null = null;
  return {
    persistent: false,
    status: async () => (unlocked ? 'unlocked' : saved ? 'locked' : 'none'),
    create: async (passphrase, ledger) => {
      if (!isStrongEnough(passphrase)) throw new VaultError('weak_passphrase');
      if (saved) throw new VaultError('vault_exists');
      saved = { passphrase, ledger };
      unlocked = true;
    },
    unlock: async (passphrase) => {
      if (!saved) throw new VaultError('no_vault');
      if (passphrase !== saved.passphrase) throw new VaultError('wrong_passphrase');
      unlocked = true;
      return { ledger: saved.ledger, recoveredFromPrevious: false };
    },
    save: async (ledger) => {
      if (!saved || !unlocked) throw new VaultError('locked');
      saved = { ...saved, ledger };
    },
    lock: async () => {
      unlocked = false;
      pending = null;
    },
    backupCreate: async (ledger) => {
      if (!saved || !unlocked) throw new VaultError('locked');
      lastBackup = { passphrase: saved.passphrase, ledger };
    },
    restoreOpen: async (passphrase) => {
      if (saved && !unlocked) throw new VaultError('locked');
      if (!lastBackup) throw new VaultError('cancelled');
      if (passphrase !== lastBackup.passphrase) throw new VaultError('wrong_passphrase');
      pending = { ...lastBackup };
      return pending.ledger;
    },
    restoreCommit: async () => {
      if (!pending) throw new VaultError('no_pending_restore');
      const passphraseChanged = saved !== null && saved.passphrase !== pending.passphrase;
      saved = pending;
      pending = null;
      unlocked = true;
      return { passphraseChanged };
    },
    restoreCancel: async () => {
      pending = null;
    },
  };
}

export function defaultBackend(): VaultBackend {
  return isTauri() ? tauriBackend() : memoryBackend();
}
