-- Espresso Dial-In Coach — Supabase schema
--
-- Paste this whole file into the Supabase SQL editor and run it once. It is idempotent, so
-- re-running it is safe.
--
-- Design note: one table with a `jsonb` payload rather than a column-per-field mirror of the
-- app's tables. This database has exactly one consumer — the app — and the domain model is
-- young. Mirroring columns would mean a migration here every time a field is added on the
-- client, and a client/server mismatch silently drops data. The cost is that you can't write
-- useful reporting SQL against it; use the app's CSV export for that.
--
-- Sharing model: rows belong to a household, and a household is a UUID. Two phones share data
-- by being members of the same household. The UUID is effectively a secret — anyone who has it
-- can join — which is the same trust model as a shared calendar link, and appropriate for a
-- household coffee log.

-- ---------------------------------------------------------------------------
-- Membership
-- ---------------------------------------------------------------------------

create table if not exists public.household_members (
  user_id uuid primary key references auth.users on delete cascade,
  -- A brand-new sign-in gets its own household; joining an existing one is an update.
  household_id uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Synced rows
-- ---------------------------------------------------------------------------

create table if not exists public.sync_rows (
  household_id uuid not null,
  -- Text, not uuid: ids are client-generated and the seeded gear uses readable ids like
  -- 'seed-grinder-df54' so that both phones agree the seeded DF54 is the same grinder.
  id text not null,
  kind text not null check (kind in ('beans', 'gear', 'sessions', 'shots')),
  data jsonb not null,
  -- Client clock, epoch ms. The conflict rule is last-write-wins on this value.
  updated_at bigint not null,
  -- Tombstone. Rows are never hard-deleted, or the deletion could not propagate.
  deleted_at bigint,
  -- Server-side arrival time, for debugging only; sync never reads it.
  server_at timestamptz not null default now(),
  primary key (household_id, id)
);

-- The only query pattern the app has: "everything in my household changed since X".
create index if not exists sync_rows_household_updated_idx
  on public.sync_rows (household_id, updated_at);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.household_members enable row level security;
alter table public.sync_rows enable row level security;

-- security definer so the policy on sync_rows can read the membership table without needing
-- its own policy to permit that read; search_path is pinned as a precaution.
create or replace function public.my_household()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select household_id from public.household_members where user_id = auth.uid();
$$;

revoke all on function public.my_household() from public;
grant execute on function public.my_household() to authenticated;

drop policy if exists "members manage their own membership" on public.household_members;
create policy "members manage their own membership"
  on public.household_members
  for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "household members read and write household rows" on public.sync_rows;
create policy "household members read and write household rows"
  on public.sync_rows
  for all
  to authenticated
  using (household_id = public.my_household())
  with check (household_id = public.my_household());

-- ---------------------------------------------------------------------------
-- After running this
-- ---------------------------------------------------------------------------
--
-- 1. Settings → API: copy the **Project URL** and the **anon** public key. The anon key is
--    meant to ship in a client; row-level security above is what actually protects the data.
--    Never put the service_role key in the app.
--
-- 2. Authentication → Providers → Email: leave email/password enabled. For a two-person setup
--    you will probably also want to turn **Confirm email** off, under Authentication → Sign In /
--    Providers, so signing up on the second phone doesn't require a round trip through email.
--
-- 3. In the app: Setup → Sync, paste the URL and anon key, and sign in. Do the same on the
--    second phone, then paste the household code from the first phone so both share one log.
