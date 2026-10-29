import { describe, expect, it } from 'vitest';
import { createHousehold, openHousehold, saveHousehold } from './household';
import { LedgerFormatError } from './ledger';
import { memoryBackend } from './vault';

const PASS = 'a long enough passphrase';

describe('household storage', () => {
  it('creates an empty household and reopens it', async () => {
    const vault = memoryBackend();
    const created = await createHousehold(vault, PASS);
    await vault.lock();
    const opened = await openHousehold(vault, PASS);
    expect(opened.ledger).toEqual(created);
    expect(opened.recoveredFromPrevious).toBe(false);
  });

  it('saves changes', async () => {
    const vault = memoryBackend();
    const ledger = await createHousehold(vault, PASS);
    ledger.settings.householdName = 'Test household';
    await saveHousehold(vault, ledger);
    await vault.lock();
    expect((await openHousehold(vault, PASS)).ledger.settings.householdName).toBe('Test household');
  });

  it('locks again if the decrypted data is not a valid ledger, so nothing can overwrite it', async () => {
    const vault = memoryBackend();
    await vault.create(PASS, '{"schemaVersion":99}');
    await vault.lock();
    await expect(openHousehold(vault, PASS)).rejects.toMatchObject({ code: 'newer_version' });
    expect(await vault.status()).toBe('locked');
    await expect(vault.save('{}')).rejects.toMatchObject({ code: 'locked' });
  });

  it('refuses to save an invalid ledger', async () => {
    const vault = memoryBackend();
    const ledger = await createHousehold(vault, PASS);
    ledger.transactions.push({ id: 'bad' } as never);
    await expect(saveHousehold(vault, ledger)).rejects.toBeInstanceOf(LedgerFormatError);
    await vault.lock();
    expect((await openHousehold(vault, PASS)).ledger.transactions).toEqual([]);
  });
});
