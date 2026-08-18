import { useSyncExternalStore } from 'react';
import { syncEngine, type SyncStatus } from '../db/sync/engine.ts';

/**
 * Subscribes to sync status.
 *
 * `useSyncExternalStore` rather than state-in-an-effect because the engine is the source of
 * truth and outlives any component: it keeps working while you're on the timer screen, and
 * whichever screen mounts next sees the current status rather than a stale first render.
 */
export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(
    (onChange) => syncEngine.subscribe(onChange),
    () => syncEngine.getStatus(),
    () => syncEngine.getStatus(),
  );
}

/** Human phrasing for how long ago a sync landed. */
export function describeLastSync(at: number | null, now: number = Date.now()): string {
  if (at === null) return 'not yet';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(at).toLocaleDateString();
}
