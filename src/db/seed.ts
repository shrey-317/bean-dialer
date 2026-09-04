import { beansRepo } from './repo/beans.ts';
import { gearRepo } from './repo/gear.ts';
import { sessionsRepo } from './repo/sessions.ts';
import { DEFAULT_TARGETS, settingsRepo } from './repo/settings.ts';
import { db, type EspressoDB } from './schema.ts';

/**
 * First-run seed: the setup this app was built around, so there is zero configuration
 * between installing and pulling a shot.
 *
 * Turin Legato V2 + DF54 + self-leveling tamper. Two of these values are load-bearing
 * rather than cosmetic:
 *
 * - `dialDirection: 'higher-is-coarser'` on the DF54 — the normal convention. The advice
 *   engine still resolves every suggestion through this field rather than assuming a
 *   direction, so a grinder that really is the exception just needs this one value changed.
 * - `pressureAdjustable: false` on the tamper. A self-leveling tamper gives consistent
 *   contact and no manual override, so all flow correction is grind-based and the engine
 *   must never suggest tamping differently.
 */
export const SEED_IDS = {
  machine: 'seed-machine-legato-v2',
  grinder: 'seed-grinder-df54',
  tamper: 'seed-tamper-self-leveling',
  basket: 'seed-basket-18g',
  bean: 'seed-bean-jvg-sidama',
  session: 'seed-session-jvg-sidama',
} as const;

/** Starting point on the DF54, already corrected for the self-leveling tamper. */
export const SEED_START_DIAL = 16.5;

export async function seedIfEmpty(dbi: EspressoDB = db): Promise<{ seeded: boolean }> {
  const existingGear = await gearRepo.list(dbi);
  await settingsRepo.get(dbi); // create the settings singleton on first run
  if (existingGear.length > 0) return { seeded: false };

  await gearRepo.create(
    {
      id: SEED_IDS.machine,
      kind: 'machine',
      name: 'Legato V2',
      brand: 'Turin',
      isDefault: true,
      spec: {
        defaultTempC: 95,
        preInfusion: { p1Sec: 3, p2Sec: 6 },
        hasAutoMode: true,
        // OPV fixed at 9 bar; the flow-control valve is a separate restriction on top of that.
        flowRestriction: 10,
      },
      notes: 'Auto button runs P1 3 s low-pressure saturation, then a 6 s bloom pause. OPV at 9 bar.',
    },
    dbi,
  );

  await gearRepo.create(
    {
      id: SEED_IDS.grinder,
      kind: 'grinder',
      name: 'DF54',
      brand: 'DF',
      isDefault: true,
      spec: {
        dialMin: 0,
        dialMax: 60,
        dialStep: 0.5,
        // The normal convention: a higher number is coarser. Do not "fix" this without
        // re-testing against the real grinder.
        dialDirection: 'higher-is-coarser',
        burrType: 'flat',
        antiStatic: 'plasma',
      },
      notes: 'Plasma/ionizer anti-static (v3/v4). Higher dial number = coarser.',
    },
    dbi,
  );

  await gearRepo.create(
    {
      id: SEED_IDS.tamper,
      kind: 'tamper',
      name: 'Self-leveling tamper',
      isDefault: true,
      spec: { selfLeveling: true, pressureAdjustable: false },
      notes:
        'Changed flow dynamics versus hand tamping and needed the grind recalibrated by 1–2 steps. No pressure override — correct flow with the grind, not the tamp.',
    },
    dbi,
  );

  await gearRepo.create(
    {
      id: SEED_IDS.basket,
      kind: 'basket',
      name: 'Stock 20 g basket',
      isDefault: true,
      // The Legato's 58 mm portafilter tops out around 20 g of depth — a 22 g basket bottoms
      // out in it — so this is the larger of the machine's included baskets, not a round number.
      spec: { capacityG: 20 },
    },
    dbi,
  );

  await beansRepo.create(
    {
      id: SEED_IDS.bean,
      roaster: 'Joe Van Gogh',
      name: 'Ethiopia Sidama',
      origin: 'Ethiopia',
      process: ['natural'],
      roastLevel: 'medium-light',
      state: 'active',
    },
    dbi,
  );

  await sessionsRepo.create(
    {
      id: SEED_IDS.session,
      beanId: SEED_IDS.bean,
      grinderId: SEED_IDS.grinder,
      machineId: SEED_IDS.machine,
      tamperId: SEED_IDS.tamper,
      basketId: SEED_IDS.basket,
      targets: { ...DEFAULT_TARGETS },
      startDial: SEED_START_DIAL,
      currentDial: SEED_START_DIAL,
      status: 'dialing',
      startedAt: Date.now(),
    },
    dbi,
  );

  return { seeded: true };
}
