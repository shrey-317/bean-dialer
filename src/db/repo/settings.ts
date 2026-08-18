import type { Settings, Targets } from '../../domain/types.ts';
import { SETTINGS_ID } from '../../domain/types.ts';
import { db, type EspressoDB } from '../schema.ts';
import { createRow, getRow, type RowPatch, updateRow } from './base.ts';

/**
 * Defaults describe the setup this app was built around: 18 g in, 40 g out, 95 °C, and the
 * Legato's 3 s / 6 s auto pre-infusion. `timingBasis: 'extraction'` means the 25–30 s window
 * refers to the pull *after* pre-infusion ends, which is the part the grind governs.
 */
export const DEFAULT_TARGETS: Targets = {
  doseG: 18,
  yieldG: 40,
  tempC: 95,
  preInfusion: { p1Sec: 3, p2Sec: 6 },
  timeWindowSec: [25, 30],
  timingBasis: 'extraction',
};

export const settingsRepo = {
  /** Reads settings, creating the singleton row on first run. */
  async get(dbi: EspressoDB = db): Promise<Settings> {
    const existing = await getRow('settings', SETTINGS_ID, dbi);
    if (existing) return existing;
    return createRow(
      'settings',
      {
        id: SETTINGS_ID,
        defaultTargets: DEFAULT_TARGETS,
        theme: 'dark',
        hapticsEnabled: true,
        soundEnabled: true,
        keepAwakeDuringShot: true,
      },
      dbi,
    );
  },

  async update(patch: RowPatch<Settings>, dbi: EspressoDB = db): Promise<Settings> {
    await settingsRepo.get(dbi); // ensure the row exists before patching
    return updateRow('settings', SETTINGS_ID, patch, dbi);
  },
};
