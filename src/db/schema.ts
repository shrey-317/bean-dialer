import Dexie, { type EntityTable } from 'dexie';
import type { Bean, Gear, Session, Settings, Shot } from '../domain/types.ts';
import type { OutboxEntry } from './sync/types.ts';

/**
 * IndexedDB schema.
 *
 * Indexing notes:
 * - `dirty` is 0|1 rather than boolean because IndexedDB cannot index booleans. The sync
 *   outbox drains by querying `dirty === 1`, so it has to be indexable.
 * - `deletedAt` is indexed so live queries can cheaply exclude tombstones.
 * - `spec` / `targets` / `tasteTags` are plain objects and deliberately not indexed;
 *   nothing queries into them.
 *
 * Bumping the version: add a new `.version(n).stores({...})` block with an `.upgrade()`
 * rather than editing an existing one, or already-installed apps will fail to open.
 */
export class EspressoDB extends Dexie {
  beans!: EntityTable<Bean, 'id'>;
  gear!: EntityTable<Gear, 'id'>;
  sessions!: EntityTable<Session, 'id'>;
  shots!: EntityTable<Shot, 'id'>;
  settings!: EntityTable<Settings, 'id'>;
  outbox!: EntityTable<OutboxEntry, 'seq'>;

  constructor(name = 'espresso-dial-in') {
    super(name);
    this.version(1).stores({
      beans: 'id, state, roaster, updatedAt, dirty, deletedAt',
      gear: 'id, kind, isDefault, updatedAt, dirty, deletedAt',
      sessions: 'id, beanId, grinderId, status, startedAt, updatedAt, dirty, deletedAt',
      shots: 'id, sessionId, pulledAt, dial, updatedAt, dirty, deletedAt',
      settings: 'id, updatedAt, dirty, deletedAt',
      outbox: '++seq, [table+rowId], at',
    });
  }
}

export const db = new EspressoDB();

/** Fresh DB instance for tests, so suites don't share state. */
export function createTestDb(name: string): EspressoDB {
  return new EspressoDB(name);
}
