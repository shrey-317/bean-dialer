import type { Shot, Targets, TimingBasis } from './types.ts';

/**
 * Derived measurements. Kept pure and free of DB/React imports so the advice engine, the
 * charts, and the tests all agree on what "the time" and "the ratio" mean.
 */

/**
 * The seconds a target window should be compared against.
 *
 * Shots store raw phases, so this is where interpretation happens — and it is the reason
 * a 3 s/6 s pre-infused pull is never accidentally compared against a bare one.
 * Returns undefined for `first-drip` when that reading wasn't captured.
 */
export function shotTimeOnBasis(shot: Shot, basis: TimingBasis): number | undefined {
  switch (basis) {
    case 'extraction':
      return shot.extractionSec;
    case 'total':
      return shot.preInfusionSec + shot.extractionSec;
    case 'first-drip':
      return shot.firstDripSec;
  }
}

/** Wall-clock length of the whole pull. */
export function totalSec(shot: Shot): number {
  return shot.preInfusionSec + shot.extractionSec;
}

/** Brew ratio as the divisor in 1:N. 18 g → 40 g is 1:2.22. */
export function brewRatio(shot: Pick<Shot, 'doseG' | 'yieldG'>): number {
  if (shot.doseG <= 0) return 0;
  return shot.yieldG / shot.doseG;
}

export function targetRatio(targets: Pick<Targets, 'doseG' | 'yieldG'>): number {
  if (targets.doseG <= 0) return 0;
  return targets.yieldG / targets.doseG;
}

/**
 * Grams per second over the extraction phase — the shape-independent way to compare pulls
 * whose yields differ. This is what gets reported when a shot's yield overshot so badly
 * that its elapsed time says nothing useful on its own.
 */
export function flowRate(shot: Shot): number {
  if (shot.extractionSec <= 0) return 0;
  return shot.yieldG / shot.extractionSec;
}

/** Signed grams away from the target yield. Positive = overshot. */
export function yieldDeviation(shot: Pick<Shot, 'yieldG'>, targets: Pick<Targets, 'yieldG'>): number {
  return shot.yieldG - targets.yieldG;
}

/**
 * How far off target the yield may be before elapsed time stops being comparable.
 * ±2 g on a 40 g shot is ~5%, which is about the point where the time difference is
 * explained by the extra liquid rather than by the grind.
 */
export const YIELD_TOLERANCE_G = 2;

export function isYieldUsable(
  shot: Pick<Shot, 'yieldG'>,
  targets: Pick<Targets, 'yieldG'>,
  toleranceG: number = YIELD_TOLERANCE_G,
): boolean {
  return Math.abs(yieldDeviation(shot, targets)) <= toleranceG;
}

/** Signed grams away from the target dose. Positive = overdosed. */
export function doseDeviation(shot: Pick<Shot, 'doseG'>, targets: Pick<Targets, 'doseG'>): number {
  return shot.doseG - targets.doseG;
}

/**
 * How far off target the dose may be before elapsed time stops being comparable. Tighter than
 * the yield tolerance: dose is set on a scale before the shot ever starts, so there's less
 * excuse for it drifting than yield has (which is often read live, mid-pour).
 */
export const DOSE_TOLERANCE_G = 0.3;

export function isDoseUsable(
  shot: Pick<Shot, 'doseG'>,
  targets: Pick<Targets, 'doseG'>,
  toleranceG: number = DOSE_TOLERANCE_G,
): boolean {
  return Math.abs(doseDeviation(shot, targets)) <= toleranceG;
}

export type WindowVerdict = 'fast' | 'in-window' | 'slow' | 'unknown';

export function windowVerdict(seconds: number | undefined, targets: Targets): WindowVerdict {
  if (seconds === undefined) return 'unknown';
  const [min, max] = targets.timeWindowSec;
  if (seconds < min) return 'fast';
  if (seconds > max) return 'slow';
  return 'in-window';
}

/** Signed seconds outside the window; 0 when inside it. */
export function secondsOutsideWindow(seconds: number, targets: Targets): number {
  const [min, max] = targets.timeWindowSec;
  if (seconds < min) return seconds - min;
  if (seconds > max) return seconds - max;
  return 0;
}

// --- Aggregates -------------------------------------------------------------

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Population standard deviation. Used as the consistency figure, so σ of one shot is 0. */
export function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

export function spread(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.max(...values) - Math.min(...values);
}

export interface SessionStats {
  shotCount: number;
  avgTimeSec: number;
  avgYieldG: number;
  avgRatio: number;
  /** σ of shot time on the session's basis — the headline consistency number. */
  timeConsistencySec: number;
  inWindowCount: number;
  channelingCount: number;
  avgRating?: number;
}

export function sessionStats(shots: Shot[], targets: Targets): SessionStats {
  const countable = shots.filter((s) => !s.discarded);
  const times = countable
    .map((s) => shotTimeOnBasis(s, targets.timingBasis))
    .filter((t): t is number => t !== undefined);
  const ratings = countable.map((s) => s.rating).filter((r): r is number => typeof r === 'number');

  return {
    shotCount: countable.length,
    avgTimeSec: mean(times),
    avgYieldG: mean(countable.map((s) => s.yieldG)),
    avgRatio: mean(countable.map(brewRatio)),
    timeConsistencySec: stdDev(times),
    inWindowCount: times.filter((t) => windowVerdict(t, targets) === 'in-window').length,
    channelingCount: countable.filter((s) => s.channeling).length,
    ...(ratings.length > 0 ? { avgRating: mean(ratings) } : {}),
  };
}

/**
 * Is the dial converged enough to call it locked in?
 *
 * Requires the last `required` countable shots to share a dial, land in the window, hold a
 * usable yield, and sit within `maxSpreadSec` of each other. Deliberately not satisfied by a
 * single good shot — one lucky pull is not a dial, which is why the default is 2. Also refuses
 * to converge if either shot carries a rating of 2 or below: a shot you actively disliked
 * doesn't confirm a dial no matter how clean the numbers are, and an un-rated shot doesn't
 * block anything (absence of a rating isn't a bad one).
 */
export function isConverged(
  shots: Shot[],
  targets: Targets,
  required = 2,
  maxSpreadSec = 2,
): boolean {
  const countable = shots.filter((s) => !s.discarded);
  if (countable.length < required) return false;

  const recent = countable.slice(-required);
  const dials = new Set(recent.map((s) => s.dial));
  if (dials.size !== 1) return false;
  if (!recent.every((s) => isYieldUsable(s, targets))) return false;
  if (recent.some((s) => s.rating !== undefined && s.rating <= 2)) return false;

  const times = recent
    .map((s) => shotTimeOnBasis(s, targets.timingBasis))
    .filter((t): t is number => t !== undefined);
  if (times.length !== required) return false;
  if (!times.every((t) => windowVerdict(t, targets) === 'in-window')) return false;

  return spread(times) <= maxSpreadSec;
}

/** Shots taken before the session first reached a locked-in dial. */
export function shotsToLockIn(shots: Shot[], lockedDial: number | undefined): number | undefined {
  if (lockedDial === undefined) return undefined;
  const countable = shots.filter((s) => !s.discarded);
  const idx = countable.findIndex((s) => s.dial === lockedDial);
  return idx === -1 ? undefined : idx + 1;
}
