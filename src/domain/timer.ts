import type { PreInfusion } from './types.ts';

/**
 * Shot timer as a pure state machine.
 *
 * Three things this design is deliberately careful about:
 *
 * 1. **Time comes from a monotonic clock passed in by the caller** (`performance.now()` in
 *    the app, fake numbers in tests). Nothing here counts `setInterval` firings, because a
 *    throttled or backgrounded tab drops them and the shot would read short.
 *
 * 2. **Stages are derived from elapsed time, not stored.** The Legato's auto cycle is purely
 *    time-based (P1 saturation, then a bloom pause, then extraction), so a tick only has to
 *    move the clock forward and the stage follows.
 *
 * 3. **A wall-clock anchor is kept alongside the monotonic one.** `performance.now()` resets
 *    to zero on reload, so restoring a mid-pull timer needs `Date.now()` to work out how much
 *    real time passed. See `restoreTimer`.
 */

export type TimerStage = 'idle' | 'p1' | 'bloom' | 'extraction' | 'done';

export interface TimerState {
  config: PreInfusion;
  /** Monotonic ms at start. Null while idle. */
  startedAt: number | null;
  /** Wall-clock ms at start; only used to survive a reload. */
  startedAtEpoch: number | null;
  /** Monotonic ms of the latest tick. */
  now: number;
  firstDripAt: number | null;
  stoppedAt: number | null;
}

export type TimerEvent =
  | { type: 'START'; at: number; epoch: number }
  | { type: 'TICK'; at: number }
  | { type: 'FIRST_DRIP'; at: number }
  | { type: 'STOP'; at: number }
  | { type: 'RESET' }
  | { type: 'SET_CONFIG'; config: PreInfusion };

export function initTimer(config: PreInfusion): TimerState {
  return {
    config,
    startedAt: null,
    startedAtEpoch: null,
    now: 0,
    firstDripAt: null,
    stoppedAt: null,
  };
}

export function preInfusionMs(config: PreInfusion): number {
  return (config.p1Sec + config.p2Sec) * 1000;
}

export function isRunning(state: TimerState): boolean {
  return state.startedAt !== null && state.stoppedAt === null;
}

export function elapsedMs(state: TimerState): number {
  if (state.startedAt === null) return 0;
  return Math.max(0, (state.stoppedAt ?? state.now) - state.startedAt);
}

export function stageOf(state: TimerState): TimerStage {
  if (state.startedAt === null) return 'idle';
  if (state.stoppedAt !== null) return 'done';
  const elapsed = elapsedMs(state);
  if (elapsed < state.config.p1Sec * 1000) return 'p1';
  if (elapsed < preInfusionMs(state.config)) return 'bloom';
  return 'extraction';
}

/** Seconds remaining in the current pre-infusion stage; null once extracting. */
export function stageRemainingSec(state: TimerState): number | null {
  const stage = stageOf(state);
  const elapsed = elapsedMs(state);
  if (stage === 'p1') return (state.config.p1Sec * 1000 - elapsed) / 1000;
  if (stage === 'bloom') return (preInfusionMs(state.config) - elapsed) / 1000;
  return null;
}

export function timerReducer(state: TimerState, event: TimerEvent): TimerState {
  switch (event.type) {
    case 'START':
      // Ignore a second start; the first press owns the pull.
      if (state.startedAt !== null) return state;
      return { ...state, startedAt: event.at, startedAtEpoch: event.epoch, now: event.at };

    case 'TICK':
      if (!isRunning(state)) return state;
      // Clamp backwards: a monotonic clock shouldn't go back, but restoring across a
      // reload can produce one stale tick, and a shot time must never shrink.
      return { ...state, now: Math.max(state.now, event.at) };

    case 'FIRST_DRIP':
      // First drip is the *first* one — later taps are fumbles, not corrections.
      if (!isRunning(state) || state.firstDripAt !== null) return state;
      return { ...state, firstDripAt: event.at, now: Math.max(state.now, event.at) };

    case 'STOP':
      if (!isRunning(state)) return state;
      return { ...state, stoppedAt: Math.max(state.startedAt!, event.at), now: event.at };

    case 'RESET':
      return initTimer(state.config);

    case 'SET_CONFIG':
      // Changing pre-infusion mid-pull would retroactively redefine the stages.
      if (state.startedAt !== null) return state;
      return { ...state, config: event.config };
  }
}

/** Round to a tenth of a second — finer than that is noise on a hand-stopped timer. */
function toTenths(ms: number): number {
  return Math.round(ms / 100) / 10;
}

export interface ShotTimes {
  preInfusionSec: number;
  extractionSec: number;
  firstDripSec?: number;
}

/**
 * The raw phase measurements to persist on a Shot.
 *
 * A pull stopped during pre-infusion yields zero extraction time rather than a negative
 * one — that shot is unusable, and the advice engine says so instead of doing arithmetic
 * on nonsense.
 */
export function toShotTimes(state: TimerState): ShotTimes {
  const total = elapsedMs(state);
  const pre = Math.min(total, preInfusionMs(state.config));
  const extraction = Math.max(0, total - preInfusionMs(state.config));
  const firstDrip =
    state.firstDripAt !== null && state.startedAt !== null
      ? toTenths(state.firstDripAt - state.startedAt)
      : undefined;

  return {
    preInfusionSec: toTenths(pre),
    extractionSec: toTenths(extraction),
    ...(firstDrip !== undefined ? { firstDripSec: firstDrip } : {}),
  };
}

// --- Persistence across reloads --------------------------------------------

const STORAGE_KEY = 'espresso.timer.v1';

/**
 * A pull is ~40 seconds. If a restored timer claims to be older than this, it's a stale
 * record from a tab closed mid-shot days ago, not a shot in progress.
 */
export const STALE_TIMER_MS = 5 * 60 * 1000;

interface PersistedTimer {
  config: PreInfusion;
  startedAtEpoch: number;
  firstDripOffsetMs: number | null;
  stoppedOffsetMs: number | null;
}

export function serializeTimer(state: TimerState): string | null {
  if (state.startedAt === null || state.startedAtEpoch === null) return null;
  const payload: PersistedTimer = {
    config: state.config,
    startedAtEpoch: state.startedAtEpoch,
    firstDripOffsetMs: state.firstDripAt === null ? null : state.firstDripAt - state.startedAt,
    stoppedOffsetMs: state.stoppedAt === null ? null : state.stoppedAt - state.startedAt,
  };
  return JSON.stringify(payload);
}

/**
 * Rebuild a timer from a persisted record, re-anchoring the monotonic clock: the elapsed
 * wall-clock time since the pull started is subtracted from *now* to synthesise the
 * `performance.now()` value the pull would have started at in this page's timeline.
 */
export function deserializeTimer(
  raw: string | null,
  monotonicNow: number,
  epochNow: number,
): TimerState | null {
  if (!raw) return null;
  let parsed: PersistedTimer;
  try {
    parsed = JSON.parse(raw) as PersistedTimer;
  } catch {
    return null;
  }
  if (!parsed?.config || typeof parsed.startedAtEpoch !== 'number') return null;

  const ageMs = epochNow - parsed.startedAtEpoch;
  if (ageMs < 0 || ageMs > STALE_TIMER_MS) return null;

  const startedAt = monotonicNow - ageMs;
  return {
    config: parsed.config,
    startedAt,
    startedAtEpoch: parsed.startedAtEpoch,
    now: monotonicNow,
    firstDripAt: parsed.firstDripOffsetMs === null ? null : startedAt + parsed.firstDripOffsetMs,
    stoppedAt: parsed.stoppedOffsetMs === null ? null : startedAt + parsed.stoppedOffsetMs,
  };
}

/** Best-effort persistence. Private-mode Safari throws on write; a lost timer is survivable. */
export function saveTimer(state: TimerState): void {
  try {
    const raw = serializeTimer(state);
    if (raw === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, raw);
  } catch {
    /* ignore */
  }
}

export function restoreTimer(config: PreInfusion): TimerState {
  try {
    const restored = deserializeTimer(localStorage.getItem(STORAGE_KEY), performance.now(), Date.now());
    if (restored) return restored;
  } catch {
    /* ignore */
  }
  return initTimer(config);
}

export function clearSavedTimer(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** Display helper: 27.4 → "27.4". Always one decimal so the width doesn't jump. */
export function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}
