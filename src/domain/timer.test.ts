import { describe, expect, it } from 'vitest';
import {
  deserializeTimer,
  elapsedMs,
  initTimer,
  serializeTimer,
  STALE_TIMER_MS,
  stageOf,
  stageRemainingSec,
  timerReducer,
  toShotTimes,
  type TimerEvent,
  type TimerState,
} from './timer.ts';

/** The Legato's auto cycle: 3 s saturation, 6 s bloom. */
const config = { p1Sec: 3, p2Sec: 6 };

function run(events: TimerEvent[], state: TimerState = initTimer(config)): TimerState {
  return events.reduce(timerReducer, state);
}

const start = (at = 0, epoch = 1_700_000_000_000): TimerEvent => ({ type: 'START', at, epoch });
const tick = (at: number): TimerEvent => ({ type: 'TICK', at });

describe('stages', () => {
  it('runs idle → p1 → bloom → extraction on elapsed time alone', () => {
    let state = initTimer(config);
    expect(stageOf(state)).toBe('idle');

    state = run([start(0), tick(1_000)], state);
    expect(stageOf(state)).toBe('p1');

    state = run([tick(3_500)], state);
    expect(stageOf(state)).toBe('bloom');

    state = run([tick(9_500)], state);
    expect(stageOf(state)).toBe('extraction');
  });

  it('treats the stage boundaries as [start, end)', () => {
    const atP1End = run([start(0), tick(3_000)]);
    expect(stageOf(atP1End)).toBe('bloom');

    const atBloomEnd = run([start(0), tick(9_000)]);
    expect(stageOf(atBloomEnd)).toBe('extraction');
  });

  it('goes straight to extraction when pre-infusion is disabled', () => {
    const state = run([start(0), tick(500)], initTimer({ p1Sec: 0, p2Sec: 0 }));
    expect(stageOf(state)).toBe('extraction');
  });

  it('counts down the remaining seconds of each pre-infusion stage', () => {
    expect(stageRemainingSec(run([start(0), tick(1_000)]))).toBe(2);
    expect(stageRemainingSec(run([start(0), tick(5_000)]))).toBe(4);
    expect(stageRemainingSec(run([start(0), tick(12_000)]))).toBeNull();
  });

  it('reports done after stopping', () => {
    const state = run([start(0), tick(30_000), { type: 'STOP', at: 30_000 }]);
    expect(stageOf(state)).toBe('done');
  });
});

describe('elapsed time', () => {
  it('measures from the start mark, not from tick count', () => {
    // One tick that jumps 27 s — exactly what a throttled tab produces.
    const state = run([start(1_000), tick(28_000)]);
    expect(elapsedMs(state)).toBe(27_000);
  });

  it('never goes backwards if a stale tick arrives', () => {
    const state = run([start(0), tick(20_000), tick(15_000)]);
    expect(elapsedMs(state)).toBe(20_000);
  });

  it('freezes at the stop mark and ignores later ticks', () => {
    const state = run([start(0), tick(27_000), { type: 'STOP', at: 27_000 }, tick(60_000)]);
    expect(elapsedMs(state)).toBe(27_000);
  });
});

describe('guards', () => {
  it('ignores a second start', () => {
    const state = run([start(0, 111), start(5_000, 222)]);
    expect(state.startedAt).toBe(0);
    expect(state.startedAtEpoch).toBe(111);
  });

  it('keeps only the first drip mark', () => {
    const state = run([
      start(0),
      { type: 'FIRST_DRIP', at: 11_000 },
      { type: 'FIRST_DRIP', at: 14_000 },
    ]);
    expect(state.firstDripAt).toBe(11_000);
  });

  it('ignores first drip and stop when not running', () => {
    const idle = run([{ type: 'FIRST_DRIP', at: 100 }, { type: 'STOP', at: 200 }]);
    expect(idle.firstDripAt).toBeNull();
    expect(idle.stoppedAt).toBeNull();

    const stopped = run([start(0), { type: 'STOP', at: 27_000 }, { type: 'STOP', at: 40_000 }]);
    expect(stopped.stoppedAt).toBe(27_000);
  });

  it('refuses to change pre-infusion mid-pull, since that redefines the stages', () => {
    const running = run([start(0), tick(5_000), { type: 'SET_CONFIG', config: { p1Sec: 1, p2Sec: 1 } }]);
    expect(running.config).toEqual(config);

    const idle = run([{ type: 'SET_CONFIG', config: { p1Sec: 1, p2Sec: 1 } }]);
    expect(idle.config).toEqual({ p1Sec: 1, p2Sec: 1 });
  });

  it('resets to idle while keeping the configured stages', () => {
    const state = run([start(0), tick(9_000), { type: 'RESET' }]);
    expect(stageOf(state)).toBe('idle');
    expect(state.config).toEqual(config);
  });
});

describe('toShotTimes', () => {
  it('splits the pull into pre-infusion and extraction', () => {
    // 36 s total: 9 s of pre-infusion, 27 s of extraction.
    const state = run([start(0), tick(36_000), { type: 'STOP', at: 36_000 }]);
    expect(toShotTimes(state)).toEqual({ preInfusionSec: 9, extractionSec: 27 });
  });

  it('records first drip relative to the start of the pull', () => {
    const state = run([
      start(0),
      { type: 'FIRST_DRIP', at: 12_400 },
      { type: 'STOP', at: 36_000 },
    ]);
    expect(toShotTimes(state).firstDripSec).toBe(12.4);
  });

  it('never reports negative extraction when stopped during pre-infusion', () => {
    const state = run([start(0), { type: 'STOP', at: 4_000 }]);
    expect(toShotTimes(state)).toEqual({ preInfusionSec: 4, extractionSec: 0 });
  });

  it('rounds to tenths', () => {
    const state = run([start(0), { type: 'STOP', at: 36_449 }]);
    expect(toShotTimes(state).extractionSec).toBe(27.4);
  });
});

describe('persistence across a reload', () => {
  it('re-anchors the monotonic clock so a restored pull keeps its true elapsed time', () => {
    const state = run([start(500, 1_000_000), { type: 'FIRST_DRIP', at: 12_500 }]);
    const raw = serializeTimer(state)!;

    // Reload 20 s later: performance.now() has reset, Date.now() has not.
    const restored = deserializeTimer(raw, 3_000, 1_020_000)!;

    expect(elapsedMs(restored)).toBe(20_000);
    expect(stageOf(restored)).toBe('extraction');
    // The first-drip mark keeps its offset within the pull.
    expect(toShotTimes(restored).firstDripSec).toBe(12);
  });

  it('keeps a stopped pull stopped', () => {
    const state = run([start(0, 1_000_000), { type: 'STOP', at: 36_000 }]);
    const restored = deserializeTimer(serializeTimer(state)!, 5_000, 1_040_000)!;

    expect(stageOf(restored)).toBe('done');
    expect(toShotTimes(restored)).toEqual({ preInfusionSec: 9, extractionSec: 27 });
  });

  it('discards a stale record rather than resuming a shot from yesterday', () => {
    const state = run([start(0, 1_000_000)]);
    const raw = serializeTimer(state)!;
    expect(deserializeTimer(raw, 0, 1_000_000 + STALE_TIMER_MS + 1)).toBeNull();
  });

  it('returns null for an idle timer, absent storage, or corrupt JSON', () => {
    expect(serializeTimer(initTimer(config))).toBeNull();
    expect(deserializeTimer(null, 0, 0)).toBeNull();
    expect(deserializeTimer('{not json', 0, 0)).toBeNull();
    expect(deserializeTimer('{"nope":1}', 0, 0)).toBeNull();
  });
});
