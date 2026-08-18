import type { SupabaseClient } from '@supabase/supabase-js';
import type { RemoteRow } from './mapping.ts';

/**
 * An in-memory stand-in for a Supabase project, used by the adapter's tests.
 *
 * It implements only the query shapes the adapter actually issues — enough to catch a wrong
 * filter, a missing `onConflict`, or broken pagination, which is where the bugs would be. It is
 * not a Postgres emulator and makes no attempt to be: row-level security in particular is not
 * modelled, so this proves the adapter's behaviour, not the schema's.
 *
 * Lives in src/ rather than a test folder so the e2e stub server can share the same shape.
 */

interface Membership {
  user_id: string;
  household_id: string;
}

type Filter = { op: 'eq' | 'gt'; column: string; value: unknown };

export interface FakeSupabaseState {
  rows: RemoteRow[];
  memberships: Membership[];
  /** Every request the adapter made, for asserting on shapes. */
  calls: { table: string; action: string; filters: Filter[]; extra?: unknown }[];
  /** Set to make the next matching action fail. */
  failNext?: { table: string; action: string; message: string };
}

class FakeQuery<T> implements PromiseLike<{ data: T | null; error: { message: string } | null }> {
  private filters: Filter[] = [];
  private orderBy: string[] = [];
  private rangeSpec: [number, number] | undefined;

  constructor(
    private readonly state: FakeSupabaseState,
    private readonly table: string,
    private readonly action: string,
    private readonly payload?: unknown,
    private readonly extra?: unknown,
  ) {}

  select(): this {
    return this;
  }
  eq(column: string, value: unknown): this {
    this.filters.push({ op: 'eq', column, value });
    return this;
  }
  gt(column: string, value: unknown): this {
    this.filters.push({ op: 'gt', column, value });
    return this;
  }
  order(column: string): this {
    this.orderBy.push(column);
    return this;
  }
  range(from: number, to: number): this {
    this.rangeSpec = [from, to];
    return this;
  }

  async maybeSingle() {
    const { data, error } = await this.run();
    if (error) return { data: null, error };
    const rows = data as unknown[];
    return { data: (rows[0] ?? null) as T, error: null };
  }

  async single() {
    const { data, error } = await this.run();
    if (error) return { data: null, error };
    const rows = data as unknown[];
    if (rows.length !== 1) return { data: null, error: { message: 'expected exactly one row' } };
    return { data: rows[0] as T, error: null };
  }

  then<R1 = { data: T | null; error: { message: string } | null }, R2 = never>(
    onFulfilled?: ((v: { data: T | null; error: { message: string } | null }) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.run().then(onFulfilled, onRejected);
  }

  private async run(): Promise<{ data: T | null; error: { message: string } | null }> {
    this.state.calls.push({
      table: this.table,
      action: this.action,
      filters: this.filters,
      extra: this.extra,
    });

    const fail = this.state.failNext;
    if (fail && fail.table === this.table && fail.action === this.action) {
      this.state.failNext = undefined;
      return { data: null, error: { message: fail.message } };
    }

    if (this.table === 'household_members') return this.runMemberships();
    if (this.table === 'sync_rows') return this.runSyncRows();
    return { data: null, error: { message: `unknown table ${this.table}` } };
  }

  private matches(record: Record<string, unknown>): boolean {
    return this.filters.every((f) =>
      f.op === 'eq'
        ? record[f.column] === f.value
        : (record[f.column] as number) > (f.value as number),
    );
  }

  private async runMemberships(): Promise<{ data: T | null; error: null }> {
    const { memberships } = this.state;

    if (this.action === 'insert') {
      const payload = this.payload as { user_id: string };
      const created: Membership = {
        user_id: payload.user_id,
        household_id: `household-${memberships.length + 1}`,
      };
      memberships.push(created);
      return { data: [created] as unknown as T, error: null };
    }

    if (this.action === 'update') {
      const patch = this.payload as Partial<Membership>;
      const updated: Membership[] = [];
      for (const m of memberships) {
        if (!this.matches(m as unknown as Record<string, unknown>)) continue;
        Object.assign(m, patch);
        updated.push(m);
      }
      return { data: updated as unknown as T, error: null };
    }

    const found = memberships.filter((m) => this.matches(m as unknown as Record<string, unknown>));
    return { data: found as unknown as T, error: null };
  }

  private async runSyncRows(): Promise<{ data: T | null; error: null }> {
    if (this.action === 'upsert') {
      for (const incoming of this.payload as RemoteRow[]) {
        const idx = this.state.rows.findIndex(
          (r) => r.household_id === incoming.household_id && r.id === incoming.id,
        );
        if (idx === -1) this.state.rows.push({ ...incoming });
        else this.state.rows[idx] = { ...incoming };
      }
      return { data: null, error: null };
    }

    let found = this.state.rows.filter((r) => this.matches(r as unknown as Record<string, unknown>));
    // Stable ordering, matching the adapter's `order('updated_at').order('id')`.
    found = [...found].sort((a, b) => a.updated_at - b.updated_at || a.id.localeCompare(b.id));
    if (this.rangeSpec) found = found.slice(this.rangeSpec[0], this.rangeSpec[1] + 1);
    return { data: found as unknown as T, error: null };
  }
}

export function createFakeSupabase(
  initial: Partial<FakeSupabaseState> = {},
): { client: SupabaseClient; state: FakeSupabaseState } {
  const state: FakeSupabaseState = {
    rows: initial.rows ?? [],
    memberships: initial.memberships ?? [],
    calls: [],
    ...(initial.failNext ? { failNext: initial.failNext } : {}),
  };

  let currentUser: { id: string; email: string } | null = null;

  const client = {
    auth: {
      async getSession() {
        return { data: { session: currentUser ? { user: currentUser } : null }, error: null };
      },
      async signInWithPassword({ email }: { email: string; password: string }) {
        currentUser = { id: `user-${email}`, email };
        return { data: { user: currentUser, session: { user: currentUser } }, error: null };
      },
      async signUp({ email }: { email: string; password: string }) {
        currentUser = { id: `user-${email}`, email };
        return { data: { user: currentUser, session: { user: currentUser } }, error: null };
      },
      async signOut() {
        currentUser = null;
        return { error: null };
      },
    },
    from(table: string) {
      return {
        select: () => new FakeQuery(state, table, 'select'),
        insert: (payload: unknown) => new FakeQuery(state, table, 'insert', payload),
        update: (payload: unknown) => new FakeQuery(state, table, 'update', payload),
        upsert: (payload: unknown, extra?: unknown) =>
          new FakeQuery(state, table, 'upsert', payload, extra),
      };
    },
  } as unknown as SupabaseClient;

  return { client, state };
}
