import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo } from 'react';
import { live, queryTable } from '../db/repo/base.ts';
import { SETTINGS_ID } from '../domain/types.ts';
import type { Bean, Gear, Session, Settings, Shot } from '../domain/types.ts';
import { buildDialInContext, type DialInContext } from './context.ts';

export type { DialInContext } from './context.ts';

/**
 * Live data for the screens.
 *
 * Each hook issues **one** query for **one** table and does all joining and filtering in plain
 * JavaScript afterwards. That is not an accident of style: Dexie's live queries only re-run when
 * a table they observed is written, and the observation is lost the moment a callback awaits
 * something — so a nested read path silently stops updating. One query in, arrays out.
 *
 * The tables here hold tens to a few thousand rows, so reading them whole is cheaper than the
 * bookkeeping needed to avoid it.
 */

function useLiveTable<T extends 'beans' | 'gear' | 'sessions' | 'shots' | 'settings'>(
  name: T,
): Awaited<ReturnType<typeof queryTable<T>>> | undefined {
  return useLiveQuery(() => queryTable(name), [name]);
}

export function useBeans(): Bean[] | undefined {
  const rows = useLiveTable('beans');
  return useMemo(() => (rows ? live(rows) : undefined), [rows]);
}

export function useGear(): Gear[] | undefined {
  const rows = useLiveTable('gear');
  return useMemo(() => (rows ? live(rows) : undefined), [rows]);
}

export function useSessions(): Session[] | undefined {
  const rows = useLiveTable('sessions');
  return useMemo(
    () => (rows ? live(rows).sort((a, b) => b.startedAt - a.startedAt) : undefined),
    [rows],
  );
}

export function useAllShots(): Shot[] | undefined {
  const rows = useLiveTable('shots');
  return useMemo(
    () => (rows ? live(rows).sort((a, b) => a.pulledAt - b.pulledAt) : undefined),
    [rows],
  );
}

/**
 * Settings, or undefined while loading. The row is created by the first-run seed; a missing row
 * means the database hasn't been prepared yet rather than that settings are empty.
 */
export function useSettings(): Settings | undefined {
  const rows = useLiveTable('settings');
  return useMemo(() => live(rows).find((s) => s.id === SETTINGS_ID), [rows]);
}

/**
 * The active dial-in session (or a named one) with its bean, gear, shots and current advice.
 *
 * `undefined` means still loading, so callers can tell that apart from "there is genuinely no
 * session in progress".
 */
export function useDialIn(sessionId?: string): DialInContext | undefined {
  const sessions = useSessions();
  const beans = useBeans();
  const gear = useGear();
  const shots = useAllShots();

  return useMemo(() => {
    if (!sessions || !beans || !gear || !shots) return undefined;
    return buildDialInContext({ sessions, beans, gear, shots, sessionId });
  }, [sessions, beans, gear, shots, sessionId]);
}

/** Sessions for one bean, newest first, each with its shots oldest-first. */
export function useBeanSessions(
  beanId: string | undefined,
): { session: Session; shots: Shot[] }[] | undefined {
  const sessions = useSessions();
  const shots = useAllShots();

  return useMemo(() => {
    if (!sessions || !shots) return undefined;
    if (!beanId) return [];
    return sessions
      .filter((s) => s.beanId === beanId)
      .map((session) => ({
        session,
        shots: shots.filter((s) => s.sessionId === session.id),
      }));
  }, [sessions, shots, beanId]);
}
