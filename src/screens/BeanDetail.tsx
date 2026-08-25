import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { BeanForm } from '../components/BeanForm.tsx';
import { DialVsTimeChart } from '../components/charts.tsx';
import { BigButton, Button, Card, EmptyState, SectionTitle, StatTile } from '../components/ui.tsx';
import { beanProcesses, beansRepo, daysOffRoast } from '../db/repo/beans.ts';
import { brewRatio, sessionStats, shotTimeOnBasis, windowVerdict } from '../domain/metrics.ts';
import type { PeakPressure, Session, Shot } from '../domain/types.ts';
import { startSession } from '../hooks/actions.ts';
import { useBeanSessions, useBeans } from '../hooks/data.ts';

const PEAK_PRESSURE_LABEL: Record<PeakPressure, string> = {
  'under-5-bar': 'under 5 bar',
  '5-to-8-bar': '5–8 bar',
  '9-bar': '9 bar',
};

/** One bag: its sessions, its shots, and whether a dial was ever locked in for it. */
export function BeanDetail() {
  const { beanId } = useParams<{ beanId: string }>();
  const beans = useBeans();
  const sessions = useBeanSessions(beanId);
  const navigate = useNavigate();
  // Hooks run before the early returns below, so this can't move closer to where it's used.
  const [buyingAgain, setBuyingAgain] = useState(false);

  if (beans === undefined || sessions === undefined) {
    return <p className="mt-8 text-center text-sm text-crust-500">Loading…</p>;
  }

  const bean = beans.find((b) => b.id === beanId);
  if (!bean) {
    return (
      <EmptyState
        title="Bean not found"
        body="It may have been deleted."
        action={<BigButton onClick={() => navigate('/beans')}>Back to beans</BigButton>}
      />
    );
  }

  const days = daysOffRoast(bean);
  const locked = sessions.find(({ session }) => session.lockedDial !== undefined)?.session;
  const dialing = sessions.find(({ session }) => session.status === 'dialing');

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <Link to="/beans" className="text-xs text-crust-500 underline">
          ← Beans
        </Link>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setBuyingAgain((b) => !b)}>
            {buyingAgain ? 'Cancel' : 'Buy this again'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              void beansRepo.update(bean.id, {
                state: bean.state === 'finished' ? 'active' : 'finished',
              })
            }
          >
            {bean.state === 'finished' ? 'Reopen bag' : 'Mark finished'}
          </Button>
        </div>
      </div>

      {buyingAgain ? (
        <BeanForm
          initial={{
            roaster: bean.roaster,
            name: bean.name,
            ...(bean.origin ? { origin: bean.origin } : {}),
            process: beanProcesses(bean),
            ...(bean.roastLevel ? { roastLevel: bean.roastLevel } : {}),
            ...(bean.tastingNotes ? { tastingNotes: bean.tastingNotes } : {}),
            ...(bean.bagWeightG !== undefined ? { bagWeightG: bean.bagWeightG } : {}),
            ...(bean.priceCents !== undefined ? { priceCents: bean.priceCents } : {}),
          }}
          submitLabel="Save new bag"
          onDone={(newBean) => navigate(`/beans/${newBean.id}`)}
        />
      ) : null}

      <Card className="mb-4">
        <h1 className="text-xl font-bold text-crust-50">{bean.name}</h1>
        <p className="text-sm text-crust-400">
          {bean.roaster}
          {bean.origin ? ` · ${bean.origin}` : ''}
          {beanProcesses(bean).length > 0 ? ` · ${beanProcesses(bean).join(' + ')}` : ''}
          {bean.roastLevel ? ` · ${bean.roastLevel}` : ''}
        </p>
        {bean.tastingNotes && bean.tastingNotes.length > 0 ? (
          <p className="mt-1 flex flex-wrap gap-1.5 text-xs text-crust-500">
            {bean.tastingNotes.map((note) => (
              <span key={note} className="rounded-full border border-crust-700 px-2 py-0.5">
                {note}
              </span>
            ))}
          </p>
        ) : null}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <StatTile
            label="Off roast"
            value={days ?? '—'}
            unit={days !== undefined ? 'days' : undefined}
            hint={bean.roastDate ?? 'no roast date'}
          />
          <StatTile
            label="Locked dial"
            value={locked?.lockedDial ?? '—'}
            tone={locked ? 'good' : 'neutral'}
            hint={locked ? 'known good' : 'not dialled in yet'}
          />
        </div>
      </Card>

      {!dialing ? (
        <BigButton className="mb-6" onClick={async () => (await startSession(bean.id), navigate('/'))}>
          {locked ? `Dial in again from ${locked.lockedDial}` : 'Start dialling in'}
        </BigButton>
      ) : null}

      {sessions.length === 0 ? (
        <EmptyState title="No sessions yet" body="Start one and every shot for this bag lands here." />
      ) : null}

      {sessions.map(({ session, shots }) => (
        <SessionBlock key={session.id} session={session} shots={shots} />
      ))}
    </>
  );
}

function SessionBlock({ session, shots }: { session: Session; shots: Shot[] }) {
  const stats = sessionStats(shots, session.targets);
  const started = new Date(session.startedAt).toLocaleDateString();

  return (
    <div className="mb-6">
      <SectionTitle
        action={
          <span className="text-[11px] uppercase tracking-wider text-crust-500">
            {session.status === 'locked'
              ? `locked at ${session.lockedDial}`
              : session.status === 'dialing'
                ? 'dialling'
                : 'abandoned'}
          </span>
        }
      >
        {started} · {stats.shotCount} shot{stats.shotCount === 1 ? '' : 's'}
      </SectionTitle>

      {shots.length > 0 ? (
        <>
          <div className="mb-3">
            <DialVsTimeChart shots={shots} targets={session.targets} />
          </div>
          <ul className="space-y-2">
            {[...shots].reverse().map((shot) => (
              <ShotRow key={shot.id} shot={shot} session={session} />
            ))}
          </ul>
        </>
      ) : (
        <p className="text-sm text-crust-500">No shots logged.</p>
      )}
    </div>
  );
}

function ShotRow({ shot, session }: { shot: Shot; session: Session }) {
  const seconds = shotTimeOnBasis(shot, session.targets.timingBasis);
  const verdict = windowVerdict(seconds, session.targets);
  const time = new Date(shot.pulledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <li
      className={`rounded-xl border p-3 ${
        shot.discarded ? 'border-crust-800 opacity-50' : 'border-crust-800 bg-crust-900'
      }`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="tnum text-base font-semibold text-crust-50">
          {seconds?.toFixed(1) ?? '—'}s
          <span className="ml-2 text-xs font-normal text-crust-400">
            dial {shot.dial} · {shot.doseG}g → {shot.yieldG.toFixed(1)}g · 1:{brewRatio(shot).toFixed(2)}
          </span>
        </span>
        <span className="shrink-0 text-[11px] text-crust-500">{time}</span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
        <Tag tone={verdict === 'in-window' ? 'good' : verdict === 'unknown' ? 'muted' : 'warn'}>
          {verdict === 'in-window' ? 'on target' : verdict}
        </Tag>
        {shot.channeling ? <Tag tone="bad">channelled</Tag> : null}
        {shot.peakPressure ? <Tag tone="muted">{PEAK_PRESSURE_LABEL[shot.peakPressure]}</Tag> : null}
        {shot.discarded ? <Tag tone="muted">not counted</Tag> : null}
        {shot.rating !== undefined ? <Tag tone="muted">{shot.rating}/5</Tag> : null}
        {shot.tasteTags.map((t) => (
          <Tag key={t} tone="muted">
            {t}
          </Tag>
        ))}
        {shot.suggestionFollowed === true ? <Tag tone="muted">advice taken</Tag> : null}
      </div>

      {shot.suggestion ? (
        <p className="mt-2 border-t border-crust-800 pt-2 text-xs text-crust-400">
          <span className="font-semibold text-crust-300">Coach said:</span> {shot.suggestion.headline}
        </p>
      ) : null}
      {shot.notes ? <p className="mt-1 text-xs italic text-crust-500">{shot.notes}</p> : null}
    </li>
  );
}

function Tag({ children, tone }: { children: React.ReactNode; tone: 'good' | 'warn' | 'bad' | 'muted' }) {
  const cls =
    tone === 'good'
      ? 'border-good text-good'
      : tone === 'warn'
        ? 'border-warn text-warn'
        : tone === 'bad'
          ? 'border-bad text-bad'
          : 'border-crust-700 text-crust-400';
  return <span className={`rounded-full border px-2 py-0.5 ${cls}`}>{children}</span>;
}
