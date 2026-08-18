import { useEffect, useReducer, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AdviceCard } from '../components/AdviceCard.tsx';
import { LogShotSheet } from '../components/LogShotSheet.tsx';
import { BigButton, Button, EmptyState, Keypad } from '../components/ui.tsx';
import { sessionsRepo } from '../db/repo/sessions.ts';
import {
  clearSavedTimer,
  elapsedMs,
  isRunning,
  preInfusionMs,
  restoreTimer,
  saveTimer,
  stageOf,
  stageRemainingSec,
  timerReducer,
  type TimerStage,
} from '../domain/timer.ts';
import { applyAdvice, declineAdvice } from '../hooks/actions.ts';
import { useDialIn, useSettings, type DialInContext } from '../hooks/data.ts';
import { cue, primeAudio } from '../platform/haptics.ts';
import { releaseWakeLock, requestWakeLock } from '../platform/wakeLock.ts';

/**
 * The shot timer.
 *
 * Built for the two seconds of attention you have while holding a cup under a group head:
 * one stage colour filling the screen, one enormous number, and at most two buttons. Each
 * stage transition is signalled three ways — colour, vibration, and a tone — because
 * `navigator.vibrate` doesn't exist on iOS and the phone may be face-down on the counter.
 *
 * Elapsed time is always derived from `performance.now()` deltas, never from counting frames,
 * so a throttled or briefly-backgrounded tab still reports the true shot length.
 */

const STAGE_STYLE: Record<TimerStage, { bg: string; label: string; sub: string }> = {
  idle: { bg: 'var(--color-stage-idle)', label: 'Ready', sub: 'Lock the basket in and press start' },
  p1: { bg: 'var(--color-stage-p1)', label: 'Pre-infusion', sub: 'Low-pressure saturation' },
  bloom: { bg: 'var(--color-stage-bloom)', label: 'Bloom', sub: 'Pressure off, puck absorbing' },
  extraction: { bg: 'var(--color-stage-extract)', label: 'Extracting', sub: 'Watch the scale' },
  done: { bg: 'var(--color-stage-done)', label: 'Done', sub: 'Log what happened' },
};

export function TimerScreen() {
  const ctx = useDialIn();
  const settings = useSettings();
  const navigate = useNavigate();

  // Restore first: a reload mid-pull must resume rather than lose the shot. The fallback
  // config is corrected by SET_CONFIG once the session's pre-infusion is known.
  const [state, dispatch] = useReducer(timerReducer, undefined, () =>
    restoreTimer({ p1Sec: 3, p2Sec: 6 }),
  );
  const [savedShotId, setSavedShotId] = useState<string | null>(null);
  // Declared here, not near the pre-start dial line below, since hooks must run unconditionally
  // and this component has several early returns before that line.
  const [dialKeypadOpen, setDialKeypadOpen] = useState(false);

  const stage = stageOf(state);
  const running = isRunning(state);
  const targets = ctx?.session?.targets;

  // Adopt the session's pre-infusion timings. The reducer refuses this mid-pull, which is
  // what we want: changing stage lengths halfway through would rewrite what already happened.
  useEffect(() => {
    if (targets) dispatch({ type: 'SET_CONFIG', config: targets.preInfusion });
  }, [targets]);

  // Tick at 10 Hz, which is exactly the precision the display shows. A per-frame rAF loop would
  // re-render sixty times a second to move a tenth-of-a-second digit — six times the work for no
  // visible difference, on a device that is probably not plugged in. The reading itself is always
  // a `performance.now()` delta, so a late or throttled tick corrects itself rather than losing
  // time.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => dispatch({ type: 'TICK', at: performance.now() }), 100);
    return () => clearInterval(id);
  }, [running]);

  // Coming back to a foregrounded tab: catch up immediately rather than on the next frame.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') dispatch({ type: 'TICK', at: performance.now() });
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // Persist only on the events that change what's stored — elapsed time is recomputed from the
  // wall-clock anchor on restore, so there's no reason to write on every frame.
  useEffect(() => {
    saveTimer(state);
  }, [state.startedAt, state.startedAtEpoch, state.firstDripAt, state.stoppedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Announce stage changes on every channel available.
  const prevStage = useRef<TimerStage>(stage);
  useEffect(() => {
    if (prevStage.current === stage) return;
    prevStage.current = stage;
    const opts = {
      haptics: settings?.hapticsEnabled ?? true,
      sound: settings?.soundEnabled ?? true,
    };
    if (stage === 'extraction') cue('extract', opts);
    else if (stage === 'bloom') cue('stage', opts);
    else if (stage === 'done') cue('stop', opts);
  }, [stage, settings?.hapticsEnabled, settings?.soundEnabled]);

  // Hold the screen awake for the pull, and let it go the moment the shot ends.
  useEffect(() => {
    if (running && (settings?.keepAwakeDuringShot ?? true)) {
      void requestWakeLock();
    } else {
      void releaseWakeLock();
    }
    return () => void releaseWakeLock();
  }, [running, settings?.keepAwakeDuringShot]);

  if (ctx === undefined) {
    return <p className="mt-8 text-center text-sm text-crust-500">Loading…</p>;
  }
  if (!ctx.session || !ctx.grinder) {
    return (
      <EmptyState
        title="Nothing to dial in yet"
        body="Start a session for a bean first — the timer records against it."
        action={<BigButton onClick={() => navigate('/beans')}>Go to beans</BigButton>}
      />
    );
  }

  const total = elapsedMs(state);
  const preMs = preInfusionMs(state.config);
  const extractionMs = Math.max(0, total - preMs);
  const remaining = stageRemainingSec(state);
  const style = STAGE_STYLE[stage];

  // During extraction the big number is extraction seconds, because that's what the target
  // window refers to. Total time stays visible but secondary.
  const bigNumber =
    stage === 'extraction' || stage === 'done' ? extractionMs / 1000 : total / 1000;

  if (stage === 'done' && !savedShotId) {
    return (
      <LogShotSheet
        ctx={ctx}
        timer={state}
        onSaved={(shotId) => {
          // Drop the persisted pull the moment it's been logged. Otherwise a reload restores a
          // stopped timer that still looks unlogged, and the same shot gets saved twice.
          clearSavedTimer();
          setSavedShotId(shotId);
        }}
        onDiscardTimer={() => {
          clearSavedTimer();
          dispatch({ type: 'RESET' });
        }}
      />
    );
  }

  if (stage === 'done' && savedShotId) {
    // `ctx.advice` has already recomputed from the shot just saved, because the live query
    // reruns on the write — so this is the verdict on *this* shot, not the previous one.
    return (
      <SavedSummary
        ctx={ctx}
        onAnother={() => {
          clearSavedTimer();
          setSavedShotId(null);
          dispatch({ type: 'RESET' });
        }}
        onHome={() => {
          clearSavedTimer();
          dispatch({ type: 'RESET' });
          navigate('/');
        }}
      />
    );
  }

  return (
    <div className="-mx-4 -mt-[calc(var(--safe-top)+1rem)] flex min-h-[calc(100vh-5rem)] flex-col">
      <div
        className="flex flex-1 flex-col items-center justify-center px-6 pt-[calc(var(--safe-top)+2rem)] transition-colors duration-500"
        style={{ backgroundColor: style.bg }}
      >
        <p className="text-xs font-bold uppercase tracking-[0.3em] text-white/70">{style.label}</p>

        <p className="tnum mt-2 text-[5.5rem] font-bold leading-none text-white">
          {bigNumber.toFixed(1)}
        </p>

        {remaining !== null && running ? (
          <p className="tnum mt-1 text-lg font-semibold text-white/80">
            {Math.max(0, remaining).toFixed(1)}s left in {style.label.toLowerCase()}
          </p>
        ) : (
          <p className="mt-1 text-sm text-white/70">
            {stage === 'extraction' ? `${(total / 1000).toFixed(1)}s total` : style.sub}
          </p>
        )}

        {stage === 'extraction' && targets ? (
          <TargetBar seconds={extractionMs / 1000} window={targets.timeWindowSec} />
        ) : null}

        {state.firstDripAt !== null && state.startedAt !== null ? (
          <p className="tnum mt-4 text-sm text-white/80">
            First drip at {((state.firstDripAt - state.startedAt) / 1000).toFixed(1)}s
          </p>
        ) : null}
      </div>

      <div className="space-y-3 bg-crust-950 px-4 pb-6 pt-4">
        {!running ? (
          <>
            <div className="flex items-baseline justify-between text-sm text-crust-400">
              <button
                type="button"
                aria-label="Edit dial"
                onClick={() => setDialKeypadOpen(true)}
                className="active:opacity-70"
              >
                Dial <span className="tnum font-semibold text-crust-100">{ctx.session.currentDial}</span>
              </button>
              <span className="tnum">
                {ctx.session.targets.doseG}g → {ctx.session.targets.yieldG}g ·{' '}
                {ctx.session.targets.tempC}°C
              </span>
            </div>
            {dialKeypadOpen ? (
              <Keypad
                label="Dial"
                value={ctx.session.currentDial}
                min={ctx.grinder.spec.dialMin}
                max={ctx.grinder.spec.dialMax}
                decimals={ctx.grinder.spec.dialStep < 1 ? 1 : 0}
                onCommit={(next) => void sessionsRepo.setDial(ctx.session!.id, next)}
                onClose={() => setDialKeypadOpen(false)}
              />
            ) : null}
            <BigButton
              onClick={() => {
                // Must happen inside the gesture, or the browser blocks audio afterwards.
                primeAudio();
                dispatch({ type: 'START', at: performance.now(), epoch: Date.now() });
              }}
            >
              Start — press with the machine
            </BigButton>
            <p className="text-center text-xs text-crust-500">
              Stages follow your {ctx.session.targets.preInfusion.p1Sec}s /{' '}
              {ctx.session.targets.preInfusion.p2Sec}s pre-infusion.
            </p>
          </>
        ) : (
          <>
            <Button
              variant="secondary"
              className="w-full"
              disabled={state.firstDripAt !== null}
              onClick={() => {
                cue('tap', {
                  haptics: settings?.hapticsEnabled ?? true,
                  sound: settings?.soundEnabled ?? true,
                });
                dispatch({ type: 'FIRST_DRIP', at: performance.now() });
              }}
            >
              {state.firstDripAt === null ? 'First drip' : 'First drip logged'}
            </Button>
            <BigButton
              variant="danger"
              onClick={() => dispatch({ type: 'STOP', at: performance.now() })}
            >
              Stop
            </BigButton>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * A bar showing where the shot is relative to the target window, so the window is legible
 * without reading numbers. Scaled to 1.5× the window's upper bound, which keeps a stalled
 * shot on-screen instead of pinning at the end.
 */
function TargetBar({ seconds, window: [min, max] }: { seconds: number; window: [number, number] }) {
  const scale = max * 1.5;
  const pct = (v: number) => `${Math.min(100, (v / scale) * 100)}%`;
  const inWindow = seconds >= min && seconds <= max;

  return (
    <div className="mt-6 w-full max-w-xs">
      <div className="relative h-3 overflow-hidden rounded-full bg-black/25">
        <div
          className="absolute inset-y-0 bg-white/25"
          style={{ left: pct(min), width: `${((max - min) / scale) * 100}%` }}
        />
        <div
          className="absolute inset-y-0 left-0 bg-white transition-[width] duration-200"
          style={{ width: pct(seconds), opacity: inWindow ? 1 : 0.65 }}
        />
      </div>
      <div className="tnum mt-1 flex justify-between text-[10px] text-white/70">
        <span>0s</span>
        <span>
          {min}–{max}s target
        </span>
        <span>{scale.toFixed(0)}s</span>
      </div>
    </div>
  );
}

/** Shot saved: show the verdict immediately, while the cup is still in your hand. */
function SavedSummary({
  ctx,
  onAnother,
  onHome,
}: {
  ctx: DialInContext;
  onAnother: () => void;
  onHome: () => void;
}) {
  const [applying, setApplying] = useState(false);
  const countable = ctx.shots.filter((s) => !s.discarded);
  const last = countable[countable.length - 1];

  return (
    <div className="space-y-3 pt-2">
      {ctx.advice && ctx.session ? (
        <AdviceCard
          advice={ctx.advice}
          applying={applying}
          onApply={async (a) => {
            setApplying(true);
            try {
              await applyAdvice(ctx.session!, a, last);
              // Locking in ends the dial-in; anything else is meant to be tested next pull.
              if (a.action.kind === 'lock-in') onHome();
              else onAnother();
            } finally {
              setApplying(false);
            }
          }}
          onDismiss={() => void declineAdvice(last)}
        />
      ) : (
        <p className="text-center text-sm text-crust-400">Shot saved.</p>
      )}
      <BigButton onClick={onAnother}>Pull another</BigButton>
      <Button variant="ghost" className="w-full" onClick={onHome}>
        Back to home
      </Button>
    </div>
  );
}
