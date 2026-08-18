/**
 * Haptics and audible cues for stage transitions.
 *
 * `navigator.vibrate` does not exist in Safari on iOS, so on an iPhone this is silently a
 * no-op. That is why the timer signals every transition three ways — vibration, a tone, and
 * a full-screen colour change — rather than relying on any single channel.
 *
 * Wrapped in an adapter so a Capacitor build can swap in the native Haptics plugin without
 * touching the timer screen.
 */

export type HapticPattern = 'stage' | 'extract' | 'stop' | 'tap';

const PATTERNS: Record<HapticPattern, number | number[]> = {
  tap: 12,
  stage: 30,
  // Extraction starting is the cue you most need to catch from across the kitchen.
  extract: [60, 40, 60],
  stop: [40, 30, 40, 30, 90],
};

export function canVibrate(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

export function vibrate(pattern: HapticPattern, enabled = true): void {
  if (!enabled || !canVibrate()) return;
  try {
    navigator.vibrate(PATTERNS[pattern]);
  } catch {
    /* a failed buzz is never worth an error */
  }
}

// --- Audio -----------------------------------------------------------------

let audioCtx: AudioContext | null = null;

/**
 * Lazily create the AudioContext. Browsers refuse to start one outside a user gesture, so
 * this is called first from the Start button's handler.
 */
function context(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    audioCtx ??= new Ctor();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    return audioCtx;
  } catch {
    return null;
  }
}

/** Call from a user gesture (the Start press) so later cues are allowed to sound. */
export function primeAudio(): void {
  context();
}

const TONES: Record<HapticPattern, { freq: number; ms: number }> = {
  tap: { freq: 660, ms: 40 },
  stage: { freq: 520, ms: 90 },
  extract: { freq: 780, ms: 160 },
  stop: { freq: 390, ms: 260 },
};

/** A short sine beep. Deliberately plain — no assets to load, works offline. */
export function beep(pattern: HapticPattern, enabled = true): void {
  if (!enabled) return;
  const ctx = context();
  if (!ctx) return;
  try {
    const { freq, ms } = TONES[pattern];
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    // Ramp instead of a hard stop, which would click.
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + ms / 1000);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + ms / 1000 + 0.02);
  } catch {
    /* ignore */
  }
}

/** Fire both channels for a transition. */
export function cue(
  pattern: HapticPattern,
  opts: { haptics?: boolean; sound?: boolean } = {},
): void {
  vibrate(pattern, opts.haptics ?? true);
  beep(pattern, opts.sound ?? true);
}
