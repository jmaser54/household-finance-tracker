import { describe, expect, it } from 'vitest';
import { installPromiseWithResolvers, installTransferToFixedLength } from './pdfjsPolyfills';

// The app's TypeScript lib predates these built-ins, so they are typed here.
type Resolvers<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void };
type WithResolvers = { withResolvers: <T>() => Resolvers<T> };

describe('polyfills for macOS Monterey WebKit', () => {
  it('Promise.withResolvers resolves and rejects like the standard one', async () => {
    class Bare<T> extends Promise<T> {}
    Object.defineProperty(Bare, 'withResolvers', { value: undefined, configurable: true, writable: true });
    installPromiseWithResolvers(Bare as unknown as PromiseConstructor);
    const make = (Bare as unknown as WithResolvers).withResolvers;
    expect(make).not.toBe((Promise as unknown as WithResolvers).withResolvers);

    const ok = make.call(Bare) as Resolvers<number>;
    expect(ok.promise).toBeInstanceOf(Bare);
    ok.resolve(7);
    await expect(ok.promise).resolves.toBe(7);

    const bad = make.call(Bare) as Resolvers<number>;
    bad.reject(new Error('stop'));
    await expect(bad.promise).rejects.toThrow('stop');
  });

  it('keeps a native Promise.withResolvers', () => {
    const native = (Promise as unknown as WithResolvers).withResolvers;
    installPromiseWithResolvers();
    expect((Promise as unknown as WithResolvers).withResolvers).toBe(native);
  });

  it('ArrayBuffer transferToFixedLength copies, truncates and zero-extends', () => {
    const target = Object.create(ArrayBuffer.prototype, { transferToFixedLength: { value: undefined, configurable: true, writable: true } });
    installTransferToFixedLength(target);
    const transfer = (target as { transferToFixedLength: (this: ArrayBuffer, n?: number) => ArrayBuffer }).transferToFixedLength;
    const source = new Uint8Array([1, 2, 3, 4]).buffer;
    expect([...new Uint8Array(transfer.call(source, 2))]).toEqual([1, 2]);
    expect([...new Uint8Array(transfer.call(source, 6))]).toEqual([1, 2, 3, 4, 0, 0]);
    expect([...new Uint8Array(transfer.call(source))]).toEqual([1, 2, 3, 4]);
  });
});
