import { Link, useNavigate } from 'react-router-dom';
import { AdviceCard } from '../components/AdviceCard.tsx';
import { BigButton, Card, EmptyState, SectionTitle, StatTile } from '../components/ui.tsx';
import { daysOffRoast, restVerdict } from '../db/repo/beans.ts';
import { brewRatio, shotTimeOnBasis, windowVerdict } from '../domain/metrics.ts';
import type { Shot, Targets } from '../domain/types.ts';
import { applyAdvice, declineAdvice } from '../hooks/actions.ts';
import { useDialIn } from '../hooks/data.ts';

/**
 * The screen you open between shots: what bean, what dial, what the last shot did, and what
 * to change. Everything else in the app is a detour from this.
 */
export function Home() {
  const ctx = useDialIn();
  const navigate = useNavigate();

  if (ctx === undefined) {
    return <p className="mt-8 text-center text-sm text-crust-500">Loading…</p>;
  }

  const { session, bean, grinder, shots, advice } = ctx;

  if (!session) {
    return (
      <>
        <Header title="Dial-in" />
        <EmptyState
          title="No bean being dialled in"
          body="Add a bag and start a session, and the coach will tell you what to change after each shot."
          action={
            <Link to="/beans">
              <BigButton>Go to beans</BigButton>
            </Link>
          }
        />
      </>
    );
  }

  const countable = shots.filter((s) => !s.discarded);
  const last = countable[countable.length - 1];
  const days = bean ? daysOffRoast(bean) : undefined;
  const rest = restVerdict(days);
  const dialStep = grinder?.spec.dialStep ?? 0.5;

  return (
    <>
      <Header title={session.status === 'locked' ? 'Dialled in' : 'Dial-in'} />

      <Card className="mb-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Link to={`/beans/${session.beanId}`} className="block">
              <h1 className="truncate text-xl font-bold text-crust-50">
                {bean ? bean.name : 'Unknown bean'}
              </h1>
              <p className="truncate text-sm text-crust-400">
                {bean?.roaster}
                {bean?.process ? ` · ${bean.process}` : ''}
                {days !== undefined ? ` · ${days}d off roast` : ''}
              </p>
            </Link>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-[11px] uppercase tracking-wider text-crust-500">Dial</div>
            <div className="tnum text-3xl font-bold leading-none text-crust-50">
              {session.currentDial.toFixed(dialStep < 1 ? 1 : 0)}
            </div>
          </div>
        </div>

        <dl className="mt-4 grid grid-cols-4 gap-2 border-t border-crust-800 pt-3 text-center">
          <Spec label="Dose" value={`${session.targets.doseG}g`} />
          <Spec label="Yield" value={`${session.targets.yieldG}g`} />
          <Spec label="Temp" value={`${session.targets.tempC}°`} />
          <Spec
            label="Target"
            value={`${session.targets.timeWindowSec[0]}–${session.targets.timeWindowSec[1]}s`}
          />
        </dl>

        {session.status === 'locked' ? (
          <p className="mt-3 rounded-lg border border-good p-2 text-xs text-crust-200">
            Dialled in at {session.lockedDial}. Keep pulling at this setting — if it drifts as the
            beans age, the coach picks that up from the next shot.
          </p>
        ) : null}

        {rest === 'too-fresh' ? (
          <p className="mt-3 rounded-lg bg-crust-800 p-2 text-xs text-crust-300">
            Only {days} days off roast — fresh beans degas and can run fast and taste sharp. It may
            keep moving on you for a few days yet.
          </p>
        ) : null}
      </Card>

      {advice ? (
        <div className="mb-4">
          <AdviceCard
            advice={advice}
            onApply={async (a) => {
              await applyAdvice(session, a, last);
              // Straight to the timer: the point of accepting advice is to test it.
              if (a.action.kind === 'grind') navigate('/timer');
            }}
            onDismiss={() => void declineAdvice(last)}
          />
        </div>
      ) : !grinder ? (
        <Card className="mb-4 border-bad">
          <p className="text-sm text-crust-200">
            This session has no grinder attached, so there's no dial to advise on.{' '}
            <Link to="/gear" className="underline">
              Pick one in Setup
            </Link>
            .
          </p>
        </Card>
      ) : null}

      <BigButton onClick={() => navigate('/timer')} className="mb-6">
        Pull a shot
      </BigButton>

      {last ? (
        <>
          <SectionTitle
            action={
              <Link to={`/beans/${session.beanId}`} className="text-xs text-crust-400 underline">
                All {countable.length} shots
              </Link>
            }
          >
            Last shot
          </SectionTitle>
          <LastShot shot={last} targets={session.targets} />
        </>
      ) : null}
    </>
  );
}

function Header({ title }: { title: string }) {
  return (
    <div className="mb-4 flex items-center justify-between">
      <h1 className="text-xs font-semibold uppercase tracking-[0.2em] text-crust-500">{title}</h1>
      <Link to="/gear" className="text-xs text-crust-500 underline">
        Gear
      </Link>
    </div>
  );
}

function Spec({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-crust-500">{label}</dt>
      <dd className="tnum text-sm font-semibold text-crust-100">{value}</dd>
    </div>
  );
}

function LastShot({ shot, targets }: { shot: Shot; targets: Targets }) {
  const seconds = shotTimeOnBasis(shot, targets.timingBasis);
  const verdict = windowVerdict(seconds, targets);
  const tone = verdict === 'in-window' ? 'good' : verdict === 'unknown' ? 'neutral' : 'warn';

  return (
    <div className="grid grid-cols-4 gap-2">
      <StatTile
        label={targets.timingBasis === 'total' ? 'Total' : 'Extract'}
        value={seconds?.toFixed(1) ?? '—'}
        unit="s"
        tone={tone}
        hint={verdict === 'in-window' ? 'on target' : verdict}
      />
      <StatTile label="Yield" value={shot.yieldG.toFixed(1)} unit="g" />
      <StatTile label="Ratio" value={`1:${brewRatio(shot).toFixed(2)}`} />
      <StatTile
        label="Dial"
        value={shot.dial}
        hint={shot.channeling ? 'channelled' : undefined}
        tone={shot.channeling ? 'bad' : 'neutral'}
      />
    </div>
  );
}
