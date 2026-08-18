import type { Advice } from '../domain/types.ts';
import { Button } from './ui.tsx';

/**
 * The coach's verdict, rendered as the most prominent thing on the screen after a shot.
 *
 * The action is never applied automatically — the app suggests, you decide, and the shot log
 * records which you did (`suggestionFollowed`). That keeps the history honest about whether
 * the advice was actually tested.
 */

const TONE: Record<Advice['action']['kind'], { border: string; text: string; label: string }> = {
  grind: { border: 'border-warn', text: 'text-warn', label: 'Adjust the grind' },
  temp: { border: 'border-warn', text: 'text-warn', label: 'Adjust temperature' },
  hold: { border: 'border-crust-600', text: 'text-crust-200', label: 'Hold and repeat' },
  'lock-in': { border: 'border-good', text: 'text-good', label: 'Dialled in' },
  reshoot: { border: 'border-bad', text: 'text-bad', label: 'Pull again' },
  none: { border: 'border-crust-700', text: 'text-crust-300', label: 'Getting started' },
};

export function AdviceCard({
  advice,
  onApply,
  onDismiss,
  applying = false,
}: {
  advice: Advice;
  /** Apply the suggested dial (or lock in). Omitted where there's nothing to apply to. */
  onApply?: (advice: Advice) => void;
  onDismiss?: () => void;
  applying?: boolean;
}) {
  const tone = TONE[advice.action.kind];
  const canApply =
    onApply !== undefined &&
    (advice.action.kind === 'grind' || advice.action.kind === 'lock-in') &&
    advice.action.newDial !== undefined;

  return (
    <section className={`rounded-2xl border-2 bg-crust-900 p-4 ${tone.border}`} aria-live="polite">
      <div className="flex items-center justify-between gap-3">
        <span className={`text-[11px] font-bold uppercase tracking-widest ${tone.text}`}>
          {tone.label}
        </span>
        <span className="text-[11px] uppercase tracking-wider text-crust-500">
          {advice.confidence} confidence
        </span>
      </div>

      <h2 className="mt-2 text-2xl font-bold leading-tight text-crust-50">{advice.headline}</h2>
      <p className="mt-2 text-sm leading-relaxed text-crust-300">{advice.reason}</p>

      {advice.notes.length > 0 ? (
        <ul className="mt-3 space-y-1.5 border-t border-crust-800 pt-3">
          {advice.notes.map((note) => (
            <li key={note} className="flex gap-2 text-xs leading-relaxed text-crust-400">
              <span aria-hidden className="text-crust-600">
                ▸
              </span>
              <span>{note}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {canApply || onDismiss ? (
        <div className="mt-4 flex gap-2">
          {canApply ? (
            <Button
              variant="primary"
              className="flex-1"
              disabled={applying}
              onClick={() => onApply?.(advice)}
            >
              {advice.action.kind === 'lock-in'
                ? `Lock in ${advice.action.newDial}`
                : `Set dial to ${advice.action.newDial}`}
            </Button>
          ) : null}
          {onDismiss ? (
            <Button variant="ghost" className={canApply ? '' : 'flex-1'} onClick={onDismiss}>
              {canApply ? 'Not now' : 'Got it'}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
