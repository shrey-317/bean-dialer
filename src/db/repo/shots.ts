import type { Shot } from '../../domain/types.ts';
import { db, type EspressoDB } from '../schema.ts';
import { createRow, deleteRow, getRow, listRows, type NewRow, type RowPatch, updateRow } from './base.ts';

export const shotsRepo = {
  create: (data: NewRow<Shot>, dbi: EspressoDB = db) => createRow('shots', data, dbi),
  update: (id: string, patch: RowPatch<Shot>, dbi: EspressoDB = db) =>
    updateRow('shots', id, patch, dbi),
  remove: (id: string, dbi: EspressoDB = db) => deleteRow('shots', id, dbi),
  get: (id: string, dbi: EspressoDB = db) => getRow('shots', id, dbi),
  list: (dbi: EspressoDB = db) => listRows('shots', dbi),

  /**
   * Shots for a session, oldest first. Chronological because every consumer — the advice
   * engine's history window, the convergence chart, the timeline — reasons forwards in time.
   */
  async forSession(sessionId: string, dbi: EspressoDB = db): Promise<Shot[]> {
    const all = await listRows('shots', dbi);
    return all.filter((s) => s.sessionId === sessionId).sort((a, b) => a.pulledAt - b.pulledAt);
  },

  /** Countable shots only: discarded pulls (flushes, spills) stay logged but don't skew stats. */
  async countableForSession(sessionId: string, dbi: EspressoDB = db): Promise<Shot[]> {
    const all = await shotsRepo.forSession(sessionId, dbi);
    return all.filter((s) => !s.discarded);
  },

  async latestForSession(sessionId: string, dbi: EspressoDB = db): Promise<Shot | undefined> {
    const all = await shotsRepo.forSession(sessionId, dbi);
    return all[all.length - 1];
  },
};
