import { describe, expect, it } from 'vitest';
import { DEFAULT_TARGETS } from '../db/repo/settings.ts';
import { adviceFor, adviceForSession } from './advice.ts';
import type { GrinderGear, Session, Shot, TamperGear, Targets } from './types.ts';

/**
 * The grinder in these tests is the DF54 as actually used: **higher dial = coarser**, the
 * normal convention. Several assertions below would pass with the sign flipped if the engine
 * hardcoded a direction, so a `higher-is-finer` mirror case is included to pin it down.
 */
const df54: GrinderGear = {
  id: 'grinder-1',
  kind: 'grinder',
  name: 'DF54',
  isDefault: true,
  updatedAt: 0,
  dirty: 0,
  spec: {
    dialMin: 0,
    dialMax: 60,
    dialStep: 0.5,
    dialDirection: 'higher-is-coarser',
    burrType: 'flat',
    antiStatic: 'plasma',
  },
};

const invertedGrinder: GrinderGear = {
  ...df54,
  id: 'grinder-2',
  name: 'Generic',
  spec: { ...df54.spec, dialDirection: 'higher-is-finer' },
};

const selfLevelingTamper: TamperGear = {
  id: 'tamper-1',
  kind: 'tamper',
  name: 'Self-leveling tamper',
  isDefault: true,
  updatedAt: 0,
  dirty: 0,
  spec: { selfLeveling: true, pressureAdjustable: false },
};

const targets: Targets = { ...DEFAULT_TARGETS };

/** A clean, on-target 27 s shot at dial 16.5. Override just what a test cares about. */
function shot(over: Partial<Shot> = {}): Shot {
  return {
    id: 'shot-1',
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
    pulledAt: 1_000,
    ...over,
  };
}

const base = { targets, grinder: df54, tamper: selfLevelingTamper, history: [] as Shot[] };

describe('grind direction', () => {
  it('goes finer by LOWERING the dial on a higher-is-coarser grinder', () => {
    const advice = adviceFor({ ...base, shot: shot({ extractionSec: 22 }) });

    expect(advice.ruleId).toBe('time-too-fast');
    expect(advice.action.kind).toBe('grind');
    expect(advice.action.newDial).toBe(16);
    expect(advice.action.deltaDial).toBe(-0.5);
    expect(advice.headline).toContain('finer');
  });

  it('goes finer by RAISING the dial on a higher-is-finer grinder', () => {
    const advice = adviceFor({
      ...base,
      grinder: invertedGrinder,
      shot: shot({ extractionSec: 22 }),
    });

    expect(advice.headline).toContain('finer');
    expect(advice.action.newDial).toBe(17);
    expect(advice.action.deltaDial).toBe(0.5);
  });

  it('goes coarser by raising the dial when the shot is slow', () => {
    const advice = adviceFor({ ...base, shot: shot({ extractionSec: 34 }) });

    expect(advice.ruleId).toBe('time-too-slow');
    expect(advice.action.newDial).toBe(17);
    expect(advice.headline).toContain('coarser');
  });
});

describe('step magnitude', () => {
  it('takes one step for a near miss', () => {
    const advice = adviceFor({ ...base, shot: shot({ extractionSec: 23 }) });
    expect(advice.action.newDial).toBe(16);
  });

  it('takes two steps when the shot is nowhere near the window', () => {
    // 40 s against a 25–30 s window is 10 s slow: walking 0.5 at a time wastes coffee.
    const advice = adviceFor({ ...base, shot: shot({ extractionSec: 40 }) });
    expect(advice.action.newDial).toBe(17.5);
  });

  it('snaps results to the grinder step and never lands between clicks', () => {
    const advice = adviceFor({ ...base, shot: shot({ dial: 16.5, extractionSec: 18 }) });
    const dial = advice.action.newDial!;
    expect(dial * 2 === Math.round(dial * 2)).toBe(true);
  });

  it('refuses to step past the end of the grinder range', () => {
    // Finer means a lower dial here, so the finest possible setting is dialMin, not dialMax.
    const atMin = adviceFor({
      ...base,
      shot: shot({ dial: 0, extractionSec: 20 }),
    });
    expect(atMin.action.kind).toBe('hold');
    expect(atMin.headline).toContain('finest');
    expect(atMin.reason).toContain("can't go finer");
  });
});

describe('yield gate', () => {
  it('refuses to change the grind when the yield overshot badly', () => {
    // 52 g in 22 s only looks fast because of the extra 12 g of liquid.
    const advice = adviceFor({ ...base, shot: shot({ extractionSec: 22, yieldG: 52 }) });

    expect(advice.ruleId).toBe('yield-out-of-range');
    expect(advice.action.kind).toBe('reshoot');
    expect(advice.action.newDial).toBeUndefined();
    expect(advice.reason).toContain('g/s');
  });

  it('accepts a yield inside tolerance and judges on time', () => {
    const advice = adviceFor({ ...base, shot: shot({ extractionSec: 22, yieldG: 41.5 }) });
    expect(advice.ruleId).toBe('time-too-fast');
  });

  it('treats an undershot yield as unusable too', () => {
    const advice = adviceFor({ ...base, shot: shot({ extractionSec: 34, yieldG: 30 }) });
    expect(advice.ruleId).toBe('yield-out-of-range');
    expect(advice.headline).toContain('under');
  });
});

describe('channeling and puck prep', () => {
  it('never suggests a tamp change when the tamper self-levels', () => {
    const advice = adviceFor({ ...base, shot: shot({ channeling: true }) });

    expect(advice.ruleId).toBe('channeling');
    expect(advice.action.kind).toBe('hold');
    const text = [advice.headline, advice.reason, ...advice.notes].join(' ').toLowerCase();
    expect(text).toContain('no pressure override');
    expect(text).not.toMatch(/tamp harder|tamp more|press harder|increase tamp/);
  });

  it('keeps the grind when time is on target but the shot channeled', () => {
    const advice = adviceFor({ ...base, shot: shot({ channeling: true }) });
    expect(advice.action.newDial).toBeUndefined();
    expect(advice.headline).toContain('16.5');
  });

  it('still corrects the grind on a fast shot, noting channeling as a factor', () => {
    const advice = adviceFor({ ...base, shot: shot({ extractionSec: 21, channeling: true }) });

    expect(advice.ruleId).toBe('time-too-fast');
    expect(advice.action.newDial).toBe(16);
    expect(advice.notes.join(' ')).toContain('shortcut');
  });

  it('measures early first drip from the end of pre-infusion, not the pull start', () => {
    // 9 s of pre-infusion means a 10 s first drip is 1 s into extraction — early.
    const early = adviceFor({ ...base, shot: shot({ firstDripSec: 10 }) });
    expect(early.ruleId).toBe('channeling');

    // The same 10 s reading is perfectly normal with no pre-infusion.
    const noPreInfusion = adviceFor({
      ...base,
      shot: shot({ firstDripSec: 10, preInfusionSec: 0 }),
    });
    expect(noPreInfusion.ruleId).not.toBe('channeling');
  });

  it('does not flag a normal first drip', () => {
    const advice = adviceFor({ ...base, shot: shot({ firstDripSec: 14 }) });
    expect(advice.ruleId).not.toBe('channeling');
  });
});

describe('taste tie-breakers', () => {
  it('suggests finer for a sour shot whose time is already on target', () => {
    const advice = adviceFor({ ...base, shot: shot({ tasteTags: ['sour'] }) });

    expect(advice.ruleId).toBe('taste-sour');
    expect(advice.action.newDial).toBe(16);
    // Temperature is offered as an alternative, never as the primary move.
    expect(advice.notes.join(' ')).toContain('96 °C');
  });

  it('suggests coarser for a bitter shot whose time is already on target', () => {
    const advice = adviceFor({ ...base, shot: shot({ tasteTags: ['bitter'] }) });

    expect(advice.ruleId).toBe('taste-bitter');
    expect(advice.action.newDial).toBe(17);
    expect(advice.notes.join(' ')).toContain('94 °C');
  });

  it('reads sour-and-bitter together as uneven extraction, not a grind error', () => {
    const advice = adviceFor({ ...base, shot: shot({ tasteTags: ['sour', 'bitter'] }) });

    expect(advice.ruleId).toBe('channeling');
    expect(advice.action.kind).toBe('hold');
  });

  it('ignores taste when the time is out of window — time comes first', () => {
    const advice = adviceFor({ ...base, shot: shot({ extractionSec: 20, tasteTags: ['bitter'] }) });
    // Bitter would say coarser, but a 20 s shot is under-extracted regardless.
    expect(advice.ruleId).toBe('time-too-fast');
    expect(advice.headline).toContain('finer');
  });
});

describe('oscillation guard', () => {
  const withSuggestion = (id: string, delta: number, over: Partial<Shot> = {}): Shot =>
    shot({
      id,
      suggestion: {
        action: { kind: 'grind', deltaDial: delta, newDial: 0 },
        headline: '',
        reason: '',
        confidence: 'medium',
        notes: [],
        ruleId: delta > 0 ? 'time-too-fast' : 'time-too-slow',
      },
      ...over,
    });

  it('stops stepping when the last suggestions alternated direction', () => {
    const history = [withSuggestion('s1', -0.5), withSuggestion('s2', +0.5)];
    // A fast shot now would step -0.5 again (finer is lower on this grinder) — the third
    // alternation.
    const advice = adviceFor({ ...base, history, shot: shot({ extractionSec: 23 }) });

    expect(advice.ruleId).toBe('oscillation');
    expect(advice.action.kind).toBe('hold');
    expect(advice.headline).toContain('16.5');
  });

  it('keeps stepping when suggestions have been consistent', () => {
    const history = [withSuggestion('s1', -0.5), withSuggestion('s2', -0.5)];
    const advice = adviceFor({ ...base, history, shot: shot({ extractionSec: 23 }) });

    expect(advice.ruleId).toBe('time-too-fast');
    expect(advice.action.newDial).toBe(16);
  });
});

describe('lock-in', () => {
  it('proposes locking in after two matching in-window shots at the same dial', () => {
    const prior = shot({ id: 'prior', extractionSec: 27, pulledAt: 500 });
    const advice = adviceFor({ ...base, history: [prior], shot: shot({ extractionSec: 28 }) });

    expect(advice.ruleId).toBe('lock-in');
    expect(advice.action.kind).toBe('lock-in');
    expect(advice.action.newDial).toBe(16.5);
  });

  it('does not lock in on a single good shot', () => {
    const advice = adviceFor({ ...base, shot: shot({ extractionSec: 27 }) });

    expect(advice.ruleId).toBe('in-window');
    expect(advice.action.kind).toBe('hold');
  });

  it('does not lock in when the two good shots were at different dials', () => {
    const prior = shot({ id: 'prior', dial: 16, extractionSec: 27, pulledAt: 500 });
    const advice = adviceFor({ ...base, history: [prior], shot: shot({ extractionSec: 28 }) });
    expect(advice.ruleId).toBe('in-window');
  });

  it('does not lock in when the two shots disagree by more than 2 s', () => {
    const prior = shot({ id: 'prior', extractionSec: 25, pulledAt: 500 });
    const advice = adviceFor({ ...base, history: [prior], shot: shot({ extractionSec: 29 }) });
    expect(advice.ruleId).toBe('in-window');
  });

  it('ignores discarded shots when judging convergence', () => {
    const prior = shot({ id: 'prior', extractionSec: 27, pulledAt: 500 });
    const flush = shot({ id: 'flush', extractionSec: 12, discarded: true, pulledAt: 700 });
    const advice = adviceFor({ ...base, history: [prior, flush], shot: shot({ extractionSec: 28 }) });
    expect(advice.ruleId).toBe('lock-in');
  });
});

describe('timing basis', () => {
  it('judges on extraction time by default, excluding pre-infusion', () => {
    // 27 s extraction plus 9 s pre-infusion: on target on 'extraction'…
    const advice = adviceFor({ ...base, shot: shot({ extractionSec: 27 }) });
    expect(advice.ruleId).toBe('in-window');

    // …but 36 s of wall clock, which would read as slow on 'total'.
    const onTotal = adviceFor({
      ...base,
      targets: { ...targets, timingBasis: 'total' },
      shot: shot({ extractionSec: 27 }),
    });
    expect(onTotal.ruleId).toBe('time-too-slow');
  });

  it('asks for a reshoot when the chosen basis was never recorded', () => {
    const advice = adviceFor({
      ...base,
      targets: { ...targets, timingBasis: 'first-drip' },
      shot: shot({ firstDripSec: undefined }),
    });
    expect(advice.action.kind).toBe('reshoot');
  });
});

describe('adviceForSession', () => {
  const session: Session = {
    id: 'session-1',
    updatedAt: 0,
    dirty: 0,
    beanId: 'bean-1',
    grinderId: 'grinder-1',
    targets,
    startDial: 16.5,
    currentDial: 16.5,
    status: 'dialing',
    startedAt: 0,
  };

  it('tells you where to start when nothing is logged yet', () => {
    const advice = adviceForSession(session, [], df54, selfLevelingTamper);

    expect(advice.ruleId).toBe('no-shots');
    expect(advice.headline).toContain('16.5');
    expect(advice.reason).toContain('18 g');
    expect(advice.reason).toContain('40 g');
  });

  it('advises from the most recent shot', () => {
    const shots = [
      shot({ id: 'old', extractionSec: 40, pulledAt: 100 }),
      shot({ id: 'new', extractionSec: 22, pulledAt: 200 }),
    ];
    const advice = adviceForSession(session, shots, df54, selfLevelingTamper);

    expect(advice.ruleId).toBe('time-too-fast');
    expect(advice.action.newDial).toBe(16);
  });

  it('skips discarded shots when picking the latest', () => {
    const shots = [
      shot({ id: 'real', extractionSec: 22, pulledAt: 100 }),
      shot({ id: 'flush', extractionSec: 5, discarded: true, pulledAt: 200 }),
    ];
    const advice = adviceForSession(session, shots, df54, selfLevelingTamper);
    expect(advice.action.newDial).toBe(16);
  });
});
