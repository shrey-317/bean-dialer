import type { Bean, Gear, Session, Settings, Shot } from '../../domain/types.ts';

/** Every table the repo layer manages. `outbox` is internal and not one of these. */
export type TableName = 'beans' | 'gear' | 'sessions' | 'shots' | 'settings';

/**
 * The tables that actually sync.
 *
 * `settings` is excluded: theme, haptics and keep-awake describe a phone, not a household, and
 * syncing them means two devices overwriting each other's preferences.
 *
 * Keeping this distinct from `TableName` in the type system is not pedantry — collapsing the two
 * is what let outbox entries be written for a table that sync later refused to touch, producing a
 * transaction whose scope was missing a store and a "waiting to send" count that never cleared.
 */
export type SyncedTableName = Exclude<TableName, 'settings'>;

export const SYNCED_TABLES: SyncedTableName[] = ['beans', 'gear', 'sessions', 'shots'];

export function isSyncedTable(name: string): name is SyncedTableName {
  return (SYNCED_TABLES as string[]).includes(name);
}

export type RowFor<T extends TableName> = T extends 'beans'
  ? Bean
  : T extends 'gear'
    ? Gear
    : T extends 'sessions'
      ? Session
      : T extends 'shots'
        ? Shot
        : Settings;

/**
 * A pending local change. Written inside the same transaction as the row itself, so the
 * outbox can never disagree with what is actually stored.
 */
export interface OutboxEntry {
  /** Auto-incremented; also the drain order. */
  seq?: number;
  /** Always a syncable table — the repo layer does not queue anything else. */
  table: SyncedTableName;
  rowId: string;
  op: 'upsert' | 'delete';
  at: number;
}

/**
 * Rows to send for one table.
 *
 * There is no separate list of deletions: a delete in this app *is* a row state
 * (`deletedAt` set), so a tombstone travels as an ordinary row. That removes a whole parallel
 * path from both the push and pull sides — and a parallel path is where a delete gets lost.
 */
export interface PushBatch {
  table: SyncedTableName;
  rows: unknown[];
}

/**
 * The seam for a future cloud backend. **Nothing implements this in v1** — there is no
 * server and no account. It exists so that adding one (Supabase, a Cloudflare Worker,
 * anything) is a new file under `db/sync/` rather than a rewrite of every screen.
 *
 * Conflict policy, decided up front so both sides can agree on it:
 * - Last write wins, compared on `updatedAt` (epoch ms).
 * - A tombstone beats a concurrent edit regardless of `updatedAt`: a delete the user
 *   performed on one device should not be resurrected by a stale edit from another.
 * - Clocks are trusted. Skew between a phone and a laptop is seconds; shot logs are not
 *   sensitive to that. If it ever matters, replace `updatedAt` with a server-assigned
 *   sequence — every row already routes through the repo layer, so it is one change.
 */
export interface SyncAdapter {
  readonly name: string;
  /**
   * Push queued local changes. Resolves once they are durably stored remotely; throwing means
   * nothing was accepted and the outbox must be left intact for the next attempt.
   */
  push(batches: PushBatch[]): Promise<void>;
  /**
   * Pull everything changed remotely since `since` (epoch ms, exclusive).
   *
   * `watermark` is what to pass as `since` next time. It comes from the highest `updatedAt`
   * actually seen rather than a clock reading, so a row written while the pull was in flight
   * cannot be skipped.
   */
  pull(since: number): Promise<{ batches: PushBatch[]; watermark: number }>;
}
