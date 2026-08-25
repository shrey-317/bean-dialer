import { describe, expect, it } from 'vitest';
import type { Bean, Shot } from '../../domain/types.ts';
import { fromRemote, toRemote, type RemoteRow } from './mapping.ts';

const bean: Bean = {
  id: 'bean-1',
  updatedAt: 1_700_000_000_000,
  dirty: 1,
  roaster: 'Joe Van Gogh',
  name: 'Ethiopia Sidama',
  process: ['natural'],
  state: 'active',
};

describe('toRemote', () => {
  it('puts the envelope in columns and everything else in data', () => {
    const remote = toRemote('beans', bean, 'house-1');

    expect(remote).toMatchObject({
      household_id: 'house-1',
      id: 'bean-1',
      kind: 'beans',
      updated_at: 1_700_000_000_000,
      deleted_at: null,
    });
    expect(remote.data).toEqual({
      roaster: 'Joe Van Gogh',
      name: 'Ethiopia Sidama',
      process: ['natural'],
      state: 'active',
    });
  });

  it('never sends the local dirty flag', () => {
    // Whether *this* device has unpushed changes is meaningless to the other one.
    expect(toRemote('beans', bean, 'house-1').data).not.toHaveProperty('dirty');
  });

  it('carries a tombstone as a column', () => {
    const remote = toRemote('beans', { ...bean, deletedAt: 999 }, 'house-1');
    expect(remote.deleted_at).toBe(999);
  });

  it('keeps nested objects intact', () => {
    const shot = {
      id: 'shot-1',
      updatedAt: 1,
      dirty: 1 as const,
      sessionId: 'session-1',
      dial: 16.5,
      doseG: 18,
      yieldG: 40,
      preInfusionSec: 9,
      extractionSec: 27,
      tempC: 95,
      channeling: false,
      tasteTags: ['sour', 'thin'],
      pulledAt: 5,
      suggestion: {
        action: { kind: 'grind', deltaDial: 0.5, newDial: 17 },
        headline: 'Grind finer: 16.5 → 17.0',
        reason: 'because',
        confidence: 'high',
        notes: [],
        ruleId: 'time-too-fast',
      },
    } as unknown as Shot;

    const data = toRemote('shots', shot, 'house-1').data as Record<string, unknown>;
    expect(data.tasteTags).toEqual(['sour', 'thin']);
    expect((data.suggestion as { action: { newDial: number } }).action.newDial).toBe(17);
  });
});

describe('fromRemote', () => {
  const remote: RemoteRow = {
    household_id: 'house-1',
    id: 'bean-1',
    kind: 'beans',
    data: { roaster: 'Joe Van Gogh', name: 'Ethiopia Sidama', state: 'active' },
    updated_at: 42,
    deleted_at: null,
  };

  it('rebuilds a local row with the envelope restored', () => {
    const result = fromRemote(remote)!;

    expect(result.table).toBe('beans');
    expect(result.row).toEqual({
      id: 'bean-1',
      updatedAt: 42,
      deletedAt: null,
      dirty: 0,
      roaster: 'Joe Van Gogh',
      name: 'Ethiopia Sidama',
      state: 'active',
    });
  });

  it('marks incoming rows clean so they are not pushed straight back', () => {
    expect(fromRemote(remote)!.row.dirty).toBe(0);
  });

  it('round-trips without losing anything', () => {
    const back = fromRemote(toRemote('beans', bean, 'house-1'))!;
    // dirty is intentionally reset; everything else must survive.
    expect(back.row).toEqual({ ...bean, dirty: 0, deletedAt: null });
  });

  it('preserves a tombstone', () => {
    const result = fromRemote({ ...remote, deleted_at: 777 })!;
    expect(result.row.deletedAt).toBe(777);
  });

  it('skips malformed records instead of throwing', () => {
    expect(fromRemote(null)).toBeUndefined();
    expect(fromRemote('nonsense')).toBeUndefined();
    expect(fromRemote({ ...remote, id: '' })).toBeUndefined();
    expect(fromRemote({ ...remote, id: 7 })).toBeUndefined();
    expect(fromRemote({ ...remote, updated_at: 'soon' })).toBeUndefined();
    expect(fromRemote({ ...remote, updated_at: Number.NaN })).toBeUndefined();
    expect(fromRemote({ ...remote, data: null })).toBeUndefined();
  });

  it('rejects an unknown kind rather than writing to a table that does not exist', () => {
    expect(fromRemote({ ...remote, kind: 'settings' })).toBeUndefined();
    expect(fromRemote({ ...remote, kind: 'wat' })).toBeUndefined();
  });
});
