import { useState } from 'react';
import { shotsRepo } from '../db/repo/shots.ts';
import { adviceFor } from '../domain/advice.ts';
import { toShotTimes, type TimerState } from '../domain/timer.ts';
import type { CremaColor, PeakPressure, Shot, TasteTag } from '../domain/types.ts';
import type { DialInContext } from '../hooks/data.ts';
import { recordPulledDial } from '../hooks/actions.ts';
import { BigButton, Button, Card, Chip, Field, Rating, SectionTitle, Stepper, TextInput, Toggle } from './ui.tsx';

/**
 * Post-shot logging.
 *
 * Ordered by what you can actually observe, and by what the coach needs most: yield first
 * (it's on the scale in front of you and gates every other judgement), then whether it
 * channelled, then taste. Everything below yield is optional — a shot logged with just a
 * weight is still a useful shot.
 */

const TASTE_TAGS: { tag: TasteTag; label: string }[] = [
  { tag: 'balanced', label: 'Balanced' },
  { tag: 'sour', label: 'Sour' },
  { tag: 'bitter', label: 'Bitter' },
  { tag: 'sweet', label: 'Sweet' },
  { tag: 'fruity', label: 'Fruity' },
  { tag: 'thin', label: 'Thin' },
  { tag: 'syrupy', label: 'Syrupy' },
  { tag: 'harsh', label: 'Harsh' },
  { tag: 'ashy', label: 'Ashy' },
];

const CREMA: { value: CremaColor; label: string }[] = [
  { value: 'pale', label: 'Pale' },
  { value: 'honey', label: 'Honey' },
  { value: 'dark', label: 'Dark' },
  { value: 'blonding-early', label: 'Blonded early' },
];

const PEAK_PRESSURE: { value: PeakPressure; label: string }[] = [
  { value: 'under-5-bar', label: 'Under 5 bar' },
  { value: '5-to-8-bar', label: '5–8 bar' },
  { value: '9-bar', label: '9 bar' },
];

export function LogShotSheet({
  ctx,
  timer,
  onSaved,
  onDiscardTimer,
}: {
  ctx: DialInContext;
  timer: TimerState;
  onSaved: (shotId: string) => void;
  onDiscardTimer: () => void;
}) {
  const { session, grinder, tamper, shots } = ctx;
  const times = toShotTimes(timer);

  const [doseG, setDoseG] = useState(session?.targets.doseG ?? 18);
  const [yieldG, setYieldG] = useState(session?.targets.yieldG ?? 40);
  const [dial, setDial] = useState(session?.currentDial ?? 16.5);
  const [tempC, setTempC] = useState(session?.targets.tempC ?? 95);
  const [channeling, setChanneling] = useState(false);
  const [crema, setCrema] = useState<CremaColor | undefined>(undefined);
  const [peakPressure, setPeakPressure] = useState<PeakPressure | undefined>(undefined);
  const [rating, setRating] = useState<number | undefined>(undefined);
  const [tags, setTags] = useState<TasteTag[]>([]);
  const [notes, setNotes] = useState('');
  const [discarded, setDiscarded] = useState(false);
  const [saving, setSaving] = useState(false);

  if (!session || !grinder) return null;

  const toggleTag = (tag: TasteTag) =>
    setTags((cur) => (cur.includes(tag) ? cur.filter((t) => t !== tag) : [...cur, tag]));

  async function save() {
    setSaving(true);
    try {
      const fields = {
        sessionId: session!.id,
        dial,
        doseG,
        yieldG,
        ...times,
        tempC,
        channeling,
        tasteTags: tags,
        pulledAt: Date.now(),
        ...(crema ? { cremaColor: crema } : {}),
        ...(peakPressure ? { peakPressure } : {}),
        ...(rating !== undefined ? { rating } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(discarded ? { discarded: true } : {}),
      };

      // Work out the advice before writing, so the shot is stored with the suggestion it
      // produced in a single write. A discarded shot gets no advice: it isn't evidence.
      const suggestion = discarded
        ? undefined
        : adviceFor({
            shot: { ...fields, id: 'pending', updatedAt: 0, dirty: 0 } as Shot,
            targets: session!.targets,
            grinder: grinder!,
            ...(tamper ? { tamper } : {}),
            history: shots.filter((s) => !s.discarded),
          });

      const shot = await shotsRepo.create({
        ...fields,
        ...(suggestion ? { suggestion } : {}),
      });
      // Whatever dial the shot actually went in at becomes the working dial from here on —
      // a manual correction here shouldn't be forgotten the moment the sheet closes.
      await recordPulledDial(session!, dial);
      onSaved(shot.id);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4 pb-4">
      <Card>
        <SectionTitle>What the timer saw</SectionTitle>
        <div className="tnum flex items-baseline gap-4">
          <span className="text-3xl font-bold text-crust-50">
            {times.extractionSec.toFixed(1)}
            <span className="ml-1 text-sm font-normal text-crust-400">s extract</span>
          </span>
          <span className="text-sm text-crust-400">
            +{times.preInfusionSec.toFixed(1)}s pre-infusion
          </span>
        </div>
        {times.firstDripSec !== undefined ? (
          <p className="tnum mt-1 text-xs text-crust-500">
            First drip {times.firstDripSec.toFixed(1)}s into the pull
          </p>
        ) : null}
      </Card>

      <Field label="Yield off the scale" hint="The number the coach trusts most.">
        <Stepper label="Yield" value={yieldG} onChange={setYieldG} step={0.1} min={0} unit="g" />
      </Field>

      <div className="space-y-3">
        <Field label="Dose">
          <Stepper label="Dose" value={doseG} onChange={setDoseG} step={0.1} min={0} unit="g" />
        </Field>
        <Field label="Dial">
          <Stepper
            label="Dial"
            value={dial}
            onChange={setDial}
            step={grinder.spec.dialStep}
            min={grinder.spec.dialMin}
            max={grinder.spec.dialMax}
          />
        </Field>
      </div>

      <Field label="Brew temperature">
        <Stepper label="Temperature" value={tempC} onChange={setTempC} step={1} decimals={0} unit="°C" />
      </Field>

      <Toggle
        checked={channeling}
        onChange={setChanneling}
        label="It channelled"
        hint="Sprayed to one side, or squirted rather than flowed."
      />

      <div>
        <SectionTitle>Crema</SectionTitle>
        <div className="flex flex-wrap gap-2">
          {CREMA.map(({ value, label }) => (
            <Chip
              key={value}
              active={crema === value}
              onClick={() => setCrema((cur) => (cur === value ? undefined : value))}
            >
              {label}
            </Chip>
          ))}
        </div>
      </div>

      <div>
        <SectionTitle>Peak pressure</SectionTitle>
        <div className="flex flex-wrap gap-2">
          {PEAK_PRESSURE.map(({ value, label }) => (
            <Chip
              key={value}
              active={peakPressure === value}
              onClick={() => setPeakPressure((cur) => (cur === value ? undefined : value))}
            >
              {label}
            </Chip>
          ))}
        </div>
      </div>

      <div>
        <SectionTitle>Taste</SectionTitle>
        <div className="flex flex-wrap gap-2">
          {TASTE_TAGS.map(({ tag, label }) => (
            <Chip key={tag} active={tags.includes(tag)} onClick={() => toggleTag(tag)}>
              {label}
            </Chip>
          ))}
        </div>
      </div>

      <Field label="Rating">
        <Rating value={rating} onChange={setRating} />
      </Field>

      <Field label="Notes">
        <TextInput
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Anything worth remembering"
        />
      </Field>

      <Toggle
        checked={discarded}
        onChange={setDiscarded}
        label="Don't count this shot"
        hint="For flushes, spills and misfires — kept in the log, left out of the stats and advice."
      />

      <div className="space-y-2 pt-2">
        <BigButton onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save shot'}
        </BigButton>
        <Button variant="ghost" className="w-full" onClick={onDiscardTimer} disabled={saving}>
          Throw this timing away
        </Button>
      </div>
    </div>
  );
}
