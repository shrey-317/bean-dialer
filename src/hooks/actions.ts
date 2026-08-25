import { gearRepo } from '../db/repo/gear.ts';
import { sessionsRepo } from '../db/repo/sessions.ts';
import { settingsRepo } from '../db/repo/settings.ts';
import { shotsRepo } from '../db/repo/shots.ts';
import { SEED_START_DIAL } from '../db/seed.ts';
import type { Advice, Session, Shot, Targets } from '../domain/types.ts';

/**
 * Acting on the coach's advice.
 *
 * Applying advice records two things: the new dial on the session, and the fact that the
 * suggestion was followed on the shot that produced it. That second part is what keeps the
 * log honest — a suggestion nobody acted on shouldn't read later as though it were tested.
 */
export async function applyAdvice(
  session: Session,
  advice: Advice,
  latestShot?: Shot,
): Promise<void> {
  const { kind, newDial } = advice.action;

  if (kind === 'lock-in' && newDial !== undefined) {
    await sessionsRepo.lockIn(session.id, newDial);
  } else if (kind === 'grind' && newDial !== undefined) {
    await sessionsRepo.setDial(session.id, newDial);
  }

  if (latestShot) {
    await shotsRepo.update(latestShot.id, { suggestionFollowed: true });
  }
}

/** Note that a suggestion was seen and deliberately not taken. */
export async function declineAdvice(latestShot?: Shot): Promise<void> {
  if (latestShot) await shotsRepo.update(latestShot.id, { suggestionFollowed: false });
}

/**
 * Keep the session's working dial in sync with whatever was actually pulled at.
 *
 * `applyAdvice` above covers the "accepted the coach's suggestion" path. This covers every
 * other one — a manual correction typed into the log sheet, a shot pulled without touching
 * advice at all — so the *next* pull (and the Home/Timer displays in the meantime) starts from
 * where the grinder was really left, not from a stale suggestion. A later `applyAdvice` call is
 * expected to overwrite this, same as it already overwrites any other `currentDial`.
 */
export async function recordPulledDial(session: Session, dial: number): Promise<void> {
  if (dial !== session.currentDial) await sessionsRepo.setDial(session.id, dial);
}

/**
 * Change the recipe — dose and/or target yield — for the rest of this session.
 *
 * `sessionsRepo.update` replaces whatever it's given wholesale, so a patch has to carry the
 * *whole* targets object or it would silently drop `tempC`/`preInfusion`/the time window. The
 * merge happens here, against the caller's already-loaded `session`, rather than in the repo
 * layer, which would otherwise need to re-read the row just to merge into it.
 */
export async function updateRecipe(
  session: Session,
  patch: Partial<Pick<Targets, 'doseG' | 'yieldG'>>,
): Promise<void> {
  await sessionsRepo.update(session.id, { targets: { ...session.targets, ...patch } });
}

/**
 * Where to start the grinder for a new session.
 *
 * Preference order, best evidence first:
 * 1. A dial previously locked in for this same bean — the whole point of locking one in.
 * 2. The working dial of the most recent session on the same grinder. A different bean is
 *    imperfect evidence, but it beats guessing, and it already accounts for the burrs and
 *    the tamper in use.
 * 3. The documented starting point for this setup.
 */
export async function suggestedStartDial(beanId: string, grinderId: string): Promise<number> {
  const forBean = await sessionsRepo.forBean(beanId);
  const locked = forBean.find((s) => s.lockedDial !== undefined);
  if (locked?.lockedDial !== undefined) return locked.lockedDial;

  const all = await sessionsRepo.list();
  const sameGrinder = all
    .filter((s) => s.grinderId === grinderId)
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  if (sameGrinder) return sameGrinder.currentDial;

  return SEED_START_DIAL;
}

/**
 * Begin dialling in a bean with the default gear and target recipe.
 *
 * Any session already being dialled is abandoned rather than left open: two live sessions
 * would make "the current dial" ambiguous, and the home screen has to have one answer.
 */
export async function startSession(beanId: string): Promise<Session | undefined> {
  const [grinder, machine, tamper, basket, settings] = await Promise.all([
    gearRepo.defaultOfKind('grinder'),
    gearRepo.defaultOfKind('machine'),
    gearRepo.defaultOfKind('tamper'),
    gearRepo.defaultOfKind('basket'),
    settingsRepo.get(),
  ]);
  if (!grinder) return undefined;

  const existing = await sessionsRepo.active();
  if (existing) await sessionsRepo.update(existing.id, { status: 'abandoned' });

  const startDial = await suggestedStartDial(beanId, grinder.id);
  const targets = { ...settings.defaultTargets };
  // The machine knows its own pre-infusion; prefer that over the generic default.
  if (machine?.kind === 'machine') {
    targets.preInfusion = { ...machine.spec.preInfusion };
    targets.tempC = machine.spec.defaultTempC;
  }

  return sessionsRepo.create({
    beanId,
    grinderId: grinder.id,
    ...(machine ? { machineId: machine.id } : {}),
    ...(tamper ? { tamperId: tamper.id } : {}),
    ...(basket ? { basketId: basket.id } : {}),
    targets,
    startDial,
    currentDial: startDial,
    status: 'dialing',
    startedAt: Date.now(),
  });
}
