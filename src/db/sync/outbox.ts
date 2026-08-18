import type { Synced } from '../../domain/types.ts';
import { db, type EspressoDB } from '../schema.ts';
import {
  isSyncedTable,
  SYNCED_TABLES,
  type PushBatch,
  type SyncAdapter,
  type SyncedTableName,
} from './types.ts';

export { SYNCED_TABLES };

/**
 * Removes queued entries for tables that don't sync.
 *
 * Needed because a database written by an earlier version queued `settings` writes. Left in
 * place they inflate the "waiting to send" count forever and, worse, make `markPushed` open a
 * transaction whose scope is missing the store it then tries to read.
 */
export async function prunePending(dbi: EspressoDB = db): Promise<number> {
  const entries = await dbi.outbox.toArray();
  const stale = entries.filter((e) => !isSyncedTable(e.table)).map((e) => e.seq!);
  if (stale.length > 0) await dbi.outbox.bulkDelete(stale);
  return stale.length;
}

/**
 * Collects pending local changes into per-table batches.
 *
 * Reads each row's *current* state rather than a snapshot taken at write time: if a shot was
 * edited three times before a sync ran, the remote should receive the latest state once, not a
 * replay of the intermediate versions. Tombstoned rows are included like any other — carrying
 * `deletedAt` is how the deletion propagates.
 */
export async function collectPending(dbi: EspressoDB = db): Promise<PushBatch[]> {
  const entries = await dbi.outbox.orderBy('seq').toArray();
  if (entries.length === 0) return [];

  const batches: PushBatch[] = [];
  for (const table of SYNCED_TABLES) {
    const ids = new Set(entries.filter((e) => e.table === table).map((e) => e.rowId));
    if (ids.size === 0) continue;

    const rows = await dbi.table(table).bulkGet([...ids]);
    const present = rows.filter((r): r is NonNullable<typeof r> => r != null);
    if (present.length > 0) batches.push({ table, rows: present });
  }
  return batches;
}

/**
 * Clear pushed entries and drop `dirty` on rows with nothing left queued.
 *
 * Takes the outbox sequence numbers that were included in the push, captured *before* it ran, so
 * a write made while the request was in flight stays queued instead of being silently marked
 * clean.
 */
export async function markPushed(seqs: number[], dbi: EspressoDB = db): Promise<void> {
  if (seqs.length === 0) return;
  const tables = [dbi.outbox, ...SYNCED_TABLES.map((t) => dbi.table(t))];

  await dbi.transaction('rw', tables, async () => {
    const entries = await dbi.outbox.bulkGet(seqs);
    await dbi.outbox.bulkDelete(seqs);

    for (const entry of entries) {
      if (!entry || !isSyncedTable(entry.table)) continue;
      const stillQueued = await dbi.outbox
        .where('[table+rowId]')
        .equals([entry.table, entry.rowId])
        .count();
      if (stillQueued > 0) continue;
      const table = dbi.table(entry.table);
      const row = await table.get(entry.rowId);
      if (row) await table.put({ ...row, dirty: 0 });
    }
  });
}

export async function pendingCount(dbi: EspressoDB = db): Promise<number> {
  const entries = await dbi.outbox.toArray();
  return entries.filter((e) => isSyncedTable(e.table)).length;
}

/** Sequence numbers currently queued, in order. */
export async function pendingSeqs(dbi: EspressoDB = db): Promise<number[]> {
  const entries = await dbi.outbox.orderBy('seq').toArray();
  return entries
    .filter((e) => isSyncedTable(e.table))
    .map((e) => e.seq!)
    .filter((s) => s !== undefined);
}

/**
 * Merge one remote row into the local database.
 *
 * The conflict rules, in order:
 * 1. A local tombstone beats a remote edit. A delete the user performed on one phone must not be
 *    resurrected by a stale edit from the other.
 * 2. Otherwise the newer `updatedAt` wins, and a tie leaves the local row alone.
 *
 * Returns whether anything was written, so the caller can report a meaningful count.
 */
export async function mergeRemoteRow(
  table: SyncedTableName,
  remote: Synced,
  dbi: EspressoDB = db,
): Promise<boolean> {
  if (!remote?.id || typeof remote.updatedAt !== 'number') return false;

  const dexieTable = dbi.table(table);
  const local = (await dexieTable.get(remote.id)) as Synced | undefined;

  if (local?.deletedAt && !remote.deletedAt) return false;
  if (local && local.updatedAt >= remote.updatedAt) return false;

  // `dirty: 0` — this state came from the remote, so there is nothing to push back.
  await dexieTable.put({ ...remote, dirty: 0 });
  return true;
}

export interface SyncResult {
  pushed: number;
  pulled: number;
  watermark: number;
}

/**
 * One push/pull cycle against an adapter.
 *
 * Push happens first so local work is never lost to a conflict resolution it could have won.
 * A throw from either side propagates: the caller decides how loudly to fail, and the outbox is
 * left intact so the next attempt retries.
 */
export async function syncOnce(
  adapter: SyncAdapter,
  since: number,
  dbi: EspressoDB = db,
): Promise<SyncResult> {
  // Capture the queue *before* pushing; anything queued during the request stays queued.
  const seqs = await pendingSeqs(dbi);
  const batches = await collectPending(dbi);

  let pushed = 0;
  if (batches.length > 0) {
    await adapter.push(batches);
    await markPushed(seqs, dbi);
    pushed = batches.reduce((n, b) => n + b.rows.length, 0);
  }

  const { batches: incoming, watermark } = await adapter.pull(since);
  let pulled = 0;
  for (const batch of incoming) {
    for (const row of batch.rows) {
      if (await mergeRemoteRow(batch.table, row as Synced, dbi)) pulled += 1;
    }
  }

  return { pushed, pulled, watermark: Math.max(since, watermark) };
}
