import { describe, expect, it } from 'vitest';
import { DEFAULT_TARGETS } from '../db/repo/settings.ts';
import {
  brewRatio,
  flowRate,
  isConverged,
  isYieldUsable,
  secondsOutsideWindow,
  sessionStats,
  shotsToLockIn,
  shotTimeOnBasis,
  stdDev,
  totalSec,
  windowVerdict,
} from './metrics.ts';
import type { Shot, Targets } from './types.ts';

const targets: Targets = { ...DEFAULT_TARGETS };

function shot(over: Partial<Shot> = {}): Shot {
  return {
    id: 'shot',
    updatedAt: 0,
    dirty: 0,
    sessionId: 'session-1',
    dial: 16.5,
    doseG: 18,
    yieldG: 40,
    preInfusionSec: 9,
    extractionSec: 27,
    tempC: 95,
    channeling: false,
    tasteTags: [],
    pulledAt: 0,
    ...over,
  };
}

describe('shotTimeOnBasis', () => {
  const s = shot({ preInfusionSec: 9, extractionSec: 27, firstDripSec: 13 });

  it('separates extraction from the whole pull', () => {
    expect(shotTimeOnBasis(s, 'extraction')).toBe(27);
    expect(shotTimeOnBasis(s, 'total')).toBe(36);
    expect(shotTimeOnBasis(s, 'first-drip')).toBe(13);
    expect(totalSec(s)).toBe(36);
  });

  it('is undefined when first drip was not captured', () => {
    expect(shotTimeOnBasis(shot({ firstDripSec: undefined }), 'first-drip')).toBeUndefined();
  });
});

describe('ratios and flow', () => {
  it('reports the brew ratio as the divisor of 1:N', () => {
    expect(brewRatio({ doseG: 18, yieldG: 40 })).toBeCloseTo(2.22, 2);
  });

  it('reports flow over the extraction phase only', () => {
    // Pre-infusion produces little or no liquid, so including it would understate flow.
    expect(flowRate(shot({ yieldG: 40, extractionSec: 25 }))).toBeCloseTo(1.6, 5);
  });

  it('does not divide by zero', () => {
    expect(flowRate(shot({ extractionSec: 0 }))).toBe(0);
    expect(brewRatio({ doseG: 0, yieldG: 40 })).toBe(0);
  });
});

describe('window verdicts', () => {
  it('classifies against the inclusive window bounds', () => {
    expect(windowVerdict(24.9, targets)).toBe('fast');
    expect(windowVerdict(25, targets)).toBe('in-window');
    expect(windowVerdict(30, targets)).toBe('in-window');
    expect(windowVerdict(30.1, targets)).toBe('slow');
    expect(windowVerdict(undefined, targets)).toBe('unknown');
  });

  it('reports signed distance from the nearest bound, zero inside', () => {
    expect(secondsOutsideWindow(22, targets)).toBe(-3);
    expect(secondsOutsideWindow(34, targets)).toBe(4);
    expect(secondsOutsideWindow(27, targets)).toBe(0);
  });
});

describe('yield tolerance', () => {
  it('accepts ±2 g and rejects beyond it', () => {
    expect(isYieldUsable({ yieldG: 42 }, targets)).toBe(true);
    expect(isYieldUsable({ yieldG: 38 }, targets)).toBe(true);
    expect(isYieldUsable({ yieldG: 42.1 }, targets)).toBe(false);
    expect(isYieldUsable({ yieldG: 52 }, targets)).toBe(false);
  });
});

describe('sessionStats', () => {
  it('summarises countable shots and excludes discarded ones', () => {
    const shots = [
      shot({ id: 'a', extractionSec: 26, yieldG: 40, rating: 4 }),
      shot({ id: 'b', extractionSec: 28, yieldG: 40, rating: 3, channeling: true }),
      shot({ id: 'c', extractionSec: 5, yieldG: 2, discarded: true }),
    ];
    const stats = sessionStats(shots, targets);

    expect(stats.shotCount).toBe(2);
    expect(stats.avgTimeSec).toBe(27);
    expect(stats.avgYieldG).toBe(40);
    expect(stats.inWindowCount).toBe(2);
    expect(stats.channelingCount).toBe(1);
    expect(stats.avgRating).toBe(3.5);
  });

  it('leaves avgRating absent when nothing was rated', () => {
    expect(sessionStats([shot()], targets).avgRating).toBeUndefined();
  });

  it('reports a single shot as perfectly consistent rather than undefined', () => {
    expect(sessionStats([shot()], targets).timeConsistencySec).toBe(0);
    expect(stdDev([27])).toBe(0);
    expect(stdDev([])).toBe(0);
  });
});

describe('isConverged', () => {
  const at = (id: string, extractionSec: number, over: Partial<Shot> = {}) =>
    shot({ id, extractionSec, ...over });

  it('needs two in-window shots at the same dial within 2 s', () => {
    expect(isConverged([at('a', 27), at('b', 28)], targets)).toBe(true);
  });

  it('rejects a single shot', () => {
    expect(isConverged([at('a', 27)], targets)).toBe(false);
  });

  it('rejects differing dials', () => {
    expect(isConverged([at('a', 27, { dial: 16 }), at('b', 28)], targets)).toBe(false);
  });

  it('rejects a spread wider than 2 s', () => {
    expect(isConverged([at('a', 25), at('b', 29)], targets)).toBe(false);
  });

  it('rejects when a yield was off target', () => {
    expect(isConverged([at('a', 27, { yieldG: 50 }), at('b', 28)], targets)).toBe(false);
  });

  it('looks only at the most recent shots', () => {
    // An early bad shot must not stop a converged pair from counting.
    expect(isConverged([at('old', 45), at('a', 27), at('b', 28)], targets)).toBe(true);
  });

  it('can be asked for three confirming shots instead of two', () => {
    expect(isConverged([at('a', 27), at('b', 28)], targets, 3)).toBe(false);
    expect(isConverged([at('a', 27), at('b', 28), at('c', 27)], targets, 3)).toBe(true);
  });
});

describe('shotsToLockIn', () => {
  it('counts shots up to and including the first at the locked dial', () => {
    const shots = [
      shot({ id: 'a', dial: 16 }),
      shot({ id: 'b', dial: 16.5 }),
      shot({ id: 'c', dial: 16.5 }),
    ];
    expect(shotsToLockIn(shots, 16.5)).toBe(2);
  });

  it('is undefined for an unlocked session', () => {
    expect(shotsToLockIn([shot()], undefined)).toBeUndefined();
  });
});
