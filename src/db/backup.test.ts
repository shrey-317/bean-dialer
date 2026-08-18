import { beforeEach, describe, expect, it } from 'vitest';
import { exportBackup, exportShotsCsv, importBackup } from './backup.ts';
import { beansRepo } from './repo/beans.ts';
import { shotsRepo } from './repo/shots.ts';
import { sessionsRepo } from './repo/sessions.ts';
import { createTestDb, type EspressoDB } from './schema.ts';
import { seedIfEmpty, SEED_IDS } from './seed.ts';

/**
 * With no cloud sync, export/import *is* the backup and the route to a new phone — so a bug here
 * loses the whole shot history rather than merely inconveniencing someone.
 */

let db: EspressoDB;
let counter = 0;

async function freshDb(): Promise<EspressoDB> {
  const instance = createTestDb(`backup-test-${counter++}`);
  await instance.open();
  return instance;
}

beforeEach(async () => {
  db = await freshDb();
  await seedIfEmpty(db);
});

async function addShot(dbi: EspressoDB, over: Partial<Parameters<typeof shotsRepo.create>[0]> = {}) {
  return shotsRepo.create(
    {
      sessionId: SEED_IDS.session,
      dial: 16.5,
      doseG: 18,
      yieldG: 40,
      preInfusionSec: 9,
      extractionSec: 27,
      tempC: 95,
      channeling: false,
      tasteTags: [],
      pulledAt: 1_700_000_000_000,
      ...over,
    },
    dbi,
  );
}

describe('exportBackup', () => {
  it('includes every table and is tagged with a format and version', async () => {
    await addShot(db);
    const backup = await exportBackup(db);

    expect(backup.format).toBe('espresso-dial-in');
    expect(backup.version).toBe(1);
    expect(backup.beans).toHaveLength(1);
    expect(backup.gear).toHaveLength(4);
    expect(backup.sessions).toHaveLength(1);
    expect(backup.shots).toHaveLength(1);
    expect(backup.settings?.defaultTargets.doseG).toBe(18);
  });

  it('leaves deleted rows out — a backup carries data, not a list of deletions', async () => {
    const bean = await beansRepo.create({ roaster: 'X', name: 'Doomed', state: 'active' }, db);
    await beansRepo.remove(bean.id, db);

    const backup = await exportBackup(db);
    expect(backup.beans.map((b) => b.name)).not.toContain('Doomed');
  });

  it('round-trips through JSON', async () => {
    await addShot(db);
    const json = JSON.stringify(await exportBackup(db));

    const target = await freshDb();
    const result = await importBackup(JSON.parse(json), target);

    expect(result.shots).toBe(1);
    expect(result.gear).toBe(4);
    expect((await sessionsRepo.active(target))?.currentDial).toBe(16.5);
    expect(await shotsRepo.forSession(SEED_IDS.session, target)).toHaveLength(1);
  });
});

describe('importBackup', () => {
  it('rejects a file that is not one of ours', async () => {
    await expect(importBackup({ format: 'something-else' }, db)).rejects.toThrow(/not an espresso/i);
    await expect(importBackup(null, db)).rejects.toThrow(/not an espresso/i);
  });

  it('refuses a backup from a newer version rather than mangling it', async () => {
    await expect(
      importBackup({ format: 'espresso-dial-in', version: 99 }, db),
    ).rejects.toThrow(/newer version/i);
  });

  it('merges rather than replaces, keeping shots the target already had', async () => {
    const local = await addShot(db, { pulledAt: 1_000 });

    const other = await freshDb();
    await seedIfEmpty(other);
    await addShot(other, { pulledAt: 2_000 });
    const backup = await exportBackup(other);

    await importBackup(JSON.parse(JSON.stringify(backup)), db);

    const shots = await shotsRepo.forSession(SEED_IDS.session, db);
    expect(shots).toHaveLength(2);
    expect(shots.map((s) => s.id)).toContain(local.id);
  });

  it('keeps the more recently edited version of a row that exists on both sides', async () => {
    const shot = await addShot(db, { notes: 'newer' });
    // An older copy of the same row must not overwrite what's here.
    const stale = {
      format: 'espresso-dial-in',
      version: 1,
      shots: [{ ...shot, notes: 'older', updatedAt: shot.updatedAt - 5_000 }],
    };

    const result = await importBackup(stale, db);

    expect(result.shots).toBe(0);
    expect((await shotsRepo.get(shot.id, db))?.notes).toBe('newer');
  });

  it('applies an incoming row that is newer than the local one', async () => {
    const shot = await addShot(db, { notes: 'old' });
    const fresher = {
      format: 'espresso-dial-in',
      version: 1,
      shots: [{ ...shot, notes: 'new', updatedAt: shot.updatedAt + 5_000 }],
    };

    expect((await importBackup(fresher, db)).shots).toBe(1);
    expect((await shotsRepo.get(shot.id, db))?.notes).toBe('new');
  });

  it('tolerates a backup missing whole tables', async () => {
    const result = await importBackup({ format: 'espresso-dial-in', version: 1 }, db);
    expect(result).toEqual({ beans: 0, gear: 0, sessions: 0, shots: 0 });
  });

  it('queues imported rows for a future sync', async () => {
    const target = await freshDb();
    await importBackup(JSON.parse(JSON.stringify(await exportBackup(db))), target);

    // Rows that arrived by import are local changes as far as any future server is concerned.
    expect(await target.outbox.count()).toBeGreaterThan(0);
  });
});

describe('exportShotsCsv', () => {
  it('joins each shot to its bean and marks whether it hit the target', async () => {
    await addShot(db, { extractionSec: 27, rating: 4, tasteTags: ['balanced'] });
    const csv = await exportShotsCsv(db);
    const [header, row] = csv.split('\n');

    expect(header).toContain('roaster');
    expect(header).toContain('on_target');
    expect(row).toContain('Joe Van Gogh');
    expect(row).toContain('Ethiopia Sidama');
    // 27 s extraction inside a 25–30 s window.
    expect(row).toContain('yes');
    expect(row).toContain('36.0'); // total = 9 s pre-infusion + 27 s
  });

  it('marks a shot outside the window as off target', async () => {
    await addShot(db, { extractionSec: 20 });
    const row = (await exportShotsCsv(db)).split('\n')[1]!;
    expect(row.split(',')).toContain('no');
  });

  it('quotes fields containing commas or quotes so the columns survive', async () => {
    await addShot(db, { notes: 'tasted like "jam", oddly' });
    const csv = await exportShotsCsv(db);

    expect(csv).toContain('"tasted like ""jam"", oddly"');
    // One header row and one data row: an unescaped comma would not add lines, but an
    // unescaped newline would — check the shape holds either way.
    expect(csv.split('\n')).toHaveLength(2);
  });

  it('includes discarded shots but flags them', async () => {
    await addShot(db, { discarded: true });
    const row = (await exportShotsCsv(db)).split('\n')[1]!;
    expect(row.split(',')).toContain('yes');
  });
});
