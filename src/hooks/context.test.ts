import { describe, expect, it } from 'vitest';
import { DEFAULT_TARGETS } from '../db/repo/settings.ts';
import type { Bean, Gear, Session, Shot } from '../domain/types.ts';
import { buildDialInContext } from './context.ts';

const grinder: Gear = {
  id: 'grinder-1',
  kind: 'grinder',
  name: 'DF54',
  isDefault: true,
  updatedAt: 0,
  dirty: 0,
  spec: { dialMin: 0, dialMax: 60, dialStep: 0.5, dialDirection: 'higher-is-finer' },
};

const tamper: Gear = {
  id: 'tamper-1',
  kind: 'tamper',
  name: 'Self-leveling tamper',
  isDefault: true,
  updatedAt: 0,
  dirty: 0,
  spec: { selfLeveling: true, pressureAdjustable: false },
};

const bean: Bean = {
  id: 'bean-1',
  roaster: 'JVG',
  name: 'Sidama',
  state: 'active',
  updatedAt: 0,
  dirty: 0,
};

function session(over: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    updatedAt: 0,
    dirty: 0,
    beanId: 'bean-1',
    grinderId: 'grinder-1',
    tamperId: 'tamper-1',
    targets: { ...DEFAULT_TARGETS },
    startDial: 16.5,
    currentDial: 16.5,
    status: 'dialing',
    startedAt: 1_000,
    ...over,
  };
}

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

const base = { beans: [bean], gear: [grinder, tamper] };

describe('buildDialInContext', () => {
  it('picks the most recently started session still being dialled', () => {
    const ctx = buildDialInContext({
      ...base,
      sessions: [
        session({ id: 'old', startedAt: 1 }),
        session({ id: 'newest', startedAt: 99 }),
        session({ id: 'locked', startedAt: 200, status: 'locked' }),
      ],
      shots: [],
    });
    expect(ctx.session?.id).toBe('newest');
  });

  it('falls back to the most recent locked session when nothing is being dialled', () => {
    // Otherwise locking a dial in — the one success in the loop — empties the home screen.
    const ctx = buildDialInContext({
      ...base,
      sessions: [
        session({ id: 'old-locked', status: 'locked', startedAt: 5 }),
        session({ id: 'locked', status: 'locked', startedAt: 50, lockedDial: 17 }),
      ],
      shots: [],
    });
    expect(ctx.session?.id).toBe('locked');
  });

  it('prefers a session still being dialled over a locked one', () => {
    const ctx = buildDialInContext({
      ...base,
      sessions: [
        session({ id: 'locked', status: 'locked', startedAt: 500 }),
        session({ id: 'dialing', status: 'dialing', startedAt: 1 }),
      ],
      shots: [],
    });
    expect(ctx.session?.id).toBe('dialing');
  });

  it('returns an empty context when there is nothing but abandoned sessions', () => {
    const ctx = buildDialInContext({
      ...base,
      sessions: [session({ status: 'abandoned' })],
      shots: [],
    });
    expect(ctx.session).toBeUndefined();
    expect(ctx.shots).toEqual([]);
    expect(ctx.advice).toBeUndefined();
  });

  it('can be asked for a specific session regardless of status', () => {
    const ctx = buildDialInContext({
      ...base,
      sessions: [session({ id: 'wanted', status: 'abandoned', startedAt: 5 }), session({ id: 'live' })],
      shots: [],
      sessionId: 'wanted',
    });
    expect(ctx.session?.id).toBe('wanted');
  });

  it('resolves bean, grinder and tamper, and advises from the shots', () => {
    const ctx = buildDialInContext({
      ...base,
      sessions: [session()],
      shots: [shot({ extractionSec: 22 })],
    });

    expect(ctx.bean?.name).toBe('Sidama');
    expect(ctx.grinder?.name).toBe('DF54');
    expect(ctx.tamper?.name).toBe('Self-leveling tamper');
    expect(ctx.advice?.ruleId).toBe('time-too-fast');
    expect(ctx.advice?.action.newDial).toBe(17);
  });

  it('only includes shots belonging to the session, oldest first', () => {
    const ctx = buildDialInContext({
      ...base,
      sessions: [session()],
      shots: [
        shot({ id: 'b', pulledAt: 200 }),
        shot({ id: 'other', sessionId: 'elsewhere', pulledAt: 150 }),
        shot({ id: 'a', pulledAt: 100 }),
      ],
    });
    expect(ctx.shots.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('gives no advice when the grinder is missing, since there is no dial to move', () => {
    const ctx = buildDialInContext({
      beans: [bean],
      gear: [tamper],
      sessions: [session()],
      shots: [shot({ extractionSec: 22 })],
    });

    expect(ctx.session).toBeDefined();
    expect(ctx.grinder).toBeUndefined();
    expect(ctx.advice).toBeUndefined();
  });

  it('ignores gear referenced by the wrong kind', () => {
    // A session pointing its grinderId at a tamper must not be treated as having a grinder.
    const ctx = buildDialInContext({
      ...base,
      sessions: [session({ grinderId: 'tamper-1' })],
      shots: [],
    });
    expect(ctx.grinder).toBeUndefined();
  });
});
