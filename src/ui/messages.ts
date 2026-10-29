import type { VaultErrorCode } from '../storage/vault';
import type { LedgerFormatErrorCode } from '../storage/ledger';

/** Plain-language messages for fixed error codes. Never include data. */
const MESSAGES: Record<VaultErrorCode | LedgerFormatErrorCode, string> = {
  wrong_passphrase: "That passphrase didn't open it. Check for typos and try again.",
  weak_passphrase: 'Please use at least 12 characters. A few unrelated words work well.',
  vault_exists: 'Household data already exists on this Mac, so a new household was not created.',
  no_vault: 'No household data was found on this Mac.',
  data_damaged: 'The saved data could not be read. It may be damaged. Nothing was changed.',
  excessive_work: 'This file asks for far more unlocking work than this Mac allows, so it was not opened.',
  too_large: 'This data is too large to open.',
  invalid_text: 'The saved data could not be read. Nothing was changed.',
  read_failed: "The saved data couldn't be read from disk. Nothing was changed.",
  write_failed: "Your changes couldn't be saved. Your previously saved data is safe. Please try again.",
  locked: 'The app is locked. Unlock it to continue.',
  already_open: 'Household Money is already open in another window.',
  not_json: 'The saved data could not be read. Nothing was changed.',
  invalid_shape: 'The saved data is not in the expected format. Nothing was changed.',
  broken_reference: 'The saved data is inconsistent. Nothing was changed.',
  newer_version: 'This data was saved by a newer version of Household Money. Please update the app.',
  backup_unverified:
    "The backup couldn't be checked after saving, so it may be incomplete. Please try again, or choose another place.",
  cancelled: 'No file was chosen.',
  no_pending_restore: 'Please choose the backup again.',
  unexpected: 'Something unexpected went wrong. Nothing was changed.',
};

/** Wording for problems with a backup file being restored. Your current data is never touched. */
const BACKUP_MESSAGES: Partial<Record<keyof typeof MESSAGES, string>> = {
  wrong_passphrase:
    "That passphrase didn't open this backup. Use the household passphrase from when the backup was made.",
  data_damaged: "This file isn't a Household Money backup, or it's damaged. Your current data hasn't been changed.",
  invalid_text: "This backup is damaged. Your current data hasn't been changed.",
  not_json: "This backup is damaged. Your current data hasn't been changed.",
  invalid_shape: "This backup isn't in the expected format. Your current data hasn't been changed.",
  broken_reference: "This backup's contents are inconsistent, so it wasn't used. Your current data hasn't been changed.",
  newer_version: 'This backup was made by a newer version of Household Money. Update the app, then try again.',
  too_large: "This file is too large to be a Household Money backup. Your current data hasn't been changed.",
  excessive_work: "This file asks for far more unlocking work than allowed, so it wasn't opened.",
  read_failed: "The backup file couldn't be read. Your current data hasn't been changed.",
  write_failed: "The restore couldn't be saved, so nothing was replaced. Your current data is safe.",
};

export function messageFor(code: string, context: 'backup' | 'general' = 'general'): string {
  const key = code as keyof typeof MESSAGES;
  return (context === 'backup' ? BACKUP_MESSAGES[key] : undefined) ?? MESSAGES[key] ?? MESSAGES.unexpected;
}
