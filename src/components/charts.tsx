import { useState, type ReactNode } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { brewRatio, shotTimeOnBasis } from '../domain/metrics.ts';
import type { Shot, Targets } from '../domain/types.ts';

/**
 * Charts for the dial-in log.
 *
 * Colour decisions, in the order the data-viz method requires:
 *
 * - **Form first.** Convergence is a relationship between two measures → scatter. Progress
 *   over a sequence of shots → lines. Neither is a magnitude comparison, so no bars.
 * - **One series wherever possible**, so identity never rides on colour: the convergence and
 *   freshness charts are single-series, and the target window is a shaded band rather than a
 *   second colour. Only the timeline has two series, and it gets a legend.
 * - **Palette validated, not eyeballed.** Slots 1 and 2 of the reference categorical theme
 *   (blue `#3987e5`, orange `#d95926`) against this app's card surface `#211a15`: worst
 *   adjacent CVD ΔE 26.8, normal-vision ΔE 31.8, both series ≥ 3:1 contrast — all checks pass.
 * - **Axis ink** is `#a3866d` (5.06:1 on the card), gridlines are a recessive hairline.
 *
 * Every chart also offers a table view, so the data is never colour- or vision-dependent.
 */

const SERIES_1 = '#3987e5';
const SERIES_2 = '#d95926';
const AXIS_INK = '#a3866d';
const GRID = '#332720';
const BAND = '#0ca30c';
/** The card colour these charts sit on; used for the ring that separates overlapping marks. */
const SURFACE = '#211a15';

const axisProps = {
  stroke: AXIS_INK,
  tick: { fill: AXIS_INK, fontSize: 11 },
  tickLine: false,
} as const;

/**
 * The target window.
 *
 * It is context, not data, so it stays recessive — a solid block of green competes with the marks
 * it exists to frame. `extendDomain` keeps it drawn even when every shot lands outside it, which
 * is precisely when you most need to see where the window is.
 */
const BAND_STYLE = {
  fill: BAND,
  fillOpacity: 0.1,
  stroke: BAND,
  strokeOpacity: 0.3,
  strokeDasharray: '3 3',
  ifOverflow: 'extendDomain',
} as const;

function ChartTooltip({
  active,
  payload,
  rows,
}: {
  active?: boolean;
  payload?: { payload?: unknown }[];
  rows: (datum: never) => { label: string; value: string }[];
}) {
  if (!active || !payload?.length) return null;
  const datum = payload[0]?.payload;
  if (!datum) return null;
  return (
    <div className="rounded-lg border border-crust-700 bg-crust-950/95 px-3 py-2 text-xs shadow-lg">
      {rows(datum as never).map(({ label, value }) => (
        <div key={label} className="flex gap-3">
          <span className="text-crust-400">{label}</span>
          <span className="tnum ml-auto font-semibold text-crust-50">{value}</span>
        </div>
      ))}
    </div>
  );
}

/** Chart wrapper: title, the plot, and a table view toggle for the same numbers. */
function ChartFrame({
  title,
  subtitle,
  children,
  table,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  table: ReactNode;
}) {
  const [showTable, setShowTable] = useState(false);

  return (
    <section className="rounded-2xl border border-crust-800 bg-crust-900 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-crust-50">{title}</h3>
          {subtitle ? <p className="mt-0.5 text-xs text-crust-400">{subtitle}</p> : null}
        </div>
        <button
          type="button"
          onClick={() => setShowTable((v) => !v)}
          className="shrink-0 rounded-lg border border-crust-700 px-2 py-1 text-[11px] text-crust-300"
        >
          {showTable ? 'Chart' : 'Table'}
        </button>
      </div>
      {showTable ? <div className="overflow-x-auto">{table}</div> : children}
    </section>
  );
}

function Table({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <table className="w-full text-left text-xs">
      <thead>
        <tr className="border-b border-crust-800 text-crust-400">
          {head.map((h) => (
            <th key={h} className="py-1.5 pr-3 font-medium">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="tnum">
        {rows.map((row, i) => (
          <tr key={i} className="border-b border-crust-800/60 text-crust-100">
            {row.map((cell, j) => (
              <td key={j} className="py-1.5 pr-3">
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Recharts sizes scatter marks from the ZAxis *area*, which is both indirect and easy to lose
 * to defaults — the marks came out about 2px wide. An explicit shape guarantees the ≥8px mark
 * the spec calls for, with a surface-coloured ring so overlapping points stay countable.
 */
function Dot({ cx, cy, fill }: { cx?: number; cy?: number; fill?: string }) {
  if (cx === undefined || cy === undefined) return null;
  return <circle cx={cx} cy={cy} r={5} fill={fill ?? SERIES_1} stroke={SURFACE} strokeWidth={2} />;
}

/**
 * A y-domain that always contains both the data and the target band, padded a little.
 *
 * Without this the band can sit outside the data's own range and simply not be drawn — which is
 * how the target window went missing from a chart whose whole purpose is showing it.
 */
function secondsDomain(values: number[], [min, max]: [number, number]): [number, number] {
  const lo = Math.min(min, ...values);
  const hi = Math.max(max, ...values);
  const pad = Math.max(2, (hi - lo) * 0.12);
  return [Math.max(0, Math.floor(lo - pad)), Math.ceil(hi + pad)];
}

interface Point {
  dial: number;
  seconds: number;
  yieldG: number;
  ratio: number;
  index: number;
  channeling: boolean;
}

function toPoints(shots: Shot[], targets: Targets): Point[] {
  return shots
    .filter((s) => !s.discarded)
    .map((s, i) => ({
      dial: s.dial,
      seconds: shotTimeOnBasis(s, targets.timingBasis) ?? 0,
      yieldG: s.yieldG,
      ratio: brewRatio(s),
      index: i + 1,
      channeling: s.channeling,
    }))
    .filter((p) => p.seconds > 0);
}

/**
 * The convergence chart: grind setting against shot time, with the target window shaded.
 *
 * This is the one chart that answers "am I getting closer?" at a glance — points marching
 * into the band means the dial is converging, points scattered across it at one dial means
 * something other than the grind is varying.
 */
export function DialVsTimeChart({ shots, targets }: { shots: Shot[]; targets: Targets }) {
  const points = toPoints(shots, targets);
  const [min, max] = targets.timeWindowSec;
  // Explicit numeric x-domain, so the target band can be told to span the whole plot. Left to
  // Recharts' 'dataMin'/'dataMax' strings the band stops at the last data point instead.
  const dials = points.map((p) => p.dial);
  const xDomain: [number, number] = [Math.min(...dials) - 0.5, Math.max(...dials) + 0.5];

  return (
    <ChartFrame
      title="Grind setting vs shot time"
      subtitle={`Shaded band is the ${min}–${max}s target. Higher dial = finer on this grinder.`}
      table={
        <Table
          head={['#', 'Dial', 'Seconds', 'Yield g']}
          rows={points.map((p) => [p.index, p.dial, p.seconds.toFixed(1), p.yieldG.toFixed(1)])}
        />
      }
    >
      {points.length === 0 ? (
        <NoData />
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <ScatterChart margin={{ top: 8, right: 12, bottom: 18, left: -8 }}>
            <CartesianGrid stroke={GRID} strokeDasharray="2 4" />
            <XAxis
              {...axisProps}
              dataKey="dial"
              type="number"
              domain={xDomain}
              label={{ value: 'Dial', position: 'insideBottom', offset: -10, fill: AXIS_INK, fontSize: 11 }}
            />
            <YAxis
              {...axisProps}
              dataKey="seconds"
              type="number"
              unit="s"
              width={44}
              domain={secondsDomain(
                points.map((p) => p.seconds),
                targets.timeWindowSec,
              )}
            />
            <ReferenceArea
              x1={xDomain[0]}
              x2={xDomain[1]}
              y1={min}
              y2={max}
              {...BAND_STYLE}
            />
            <Tooltip
              content={
                <ChartTooltip
                  rows={(d: Point) => [
                    { label: 'Shot', value: `#${d.index}` },
                    { label: 'Dial', value: String(d.dial) },
                    { label: 'Time', value: `${d.seconds.toFixed(1)}s` },
                    { label: 'Yield', value: `${d.yieldG.toFixed(1)}g` },
                    ...(d.channeling ? [{ label: 'Note', value: 'channelled' }] : []),
                  ]}
                />
              }
            />
            <Scatter data={points} fill={SERIES_1} shape={<Dot />} />
          </ScatterChart>
        </ResponsiveContainer>
      )}
    </ChartFrame>
  );
}

/** Extraction time and time-to-first-drip across the session, in the order pulled. */
export function ShotTimelineChart({ shots, targets }: { shots: Shot[]; targets: Targets }) {
  const rows = shots
    .filter((s) => !s.discarded)
    .map((s, i) => ({
      index: i + 1,
      dial: s.dial,
      extraction: shotTimeOnBasis(s, targets.timingBasis) ?? null,
      firstDrip: s.firstDripSec ?? null,
    }));
  const [min, max] = targets.timeWindowSec;

  return (
    <ChartFrame
      title="Shot by shot"
      subtitle="How the timing moved as you adjusted."
      table={
        <Table
          head={['#', 'Dial', 'Time s', 'First drip s']}
          rows={rows.map((r) => [r.index, r.dial, r.extraction?.toFixed(1) ?? '—', r.firstDrip?.toFixed(1) ?? '—'])}
        />
      }
    >
      {rows.length === 0 ? (
        <NoData />
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 18, left: -8 }}>
            <CartesianGrid stroke={GRID} strokeDasharray="2 4" />
            <XAxis
              {...axisProps}
              dataKey="index"
              allowDecimals={false}
              label={{ value: 'Shot', position: 'insideBottom', offset: -10, fill: AXIS_INK, fontSize: 11 }}
            />
            <YAxis
              {...axisProps}
              unit="s"
              width={44}
              domain={secondsDomain(
                rows.flatMap((r) => [r.extraction, r.firstDrip].filter((v): v is number => v !== null)),
                targets.timeWindowSec,
              )}
            />
            <ReferenceArea y1={min} y2={max} {...BAND_STYLE} />
            <Tooltip
              content={
                <ChartTooltip
                  rows={(d: (typeof rows)[number]) => [
                    { label: 'Shot', value: `#${d.index}` },
                    { label: 'Dial', value: String(d.dial) },
                    { label: 'Time', value: d.extraction === null ? '—' : `${d.extraction.toFixed(1)}s` },
                    { label: 'First drip', value: d.firstDrip === null ? '—' : `${d.firstDrip.toFixed(1)}s` },
                  ]}
                />
              }
            />
            <Legend
              verticalAlign="top"
              height={28}
              wrapperStyle={{ fontSize: 11, color: AXIS_INK }}
              iconSize={8}
            />
            <Line
              type="monotone"
              dataKey="extraction"
              name="Shot time"
              stroke={SERIES_1}
              strokeWidth={2}
              dot={{ r: 4, strokeWidth: 2, stroke: SURFACE }}
              connectNulls
            />
            <Line
              type="monotone"
              dataKey="firstDrip"
              name="First drip"
              stroke={SERIES_2}
              strokeWidth={2}
              strokeDasharray="4 3"
              dot={{ r: 4, strokeWidth: 2, stroke: SURFACE }}
              connectNulls
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </ChartFrame>
  );
}

export interface FreshnessPoint {
  days: number;
  rating: number;
  bean: string;
}

/** Rating against days off roast, pooled across bags — the freshness curve made visible. */
export function FreshnessChart({ points }: { points: FreshnessPoint[] }) {
  return (
    <ChartFrame
      title="Rating vs days off roast"
      subtitle="Where your rated shots landed as bags aged."
      table={
        <Table
          head={['Bean', 'Days', 'Rating']}
          rows={points.map((p) => [p.bean, p.days, p.rating])}
        />
      }
    >
      {points.length === 0 ? (
        <NoData hint="Rate a few shots and record roast dates, and the curve appears here." />
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <ScatterChart margin={{ top: 8, right: 12, bottom: 18, left: -8 }}>
            <CartesianGrid stroke={GRID} strokeDasharray="2 4" />
            <XAxis
              {...axisProps}
              dataKey="days"
              type="number"
              label={{ value: 'Days off roast', position: 'insideBottom', offset: -10, fill: AXIS_INK, fontSize: 11 }}
            />
            <YAxis {...axisProps} dataKey="rating" type="number" domain={[0, 5]} ticks={[1, 2, 3, 4, 5]} width={44} />
            <Tooltip
              content={
                <ChartTooltip
                  rows={(d: FreshnessPoint) => [
                    { label: 'Bean', value: d.bean },
                    { label: 'Days', value: String(d.days) },
                    { label: 'Rating', value: `${d.rating}/5` },
                  ]}
                />
              }
            />
            <Scatter data={points} fill={SERIES_1} shape={<Dot />} />
          </ScatterChart>
        </ResponsiveContainer>
      )}
    </ChartFrame>
  );
}

function NoData({ hint = 'Log a shot and this fills in.' }: { hint?: string }) {
  return (
    <div className="flex h-[180px] items-center justify-center rounded-xl border border-dashed border-crust-800 px-4 text-center text-xs text-crust-500">
      {hint}
    </div>
  );
}
