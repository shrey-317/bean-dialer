import { Link } from 'react-router-dom';
import { Card, Chip, Field, SectionTitle, Stepper, TextInput, Toggle } from '../components/ui.tsx';
import { gearRepo } from '../db/repo/gear.ts';
import type { Gear as GearRow, GrinderGear, MachineGear, TamperGear } from '../domain/types.ts';
import { useGear } from '../hooks/data.ts';

/**
 * Gear setup.
 *
 * The grinder's **dial direction** is the field that matters most on this screen. Get it wrong
 * and every suggestion the coach makes points the wrong way, which is worse than no advice at
 * all — so it's spelled out in words rather than hidden behind a toggle labelled "invert".
 */
export function Gear() {
  const gear = useGear();
  if (gear === undefined) {
    return <p className="mt-8 text-center text-sm text-crust-500">Loading…</p>;
  }

  const byKind = <K extends GearRow['kind']>(kind: K) =>
    gear.filter((g): g is Extract<GearRow, { kind: K }> => g.kind === kind);

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xs font-semibold uppercase tracking-[0.2em] text-crust-500">Gear</h1>
        <Link to="/settings" className="text-xs text-crust-500 underline">
          Recipe defaults
        </Link>
      </div>

      <div className="space-y-6">
        <div>
          <SectionTitle>Grinder</SectionTitle>
          <div className="space-y-3">
            {byKind('grinder').map((g) => (
              <GrinderCard key={g.id} grinder={g} />
            ))}
          </div>
        </div>

        <div>
          <SectionTitle>Machine</SectionTitle>
          <div className="space-y-3">
            {byKind('machine').map((m) => (
              <MachineCard key={m.id} machine={m} />
            ))}
          </div>
        </div>

        <div>
          <SectionTitle>Tamper</SectionTitle>
          <div className="space-y-3">
            {byKind('tamper').map((t) => (
              <TamperCard key={t.id} tamper={t} />
            ))}
          </div>
        </div>

        <div>
          <SectionTitle>Basket</SectionTitle>
          <div className="space-y-3">
            {byKind('basket').map((b) => (
              <Card key={b.id}>
                <h3 className="text-base font-semibold text-crust-50">{b.name}</h3>
                <p className="text-xs text-crust-400">{b.spec.capacityG}g capacity</p>
              </Card>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function GearHeader({ item }: { item: GearRow }) {
  return (
    <div className="mb-3">
      <h3 className="text-base font-semibold text-crust-50">
        {item.brand ? `${item.brand} ` : ''}
        {item.name}
      </h3>
      {item.notes ? <p className="mt-0.5 text-xs text-crust-500">{item.notes}</p> : null}
    </div>
  );
}

function GrinderCard({ grinder }: { grinder: GrinderGear }) {
  const { spec } = grinder;
  const set = (patch: Partial<GrinderGear['spec']>) =>
    void gearRepo.update(grinder.id, { spec: { ...spec, ...patch } });

  return (
    <Card>
      <GearHeader item={grinder} />

      <Field
        label="Which way is finer?"
        hint="If this is wrong, every grind suggestion points the wrong way."
      >
        <div className="flex flex-wrap gap-2">
          <Chip
            active={spec.dialDirection === 'higher-is-finer'}
            onClick={() => set({ dialDirection: 'higher-is-finer' })}
          >
            Higher number = finer
          </Chip>
          <Chip
            active={spec.dialDirection === 'higher-is-coarser'}
            onClick={() => set({ dialDirection: 'higher-is-coarser' })}
          >
            Higher number = coarser
          </Chip>
        </div>
      </Field>

      <div className="mt-3 grid grid-cols-3 gap-2">
        <Field label="Step">
          <TextInput
            inputMode="decimal"
            value={String(spec.dialStep)}
            onChange={(e) => {
              const next = Number.parseFloat(e.target.value);
              if (next > 0) set({ dialStep: next });
            }}
          />
        </Field>
        <Field label="Min">
          <TextInput
            inputMode="decimal"
            value={String(spec.dialMin)}
            onChange={(e) => {
              const next = Number.parseFloat(e.target.value);
              if (!Number.isNaN(next)) set({ dialMin: next });
            }}
          />
        </Field>
        <Field label="Max">
          <TextInput
            inputMode="decimal"
            value={String(spec.dialMax)}
            onChange={(e) => {
              const next = Number.parseFloat(e.target.value);
              if (!Number.isNaN(next)) set({ dialMax: next });
            }}
          />
        </Field>
      </div>
    </Card>
  );
}

function MachineCard({ machine }: { machine: MachineGear }) {
  const { spec } = machine;
  const set = (patch: Partial<MachineGear['spec']>) =>
    void gearRepo.update(machine.id, { spec: { ...spec, ...patch } });

  return (
    <Card>
      <GearHeader item={machine} />

      <Field label="Brew temperature">
        <Stepper
          label="Brew temperature"
          value={spec.defaultTempC}
          onChange={(v) => set({ defaultTempC: v })}
          step={1}
          decimals={0}
          unit="°C"
        />
      </Field>

      <div className="mt-3 space-y-3">
        <Field label="P1 saturation" hint="Low pressure.">
          <Stepper
            label="P1 seconds"
            value={spec.preInfusion.p1Sec}
            onChange={(v) => set({ preInfusion: { ...spec.preInfusion, p1Sec: v } })}
            step={1}
            min={0}
            decimals={0}
            unit="s"
          />
        </Field>
        <Field label="P2 bloom" hint="Pressure off.">
          <Stepper
            label="P2 seconds"
            value={spec.preInfusion.p2Sec}
            onChange={(v) => set({ preInfusion: { ...spec.preInfusion, p2Sec: v } })}
            step={1}
            min={0}
            decimals={0}
            unit="s"
          />
        </Field>
      </div>
      <p className="mt-2 text-xs text-crust-500">
        The timer uses these to drive its stages. New sessions pick them up; a session already in
        progress keeps the timings it started with.
      </p>

      <div className="mt-3">
        <Field
          label="Flow restriction"
          hint="The group's flow-control valve, if it has one — separate from the OPV. Tracked for reference only; the coach doesn't yet know when this changes."
        >
          <Stepper
            label="Flow restriction"
            value={spec.flowRestriction ?? 0}
            onChange={(v) => set({ flowRestriction: v })}
            step={0.5}
            min={0}
            unit="ml/s"
          />
        </Field>
      </div>
    </Card>
  );
}

function TamperCard({ tamper }: { tamper: TamperGear }) {
  const { spec } = tamper;
  return (
    <Card>
      <GearHeader item={tamper} />
      <div className="space-y-2">
        <Toggle
          checked={spec.selfLeveling}
          label="Self-levelling"
          hint="Consistent contact without judging it by feel."
          onChange={(v) => void gearRepo.update(tamper.id, { spec: { ...spec, selfLeveling: v } })}
        />
        <Toggle
          checked={spec.pressureAdjustable}
          label="Tamp pressure adjustable"
          hint="Off means the coach never suggests changing it — there's no control to change."
          onChange={(v) =>
            void gearRepo.update(tamper.id, { spec: { ...spec, pressureAdjustable: v } })
          }
        />
      </div>
    </Card>
  );
}
