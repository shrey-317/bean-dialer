# Bean Dialer — Espresso Dial-In Coach

An offline, installable web app for dialling in espresso. Run the staged pre-infusion timer, log
the shot, and it tells you what to change next — in your grinder's own units.

Built around one specific setup: a **Turin Legato V2**, a **DF54** grinder, and a
**self-levelling tamper**. Nothing is hardcoded to it — gear is editable — but the app ships
pre-seeded with it, so there is no configuration between installing and pulling a shot.

## Why the advice is the way it is

Two details of that setup drive real design decisions rather than being cosmetic.

**On this DF54, a higher dial number is coarser** — the normal convention. Grind direction is
still a property of the grinder record (`dialDirection`) rather than assumed, though: not every
grinder runs this way, and every suggestion is expressed as "finer" or "coarser" and converted to
a signed dial change through it. There is a test asserting a 22 s shot suggests **16.0** from
16.5, and a mirrored test on a `higher-is-finer` grinder — because a coach that confidently tells
you to turn the wrong way is worse than no coach.

**A self-levelling tamper has no pressure override.** All flow correction is grind-based, so the
engine never suggests tamping differently, and says as much when it diagnoses channelling.

## How a shot is measured

Shots store raw phases — `preInfusionSec`, `extractionSec`, `firstDripSec` — never a single
pre-interpreted "total time". A pull on the Legato's auto cycle has 3 s of saturation and a 6 s
bloom before extraction begins, and comparing that against a bare pull is how you end up chasing
a grind setting that was never wrong. Which measurement the target window refers to is chosen at
read time and configurable in Setup; the default is extraction only, since that is the part the
grind actually governs.

The same care applies to first drip: "early" is measured from the *end* of pre-infusion, so 9 s to
first drip is normal here rather than alarming.

## The rules, in order

The engine (`src/domain/advice.ts`) is a pure function. The first rule that fires wins.

1. **Dose gate.** More than ±0.3 g off target and the shot isn't comparable to one at the target
   dose — more or less coffee changes puck resistance before the grind gets a say. Tighter than
   the yield gate below, since dose is scale-weighed rather than eyeballed mid-pour. Runs first:
   dose is the more upstream variable, so it's the more useful one to fix when both are off.
2. **Yield gate.** More than ±2 g off target and the elapsed time says as much about the extra
   liquid as about the grind. It reports flow rate in g/s and asks for a clean shot instead of
   changing anything.
3. **Time correction.** Below the window → finer; above → coarser. One step for a normal miss,
   more when the shot is nowhere near, clamped to the grinder's range and snapped to its steps.
   Peak pressure, flow rate and bean freshness all layer in here as *notes*, never as a change to
   the action itself — see below.
4. **Oscillation guard.** If suggestions have been alternating finer/coarser, it stops stepping
   and asks for two pulls at the same setting — the real answer is between two clicks.
5. **Channelling.** With the time already on target, an uneven puck is the remaining problem, so
   the grind stays put and the advice is about distribution.
6. **Lock-in.** Two consecutive in-window shots at the same dial, with matching yields and within
   2 s of each other, and it offers to lock the dial in. One good shot is not a dial — and a shot
   you rated 2/5 or lower doesn't count as one either, no matter how clean the numbers are.
7. **Taste tie-breaker.** Only once the numbers are good: sour/thin → finer, bitter/harsh →
   coarser, with temperature offered as the alternative rather than the primary move.

Discarded shots (flushes, spills) stay in the log and are excluded from advice and statistics.

### What corroborates the time-based call, and what deliberately doesn't

A fast or slow verdict is still the primary signal, but a few other readings sharpen or complicate
it — as *notes* on that same call, never as a rule of their own:

- **Peak pressure.** Low pressure (under 5 bar) on a fast shot corroborates "too coarse" and lifts
  confidence. Low pressure on a *slow* shot is the more useful reading: that combination is
  physically odd for a genuinely fine grind, and points at an uneven or blocked puck rather than
  the dial. What pressure can't do is tell a channelled puck apart from a truly coarse one — both
  read as low resistance on the gauge — so it's never used to relabel a shot as channelling; that
  stays reserved for what you actually saw.
- **Flow rate.** Above roughly 2.5 g/s, taste tends to drop off, per Lance Hedrick's published
  extraction testing. Noted on a fast shot, never a gate — deliberately fast styles (turbo shots)
  run well above this on purpose.
- **Bean freshness.** Under about 5 days off roast, a bean is still degassing enough to run a shot
  fast on its own, independent of the grind. Surfaces as a caveat on a fast-shot correction, not a
  reason to withhold it — the correction is probably still right, it just may need rechecking once
  the bag settles.
- **Crema colour is not read at all.** It correlates far more with bean freshness and roast degree
  than with extraction quality — James Hoffmann has demonstrated a badly under-extracted shot with
  thick "textbook" crema and a well-extracted one with much less. Acting on it here would mean
  acting on the wrong variable, not a weaker version of a right one. It's still logged, for your
  own notes, but the coach never reads it.

## Data

Shots are written to IndexedDB on the device first, always, and every screen works with no
network. Export JSON to keep a backup of your own, or CSV to open the log in a spreadsheet;
importing merges rather than replaces, newest edit winning per row.

Every row carries a sync envelope (`updatedAt`, `deletedAt`, `dirty`) and all writes funnel
through `src/db/repo`, which stamps them and queues an outbox entry in the same transaction.
Deletes are tombstones, so a deletion can actually propagate.

## Sync between two phones

Optional, and off until you configure it. With it on, two phones share one set of beans, gear,
sessions and shots.

**Device settings deliberately do not sync** — theme, sound, haptics and keep-awake describe a
phone, not a household.

### Setting it up

1. Create a free project at [supabase.com](https://supabase.com).
2. Open the SQL editor and run [`supabase/schema.sql`](supabase/schema.sql). It is idempotent.
3. In the app: **Setup → Sync between phones**, paste the **Project URL** and the **anon** public
   key from Supabase → Settings → API, then create an account.
4. On the second phone, do the same and sign in — then copy the **household code** from the first
   phone and paste it into *Join the other phone's household*. Shots already on the second phone
   are kept and pushed into the household it joins.

The anon key belongs in the client: it is designed to be public, and the row-level security in
the schema is what protects the data. The `service_role` key must never go near the app.

The household id is effectively a shared secret — anyone holding it can join — which is the same
trust model as a shared calendar link.

### How it behaves

- **Local first.** A write lands in IndexedDB and is queued; sync is a background chore that
  happens afterwards. A failure surfaces as status on the Setup screen and never interrupts
  logging a shot.
- **When it syncs.** On launch, a couple of seconds after a change (debounced), when the app comes
  back to the foreground, when the network returns, and once a minute while open. Not realtime:
  two phones rarely pull shots at the same moment, and it avoids holding a socket open in a pocket.
- **Conflicts.** Last write wins on `updatedAt`, except that a tombstone beats a concurrent edit —
  a bean you deleted on one phone shouldn't be resurrected by a stale edit from the other. Clock
  skew between two phones on network time is seconds, which shot logs tolerate.
- **What travels.** One `sync_rows` table with the domain object in a `jsonb` column, rather than a
  column-per-field mirror. The app is the only consumer and the model is still moving; mirroring
  columns would mean a Postgres migration for every field. The tradeoff is no useful server-side
  reporting SQL — use the CSV export for that.

### What the tests do and don't prove

`e2e/sync.spec.ts` drives two independent browser contexts — two devices, separate storage,
separate sign-ins — against a stub project (`e2e/stub-supabase.mjs`) using the real supabase-js
client, and asserts that a shot logged on one shows up on the other, that an offline shot syncs
when the network returns, and that the app is untouched with sync switched off.

It does **not** prove `supabase/schema.sql` or its row-level security are correct: the stub only
simulates household scoping, and real policy enforcement needs a real project. The first sync
against your own project is the test for that — and if the schema hasn't been applied, the app
says the database refused the change rather than failing silently.

## Installing it on a phone

Deployed via GitHub Pages, which supplies the HTTPS origin a service worker needs.

- **Android / Chrome** — an install button appears in Setup.
- **iPhone** — Safari has no programmatic install: use **Share → Add to Home Screen**. It must be
  Safari; other iOS browsers cannot add to the home screen.

Once installed it runs full-screen and works with no network at all.

### What a web app can't do

No web page can keep a timer running while backgrounded, so the timer needs the app in the
foreground — fine for a 40-second shot, and the Screen Wake Lock API keeps the display on where
it's supported. `navigator.vibrate` doesn't exist on iOS, so every stage transition is signalled
three ways: a full-screen colour change, a tone, and vibration where available.

All of those touchpoints live behind thin adapters in `src/platform/`, so wrapping this in
Capacitor to ship real App Store / Play Store binaries later means swapping adapter
implementations rather than rewriting features.

## Development

```bash
npm install
npm run dev          # dev server
npm run typecheck    # tsc --noEmit
npm run lint
npm test             # Vitest unit tests
npm run test:e2e     # Playwright, against a production build
npm run icons        # regenerate the PWA icons from their SVG source
npm run build        # BASE_PATH=/ for a root-served build
```

`npm run test:e2e` also writes a walkthrough of every screen to `screenshots/`. Look at them after
a UI change — the automated checks cover colour and behaviour, not whether a label collides.

### Layout

```
src/domain/     pure logic: advice engine, metrics, timer state machine — no DB, no React
src/db/         Dexie schema, the repo layer every write goes through, seed, backup
src/db/sync/    the sync contract, the Supabase adapter, and the scheduling engine
src/hooks/      live queries and the pure context builder that joins them
src/platform/   haptics, wake lock, install — feature-detected, all degrade to no-ops
src/screens/    one file per screen
src/components/ shared UI and the charts
supabase/       the SQL to run once in your own project
```

### Three things worth knowing before changing code

**Live queries.** Dexie only re-runs a live query when a table it observed is written, and that
observation is lost after the first `await` in an async callback. So hooks issue exactly one
un-awaited query per table (`queryTable`) and join in plain JavaScript. A nested async read path
looks correct and silently stops updating.

**The base path.** A project Pages site is served from `/<repo>/`, and the Vite `base`, the router
`basename`, and the manifest `scope`/`start_url` must all agree. They all derive from `BASE_PATH`;
disagreement produces a blank installed app or an install that silently refuses. An e2e test
checks the manifest against the path it was actually served from.

**`TableName` vs `SyncedTableName`.** The repo layer manages five tables; four of them sync. Those
are separate types on purpose — collapsing them is what once let `settings` writes into the sync
outbox, which both inflated the "waiting to send" count forever and produced a Dexie transaction
whose scope was missing the store it then read. If you add a table, decide which it is.
