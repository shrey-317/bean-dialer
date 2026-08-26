/**
 * Domain types for the dial-in coach.
 *
 * Two conventions worth knowing before reading further:
 *
 * 1. Every persisted row carries the `Synced` envelope. Nothing in the app deletes a row
 *    outright — deletes are tombstones — so a future sync adapter can propagate them.
 *
 * 2. Shots store *raw measured facts*, never a pre-interpreted "total time". A pull on the
 *    Legato's auto cycle has a pre-infusion phase and an extraction phase, and comparing a
 *    3s/6s pre-infused pull against a bare pull is how you end up chasing a grind setting
 *    that was never wrong. So we record `preInfusionSec`, `extractionSec` and
 *    `firstDripSec` separately and pick a comparison basis at read time
 *    (see `shotTimeOnBasis` in ./metrics.ts).
 */

/** Fields every syncable row carries. */
export interface Synced {
  id: string;
  /** Epoch ms, restamped on every write. Basis for last-write-wins conflict resolution. */
  updatedAt: number;
  /** Tombstone marker. Present ⇒ the row is deleted and must be filtered from all reads. */
  deletedAt?: number | null;
  /** 1 = local change not yet pushed. Numeric because IndexedDB cannot index booleans. */
  dirty: 0 | 1;
}

// ---------------------------------------------------------------------------
// Gear
// ---------------------------------------------------------------------------

/**
 * Which way the grind adjuster runs. On the DF54 as used here, and on most grinders, a
 * *higher* number is *coarser* — but it's a property of the specific grinder, not something
 * to assume, so the advice engine resolves every suggestion through this field rather than
 * hardcoding a direction.
 */
export type DialDirection = 'higher-is-finer' | 'higher-is-coarser';

export type GearKind = 'machine' | 'grinder' | 'tamper' | 'basket';

export interface PreInfusion {
  /** Low-pressure saturation, seconds. */
  p1Sec: number;
  /** Bloom / pause after saturation, seconds. */
  p2Sec: number;
}

export interface MachineSpec {
  defaultTempC: number;
  /** The machine's programmed pre-infusion, used to pre-fill the timer stages. */
  preInfusion: PreInfusion;
  hasAutoMode: boolean;
}

export interface GrinderSpec {
  dialMin: number;
  dialMax: number;
  /** Smallest meaningful adjustment. Every suggested dial is rounded to a multiple of this. */
  dialStep: number;
  dialDirection: DialDirection;
  burrType?: 'flat' | 'conical';
  antiStatic?: 'none' | 'plasma' | 'ionizer';
}

export interface TamperSpec {
  selfLeveling: boolean;
  /**
   * False for a self-leveling tamper. When false the advice engine must never propose a
   * tamp-pressure change, because there is no such control to turn.
   */
  pressureAdjustable: boolean;
  diameterMm?: number;
}

export interface BasketSpec {
  capacityG: number;
  diameterMm?: number;
}

interface GearBase extends Synced {
  name: string;
  brand?: string;
  /** The one picked by default for new sessions, per kind. */
  isDefault: boolean;
  notes?: string;
}

export interface MachineGear extends GearBase {
  kind: 'machine';
  spec: MachineSpec;
}
export interface GrinderGear extends GearBase {
  kind: 'grinder';
  spec: GrinderSpec;
}
export interface TamperGear extends GearBase {
  kind: 'tamper';
  spec: TamperSpec;
}
export interface BasketGear extends GearBase {
  kind: 'basket';
  spec: BasketSpec;
}

/** Discriminated on `kind`, so `spec` narrows correctly. */
export type Gear = MachineGear | GrinderGear | TamperGear | BasketGear;

// ---------------------------------------------------------------------------
// Beans
// ---------------------------------------------------------------------------

export type BeanProcess = 'natural' | 'washed' | 'honey' | 'anaerobic' | 'other';

export type RoastLevel = 'light' | 'medium-light' | 'medium' | 'medium-dark' | 'dark';

export type BeanState = 'unopened' | 'resting' | 'active' | 'finished';

export interface Bean extends Synced {
  roaster: string;
  name: string;
  origin?: string;
  /**
   * A bag is often more than one process — a co-ferment or a blend of lots. An array, not a
   * single value, and never empty (omit the field instead of storing `[]`).
   */
  process?: BeanProcess[];
  roastLevel?: RoastLevel;
  /** ISO calendar date (yyyy-mm-dd) — a day, not an instant. Powers days-off-roast. */
  roastDate?: string;
  bagWeightG?: number;
  priceCents?: number;
  notes?: string;
  /** The roaster's own tasting notes, e.g. ["black cherry", "chocolate", "brown sugar"]. Free
   *  text, not a fixed list — there's no closed set of flavour words worth enumerating. */
  tastingNotes?: string[];
  state: BeanState;
}

// ---------------------------------------------------------------------------
// Sessions (a dial-in campaign for one bean on one gear combination)
// ---------------------------------------------------------------------------

/**
 * Which measurement a target time window and all comparisons refer to.
 * - `extraction`  — after pre-infusion ends, to stop. The default: it isolates the part of
 *                   the pull that the grind actually governs.
 * - `total`       — the whole pull including pre-infusion, i.e. what a wall clock shows.
 * - `first-drip`  — pump start to first drip. A puck-prep and resistance signal.
 */
export type TimingBasis = 'extraction' | 'total' | 'first-drip';

export interface Targets {
  doseG: number;
  yieldG: number;
  tempC: number;
  preInfusion: PreInfusion;
  /** Inclusive [min, max] seconds, interpreted on `timingBasis`. */
  timeWindowSec: [number, number];
  timingBasis: TimingBasis;
}

export type SessionStatus = 'dialing' | 'locked' | 'abandoned';

export interface Session extends Synced {
  beanId: string;
  grinderId: string;
  machineId?: string;
  tamperId?: string;
  basketId?: string;
  targets: Targets;
  startDial: number;
  currentDial: number;
  status: SessionStatus;
  /** Set when the session is locked in, so reopening the bag starts from a known-good number. */
  lockedDial?: number;
  lockedAt?: number;
  startedAt: number;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Shots
// ---------------------------------------------------------------------------

export type TasteTag =
  | 'sour'
  | 'bitter'
  | 'balanced'
  | 'harsh'
  | 'sweet'
  | 'thin'
  | 'syrupy'
  | 'fruity'
  | 'ashy';

export type CremaColor = 'pale' | 'honey' | 'dark' | 'blonding-early';

/**
 * Coarse, eyeballed peak pressure rather than a precise reading — this app has no gauge
 * integration, so asking for more precision than "did the needle get to 9?" would just invite
 * guessed decimals. `full` covers a normal 9-bar pump; `under` flags a machine or puck problem
 * worth troubleshooting separately from the grind.
 */
export type PeakPressure = 'under-5-bar' | '5-to-8-bar' | '9-bar';

export interface Shot extends Synced {
  sessionId: string;
  /** Grinder setting this shot was pulled at, in the grinder's own units. */
  dial: number;
  doseG: number;
  yieldG: number;
  /** Measured pre-infusion duration (P1 + P2) actually used for this pull. */
  preInfusionSec: number;
  /** Pre-infusion end to stop. */
  extractionSec: number;
  /** Pump start to first drip in the cup. Optional: easy to miss while pulling. */
  firstDripSec?: number;
  tempC: number;
  channeling: boolean;
  cremaColor?: CremaColor;
  /** Peak gauge reading, if the machine has one and it was watched. */
  peakPressure?: PeakPressure;
  /** 1–5, subjective overall. */
  rating?: number;
  tasteTags: TasteTag[];
  notes?: string;
  pulledAt: number;
  /** The advice shown at the time, kept so history explains its own decisions. */
  suggestion?: Advice;
  suggestionFollowed?: boolean;
  /** Flush/purge/spilled shots stay in the log but are excluded from analytics. */
  discarded?: boolean;
}

// ---------------------------------------------------------------------------
// Advice
// ---------------------------------------------------------------------------

export type AdviceKind =
  /** Change the grinder setting. */
  | 'grind'
  /** Change brew temperature (only ever offered once time is already in window). */
  | 'temp'
  /** Stop stepping and repeat at the current setting. */
  | 'hold'
  /** The dial looks converged — offer to lock it in. */
  | 'lock-in'
  /** The shot can't be interpreted; pull another one cleanly. */
  | 'reshoot'
  /** Nothing actionable. */
  | 'none';

export interface AdviceAction {
  kind: AdviceKind;
  /** Signed change in grinder units, already resolved through `dialDirection`. */
  deltaDial?: number;
  newDial?: number;
  deltaTempC?: number;
  newTempC?: number;
}

export type Confidence = 'low' | 'medium' | 'high';

export interface Advice {
  action: AdviceAction;
  /** One short line for the big card, e.g. "Grind finer — 16.5 → 16.0". */
  headline: string;
  /** Why, in plain language, referencing the actual numbers. */
  reason: string;
  confidence: Confidence;
  /** Secondary observations that don't change the primary action. */
  notes: string[];
  /** Which rule produced this. Makes tests and bug reports concrete. */
  ruleId: AdviceRuleId;
}

export type AdviceRuleId =
  | 'no-shots'
  | 'yield-out-of-range'
  | 'time-too-fast'
  | 'time-too-slow'
  | 'channeling'
  | 'taste-sour'
  | 'taste-bitter'
  | 'oscillation'
  | 'lock-in'
  | 'in-window';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const SETTINGS_ID = 'singleton';

export interface Settings extends Synced {
  /** Always `SETTINGS_ID`; this table holds exactly one row. */
  id: typeof SETTINGS_ID;
  defaultTargets: Targets;
  theme: 'dark' | 'light' | 'system';
  hapticsEnabled: boolean;
  soundEnabled: boolean;
  /** Keep the screen awake during a pull, where the platform allows it. */
  keepAwakeDuringShot: boolean;
}
