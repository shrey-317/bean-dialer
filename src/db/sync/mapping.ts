import type { Synced } from '../../domain/types.ts';
import type { SyncedTableName } from './types.ts';

/**
 * Translation between local rows and `sync_rows` records.
 *
 * Pure and separate from the network code, because this is where a silent data-loss bug would
 * live: drop a field here and it vanishes on the round trip without any error.
 */

/** A row as stored in Postgres. */
export interface RemoteRow {
  household_id: string;
  id: string;
  kind: SyncedTableName;
  data: Record<string, unknown>;
  updated_at: number;
  deleted_at: number | null;
}

/**
 * Local row → remote record.
 *
 * `data` carries the whole domain object minus the fields that are either represented as
 * columns (`id`, `updatedAt`, `deletedAt`) or purely local (`dirty` — whether *this device* has
 * unpushed changes means nothing to anyone else).
 */
export function toRemote(
  table: SyncedTableName,
  row: Synced,
  householdId: string,
): RemoteRow {
  const { id, updatedAt, deletedAt, dirty: _dirty, ...data } = row as Synced & Record<string, unknown>;

  return {
    household_id: householdId,
    id,
    kind: table,
    data: data as Record<string, unknown>,
    updated_at: updatedAt,
    deleted_at: deletedAt ?? null,
  };
}

/**
 * Remote record → local row.
 *
 * Returns undefined for anything malformed rather than throwing: one bad record should not
 * abort a whole sync, and the app can survive skipping it.
 */
export function fromRemote(remote: unknown): { table: SyncedTableName; row: Synced } | undefined {
  if (!remote || typeof remote !== 'object') return undefined;
  const r = remote as Partial<RemoteRow>;

  if (typeof r.id !== 'string' || r.id === '') return undefined;
  if (typeof r.updated_at !== 'number' || !Number.isFinite(r.updated_at)) return undefined;
  if (!isSyncedTable(r.kind)) return undefined;
  if (!r.data || typeof r.data !== 'object') return undefined;

  return {
    table: r.kind,
    row: {
      ...(r.data as Record<string, unknown>),
      id: r.id,
      updatedAt: r.updated_at,
      deletedAt: r.deleted_at ?? null,
      // Arrived from the remote, so there is nothing to push back.
      dirty: 0,
    } as Synced,
  };
}

function isSyncedTable(value: unknown): value is SyncedTableName {
  return value === 'beans' || value === 'gear' || value === 'sessions' || value === 'shots';
}
