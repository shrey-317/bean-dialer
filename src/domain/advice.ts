import { dialDelta, snapDial } from '../db/repo/gear.ts';
import {
  flowRate,
  isConverged,
  isYieldUsable,
  secondsOutsideWindow,
  shotTimeOnBasis,
  windowVerdict,
  YIELD_TOLERANCE_G,
  yieldDeviation,
} from './metrics.ts';
import type {
  Advice,
  AdviceRuleId,
  GrinderGear,
  Session,
  Shot,
  TamperGear,
  Targets,
} from './types.ts';

/**
 * The dial-in coach.
 *
 * A pure function of (latest shot, session targets, grinder, tamper, prior shots) — no DB,
 * no React — so every rule is directly unit-testable and the same logic could later run
 * server-side unchanged.
 *
 * Design rules that matter more than the individual heuristics:
 *
 * - **Direction is never assumed.** Every grind change is expressed as "finer" or "coarser"
 *   and converted to a signed dial delta by `dialDelta`, which reads the grinder's
 *   `dialDirection`. On the DF54 used here, finer means a *higher* number.
 *
 * - **Tamp pressure is never suggested** when the tamper reports
 *   `pressureAdjustable: false`. A self-leveling tamper has no such control, so advising it
 *   would send you chasing a knob that doesn't exist.
 *
 * - **One change at a time.** The engine only ever proposes a single primary action, because
 *   two simultaneous changes make the next shot uninterpretable.
 */

/** Rules are evaluated in this order; the first that fires wins. */
export interface AdviceInput {
  shot: Shot;
  targets: Targets;
  grinder: GrinderGear;
  tamper?: TamperGear;
  /** Prior countable shots for this session, oldest first, excluding `shot`. */
  history: Shot[];
}

/** Seconds after pre-infusion ends that count as "dripping suspiciously early". */
export const EARLY_DRIP_SEC = 3;

function formatDial(value: number, step: number): string {
  const decimals = (String(step).split('.')[1] ?? '').length;
  return value.toFixed(Math.max(decimals, 0));
}

function fmt(n: number, decimals = 1): string {
  return n.toFixed(decimals).replace(/\.0$/, '');
}

/**
 * Step magnitude for a given miss. One step for a normal miss, more when the shot is
 * nowhere near the window — walking 0.5 at a time from 45 s wastes coffee.
 */
function stepsForMiss(secondsOff: number): number {
  return Math.min(3, Math.max(1, Math.ceil(Math.abs(secondsOff) / 5)));
}

function grindAdvice(
  direction: 'finer' | 'coarser',
  steps: number,
  input: AdviceInput,
  ruleId: AdviceRuleId,
  reason: string,
  notes: string[],
  confidence: Advice['confidence'],
): Advice {
  const spec = input.grinder.spec;
  const delta = dialDelta(direction, steps, spec);
  const from = input.shot.dial;
  const to = snapDial(from + delta, spec);
  const atLimit = to === from;

  if (atLimit) {
    return {
      action: { kind: 'hold' },
      headline: `Already at the ${direction === 'finer' ? 'finest' : 'coarsest'} setting`,
      reason: `${reason} But dial ${formatDial(from, spec.dialStep)} is the end of this grinder's range, so the grind can't go ${direction}.`,
      confidence: 'low',
      notes: [
        ...notes,
        'Change something else instead: dose, basket, or brew temperature — or check the burrs are seated and clean.',
      ],
      ruleId,
    };
  }

  return {
    action: { kind: 'grind', deltaDial: to - from, newDial: to },
    headline: `Grind ${direction}: ${formatDial(from, spec.dialStep)} → ${formatDial(to, spec.dialStep)}`,
    reason,
    confidence,
    notes,
    ruleId,
  };
}

/** Notes about puck prep, worded for the tamper actually in use. */
function prepNotes(tamper: TamperGear | undefined): string[] {
  const notes = [
    'Distribute the grounds before tamping — WDT or a stir breaks up clumps that cause channeling.',
  ];
  if (tamper?.spec.pressureAdjustable === false) {
    notes.push(
      `${tamper.name} levels itself and has no pressure override, so don't try to fix this by tamping differently — correct it with the grind and distribution.`,
    );
  }
  return notes;
}

/**
 * Whether the recent suggestion history is bouncing back and forth. Oscillation means the
 * true setting is between two steps, and stepping again just moves the problem — better to
 * repeat a shot and see where it really sits.
 */
function isOscillating(history: Shot[], proposedDelta: number): boolean {
  const signs = history
    .filter((s) => !s.discarded)
    .map((s) => s.suggestion?.action)
    .filter((a) => a?.kind === 'grind' && typeof a.deltaDial === 'number' && a.deltaDial !== 0)
    .map((a) => Math.sign(a!.deltaDial!));

  const [prev2, prev1] = signs.slice(-2);
  if (prev2 === undefined || prev1 === undefined) return false;
  // Three alternating in a row, counting the one we're about to give.
  return prev2 !== prev1 && Math.sign(proposedDelta) !== prev1;
}

export function adviceFor(input: AdviceInput): Advice {
  const { shot, targets, grinder, tamper, history } = input;
  const spec = grinder.spec;
  const seconds = shotTimeOnBasis(shot, targets.timingBasis);
  const basisLabel =
    targets.timingBasis === 'extraction'
      ? 'extraction time (after pre-infusion)'
      : targets.timingBasis === 'total'
        ? 'total time'
        : 'time to first drip';
  const [winMin, winMax] = targets.timeWindowSec;

  // --- Rule: unusable shot -------------------------------------------------
  if (shot.extractionSec <= 0 || seconds === undefined) {
    return {
      action: { kind: 'reshoot' },
      headline: 'Not enough to go on',
      reason: `This shot has no usable ${basisLabel}, so there's nothing to compare against the ${winMin}–${winMax} s target.`,
      confidence: 'low',
      notes: ['Log the next pull with the timer running from the moment you hit the button.'],
      ruleId: 'yield-out-of-range',
    };
  }

  // --- Rule 1: yield gate --------------------------------------------------
  // A shot that missed its yield badly can't be read on time alone: extra liquid takes
  // extra seconds, so a 52 g pull looks "slow" even at a perfect grind. Report flow rate
  // and ask for a clean shot rather than chasing the grind.
  if (!isYieldUsable(shot, targets)) {
    const dev = yieldDeviation(shot, targets);
    const over = dev > 0;
    return {
      action: { kind: 'reshoot' },
      headline: `Yield was ${over ? 'over' : 'under'} by ${fmt(Math.abs(dev))} g — pull another`,
      reason:
        `You got ${fmt(shot.yieldG)} g instead of ${fmt(targets.yieldG)} g, which is more than ` +
        `${YIELD_TOLERANCE_G} g off, so the ${fmt(seconds)} s says as much about the extra liquid as about the grind. ` +
        `Flow rate was ${fmt(flowRate(shot), 2)} g/s.`,
      confidence: 'high',
      notes: [
        `Keep the grind at ${formatDial(shot.dial, spec.dialStep)} and stop the shot at ${fmt(targets.yieldG)} g.`,
        over
          ? 'If it ran away from you, the shot is probably fast too — the next clean pull will tell you.'
          : 'If you cut it early because it stalled, that already points at too fine.',
      ],
      ruleId: 'yield-out-of-range',
    };
  }

  const verdict = windowVerdict(seconds, targets);
  const secondsOff = secondsOutsideWindow(seconds, targets);

  // Dripping before or immediately after pre-infusion means the puck is offering almost no
  // resistance. Note the threshold is measured from the *end* of pre-infusion: with the
  // Legato's 3 s + 6 s auto cycle, "9 s to first drip" is normal, not early.
  const dripAfterPreInfusion =
    shot.firstDripSec === undefined ? undefined : shot.firstDripSec - shot.preInfusionSec;
  const earlyDrip = dripAfterPreInfusion !== undefined && dripAfterPreInfusion < EARLY_DRIP_SEC;

  // --- Rule: time out of window -------------------------------------------
  if (verdict === 'fast' || verdict === 'slow') {
    const direction = verdict === 'fast' ? 'finer' : 'coarser';
    const steps = stepsForMiss(secondsOff);
    const notes: string[] = [];

    if (shot.channeling) {
      notes.push(
        'You also marked channeling, so some of this speed is water finding a shortcut rather than the grind being too coarse.',
        ...prepNotes(tamper),
      );
    } else if (earlyDrip && verdict === 'fast') {
      notes.push(
        `First drip came ${fmt(dripAfterPreInfusion!)} s after pre-infusion ended — the puck is offering very little resistance, which fits a grind this coarse.`,
      );
    }

    const proposedDelta = dialDelta(direction, steps, spec);
    if (isOscillating(history, proposedDelta)) {
      const held = formatDial(shot.dial, spec.dialStep);
      return {
        action: { kind: 'hold' },
        headline: `Hold at ${held} and pull two more`,
        reason:
          `The last few suggestions have been bouncing between finer and coarser, which usually means the right setting is between two clicks rather than at one of them. ` +
          `This shot ran ${fmt(seconds)} s against a ${winMin}–${winMax} s target.`,
        confidence: 'medium',
        notes: [
          `Stay at ${held} for two pulls and keep dose and yield identical — that shows where this setting truly sits.`,
          'If both land outside the window in the same direction, then step once more that way.',
          ...notes,
        ],
        ruleId: 'oscillation',
      };
    }

    const reason =
      verdict === 'fast'
        ? `${fmt(seconds)} s ${basisLabel} is ${fmt(Math.abs(secondsOff))} s under the ${winMin}–${winMax} s target, so water is moving through the puck too easily.`
        : `${fmt(seconds)} s ${basisLabel} is ${fmt(secondsOff)} s over the ${winMin}–${winMax} s target, so the puck is choking the flow.`;

    return grindAdvice(
      direction,
      steps,
      input,
      verdict === 'fast' ? 'time-too-fast' : 'time-too-slow',
      reason,
      notes,
      Math.abs(secondsOff) >= 2 ? 'high' : 'medium',
    );
  }

  // --- In the window from here on -----------------------------------------

  // --- Rule: channeling ----------------------------------------------------
  // Time is fine, so the grind is roughly right; an uneven puck is the remaining problem.
  // Changing the grind now would move a variable that isn't the cause.
  if (shot.channeling || earlyDrip) {
    return {
      action: { kind: 'hold' },
      headline: `Keep ${formatDial(shot.dial, spec.dialStep)} — fix the puck, not the grind`,
      reason:
        `${fmt(seconds)} s is inside the ${winMin}–${winMax} s target, so the grind is close. ` +
        (shot.channeling
          ? 'The channeling is a distribution problem, and grinding around it would only trade one fault for another.'
          : `First drip came ${fmt(dripAfterPreInfusion!)} s after pre-infusion, which is early for a shot this length — a sign water found a channel.`),
      confidence: 'medium',
      notes: prepNotes(tamper),
      ruleId: 'channeling',
    };
  }

  // --- Rule: lock-in -------------------------------------------------------
  const allShots = [...history, shot];
  if (isConverged(allShots, targets)) {
    const dial = formatDial(shot.dial, spec.dialStep);
    return {
      action: { kind: 'lock-in', newDial: shot.dial },
      headline: `Locked in at ${dial}`,
      reason: `Consecutive shots at ${dial} landed inside the ${winMin}–${winMax} s window with matching yields, so this is a repeatable setting rather than one good pull.`,
      confidence: 'high',
      notes: [
        'Save it and the next bag of this bean starts here instead of from scratch.',
        'Expect to revisit it as the beans age — resistance drops over a couple of weeks.',
      ],
      ruleId: 'lock-in',
    };
  }

  // --- Rule: taste tie-breaker --------------------------------------------
  // Only reachable when the numbers are already good, so taste is the deciding input.
  const tags = new Set(shot.tasteTags);
  const sour = tags.has('sour') || tags.has('thin');
  const bitter = tags.has('bitter') || tags.has('harsh') || tags.has('ashy');

  if (sour && !bitter) {
    return grindAdvice(
      'finer',
      1,
      input,
      'taste-sour',
      `${fmt(seconds)} s is on target, but ${tags.has('sour') ? 'sour' : 'thin'} says it's under-extracted — finer gives the water more to dissolve.`,
      [
        `Alternatively hold the grind and raise the temperature to ${shot.tempC + 1} °C, which pushes extraction the same direction more gently.`,
        'Change one of the two, not both, or the next shot tells you nothing.',
      ],
      'medium',
    );
  }

  if (bitter && !sour) {
    return grindAdvice(
      'coarser',
      1,
      input,
      'taste-bitter',
      `${fmt(seconds)} s is on target, but bitterness says it's over-extracted — coarser takes some of the bite out.`,
      [
        `Alternatively hold the grind and drop the temperature to ${shot.tempC - 1} °C.`,
        'Change one of the two, not both, or the next shot tells you nothing.',
      ],
      'medium',
    );
  }

  if (sour && bitter) {
    return {
      action: { kind: 'hold' },
      headline: `Sour and bitter together — pull again at ${formatDial(shot.dial, spec.dialStep)}`,
      reason:
        'Tasting under- and over-extracted at once usually means the water went through unevenly rather than the grind being wrong, so parts of the puck gave up too much and parts too little.',
      confidence: 'low',
      notes: prepNotes(tamper),
      ruleId: 'channeling',
    };
  }

  // --- Rule: in window, not yet confirmed ---------------------------------
  return {
    action: { kind: 'hold' },
    headline: `On target — pull one more at ${formatDial(shot.dial, spec.dialStep)}`,
    reason: `${fmt(seconds)} s sits inside the ${winMin}–${winMax} s window at ${fmt(shot.yieldG)} g. One shot can be luck, so repeat it before calling the dial done.`,
    confidence: 'medium',
    notes: ['Keep dose, yield and pre-infusion identical so the repeat actually confirms something.'],
    ruleId: 'in-window',
  };
}

/**
 * Advice for a session as a whole, given its shots. Handles the empty case so the home
 * screen has something to say before the first pull.
 */
export function adviceForSession(
  session: Session,
  shots: Shot[],
  grinder: GrinderGear,
  tamper?: TamperGear,
): Advice {
  const countable = shots.filter((s) => !s.discarded);
  const latest = countable[countable.length - 1];

  if (!latest) {
    const spec = grinder.spec;
    return {
      action: { kind: 'none' },
      headline: `Start at ${formatDial(session.currentDial, spec.dialStep)}`,
      reason: `No shots logged for this bean yet. Pull one at ${formatDial(session.currentDial, spec.dialStep)} with ${fmt(session.targets.doseG)} g in and ${fmt(session.targets.yieldG)} g out, and the coach works from there.`,
      confidence: 'low',
      notes: [
        `Target is ${session.targets.timeWindowSec[0]}–${session.targets.timeWindowSec[1]} s at ${fmt(session.targets.tempC)} °C.`,
      ],
      ruleId: 'no-shots',
    };
  }

  return adviceFor({
    shot: latest,
    targets: session.targets,
    grinder,
    ...(tamper ? { tamper } : {}),
    history: countable.slice(0, -1),
  });
}
