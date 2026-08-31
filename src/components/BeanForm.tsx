import { useState } from 'react';
import { beansRepo } from '../db/repo/beans.ts';
import type { Bean, BeanProcess, RoastLevel } from '../domain/types.ts';
import { BigButton, Button, Card, Chip, Field, SectionTitle, TextInput } from './ui.tsx';

const PROCESSES: BeanProcess[] = ['natural', 'washed', 'honey', 'anaerobic', 'other'];
const ROASTS: RoastLevel[] = ['light', 'medium-light', 'medium', 'medium-dark', 'dark'];

type BeanSeed = Partial<
  Pick<
    Bean,
    | 'roaster'
    | 'name'
    | 'origin'
    | 'process'
    | 'roastLevel'
    | 'roastDate'
    | 'tastingNotes'
    | 'bagWeightG'
    | 'priceCents'
  >
>;

/**
 * Add a bag — either from scratch, or pre-filled from an earlier one via `initial` (see
 * `BeanDetail`'s "Buy this again"). A bag is never a straight duplicate: `roastDate` is the one
 * field `initial` deliberately doesn't carry forward — a new bag means a new roast date, and
 * defaulting it to today rather than leaving it blank saves a tap for the common case of
 * logging it the day it arrives, while still being one edit away from correct.
 */
export function BeanForm({
  initial,
  submitLabel = 'Save bag',
  onDone,
}: {
  initial?: BeanSeed;
  submitLabel?: string;
  onDone: (bean: Bean) => void;
}) {
  const [roaster, setRoaster] = useState(initial?.roaster ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [origin, setOrigin] = useState(initial?.origin ?? '');
  // A prefilled form defaults to today when nothing more specific is known (saves a tap for the
  // common case of logging a bag the day it arrives) — but a genuinely known date, like one a
  // bag scan actually read off the label, always wins over that default.
  const [roastDate, setRoastDate] = useState(
    initial?.roastDate ?? (initial ? new Date().toISOString().slice(0, 10) : ''),
  );
  const [process, setProcess] = useState<BeanProcess[]>(initial?.process ?? []);
  const [roastLevel, setRoastLevel] = useState<RoastLevel | undefined>(initial?.roastLevel);
  const [tastingNotes, setTastingNotes] = useState<string[]>(initial?.tastingNotes ?? []);
  const [noteInput, setNoteInput] = useState('');
  const [saving, setSaving] = useState(false);

  const canSave = name.trim().length > 0 && !saving;

  const toggleProcess = (p: BeanProcess) =>
    setProcess((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));

  const addNote = () => {
    const trimmed = noteInput.trim();
    if (trimmed && !tastingNotes.includes(trimmed)) setTastingNotes((notes) => [...notes, trimmed]);
    setNoteInput('');
  };
  const removeNote = (note: string) => setTastingNotes((notes) => notes.filter((n) => n !== note));

  return (
    <Card className="mb-4 space-y-3">
      <Field label="Name">
        <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Ethiopia Sidama" />
      </Field>
      <Field label="Roaster">
        <TextInput value={roaster} onChange={(e) => setRoaster(e.target.value)} placeholder="Joe Van Gogh" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Origin">
          <TextInput value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="Ethiopia" />
        </Field>
        <Field label="Roast date" hint="Drives days off roast.">
          <TextInput type="date" value={roastDate} onChange={(e) => setRoastDate(e.target.value)} />
        </Field>
      </div>

      <div>
        <SectionTitle>Process</SectionTitle>
        <div className="flex flex-wrap gap-2">
          {PROCESSES.map((p) => (
            <Chip key={p} active={process.includes(p)} onClick={() => toggleProcess(p)}>
              {p}
            </Chip>
          ))}
        </div>
      </div>

      <div>
        <SectionTitle>Roast level</SectionTitle>
        <div className="flex flex-wrap gap-2">
          {ROASTS.map((r) => (
            <Chip key={r} active={roastLevel === r} onClick={() => setRoastLevel((c) => (c === r ? undefined : r))}>
              {r}
            </Chip>
          ))}
        </div>
      </div>

      <div>
        <SectionTitle>Tasting notes</SectionTitle>
        {tastingNotes.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-2">
            {tastingNotes.map((note) => (
              <Chip key={note} active onClick={() => removeNote(note)}>
                {note} ×
              </Chip>
            ))}
          </div>
        ) : null}
        <div className="flex gap-2">
          <TextInput
            value={noteInput}
            onChange={(e) => setNoteInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addNote();
              }
            }}
            placeholder="black cherry"
          />
          <Button type="button" onClick={addNote} disabled={!noteInput.trim()}>
            Add
          </Button>
        </div>
      </div>

      <BigButton
        disabled={!canSave}
        onClick={async () => {
          setSaving(true);
          try {
            const bean = await beansRepo.create({
              roaster: roaster.trim() || 'Unknown roaster',
              name: name.trim(),
              state: 'active',
              ...(origin.trim() ? { origin: origin.trim() } : {}),
              ...(roastDate ? { roastDate } : {}),
              ...(process.length > 0 ? { process } : {}),
              ...(roastLevel ? { roastLevel } : {}),
              ...(tastingNotes.length > 0 ? { tastingNotes } : {}),
              ...(initial?.bagWeightG !== undefined ? { bagWeightG: initial.bagWeightG } : {}),
              ...(initial?.priceCents !== undefined ? { priceCents: initial.priceCents } : {}),
            });
            onDone(bean);
          } finally {
            setSaving(false);
          }
        }}
      >
        {saving ? 'Saving…' : submitLabel}
      </BigButton>
    </Card>
  );
}
