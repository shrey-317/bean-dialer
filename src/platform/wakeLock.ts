/**
 * Screen Wake Lock, best effort.
 *
 * A web page cannot keep a timer running in the background, so the realistic goal is simply
 * to stop the screen dimming during the ~40 seconds you are watching a shot. Support is
 * uneven (and the lock is dropped automatically whenever the page is hidden), so every path
 * here degrades to doing nothing rather than throwing.
 */

type Sentinel = { released: boolean; release(): Promise<void> };

let sentinel: Sentinel | null = null;

export function wakeLockSupported(): boolean {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
}

export async function requestWakeLock(): Promise<boolean> {
  if (!wakeLockSupported()) return false;
  try {
    const wl = (navigator as Navigator & {
      wakeLock: { request(type: 'screen'): Promise<Sentinel> };
    }).wakeLock;
    sentinel = await wl.request('screen');
    return true;
  } catch {
    // Denied, or the page wasn't visible. Not worth surfacing to the user.
    return false;
  }
}

export async function releaseWakeLock(): Promise<void> {
  try {
    if (sentinel && !sentinel.released) await sentinel.release();
  } catch {
    /* ignore */
  } finally {
    sentinel = null;
  }
}

export function wakeLockHeld(): boolean {
  return sentinel !== null && !sentinel.released;
}
