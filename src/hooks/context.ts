import { isGrinder, isTamper } from '../db/repo/gear.ts';
import { adviceForSession } from '../domain/advice.ts';
import type { Advice, Bean, Gear, GrinderGear, Session, Shot, TamperGear } from '../domain/types.ts';

/**
 * Assembling the dial-in view from already-loaded tables.
 *
 * Pure and synchronous on purpose. The joining used to happen inside an async Dexie read, which
 * both broke live-query tracking and made this logic awkward to test. As a function over plain
 * arrays it is neither.
 */

export interface DialInContext {
  session?: Session;
  bean?: Bean;
  grinder?: GrinderGear;
  tamper?: TamperGear;
  /** Shots for the session, oldest first, including discarded ones. */
  shots: Shot[];
  /** Absent when there is no session, or no grinder to advise a dial on. */
  advice?: Advice;
}

export function buildDialInContext({
  sessions,
  beans,
  gear,
  shots,
  sessionId,
}: {
  sessions: Session[];
  beans: Bean[];
  gear: Gear[];
  shots: Shot[];
  sessionId?: string;
}): DialInContext {
  // Named session if asked for; otherwise the most recently started one still being dialled, and
  // failing that the most recent locked-in one.
  //
  // The fallback matters: locking a dial in used to leave the home screen saying "no bean being
  // dialled in", which turns the one success in the whole loop into an empty screen. A locked
  // session is still the bean you are pulling — you just aren't hunting a setting any more.
  const mostRecent = (status: Session['status']) =>
    sessions.filter((s) => s.status === status).sort((a, b) => b.startedAt - a.startedAt)[0];

  const session = sessionId
    ? sessions.find((s) => s.id === sessionId)
    : (mostRecent('dialing') ?? mostRecent('locked'));

  if (!session) return { shots: [] };

  const bean = beans.find((b) => b.id === session.beanId);
  const grinderGear = gear.find((g) => g.id === session.grinderId);
  const tamperGear = session.tamperId ? gear.find((g) => g.id === session.tamperId) : undefined;
  const grinder = grinderGear && isGrinder(grinderGear) ? grinderGear : undefined;
  const tamper = tamperGear && isTamper(tamperGear) ? tamperGear : undefined;

  const sessionShots = shots
    .filter((s) => s.sessionId === session.id)
    .sort((a, b) => a.pulledAt - b.pulledAt);

  return {
    session,
    ...(bean ? { bean } : {}),
    ...(grinder ? { grinder } : {}),
    ...(tamper ? { tamper } : {}),
    shots: sessionShots,
    // Without a grinder there is no dial to advise on — that session is broken, not just empty.
    ...(grinder ? { advice: adviceForSession(session, sessionShots, grinder, tamper) } : {}),
  };
}
