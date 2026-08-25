import type { Bean, BeanProcess } from '../../domain/types.ts';
import { db, type EspressoDB } from '../schema.ts';
import { createRow, deleteRow, getRow, listRows, type NewRow, type RowPatch, updateRow } from './base.ts';

export const beansRepo = {
  create: (data: NewRow<Bean>, dbi: EspressoDB = db) => createRow('beans', data, dbi),
  update: (id: string, patch: RowPatch<Bean>, dbi: EspressoDB = db) =>
    updateRow('beans', id, patch, dbi),
  remove: (id: string, dbi: EspressoDB = db) => deleteRow('beans', id, dbi),
  get: (id: string, dbi: EspressoDB = db) => getRow('beans', id, dbi),
  list: (dbi: EspressoDB = db) => listRows('beans', dbi),
};

/**
 * `process` as an array, regardless of what's actually stored.
 *
 * `process` used to be a single value, and a device that installed the app before this change
 * may still have rows on disk (or a synced copy from before the household caught up) holding
 * the old shape. Read through this instead of `bean.process` directly anywhere the value is
 * displayed or edited, or an old row throws the moment something calls `.join`/`.includes` on
 * what turns out to be a bare string.
 */
export function beanProcesses(bean: Pick<Bean, 'process'>): BeanProcess[] {
  const p = bean.process as BeanProcess[] | BeanProcess | undefined;
  if (!p) return [];
  return Array.isArray(p) ? p : [p];
}

/**
 * Whole days since roast, or undefined when no roast date is recorded.
 * Compared date-to-date rather than instant-to-instant: a bag roasted "yesterday" should
 * read as 1 day off roast at 8am, not 0.6.
 */
export function daysOffRoast(bean: Pick<Bean, 'roastDate'>, at: Date = new Date()): number | undefined {
  if (!bean.roastDate) return undefined;
  const roast = Date.parse(`${bean.roastDate}T00:00:00`);
  if (Number.isNaN(roast)) return undefined;
  const today = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  return Math.max(0, Math.round((today - roast) / 86_400_000));
}

/**
 * Rough guidance only, and deliberately coarse. Rest windows are roast- and
 * bean-dependent; this is a nudge, not a verdict.
 */
export function restVerdict(days: number | undefined): 'too-fresh' | 'ready' | 'past-peak' | 'unknown' {
  if (days === undefined) return 'unknown';
  if (days < 5) return 'too-fresh';
  if (days <= 28) return 'ready';
  return 'past-peak';
}
