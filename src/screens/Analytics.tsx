import { DialVsTimeChart, FreshnessChart, ShotTimelineChart, type FreshnessPoint } from '../components/charts.tsx';
import { EmptyState, SectionTitle, StatTile } from '../components/ui.tsx';
import { daysOffRoast } from '../db/repo/beans.ts';
import { sessionStats, shotsToLockIn } from '../domain/metrics.ts';
import { useAllShots, useBeans, useDialIn, useSessions } from '../hooks/data.ts';

/**
 * Stats for the session being dialled in, plus one all-time view.
 *
 * Scoped to the current session on purpose: shot times only mean something against a
 * particular bean, dose and gear combination, so pooling every shot ever pulled into one
 * average would produce a number that describes nothing. The freshness chart is the exception —
 * comparing rating against bag age is precisely a cross-bag question.
 */
export function Analytics() {
  const ctx = useDialIn();
  const beans = useBeans();
  const sessions = useSessions();
  const allShots = useAllShots();

  if (ctx === undefined || beans === undefined || allShots === undefined) {
    return <p className="mt-8 text-center text-sm text-crust-500">Loading…</p>;
  }

  const { session, bean, shots } = ctx;
  const stats = session ? sessionStats(shots, session.targets) : undefined;
  const lockedIn = session ? shotsToLockIn(shots, session.lockedDial) : undefined;

  // Rated shots need both a rating and a roast date to place on the freshness curve.
  const beanById = new Map(beans.map((b) => [b.id, b]));
  const sessionById = new Map((sessions ?? []).map((s) => [s.id, s]));
  const freshness: FreshnessPoint[] = allShots.flatMap((shot) => {
    if (shot.discarded || shot.rating === undefined) return [];
    const shotBean = beanById.get(sessionById.get(shot.sessionId)?.beanId ?? '');
    if (!shotBean?.roastDate) return [];
    const days = daysOffRoast(shotBean, new Date(shot.pulledAt));
    if (days === undefined) return [];
    return [{ days, rating: shot.rating, bean: shotBean.name }];
  });

  return (
    <>
      <h1 className="mb-4 text-xs font-semibold uppercase tracking-[0.2em] text-crust-500">Stats</h1>

      {session && stats ? (
        <>
          <SectionTitle>{bean?.name ?? 'Current session'}</SectionTitle>
          <div className="mb-4 grid grid-cols-2 gap-2">
            <StatTile
              label="Shots"
              value={stats.shotCount}
              hint={lockedIn !== undefined ? `${lockedIn} to lock in` : 'still dialling'}
            />
            <StatTile
              label="In window"
              value={`${stats.inWindowCount}/${stats.shotCount}`}
              tone={stats.inWindowCount > 0 ? 'good' : 'neutral'}
            />
            <StatTile
              label="Avg time"
              value={stats.shotCount ? stats.avgTimeSec.toFixed(1) : '—'}
              unit="s"
              hint={`target ${session.targets.timeWindowSec[0]}–${session.targets.timeWindowSec[1]}s`}
            />
            <StatTile
              label="Consistency"
              value={stats.shotCount > 1 ? `±${stats.timeConsistencySec.toFixed(1)}` : '—'}
              unit="s"
              hint="σ of shot time"
              tone={stats.shotCount > 1 && stats.timeConsistencySec <= 1.5 ? 'good' : 'neutral'}
            />
            <StatTile
              label="Avg yield"
              value={stats.shotCount ? stats.avgYieldG.toFixed(1) : '—'}
              unit="g"
              hint={`target ${session.targets.yieldG}g`}
            />
            <StatTile
              label="Channelled"
              value={stats.channelingCount}
              tone={stats.channelingCount > 0 ? 'warn' : 'neutral'}
            />
          </div>

          <div className="space-y-4">
            <DialVsTimeChart shots={shots} targets={session.targets} />
            <ShotTimelineChart shots={shots} targets={session.targets} />
          </div>
        </>
      ) : (
        <EmptyState
          title="No session to summarise"
          body="Start dialling a bean in and its numbers show up here."
        />
      )}

      <div className="mt-6">
        <SectionTitle>All bags</SectionTitle>
        <FreshnessChart points={freshness} />
      </div>
    </>
  );
}
