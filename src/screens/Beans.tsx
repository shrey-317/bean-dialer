import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BeanForm } from '../components/BeanForm.tsx';
import { BeanScanner } from '../components/BeanScanner.tsx';
import { BigButton, Button, Card, EmptyState, SectionTitle } from '../components/ui.tsx';
import { beanProcesses, daysOffRoast, restVerdict } from '../db/repo/beans.ts';
import type { Bean } from '../domain/types.ts';
import { startSession } from '../hooks/actions.ts';
import { useBeans, useSessions } from '../hooks/data.ts';

type AddMode = 'none' | 'manual' | 'scan';

const REST_LABEL: Record<ReturnType<typeof restVerdict>, string> = {
  'too-fresh': 'still degassing',
  ready: 'in the window',
  'past-peak': 'getting old',
  unknown: 'no roast date',
};

export function Beans() {
  const beans = useBeans();
  const sessions = useSessions();
  const [mode, setMode] = useState<AddMode>('none');

  if (beans === undefined) {
    return <p className="mt-8 text-center text-sm text-crust-500">Loading…</p>;
  }

  const active = beans.filter((b) => b.state !== 'finished');
  const finished = beans.filter((b) => b.state === 'finished');
  const activeSessionBeanId = sessions?.find((s) => s.status === 'dialing')?.beanId;
  const closeForm = () => setMode('none');

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-2">
        <h1 className="text-xs font-semibold uppercase tracking-[0.2em] text-crust-500">Beans</h1>
        <div className="flex gap-2">
          {mode === 'none' ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => setMode('scan')}>
                Scan a bag
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setMode('manual')}>
                Add bag
              </Button>
            </>
          ) : (
            <Button variant="ghost" size="sm" onClick={closeForm}>
              Cancel
            </Button>
          )}
        </div>
      </div>

      {mode === 'manual' ? <BeanForm onDone={closeForm} /> : null}
      {mode === 'scan' ? <BeanScanner onDone={closeForm} /> : null}

      {active.length === 0 && mode === 'none' ? (
        <EmptyState
          title="No beans yet"
          body="Add the bag you're pulling and the coach can start tracking it."
          action={
            <div className="space-y-2">
              <BigButton onClick={() => setMode('manual')}>Add a bag</BigButton>
              <Button variant="ghost" className="w-full" onClick={() => setMode('scan')}>
                Or scan the label
              </Button>
            </div>
          }
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
            {beanProcesses(bean).length > 0 ? ` · ${beanProcesses(bean).join(' + ')}` : ''}
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
