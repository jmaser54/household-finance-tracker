/**
 * Standard built-ins that pdf.js 6's legacy build calls without polyfilling,
 * and that macOS Monterey's built-in WebKit (Safari 15 generation) lacks.
 * Each is defined only when missing, with the standard behaviour. Imported
 * first, both in the app window (pdfjsApp.ts) and in pdf.js's worker
 * (pdfjsWorker.ts). Found by auditing pdf.js's uses against Safari 15.4 and
 * confirmed in WebKit 15.4 in CI (PROJECT_PRINCIPLES.md §15).
 *
 * Not polyfilled: AbortSignal.any (Safari 17.4), used only by pdf.js's viewer,
 * editor and touch code, which the app never calls.
 */

type WithResolvers = <T>() => { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (reason?: unknown) => void };

/** Promise.withResolvers (Safari 17.4): used throughout pdf.js. */
export function installPromiseWithResolvers(target: PromiseConstructor = Promise): void {
  const ctor = target as unknown as { withResolvers?: WithResolvers };
  if (typeof ctor.withResolvers === 'function') return;
  Object.defineProperty(target, 'withResolvers', {
    configurable: true,
    writable: true,
    value: function withResolvers<T>(this: PromiseConstructor) {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new this<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    },
  });
}

/**
 * ArrayBuffer.prototype.transferToFixedLength (Safari 17.4): used by the
 * worker when it packages font data. A copy of the first `length` bytes; the
 * original is not detached, which pdf.js does not rely on (it drops it).
 */
export function installTransferToFixedLength(target: ArrayBuffer = ArrayBuffer.prototype): void {
  const proto = target as unknown as { transferToFixedLength?: unknown };
  if (typeof proto.transferToFixedLength === 'function') return;
  Object.defineProperty(target, 'transferToFixedLength', {
    configurable: true,
    writable: true,
    value: function transferToFixedLength(this: ArrayBuffer, length: number = this.byteLength) {
      const copy = new ArrayBuffer(length);
      new Uint8Array(copy).set(new Uint8Array(this, 0, Math.min(length, this.byteLength)));
      return copy;
    },
  });
}

installPromiseWithResolvers();
installTransferToFixedLength();
