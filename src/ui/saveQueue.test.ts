import { describe, expect, it } from 'vitest';
import { createSaveQueue, type SaveState } from './saveQueue';

describe('background saving', () => {
  it('saves changes made during a save together in one more save, ending with the latest', async () => {
    const saved: number[] = [];
    const states: SaveState[] = [];
    let release!: () => void;
    const queue = createSaveQueue<number>(
      (v) => {
        saved.push(v);
        return saved.length === 1 ? new Promise<void>((r) => (release = r)) : Promise.resolve();
      },
      (s) => states.push(s),
    );
    queue.schedule(1);
    queue.schedule(2);
    queue.schedule(3);
    release();
    await queue.flush();
    expect(saved).toEqual([1, 3]);
    expect(states.at(-1)).toBe('saved');
  });

  it('reports a failed save and tries again on flush', async () => {
    let fail = true;
    const saved: number[] = [];
    const states: SaveState[] = [];
    const queue = createSaveQueue<number>(
      async (v) => {
        if (fail) throw new Error('disk');
        saved.push(v);
      },
      (s) => states.push(s),
    );
    queue.schedule(7);
    await expect(queue.flush()).rejects.toThrow('save_failed');
    expect(states).toContain('error');
    fail = false;
    await queue.flush();
    expect(saved).toEqual([7]);
  });
});
