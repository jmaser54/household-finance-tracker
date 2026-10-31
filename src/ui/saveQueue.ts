/**
 * Saves in the background, one at a time. Each change is shown at once;
 * saving (which encrypts the whole household, by design not instant) runs
 * behind it, and changes made meanwhile are saved together in the next one.
 * `flush` waits until everything is saved, before locking or a backup.
 */
export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export function createSaveQueue<T>(save: (value: T) => Promise<void>, onState: (state: SaveState) => void) {
  let pending: { value: T } | null = null;
  let running: Promise<void> | null = null;

  async function run() {
    while (pending) {
      const { value } = pending;
      pending = null;
      onState('saving');
      try {
        await save(value);
        if (!pending) onState('saved');
      } catch {
        // Keep it to try again with the next change (or the next flush).
        if (!pending) pending = { value };
        onState('error');
        break;
      }
    }
    running = null;
  }

  return {
    schedule(value: T) {
      pending = { value };
      if (!running) running = run();
    },
    /** Resolves when nothing is waiting to be saved; rejects if the last save failed. */
    async flush(): Promise<void> {
      if (!running && pending) running = run();
      if (running) await running;
      if (pending) throw new Error('save_failed');
    },
  };
}
