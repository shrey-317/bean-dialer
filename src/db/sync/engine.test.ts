import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { beansRepo } from '../repo/beans.ts';
import { createTestDb, type EspressoDB } from '../schema.ts';
import { describeError, saveConfig, SyncEngine } from './engine.ts';
import { createFakeSupabase, type FakeSupabaseState } from './fake-supabase.ts';

/**
 * The engine's job is scheduling and *never getting in the way*. These tests are mostly about
 * failure: a sync that throws at a screen, blocks a write, or clears the outbox on a failed push
 * would be far worse than no sync at all.
 */

let db: EspressoDB;
let counter = 0;
let state: FakeSupabaseState;
let engine: SyncEngine;

const DEBOUNCE_MS = 40;

function makeEngine() {
  const fake = createFakeSupabase();
  state = fake.state;
  return new SyncEngine(db, async () => fake.client, {
    pushDebounceMs: DEBOUNCE_MS,
    // Long enough never to fire during a test.
    pollIntervalMs: 60_000,
  });
}

/** `start()` deliberately doesn't await its first sync, so tests wait for it to land. */
async function settled(): Promise<void> {
  for (let i = 0; i < 50 && engine.getStatus().phase === 'syncing'; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(async () => {
  localStorage.clear();
  db = createTestDb(`engine-test-${counter++}`);
  await db.open();
  saveConfig({ url: 'https://example.supabase.co', anonKey: 'anon' });
  engine = makeEngine();
});

afterEach(() => {
  engine.dispose();
});

describe('configuration', () => {
  it('stays off and reports as unconfigured with no project details', async () => {
    saveConfig(null);
    const bare = makeEngine();
    await bare.start();

    expect(bare.getStatus().configured).toBe(false);
    expect(bare.getStatus().phase).toBe('off');
    bare.dispose();
  });

  it('reports configured but signed out before sign-in', async () => {
    await engine.start();

    expect(engine.getStatus().configured).toBe(true);
    expect(engine.getStatus().session).toBeNull();
    expect(engine.getStatus().phase).toBe('off');
  });

  it('restores a previous session without a password', async () => {
    await engine.start();
    await engine.signIn('me@example.com', 'pw');

    // Same fake client, as if the app had been reopened.
    await engine.start();
    await settled();
    expect(engine.getStatus().session?.email).toBe('me@example.com');
    expect(engine.getStatus().phase).toBe('idle');
  });
});

describe('syncing', () => {
  it('pushes local rows once signed in', async () => {
    await beansRepo.create({ roaster: 'JVG', name: 'Sidama', state: 'active' }, db);
    await engine.start();
    await engine.signIn('me@example.com', 'pw');

    expect(state.rows).toHaveLength(1);
    expect(engine.getStatus().phase).toBe('idle');
    expect(engine.getStatus().pending).toBe(0);
    expect(engine.getStatus().lastSyncedAt).toBeGreaterThan(0);
  });

  it('pulls the other phone\'s rows into this database', async () => {
    await engine.start();
    await engine.signIn('me@example.com', 'pw');

    // A bean logged on the other device, already in the household.
    state.rows.push({
      household_id: engine.getStatus().session!.householdId,
      id: 'from-her-phone',
      kind: 'beans',
      data: { roaster: 'Counter Culture', name: 'Hologram', state: 'active' },
      updated_at: Date.now() + 1_000,
      deleted_at: null,
    });
    await engine.syncNow();

    const beans = await beansRepo.list(db);
    expect(beans.map((b) => b.name)).toContain('Hologram');
  });

  it('does nothing when signed out', async () => {
    await engine.start();
    await beansRepo.create({ roaster: 'JVG', name: 'Sidama', state: 'active' }, db);

    await engine.syncNow();

    expect(state.rows).toHaveLength(0);
    expect(engine.getStatus().phase).toBe('off');
  });

  it('reports a failure as status rather than throwing at the caller', async () => {
    await engine.start();
    await engine.signIn('me@example.com', 'pw');
    await beansRepo.create({ roaster: 'JVG', name: 'Sidama', state: 'active' }, db);
    state.failNext = { table: 'sync_rows', action: 'upsert', message: 'permission denied' };

    // Must resolve, not reject: a screen calling this cannot be allowed to blow up.
    await expect(engine.syncNow()).resolves.toBeUndefined();

    expect(engine.getStatus().phase).toBe('error');
    expect(engine.getStatus().error).toMatch(/database refused/i);
    // And the change is still queued for the next attempt.
    expect(engine.getStatus().pending).toBe(1);
  });

  it('collapses overlapping syncs instead of racing them', async () => {
    await engine.start();
    await engine.signIn('me@example.com', 'pw');
    state.calls.length = 0;

    await Promise.all([engine.syncNow(), engine.syncNow(), engine.syncNow()]);

    // One cycle runs, and at most one more follows for whatever arrived meanwhile.
    const selects = state.calls.filter((c) => c.table === 'sync_rows' && c.action === 'select');
    expect(selects.length).toBeLessThanOrEqual(2);
  });
});

describe('local change notifications', () => {
  it('debounces a burst of edits into one sync', async () => {
    await engine.start();
    await engine.signIn('me@example.com', 'pw');
    await settled();
    state.calls.length = 0;

    engine.notifyLocalChange();
    engine.notifyLocalChange();
    engine.notifyLocalChange();
    // Nothing yet: three edits in a row must not be three round trips.
    expect(state.calls.filter((c) => c.table === 'sync_rows')).toHaveLength(0);

    await new Promise((r) => setTimeout(r, DEBOUNCE_MS * 3));
    await settled();

    const selects = state.calls.filter((c) => c.table === 'sync_rows' && c.action === 'select');
    expect(selects).toHaveLength(1);
  });

  it('does not schedule anything while signed out', async () => {
    await engine.start();

    engine.notifyLocalChange();
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS * 3));

    expect(state.calls.filter((c) => c.table === 'sync_rows')).toHaveLength(0);
  });
});

describe('households', () => {
  it('re-pulls from scratch after joining another household', async () => {
    await engine.start();
    await engine.signIn('wife@example.com', 'pw');

    // Phone one's household already has history.
    state.rows.push({
      household_id: 'phone-one-household',
      id: 'existing-bean',
      kind: 'beans',
      data: { roaster: 'JVG', name: 'Sidama', state: 'active' },
      updated_at: 1_000,
      deleted_at: null,
    });

    await engine.joinHousehold('phone-one-household');
    await settled();

    // The watermark had already advanced past 1_000; joining must reset it or this row would
    // never arrive.
    expect((await beansRepo.list(db)).map((b) => b.name)).toContain('Sidama');
  });
});

describe('signing out', () => {
  it('leaves local data alone', async () => {
    await engine.start();
    await engine.signIn('me@example.com', 'pw');
    await beansRepo.create({ roaster: 'JVG', name: 'Sidama', state: 'active' }, db);

    await engine.signOut();

    expect(engine.getStatus().session).toBeNull();
    expect(await beansRepo.list(db)).toHaveLength(1);
  });
});

describe('describeError', () => {
  it('turns a network failure into reassurance rather than alarm', () => {
    expect(describeError(new TypeError('Failed to fetch'))).toMatch(/saved on this phone/i);
  });

  it('explains an expired token and a bad password', () => {
    expect(describeError(new Error('JWT expired'))).toMatch(/sign in again/i);
    expect(describeError(new Error('Invalid login credentials'))).toMatch(/did not match/i);
  });

  it('passes anything else through as-is', () => {
    expect(describeError(new Error('something odd'))).toBe('something odd');
    expect(describeError('a string')).toBe('a string');
  });
});
