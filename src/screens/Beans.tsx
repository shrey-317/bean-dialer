import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BigButton, Button, Card, Chip, EmptyState, Field, SectionTitle, TextInput } from '../components/ui.tsx';
import { beansRepo, daysOffRoast, restVerdict } from '../db/repo/beans.ts';
import type { Bean, BeanProcess, RoastLevel } from '../domain/types.ts';
import { startSession } from '../hooks/actions.ts';
import { useBeans, useSessions } from '../hooks/data.ts';

const PROCESSES: BeanProcess[] = ['natural', 'washed', 'honey', 'anaerobic', 'other'];
const ROASTS: RoastLevel[] = ['light', 'medium-light', 'medium', 'medium-dark', 'dark'];

const REST_LABEL: Record<ReturnType<typeof restVerdict>, string> = {
  'too-fresh': 'still degassing',
  ready: 'in the window',
  'past-peak': 'getting old',
  unknown: 'no roast date',
};

export function Beans() {
  const beans = useBeans();
  const sessions = useSessions();
  const [adding, setAdding] = useState(false);

  if (beans === undefined) {
    return <p className="mt-8 text-center text-sm text-crust-500">Loading…</p>;
  }

  const active = beans.filter((b) => b.state !== 'finished');
  const finished = beans.filter((b) => b.state === 'finished');
  const activeSessionBeanId = sessions?.find((s) => s.status === 'dialing')?.beanId;

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xs font-semibold uppercase tracking-[0.2em] text-crust-500">Beans</h1>
        <Button variant="ghost" size="sm" onClick={() => setAdding((a) => !a)}>
          {adding ? 'Cancel' : 'Add bag'}
        </Button>
      </div>

      {adding ? <AddBeanForm onDone={() => setAdding(false)} /> : null}

      {active.length === 0 && !adding ? (
        <EmptyState
          title="No beans yet"
          body="Add the bag you're pulling and the coach can start tracking it."
          action={<BigButton onClick={() => setAdding(true)}>Add a bag</BigButton>}
        />
      ) : null}

      {active.length > 0 ? (
        <ul className="space-y-3">
          {active.map((bean) => (
            <BeanRow key={bean.id} bean={bean} isActive={bean.id === activeSessionBeanId} />
          ))}
        </ul>
      ) : null}

      {finished.length > 0 ? (
        <div className="mt-8">
          <SectionTitle>Finished</SectionTitle>
          <ul className="space-y-3 opacity-60">
            {finished.map((bean) => (
              <BeanRow key={bean.id} bean={bean} isActive={false} />
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

function BeanRow({ bean, isActive }: { bean: Bean; isActive: boolean }) {
  const navigate = useNavigate();
  const days = daysOffRoast(bean);
  const rest = restVerdict(days);

  return (
    <Card as="li" className={isActive ? 'border-good' : ''}>
      <div className="flex items-start justify-between gap-3">
        <Link to={`/beans/${bean.id}`} className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold text-crust-50">{bean.name}</h2>
          <p className="truncate text-sm text-crust-400">
            {bean.roaster}
            {bean.process ? ` · ${bean.process}` : ''}
            {bean.roastLevel ? ` · ${bean.roastLevel}` : ''}
          </p>
          <p className="mt-1 text-xs text-crust-500">
            {days !== undefined ? `${days} days off roast — ${REST_LABEL[rest]}` : REST_LABEL[rest]}
          </p>
        </Link>
        {isActive ? (
          <span className="shrink-0 rounded-full bg-good px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-white">
            Dialling
          </span>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            onClick={async () => {
              const session = await startSession(bean.id);
              if (session) navigate('/');
            }}
          >
            Dial in
          </Button>
        )}
      </div>
    </Card>
  );
}

function AddBeanForm({ onDone }: { onDone: () => void }) {
  const [roaster, setRoaster] = useState('');
  const [name, setName] = useState('');
  const [origin, setOrigin] = useState('');
  const [roastDate, setRoastDate] = useState('');
  const [process, setProcess] = useState<BeanProcess | undefined>();
  const [roastLevel, setRoastLevel] = useState<RoastLevel | undefined>();
  const [saving, setSaving] = useState(false);

  const canSave = name.trim().length > 0 && !saving;

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
            <Chip key={p} active={process === p} onClick={() => setProcess((c) => (c === p ? undefined : p))}>
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

      <BigButton
        disabled={!canSave}
        onClick={async () => {
          setSaving(true);
          try {
            await beansRepo.create({
              roaster: roaster.trim() || 'Unknown roaster',
              name: name.trim(),
              state: 'active',
              ...(origin.trim() ? { origin: origin.trim() } : {}),
              ...(roastDate ? { roastDate } : {}),
              ...(process ? { process } : {}),
              ...(roastLevel ? { roastLevel } : {}),
            });
            onDone();
          } finally {
            setSaving(false);
          }
        }}
      >
        {saving ? 'Saving…' : 'Save bag'}
      </BigButton>
    </Card>
  );
}
