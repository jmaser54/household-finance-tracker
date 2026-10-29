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
  unexpected: 'Something unexpected went wrong. Nothing was changed.',
};

export function messageFor(code: string): string {
  return MESSAGES[code as keyof typeof MESSAGES] ?? MESSAGES.unexpected;
}
