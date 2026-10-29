import { describe, expect, it } from 'vitest';
import { confirmRestore, createHousehold, makeBackup, openBackup, openHousehold, saveHousehold } from './household';
import { LedgerFormatError } from './ledger';
import { memoryBackend, VaultError } from './vault';

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

describe('backup and restore', () => {
  const NOW = new Date('2026-10-29T15:30:00Z');

  async function householdWithBackup() {
    const vault = memoryBackend();
    const ledger = await createHousehold(vault, PASS);
    ledger.settings.householdName = 'Backed-up household';
    await saveHousehold(vault, ledger);
    const backedUp = await makeBackup(vault, ledger, NOW);
    return { vault, backedUp };
  }

  it('records the backup time on the household data', async () => {
    const { vault, backedUp } = await householdWithBackup();
    expect(backedUp.settings.lastBackupAt).toBe(NOW.toISOString());
    await vault.lock();
    expect((await openHousehold(vault, PASS)).ledger.settings.lastBackupAt).toBe(NOW.toISOString());
  });

  it('does not record a backup time when the person cancels the save panel', async () => {
    const vault = memoryBackend();
    const ledger = await createHousehold(vault, PASS);
    const failing = { ...vault, backupCreate: () => Promise.reject(new VaultError('cancelled')) };
    await expect(makeBackup(failing, ledger, NOW)).rejects.toMatchObject({ code: 'cancelled' });
    await vault.lock();
    expect((await openHousehold(vault, PASS)).ledger.settings.lastBackupAt).toBeUndefined();
  });

  it('restores a backup over newer data after confirmation', async () => {
    const { vault } = await householdWithBackup();
    const current = (await openHousehold(vault, PASS).catch(() => null)) ?? null;
    expect(current).not.toBeNull();
    const changed = current!.ledger;
    changed.settings.householdName = 'Changed after the backup';
    await saveHousehold(vault, changed);

    const opened = await openBackup(vault, PASS);
    expect(opened.summary).toMatchObject({ accounts: 0, transactions: 0, backedUpAt: NOW.toISOString() });
    // Opening alone replaces nothing.
    await vault.lock();
    expect((await openHousehold(vault, PASS)).ledger.settings.householdName).toBe('Changed after the backup');

    const reopened = await openBackup(vault, PASS);
    const result = await confirmRestore(vault, reopened.ledger);
    expect(result.passphraseChanged).toBe(false);
    await vault.lock();
    expect((await openHousehold(vault, PASS)).ledger.settings.householdName).toBe('Backed-up household');
  });

  it('refuses a wrong passphrase and replaces nothing', async () => {
    const { vault } = await householdWithBackup();
    await expect(openBackup(vault, 'not the household passphrase')).rejects.toMatchObject({ code: 'wrong_passphrase' });
    await expect(vault.restoreCommit()).rejects.toMatchObject({ code: 'no_pending_restore' });
  });

  it('refuses a backup whose contents are damaged or from a newer version, and forgets it', async () => {
    for (const bad of ['{"schemaVersion":99}', '{"schemaVersion":1,"accounts":"oops"}', 'not json']) {
      const vault = memoryBackend();
      await createHousehold(vault, PASS);
      await vault.backupCreate(bad, '2026-10-29');
      await expect(openBackup(vault, PASS)).rejects.toBeInstanceOf(LedgerFormatError);
      await expect(vault.restoreCommit()).rejects.toMatchObject({ code: 'no_pending_restore' });
      await vault.lock();
      expect((await openHousehold(vault, PASS)).ledger.transactions).toEqual([]);
    }
  });

  it('cancelling after opening a backup keeps the current data', async () => {
    const { vault } = await householdWithBackup();
    await openBackup(vault, PASS);
    await vault.restoreCancel();
    await expect(vault.restoreCommit()).rejects.toMatchObject({ code: 'no_pending_restore' });
  });

  it('a locked household cannot be replaced by a restore', async () => {
    const { vault } = await householdWithBackup();
    await vault.lock();
    await expect(openBackup(vault, PASS)).rejects.toMatchObject({ code: 'locked' });
  });

  it('restores onto a new Mac with no household yet', async () => {
    const { vault: oldMac } = await householdWithBackup();
    const backup = await oldMac.restoreOpen(PASS); // the backup file's contents
    const newMac = memoryBackend();
    // Simulate the backup file arriving on the new Mac.
    const seeded = { ...newMac, restoreOpen: async (passphrase: string) => {
      if (passphrase !== PASS) throw new VaultError('wrong_passphrase');
      return backup;
    }, restoreCommit: async () => {
      await newMac.create(PASS, backup);
      return { passphraseChanged: false };
    } };
    const opened = await openBackup(seeded, PASS);
    await confirmRestore(seeded, opened.ledger);
    await newMac.lock();
    expect((await openHousehold(newMac, PASS)).ledger.settings.householdName).toBe('Backed-up household');
  });
});
