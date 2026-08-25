import { brewRatio, shotTimeOnBasis, totalSec } from '../domain/metrics.ts';
import type { Bean, Session, Shot } from '../domain/types.ts';
import { beansRepo } from './repo/beans.ts';
import { gearRepo } from './repo/gear.ts';
import { sessionsRepo } from './repo/sessions.ts';
import { settingsRepo } from './repo/settings.ts';
import { shotsRepo } from './repo/shots.ts';
import { db, type EspressoDB } from './schema.ts';

/**
 * Export and import.
 *
 * With no cloud sync in v1, this file *is* the backup story and the route to a new phone, so
 * the format is plain readable JSON rather than anything clever. Tombstoned rows are excluded:
 * a backup should carry your data, not a ledger of things you deleted.
 */

export const BACKUP_VERSION = 1;

export interface Backup {
  format: 'espresso-dial-in';
  version: number;
  exportedAt: string;
  beans: Bean[];
  gear: Awaited<ReturnType<typeof gearRepo.list>>;
  sessions: Session[];
  shots: Shot[];
  settings: Awaited<ReturnType<typeof settingsRepo.get>> | null;
}

export async function exportBackup(dbi: EspressoDB = db): Promise<Backup> {
  const [beans, gear, sessions, shots, settings] = await Promise.all([
    beansRepo.list(dbi),
    gearRepo.list(dbi),
    sessionsRepo.list(dbi),
    shotsRepo.list(dbi),
    settingsRepo.get(dbi),
  ]);

  return {
    format: 'espresso-dial-in',
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    beans,
    gear,
    sessions,
    shots,
    settings,
  };
}

export interface ImportResult {
  beans: number;
  gear: number;
  sessions: number;
  shots: number;
}

/**
 * Merge a backup into the current database.
 *
 * Merge rather than replace, and last-write-wins per row on `updatedAt` — the same rule the
 * sync seam uses, so restoring a backup onto a phone that has since logged shots keeps both.
 * Rows are written with `dirty: 1` so a future sync would push whatever arrived this way.
 */
export async function importBackup(raw: unknown, dbi: EspressoDB = db): Promise<ImportResult> {
  const backup = raw as Partial<Backup> | null;
  if (!backup || backup.format !== 'espresso-dial-in') {
    throw new Error('That file is not an espresso dial-in backup.');
  }
  if (typeof backup.version !== 'number' || backup.version > BACKUP_VERSION) {
    throw new Error(
      `That backup was written by a newer version of the app (format ${String(backup.version)}).`,
    );
  }

  const result: ImportResult = { beans: 0, gear: 0, sessions: 0, shots: 0 };

  const mergeTable = async (
    name: 'beans' | 'gear' | 'sessions' | 'shots',
    rows: { id: string; updatedAt?: number }[] | undefined,
  ) => {
    if (!Array.isArray(rows)) return 0;
    let written = 0;
    const table = dbi.table(name);
    for (const row of rows) {
      if (!row?.id) continue;
      const existing = (await table.get(row.id)) as { updatedAt?: number } | undefined;
      if (existing && (existing.updatedAt ?? 0) >= (row.updatedAt ?? 0)) continue;
      await table.put({ ...row, dirty: 1 });
      await dbi.outbox.add({ table: name, rowId: row.id, op: 'upsert', at: Date.now() });
      written += 1;
    }
    return written;
  };

  result.beans = await mergeTable('beans', backup.beans);
  result.gear = await mergeTable('gear', backup.gear);
  result.sessions = await mergeTable('sessions', backup.sessions);
  result.shots = await mergeTable('shots', backup.shots);

  return result;
}

/** One row per shot, joined with its bean and session so the file stands alone in a spreadsheet. */
export async function exportShotsCsv(dbi: EspressoDB = db): Promise<string> {
  const [shots, sessions, beans] = await Promise.all([
    shotsRepo.list(dbi),
    sessionsRepo.list(dbi),
    beansRepo.list(dbi),
  ]);
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const beanById = new Map(beans.map((b) => [b.id, b]));

  const header = [
    'pulled_at',
    'roaster',
    'bean',
    'dial',
    'dose_g',
    'yield_g',
    'ratio',
    'pre_infusion_s',
    'extraction_s',
    'total_s',
    'first_drip_s',
    'temp_c',
    'on_target',
    'channeling',
    'peak_pressure',
    'rating',
    'taste',
    'discarded',
    'coach_said',
    'notes',
  ];

  const rows = shots
    .sort((a, b) => a.pulledAt - b.pulledAt)
    .map((shot) => {
      const session = sessionById.get(shot.sessionId);
      const bean = session ? beanById.get(session.beanId) : undefined;
      const seconds = session ? shotTimeOnBasis(shot, session.targets.timingBasis) : undefined;
      const window = session?.targets.timeWindowSec;
      const onTarget =
        seconds !== undefined && window ? (seconds >= window[0] && seconds <= window[1] ? 'yes' : 'no') : '';

      return [
        new Date(shot.pulledAt).toISOString(),
        bean?.roaster ?? '',
        bean?.name ?? '',
        shot.dial,
        shot.doseG,
        shot.yieldG,
        brewRatio(shot).toFixed(2),
        shot.preInfusionSec,
        shot.extractionSec,
        totalSec(shot).toFixed(1),
        shot.firstDripSec ?? '',
        shot.tempC,
        onTarget,
        shot.channeling ? 'yes' : 'no',
        shot.peakPressure ?? '',
        shot.rating ?? '',
        shot.tasteTags.join(' '),
        shot.discarded ? 'yes' : 'no',
        shot.suggestion?.headline ?? '',
        shot.notes ?? '',
      ];
    });

  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
}

/** Quote anything containing a comma, quote or newline; double up inner quotes. */
function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Trigger a file download in the browser. */
export function downloadFile(filename: string, contents: string, type: string): void {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Revoking immediately can cancel the download in some browsers; a tick is enough.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
