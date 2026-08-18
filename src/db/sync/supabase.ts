import type { SupabaseClient } from '@supabase/supabase-js';
import { fromRemote, toRemote, type RemoteRow } from './mapping.ts';
import type { PushBatch, SyncAdapter } from './types.ts';

/**
 * Sync against a Supabase project.
 *
 * Deliberately thin: all of the merge logic lives in `outbox.ts` and is tested without a network,
 * so this file is only responsible for talking to Postgres and for the household lookup.
 *
 * The `anon` key belongs in the client — it is designed to be public, and the row-level security
 * in `supabase/schema.sql` is what actually protects the data. The service_role key must never
 * appear here.
 */

/** Rows per request. Supabase caps a response at 1000 by default; this stays clear of it. */
export const PAGE_SIZE = 500;

export interface SupabaseConfig {
  url: string;
  anonKey: string;
}

export type SupabaseFactory = (config: SupabaseConfig) => Promise<SupabaseClient>;

/**
 * Loads supabase-js on demand.
 *
 * A dynamic import keeps it out of the initial bundle: someone who never turns sync on shouldn't
 * download an auth library to time a shot. `persistSession` keeps you signed in across app
 * launches, which matters when the app is a home-screen icon rather than a tab.
 */
const defaultFactory: SupabaseFactory = async ({ url, anonKey }) => {
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // No OAuth redirects to interpret, and detection interferes with the router.
      detectSessionInUrl: false,
    },
  });
};

export interface SyncSession {
  userId: string;
  email: string | undefined;
  householdId: string;
}

/**
 * Wraps a Supabase project as a `SyncAdapter`, plus the auth and household operations the
 * settings screen needs.
 */
export class SupabaseSync implements SyncAdapter {
  readonly name = 'supabase';

  private client: SupabaseClient | null = null;
  private session: SyncSession | null = null;

  constructor(
    private readonly config: SupabaseConfig,
    private readonly factory: SupabaseFactory = defaultFactory,
  ) {}

  private async getClient(): Promise<SupabaseClient> {
    this.client ??= await this.factory(this.config);
    return this.client;
  }

  /** Restores an existing session, if the user signed in previously. Safe to call repeatedly. */
  async restore(): Promise<SyncSession | null> {
    const client = await this.getClient();
    const { data } = await client.auth.getSession();
    const user = data.session?.user;
    if (!user) {
      this.session = null;
      return null;
    }
    return this.adopt(user.id, user.email);
  }

  async signIn(email: string, password: string): Promise<SyncSession> {
    const client = await this.getClient();
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    if (!data.user) throw new Error('Signed in but no user was returned.');
    return this.adopt(data.user.id, data.user.email);
  }

  async signUp(email: string, password: string): Promise<SyncSession> {
    const client = await this.getClient();
    const { data, error } = await client.auth.signUp({ email, password });
    if (error) throw error;
    if (!data.session) {
      // Email confirmation is on for this project, so there is no session to work with yet.
      throw new Error(
        'Account created — confirm the address from the email Supabase sent, then sign in. ' +
          'To skip this, turn off "Confirm email" in the Supabase dashboard.',
      );
    }
    return this.adopt(data.session.user.id, data.session.user.email);
  }

  async signOut(): Promise<void> {
    const client = await this.getClient();
    await client.auth.signOut();
    this.session = null;
  }

  currentSession(): SyncSession | null {
    return this.session;
  }

  /**
   * Finds this user's household, creating one on first sign-in.
   *
   * A brand-new account gets a fresh household (the column defaults to a new UUID); the second
   * phone then joins by pasting that id. Kept here rather than in a trigger so the whole model
   * is visible in one place.
   */
  private async adopt(userId: string, email: string | undefined): Promise<SyncSession> {
    const client = await this.getClient();

    const existing = await client
      .from('household_members')
      .select('household_id')
      .eq('user_id', userId)
      .maybeSingle();
    if (existing.error) throw existing.error;

    let householdId = (existing.data as { household_id: string } | null)?.household_id;

    if (!householdId) {
      const created = await client
        .from('household_members')
        .insert({ user_id: userId })
        .select('household_id')
        .single();
      if (created.error) throw created.error;
      householdId = (created.data as { household_id: string }).household_id;
    }

    this.session = { userId, email, householdId };
    return this.session;
  }

  /**
   * Point this device at another household.
   *
   * Everything already on the device stays put and will be pushed into the household it is
   * joining — which is what you want when the second phone has been logging shots on its own
   * before the two were connected.
   */
  async joinHousehold(householdId: string): Promise<SyncSession> {
    const session = this.requireSession();
    const client = await this.getClient();

    const { error } = await client
      .from('household_members')
      .update({ household_id: householdId })
      .eq('user_id', session.userId);
    if (error) throw error;

    this.session = { ...session, householdId };
    return this.session;
  }

  async push(batches: PushBatch[]): Promise<void> {
    const session = this.requireSession();
    const client = await this.getClient();

    const records = batches.flatMap((batch) =>
      batch.rows.map((row) =>
        toRemote(batch.table, row as Parameters<typeof toRemote>[1], session.householdId),
      ),
    );

    // Chunked so a long offline stretch doesn't produce one enormous request.
    for (let i = 0; i < records.length; i += PAGE_SIZE) {
      const chunk = records.slice(i, i + PAGE_SIZE);
      const { error } = await client
        .from('sync_rows')
        .upsert(chunk, { onConflict: 'household_id,id' });
      if (error) throw error;
    }
  }

  async pull(since: number): Promise<{ batches: PushBatch[]; watermark: number }> {
    const session = this.requireSession();
    const client = await this.getClient();

    const byTable = new Map<PushBatch['table'], unknown[]>();
    let watermark = since;

    // Offset paging over a stable `(updated_at, id)` ordering.
    //
    // The obvious alternative — carry the last row's `updated_at` as a cursor — stalls when a
    // whole page shares one millisecond, which a bulk import or a seed can easily produce: the
    // next request asks for `> that same value` and returns the same page forever. Offsets have
    // their own weakness (rows arriving mid-pull can shift the window), but that only defers a
    // row to the next sync, because the watermark only advances over rows actually seen.
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data, error } = await client
        .from('sync_rows')
        .select('household_id, id, kind, data, updated_at, deleted_at')
        .eq('household_id', session.householdId)
        .gt('updated_at', since)
        .order('updated_at', { ascending: true })
        .order('id', { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);
      if (error) throw error;

      const page = (data ?? []) as RemoteRow[];
      for (const remote of page) {
        const parsed = fromRemote(remote);
        if (!parsed) continue;
        const rows = byTable.get(parsed.table) ?? [];
        rows.push(parsed.row);
        byTable.set(parsed.table, rows);
        watermark = Math.max(watermark, parsed.row.updatedAt);
      }

      if (page.length < PAGE_SIZE) break;
    }

    return {
      batches: [...byTable].map(([table, rows]) => ({ table, rows })),
      watermark,
    };
  }

  private requireSession(): SyncSession {
    if (!this.session) throw new Error('Not signed in to sync.');
    return this.session;
  }
}
