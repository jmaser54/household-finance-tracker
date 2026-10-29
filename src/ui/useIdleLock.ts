import { useEffect } from 'preact/hooks';

export const AUTO_LOCK_MINUTES = 15;
const ACTIVITY = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;

/** Calls `onIdle` after `minutes` without keyboard, mouse or touch activity. */
export function useIdleLock(active: boolean, onIdle: () => void, minutes = AUTO_LOCK_MINUTES): void {
  useEffect(() => {
    if (!active) return;
    let timer = setTimeout(onIdle, minutes * 60_000);
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(onIdle, minutes * 60_000);
    };
    for (const type of ACTIVITY) window.addEventListener(type, reset, { passive: true });
    return () => {
      clearTimeout(timer);
      for (const type of ACTIVITY) window.removeEventListener(type, reset);
    };
  }, [active, onIdle, minutes]);
}
