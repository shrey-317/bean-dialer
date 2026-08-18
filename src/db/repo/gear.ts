import type { Gear, GearKind, GrinderGear, MachineGear, TamperGear } from '../../domain/types.ts';
import { db, type EspressoDB } from '../schema.ts';
import { createRow, deleteRow, getRow, listRows, type NewRow, type RowPatch, updateRow } from './base.ts';

export const gearRepo = {
  create: (data: NewRow<Gear>, dbi: EspressoDB = db) => createRow('gear', data, dbi),
  update: (id: string, patch: RowPatch<Gear>, dbi: EspressoDB = db) =>
    updateRow('gear', id, patch, dbi),
  remove: (id: string, dbi: EspressoDB = db) => deleteRow('gear', id, dbi),
  get: (id: string, dbi: EspressoDB = db) => getRow('gear', id, dbi),
  list: (dbi: EspressoDB = db) => listRows('gear', dbi),

  async ofKind(kind: GearKind, dbi: EspressoDB = db): Promise<Gear[]> {
    const all = await listRows('gear', dbi);
    return all.filter((g) => g.kind === kind);
  },

  /** The default item of a kind, falling back to the first one that exists. */
  async defaultOfKind(kind: GearKind, dbi: EspressoDB = db): Promise<Gear | undefined> {
    const items = await gearRepo.ofKind(kind, dbi);
    return items.find((g) => g.isDefault) ?? items[0];
  },
};

// Narrowing helpers. The union is discriminated on `kind`, so these are just typed filters
// that keep `spec` access honest at call sites.
export const isGrinder = (g: Gear): g is GrinderGear => g.kind === 'grinder';
export const isMachine = (g: Gear): g is MachineGear => g.kind === 'machine';
export const isTamper = (g: Gear): g is TamperGear => g.kind === 'tamper';

/**
 * Snap a dial value to the grinder's own increments and range.
 * Floating point matters here: 16.5 + 0.5 must read as 17, not 16.999999999999998.
 */
export function snapDial(value: number, grinder: GrinderGear['spec']): number {
  const { dialMin, dialMax, dialStep } = grinder;
  const clamped = Math.min(dialMax, Math.max(dialMin, value));
  const steps = Math.round((clamped - dialMin) / dialStep);
  const snapped = dialMin + steps * dialStep;
  // Round to the precision implied by the step (0.5 → 1dp, 0.25 → 2dp).
  const decimals = (String(dialStep).split('.')[1] ?? '').length;
  return Number(snapped.toFixed(Math.max(decimals, 1)));
}

/**
 * Turn "I want it finer/coarser by N steps" into a signed change in dial units.
 * This is the function that keeps the app from confidently telling you to turn the wrong
 * way on a grinder where higher means finer.
 */
export function dialDelta(
  direction: 'finer' | 'coarser',
  steps: number,
  grinder: GrinderGear['spec'],
): number {
  const magnitude = steps * grinder.dialStep;
  const higherIsFiner = grinder.dialDirection === 'higher-is-finer';
  const sign = direction === 'finer' ? (higherIsFiner ? 1 : -1) : higherIsFiner ? -1 : 1;
  return sign * magnitude;
}
