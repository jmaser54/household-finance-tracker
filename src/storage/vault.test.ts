import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args), isTauri: () => false }));

const { isStrongEnough, memoryBackend, tauriBackend, VaultError } = await import('./vault');

describe('passphrase rule', () => {
  it('requires at least 12 characters, counting letters not bytes', () => {
    expect(isStrongEnough('elevenchars')).toBe(false);
    expect(isStrongEnough('twelve chars')).toBe(true);
    expect(isStrongEnough('            ')).toBe(false);
    expect(isStrongEnough('ééééééééééé')).toBe(false); // 11 characters, 22 bytes
  });
});

describe('Mac app backend', () => {
  beforeEach(() => invoke.mockReset());

  it('passes arguments to the Rust commands', async () => {
    invoke.mockResolvedValueOnce(['{"x":1}', true]);
    await expect(tauriBackend().unlock('pass phrase here')).resolves.toEqual({ ledger: '{"x":1}', recoveredFromPrevious: true });
    expect(invoke).toHaveBeenCalledWith('vault_unlock', { passphrase: 'pass phrase here' });
  });

  it('passes backup and restore calls to the Rust commands', async () => {
    invoke.mockResolvedValue(undefined);
    await tauriBackend().backupCreate('{"x":1}', '2026-10-29');
    expect(invoke).toHaveBeenCalledWith('backup_create', { ledger: '{"x":1}', date: '2026-10-29' });
    invoke.mockResolvedValueOnce('{"y":2}');
    await expect(tauriBackend().restoreOpen('household passphrase')).resolves.toBe('{"y":2}');
    expect(invoke).toHaveBeenCalledWith('restore_open', { passphrase: 'household passphrase' });
    invoke.mockResolvedValueOnce(true);
    await expect(tauriBackend().restoreCommit()).resolves.toEqual({ passphraseChanged: true });
    expect(invoke).toHaveBeenCalledWith('restore_commit', undefined);
  });

  it.each(['cancelled', 'backup_unverified', 'no_pending_restore'])('maps the backup error %s', async (code) => {
    invoke.mockRejectedValueOnce(code);
    await expect(tauriBackend().restoreOpen('x')).rejects.toMatchObject({ code });
  });

  it('turns Rust error codes into VaultError codes', async () => {
    invoke.mockRejectedValueOnce('wrong_passphrase');
    await expect(tauriBackend().unlock('x')).rejects.toMatchObject({ code: 'wrong_passphrase' });
  });

  it('never surfaces unknown error text', async () => {
    invoke.mockRejectedValueOnce('some internal detail with data');
    const error = await tauriBackend().save('{}').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VaultError);
    expect((error as InstanceType<typeof VaultError>).code).toBe('unexpected');
    expect(String((error as Error).message)).not.toContain('internal detail');
  });
});

describe('browser stand-in follows the same rules', () => {
  it('creates, locks, refuses a wrong passphrase, and unlocks', async () => {
    const vault = memoryBackend();
    expect(vault.persistent).toBe(false);
    expect(await vault.status()).toBe('none');
    await expect(vault.create('short', '{}')).rejects.toMatchObject({ code: 'weak_passphrase' });
    await vault.create('a long enough passphrase', '{"v":1}');
    await expect(vault.create('another long passphrase', '{}')).rejects.toMatchObject({ code: 'vault_exists' });
    await vault.lock();
    expect(await vault.status()).toBe('locked');
    await expect(vault.save('{}')).rejects.toMatchObject({ code: 'locked' });
    await expect(vault.unlock('not the passphrase')).rejects.toMatchObject({ code: 'wrong_passphrase' });
    await expect(vault.unlock('a long enough passphrase')).resolves.toEqual({ ledger: '{"v":1}', recoveredFromPrevious: false });
  });
});
