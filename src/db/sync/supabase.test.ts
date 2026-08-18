import { describe, expect, it } from 'vitest';
import type { Bean } from '../../domain/types.ts';
import { createFakeSupabase, type FakeSupabaseState } from './fake-supabase.ts';
import type { RemoteRow } from './mapping.ts';
import { PAGE_SIZE, SupabaseSync } from './supabase.ts';

/**
 * The adapter tested against an in-memory stand-in. This covers the household bootstrap, the
 * request shapes, and pagination — the parts that would be wrong in a way no type checker
 * catches. It does not prove the SQL schema or its row-level security, which can only be
 * verified against a real project.
 */

function setup(initial: Partial<FakeSupabaseState> = {}) {
  const { client, state } = createFakeSupabase(initial);
  const sync = new SupabaseSync(
    { url: 'https://example.supabase.co', anonKey: 'anon' },
    async () => client,
  );
  return { sync, state };
}

function bean(over: Partial<Bean> = {}): Bean {
  return {
    id: 'bean-1',
    updatedAt: 1_000,
    dirty: 1,
    roaster: 'Joe Van Gogh',
    name: 'Ethiopia Sidama',
    state: 'active',
    ...over,
  };
}

function remoteBean(id: string, updatedAt: number, over: Partial<RemoteRow> = {}): RemoteRow {
  return {
    household_id: 'household-1',
    id,
    kind: 'beans',
    data: { roaster: 'R', name: id, state: 'active' },
    updated_at: updatedAt,
    deleted_at: null,
    ...over,
  };
}

describe('sign in and households', () => {
  it('creates a household on first sign-in', async () => {
    const { sync, state } = setup();
    const session = await sync.signIn('me@example.com', 'pw');

    expect(session.householdId).toBe('household-1');
    expect(state.memberships).toEqual([{ user_id: 'user-me@example.com', household_id: 'household-1' }]);
  });

  it('reuses the household on a later sign-in', async () => {
    const { sync } = setup({
      memberships: [{ user_id: 'user-me@example.com', household_id: 'existing-house' }],
    });
    const session = await sync.signIn('me@example.com', 'pw');
    expect(session.householdId).toBe('existing-house');
  });

  it('restores a session without asking for a password again', async () => {
    const { sync } = setup();
    expect(await sync.restore()).toBeNull();

    await sync.signIn('me@example.com', 'pw');
    const restored = await sync.restore();
    expect(restored?.householdId).toBe('household-1');
  });

  it('joins another household so the second phone shares one log', async () => {
    const { sync, state } = setup();
    await sync.signIn('wife@example.com', 'pw');

    const session = await sync.joinHousehold('household-of-phone-one');

    expect(session.householdId).toBe('household-of-phone-one');
    expect(state.memberships[0]!.household_id).toBe('household-of-phone-one');
  });

  it('forgets the session on sign out', async () => {
    const { sync } = setup();
    await sync.signIn('me@example.com', 'pw');
    await sync.signOut();

    expect(sync.currentSession()).toBeNull();
    await expect(sync.push([{ table: 'beans', rows: [bean()] }])).rejects.toThrow(/not signed in/i);
  });

  it('refuses to sync before signing in', async () => {
    const { sync } = setup();
    await expect(sync.pull(0)).rejects.toThrow(/not signed in/i);
  });
});

describe('push', () => {
  it('sends rows scoped to the household, keyed for upsert', async () => {
    const { sync, state } = setup();
    await sync.signIn('me@example.com', 'pw');

    await sync.push([{ table: 'beans', rows: [bean()] }]);

    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({
      household_id: 'household-1',
      id: 'bean-1',
      kind: 'beans',
      updated_at: 1_000,
      deleted_at: null,
    });
    // Without onConflict a repeat push would be a duplicate-key error rather than an update.
    const upsert = state.calls.find((c) => c.action === 'upsert');
    expect(upsert?.extra).toEqual({ onConflict: 'household_id,id' });
  });

  it('updates an existing row rather than duplicating it', async () => {
    const { sync, state } = setup();
    await sync.signIn('me@example.com', 'pw');

    await sync.push([{ table: 'beans', rows: [bean({ name: 'first' })] }]);
    await sync.push([{ table: 'beans', rows: [bean({ name: 'second', updatedAt: 2_000 })] }]);

    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]!.data.name).toBe('second');
    expect(state.rows[0]!.updated_at).toBe(2_000);
  });

  it('carries tombstones', async () => {
    const { sync, state } = setup();
    await sync.signIn('me@example.com', 'pw');

    await sync.push([{ table: 'beans', rows: [bean({ deletedAt: 5_000 })] }]);
    expect(state.rows[0]!.deleted_at).toBe(5_000);
  });

  it('chunks a large backlog instead of one enormous request', async () => {
    const { sync, state } = setup();
    await sync.signIn('me@example.com', 'pw');

    const rows = Array.from({ length: PAGE_SIZE + 25 }, (_, i) => bean({ id: `bean-${i}` }));
    await sync.push([{ table: 'beans', rows }]);

    const upserts = state.calls.filter((c) => c.action === 'upsert');
    expect(upserts).toHaveLength(2);
    expect(state.rows).toHaveLength(PAGE_SIZE + 25);
  });

  it('surfaces a failure so the outbox is not cleared', async () => {
    const { sync } = setup({
      failNext: { table: 'sync_rows', action: 'upsert', message: 'permission denied' },
    });
    await sync.signIn('me@example.com', 'pw');

    await expect(sync.push([{ table: 'beans', rows: [bean()] }])).rejects.toThrow(/permission denied/);
  });
});

describe('pull', () => {
  it('returns only rows newer than the watermark, grouped by table', async () => {
    const { sync } = setup({
      rows: [
        remoteBean('old', 500),
        remoteBean('new', 1_500),
        { ...remoteBean('a-shot', 1_800), kind: 'shots', data: { sessionId: 's', dial: 16.5 } },
      ],
    });
    await sync.signIn('me@example.com', 'pw');

    const { batches, watermark } = await sync.pull(1_000);

    expect(watermark).toBe(1_800);
    const byTable = Object.fromEntries(batches.map((b) => [b.table, b.rows.length]));
    expect(byTable).toEqual({ beans: 1, shots: 1 });
  });

  it('scopes to this household', async () => {
    const { sync } = setup({
      rows: [remoteBean('mine', 100), { ...remoteBean('theirs', 200), household_id: 'someone-else' }],
    });
    await sync.signIn('me@example.com', 'pw');

    const { batches } = await sync.pull(0);
    expect(batches[0]!.rows).toHaveLength(1);
    expect((batches[0]!.rows[0] as { id: string }).id).toBe('mine');
  });

  it('pages through more rows than fit in one request', async () => {
    const rows = Array.from({ length: PAGE_SIZE * 2 + 7 }, (_, i) =>
      remoteBean(`bean-${String(i).padStart(4, '0')}`, 1_000 + i),
    );
    const { sync, state } = setup({ rows });
    await sync.signIn('me@example.com', 'pw');

    const { batches, watermark } = await sync.pull(0);

    expect(batches[0]!.rows).toHaveLength(PAGE_SIZE * 2 + 7);
    expect(watermark).toBe(1_000 + rows.length - 1);
    // Three full-ish pages: 500, 500, 7.
    expect(state.calls.filter((c) => c.table === 'sync_rows' && c.action === 'select')).toHaveLength(3);
  });

  it('terminates when a whole page shares one timestamp', async () => {
    // A bulk import can stamp hundreds of rows in the same millisecond. Cursor paging on
    // updated_at alone would re-request the same page forever.
    const rows = Array.from({ length: PAGE_SIZE + 10 }, (_, i) =>
      remoteBean(`bean-${String(i).padStart(4, '0')}`, 7_777),
    );
    const { sync } = setup({ rows });
    await sync.signIn('me@example.com', 'pw');

    const { batches, watermark } = await sync.pull(0);

    expect(batches[0]!.rows).toHaveLength(PAGE_SIZE + 10);
    expect(watermark).toBe(7_777);
  });

  it('never moves the watermark backwards on an empty pull', async () => {
    const { sync } = setup();
    await sync.signIn('me@example.com', 'pw');

    const { batches, watermark } = await sync.pull(9_999);
    expect(batches).toEqual([]);
    expect(watermark).toBe(9_999);
  });

  it('skips malformed records rather than failing the sync', async () => {
    const { sync } = setup({
      rows: [
        remoteBean('good', 100),
        { ...remoteBean('bad-kind', 200), kind: 'settings' as never },
        { ...remoteBean('bad-stamp', 300), updated_at: 'soon' as never },
      ],
    });
    await sync.signIn('me@example.com', 'pw');

    const { batches } = await sync.pull(0);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.rows).toHaveLength(1);
  });

  it('surfaces a query failure', async () => {
    const { sync } = setup({
      failNext: { table: 'sync_rows', action: 'select', message: 'JWT expired' },
    });
    await sync.signIn('me@example.com', 'pw');

    await expect(sync.pull(0)).rejects.toThrow(/JWT expired/);
  });
});
