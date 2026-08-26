import { beforeEach, describe, expect, it } from 'vitest';
import { seedIfEmpty, SEED_IDS, SEED_START_DIAL } from '../seed.ts';
import { createTestDb, type EspressoDB } from '../schema.ts';
import {
  collectPending,
  markPushed,
  pendingCount,
  pendingSeqs,
  prunePending,
  SYNCED_TABLES,
  syncOnce,
} from '../sync/outbox.ts';
import type { PushBatch, SyncAdapter } from '../sync/types.ts';
import { beansRepo, daysOffRoast, restVerdict } from './beans.ts';
import { dialDelta, gearRepo, isGrinder, snapDial } from './gear.ts';
import { sessionsRepo } from './sessions.ts';
import { settingsRepo } from './settings.ts';
import { shotsRepo } from './shots.ts';

let db: EspressoDB;
let dbCounter = 0;

beforeEach(async () => {
  // A fresh database per test: IndexedDB is process-global under fake-indexeddb.
  db = createTestDb(`test-db-${dbCounter++}`);
  await db.open();
});

describe('write stamping', () => {
  it('stamps the envelope and queues an outbox entry on create', async () => {
    const bean = await beansRepo.create({ roaster: 'JVG', name: 'Sidama', state: 'active' }, db);

    expect(bean.id).toBeTruthy();
    expect(bean.updatedAt).toBeGreaterThan(0);
    expect(bean.dirty).toBe(1);

    const pending = await collectPending(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.table).toBe('beans');
    expect(pending[0]!.rows).toHaveLength(1);
  });

  it('restamps updatedAt on every update', async () => {
    const bean = await beansRepo.create({ roaster: 'JVG', name: 'Sidama', state: 'active' }, db);
    await new Promise((r) => setTimeout(r, 2));
    const updated = await beansRepo.update(bean.id, { state: 'finished' }, db);

    expect(updated.updatedAt).toBeGreaterThan(bean.updatedAt);
    expect(updated.state).toBe('finished');
    expect(updated.dirty).toBe(1);
  });

  it('rejects an update to a row that does not exist', async () => {
    await expect(beansRepo.update('nope', { state: 'finished' }, db)).rejects.toThrow(/no row/);
  });
});

describe('tombstones', () => {
  it('hides deleted rows from reads but keeps them for sync', async () => {
    const bean = await beansRepo.create({ roaster: 'JVG', name: 'Sidama', state: 'active' }, db);
    await beansRepo.remove(bean.id, db);

    expect(await beansRepo.get(bean.id, db)).toBeUndefined();
    expect(await beansRepo.list(db)).toHaveLength(0);

    // The row itself survives, carrying the deletion for a future server to learn about.
    const raw = await db.beans.get(bean.id);
    expect(raw?.deletedAt).toBeGreaterThan(0);

    // The tombstone travels as an ordinary row, carrying deletedAt.
    const pending = await collectPending(db);
    expect(pending[0]!.rows).toHaveLength(1);
    expect((pending[0]!.rows[0] as { id: string }).id).toBe(bean.id);
    expect((pending[0]!.rows[0] as { deletedAt: number }).deletedAt).toBeGreaterThan(0);
  });

  it('is a no-op when deleting something already gone', async () => {
    await expect(beansRepo.remove('missing', db)).resolves.toBeUndefined();
    expect(await pendingCount(db)).toBe(0);
  });
});

describe('outbox coalescing', () => {
  it('sends one row for a row edited several times', async () => {
    const bean = await beansRepo.create({ roaster: 'JVG', name: 'Sidama', state: 'active' }, db);
    await beansRepo.update(bean.id, { notes: 'first' }, db);
    await beansRepo.update(bean.id, { notes: 'second' }, db);

    const pending = await collectPending(db);
    expect(pending[0]!.rows).toHaveLength(1);
    // The latest state, not a replay of the intermediate versions.
    expect((pending[0]!.rows[0] as { notes: string }).notes).toBe('second');
  });

  it('clears dirty only once every queued change for a row is pushed', async () => {
    const bean = await beansRepo.create({ roaster: 'JVG', name: 'Sidama', state: 'active' }, db);
    await beansRepo.update(bean.id, { notes: 'later' }, db);

    const all = await db.outbox.toArray();
    const [first, ...rest] = all.map((e) => e.seq!);

    await markPushed([first!], db);
    expect((await db.beans.get(bean.id))?.dirty).toBe(1);

    await markPushed(rest, db);
    expect((await db.beans.get(bean.id))?.dirty).toBe(0);
    expect(await pendingCount(db)).toBe(0);
  });
});

describe('sync seam', () => {
  /** A stand-in for any backend, so the merge rules can be tested without one. */
  function fakeAdapter(
    incoming: PushBatch[] = [],
    opts: { failPush?: boolean } = {},
  ): SyncAdapter & { pushed: PushBatch[][] } {
    const pushed: PushBatch[][] = [];
    return {
      name: 'fake',
      pushed,
      async push(batches) {
        if (opts.failPush) throw new Error('network down');
        pushed.push(batches);
      },
      async pull() {
        // Defensive because some tests deliberately feed malformed rows through.
        const stamps = incoming
          .flatMap((b) => b.rows)
          .map((r) => (r as { updatedAt?: unknown } | null)?.updatedAt)
          .filter((v): v is number => typeof v === 'number');
        return { batches: incoming, watermark: Math.max(0, ...stamps) };
      },
    };
  }

  it('pushes pending changes and marks them clean', async () => {
    const bean = await beansRepo.create({ roaster: 'JVG', name: 'Sidama', state: 'active' }, db);
    const adapter = fakeAdapter();

    const result = await syncOnce(adapter, 0, db);

    expect(result.pushed).toBe(1);
    expect((await db.beans.get(bean.id))?.dirty).toBe(0);
    expect(adapter.pushed[0]![0]!.table).toBe('beans');
    expect(await pendingCount(db)).toBe(0);
  });

  it('leaves the queue intact when the push fails', async () => {
    const bean = await beansRepo.create({ roaster: 'JVG', name: 'Sidama', state: 'active' }, db);

    await expect(syncOnce(fakeAdapter([], { failPush: true }), 0, db)).rejects.toThrow(/network/);

    // Nothing may be marked clean on a failed push, or the change is lost forever.
    expect((await db.beans.get(bean.id))?.dirty).toBe(1);
    expect(await pendingCount(db)).toBe(1);
  });

  it('keeps a change made during the push queued for next time', async () => {
    const bean = await beansRepo.create({ roaster: 'JVG', name: 'Sidama', state: 'active' }, db);
    const adapter: SyncAdapter = {
      name: 'racy',
      async push() {
        // A shot logged while the request was in flight.
        await beansRepo.update(bean.id, { notes: 'written mid-push' }, db);
      },
      async pull() {
        return { batches: [], watermark: 0 };
      },
    };

    await syncOnce(adapter, 0, db);

    expect(await pendingCount(db)).toBe(1);
    expect((await db.beans.get(bean.id))?.dirty).toBe(1);
  });

  it('accepts a newer remote row and rejects a staler one', async () => {
    const bean = await beansRepo.create({ roaster: 'JVG', name: 'Sidama', state: 'active' }, db);
    await markPushed(await pendingSeqs(db), db);

    const stale = { ...bean, roaster: 'STALE', updatedAt: bean.updatedAt - 1000, dirty: 0 as const };
    await syncOnce(fakeAdapter([{ table: 'beans', rows: [stale] }]), 0, db);
    expect((await db.beans.get(bean.id))?.roaster).toBe('JVG');

    const fresh = { ...bean, roaster: 'FRESH', updatedAt: bean.updatedAt + 1000, dirty: 0 as const };
    const result = await syncOnce(fakeAdapter([{ table: 'beans', rows: [fresh] }]), 0, db);
    expect((await db.beans.get(bean.id))?.roaster).toBe('FRESH');
    expect(result.pulled).toBe(1);
  });

  it('does not queue a pulled row back for pushing', async () => {
    const bean = await beansRepo.create({ roaster: 'JVG', name: 'Sidama', state: 'active' }, db);
    await markPushed(await pendingSeqs(db), db);

    const fresh = { ...bean, roaster: 'FROM REMOTE', updatedAt: bean.updatedAt + 1000, dirty: 1 };
    await syncOnce(fakeAdapter([{ table: 'beans', rows: [fresh] }]), 0, db);

    // Otherwise two devices ping-pong the same row back and forth forever.
    expect((await db.beans.get(bean.id))?.dirty).toBe(0);
    expect(await pendingCount(db)).toBe(0);
  });

  it('applies a remote tombstone', async () => {
    const bean = await beansRepo.create({ roaster: 'JVG', name: 'Sidama', state: 'active' }, db);
    await markPushed(await pendingSeqs(db), db);

    const deleted = { ...bean, updatedAt: bean.updatedAt + 1000, deletedAt: Date.now(), dirty: 0 as const };
    await syncOnce(fakeAdapter([{ table: 'beans', rows: [deleted] }]), 0, db);

    expect(await beansRepo.get(bean.id, db)).toBeUndefined();
  });

  it('lets a local tombstone win over a remote edit', async () => {
    const bean = await beansRepo.create({ roaster: 'JVG', name: 'Sidama', state: 'active' }, db);
    await beansRepo.remove(bean.id, db);
    await markPushed(await pendingSeqs(db), db);

    const revived = { ...bean, roaster: 'REVIVED', updatedAt: Date.now() + 5000, dirty: 0 as const };
    await syncOnce(fakeAdapter([{ table: 'beans', rows: [revived] }]), 0, db);

    // A delete the user performed must not be undone by another device's stale edit.
    expect(await beansRepo.get(bean.id, db)).toBeUndefined();
  });

  it('advances the watermark to the newest row seen, never backwards', async () => {
    const bean = await beansRepo.create({ roaster: 'JVG', name: 'Sidama', state: 'active' }, db);
    const row = { ...bean, updatedAt: 5_000, dirty: 0 as const };

    const forward = await syncOnce(fakeAdapter([{ table: 'beans', rows: [row] }]), 1_000, db);
    expect(forward.watermark).toBe(5_000);

    // An empty pull must not rewind the watermark and re-fetch everything next time.
    const empty = await syncOnce(fakeAdapter([]), 9_000, db);
    expect(empty.watermark).toBe(9_000);
  });

  it('ignores malformed remote rows instead of corrupting the table', async () => {
    const junk = [{ id: '', updatedAt: 1 }, { id: 'x' }, null] as unknown[];
    const result = await syncOnce(fakeAdapter([{ table: 'beans', rows: junk }]), 0, db);

    expect(result.pulled).toBe(0);
    expect(await beansRepo.list(db)).toHaveLength(0);
  });

  it('never syncs device settings', async () => {
    // Theme and haptics belong to a phone, not a household.
    expect(SYNCED_TABLES).not.toContain('settings');
  });
});

describe('seed', () => {
  it('creates the documented setup and is idempotent', async () => {
    expect((await seedIfEmpty(db)).seeded).toBe(true);
    expect((await seedIfEmpty(db)).seeded).toBe(false);

    const gear = await gearRepo.list(db);
    expect(gear).toHaveLength(4);

    const grinder = gear.find((g) => g.id === SEED_IDS.grinder);
    expect(grinder && isGrinder(grinder)).toBe(true);
    if (grinder && isGrinder(grinder)) {
      // The load-bearing detail: higher number is coarser on this grinder.
      expect(grinder.spec.dialDirection).toBe('higher-is-coarser');
      expect(grinder.spec.dialStep).toBe(0.5);
    }

    const tamper = gear.find((g) => g.id === SEED_IDS.tamper);
    expect(tamper?.kind === 'tamper' && tamper.spec.pressureAdjustable).toBe(false);

    const session = await sessionsRepo.active(db);
    expect(session?.currentDial).toBe(SEED_START_DIAL);
    expect(session?.targets.doseG).toBe(18);
    expect(session?.targets.yieldG).toBe(40);
    expect(session?.targets.tempC).toBe(95);
    expect(session?.targets.preInfusion).toEqual({ p1Sec: 3, p2Sec: 6 });
    expect(session?.targets.timeWindowSec).toEqual([25, 30]);
  });
});

describe('sessions', () => {
  it('locks in a dial and reopens', async () => {
    await seedIfEmpty(db);
    const session = (await sessionsRepo.active(db))!;

    const locked = await sessionsRepo.lockIn(session.id, 17, db);
    expect(locked.status).toBe('locked');
    expect(locked.lockedDial).toBe(17);
    expect(locked.currentDial).toBe(17);
    expect(await sessionsRepo.active(db)).toBeUndefined();

    await sessionsRepo.reopen(session.id, db);
    expect((await sessionsRepo.active(db))?.id).toBe(session.id);
  });
});

describe('shots', () => {
  it('returns session shots oldest first and separates discarded ones', async () => {
    await seedIfEmpty(db);
    const session = (await sessionsRepo.active(db))!;
    const make = (pulledAt: number, discarded = false) =>
      shotsRepo.create(
        {
          sessionId: session.id,
          dial: 16.5,
          doseG: 18,
          yieldG: 40,
          preInfusionSec: 9,
          extractionSec: 27,
          tempC: 95,
          channeling: false,
          tasteTags: [],
          pulledAt,
          ...(discarded ? { discarded: true } : {}),
        },
        db,
      );

    await make(300);
    await make(100);
    await make(200, true);

    const ordered = await shotsRepo.forSession(session.id, db);
    expect(ordered.map((s) => s.pulledAt)).toEqual([100, 200, 300]);
    expect(await shotsRepo.countableForSession(session.id, db)).toHaveLength(2);
    expect((await shotsRepo.latestForSession(session.id, db))?.pulledAt).toBe(300);
  });
});

describe('dial arithmetic', () => {
  const higherIsFiner = {
    dialMin: 0,
    dialMax: 60,
    dialStep: 0.5,
    dialDirection: 'higher-is-finer' as const,
  };
  const higherIsCoarser = { ...higherIsFiner, dialDirection: 'higher-is-coarser' as const };

  it('resolves finer/coarser through the grinder direction', () => {
    expect(dialDelta('finer', 1, higherIsFiner)).toBe(0.5);
    expect(dialDelta('coarser', 1, higherIsFiner)).toBe(-0.5);
    expect(dialDelta('finer', 1, higherIsCoarser)).toBe(-0.5);
    expect(dialDelta('coarser', 2, higherIsCoarser)).toBe(1);
  });

  it('snaps to steps without floating point noise', () => {
    // 16.5 + 0.5 must read as 17, not 16.999999999999998.
    expect(snapDial(16.5 + 0.5, higherIsFiner)).toBe(17);
    expect(snapDial(16.7, higherIsFiner)).toBe(16.5);
    expect(snapDial(16.8, higherIsFiner)).toBe(17);
  });

  it('clamps to the grinder range', () => {
    expect(snapDial(-5, higherIsFiner)).toBe(0);
    expect(snapDial(999, higherIsFiner)).toBe(60);
  });
});

describe('roast dates', () => {
  it('counts whole days from the roast date', () => {
    const bean = { roastDate: '2026-08-01' };
    expect(daysOffRoast(bean, new Date(2026, 7, 12, 8, 0))).toBe(11);
    expect(daysOffRoast(bean, new Date(2026, 7, 1, 23, 0))).toBe(0);
  });

  it('is undefined without a roast date', () => {
    expect(daysOffRoast({}, new Date())).toBeUndefined();
    expect(daysOffRoast({ roastDate: 'not-a-date' }, new Date())).toBeUndefined();
  });

  it('gives coarse rest guidance', () => {
    expect(restVerdict(2)).toBe('too-fresh');
    expect(restVerdict(10)).toBe('ready');
    expect(restVerdict(40)).toBe('past-peak');
    expect(restVerdict(undefined)).toBe('unknown');
  });
});

describe('non-synced tables', () => {
  it('never queues settings for sync', async () => {
    // Theme and haptics are per-device. Queuing them also used to break markPushed, whose
    // transaction scope covers only the syncable stores.
    await settingsRepo.get(db);
    await settingsRepo.update({ theme: 'light' }, db);

    expect(await pendingCount(db)).toBe(0);
    expect(await collectPending(db)).toEqual([]);
  });

  it('prunes entries left by an older version', async () => {
    await beansRepo.create({ roaster: 'JVG', name: 'Sidama', state: 'active' }, db);
    // What a previous build would have written.
    await db.outbox.add({ table: 'settings' as never, rowId: 'singleton', op: 'upsert', at: 1 });

    expect(await prunePending(db)).toBe(1);
    expect(await pendingCount(db)).toBe(1);
  });

  it('survives a stale settings entry rather than failing the whole sync', async () => {
    await beansRepo.create({ roaster: 'JVG', name: 'Sidama', state: 'active' }, db);
    await db.outbox.add({ table: 'settings' as never, rowId: 'singleton', op: 'upsert', at: 1 });

    const adapter: SyncAdapter = {
      name: 'fake',
      async push() {},
      async pull() {
        return { batches: [], watermark: 0 };
      },
    };

    await expect(syncOnce(adapter, 0, db)).resolves.toMatchObject({ pushed: 1 });
  });
});
