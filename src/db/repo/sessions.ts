import type { Session } from '../../domain/types.ts';
import { db, type EspressoDB } from '../schema.ts';
import { createRow, deleteRow, getRow, listRows, type NewRow, type RowPatch, updateRow } from './base.ts';

export const sessionsRepo = {
  create: (data: NewRow<Session>, dbi: EspressoDB = db) => createRow('sessions', data, dbi),
  update: (id: string, patch: RowPatch<Session>, dbi: EspressoDB = db) =>
    updateRow('sessions', id, patch, dbi),
  remove: (id: string, dbi: EspressoDB = db) => deleteRow('sessions', id, dbi),
  get: (id: string, dbi: EspressoDB = db) => getRow('sessions', id, dbi),
  list: (dbi: EspressoDB = db) => listRows('sessions', dbi),

  /** Most recently started session still being dialed, if any. */
  async active(dbi: EspressoDB = db): Promise<Session | undefined> {
    const all = await listRows('sessions', dbi);
    return all
      .filter((s) => s.status === 'dialing')
      .sort((a, b) => b.startedAt - a.startedAt)[0];
  },

  async forBean(beanId: string, dbi: EspressoDB = db): Promise<Session[]> {
    const all = await listRows('sessions', dbi);
    return all.filter((s) => s.beanId === beanId).sort((a, b) => b.startedAt - a.startedAt);
  },

  /** Record the working dial after an adjustment. */
  setDial: (id: string, dial: number, dbi: EspressoDB = db) =>
    updateRow('sessions', id, { currentDial: dial }, dbi),

  /** Freeze a known-good setting so the next bag of the same bean starts from it. */
  lockIn: (id: string, dial: number, dbi: EspressoDB = db) =>
    updateRow(
      'sessions',
      id,
      { status: 'locked', lockedDial: dial, currentDial: dial, lockedAt: Date.now() },
      dbi,
    ),

  /** Reopen a locked session — e.g. the bean aged and it drifted. */
  reopen: (id: string, dbi: EspressoDB = db) =>
    updateRow('sessions', id, { status: 'dialing' }, dbi),
};
