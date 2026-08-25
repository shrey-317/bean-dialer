import { useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';

/**
 * Shared UI primitives.
 *
 * Sizing here is deliberate rather than decorative: this app gets used standing at a machine,
 * one-handed, often with damp fingers, reading from arm's length. So interactive targets are
 * at least 56 px tall, numbers are large and tabular, and nothing important depends on colour
 * alone.
 */

export function Card({
  children,
  className = '',
  as: Tag = 'div',
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'section' | 'li';
}) {
  return (
    <Tag className={`rounded-2xl border border-crust-800 bg-crust-900 p-4 ${className}`}>
      {children}
    </Tag>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-3">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-crust-400">{children}</h2>
      {action}
    </div>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-crust-100 text-crust-950 active:bg-crust-200',
  secondary: 'bg-crust-800 text-crust-100 active:bg-crust-700',
  ghost: 'bg-transparent text-crust-200 border border-crust-700 active:bg-crust-800',
  danger: 'bg-bad text-white active:opacity-90',
};

/**
 * Size is a prop rather than something callers override with a class. Passing `min-h-10` in
 * `className` looks like it should win but doesn't: both utilities have the same specificity, so
 * whichever Tailwind emits later wins regardless of the order they appear in the attribute.
 */
type ButtonSize = 'sm' | 'md' | 'lg';

const SIZES: Record<ButtonSize, string> = {
  sm: 'min-h-10 px-3 text-sm',
  md: 'min-h-14 px-5 text-base',
  lg: 'min-h-16 px-5 text-lg tracking-wide',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return (
    <button
      className={`rounded-xl font-semibold transition-colors disabled:opacity-40 ${SIZES[size]} ${VARIANTS[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Full-width, unmissable. Used for the one action a screen exists to perform. */
export function BigButton({
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <Button
      {...rest}
      size="lg"
      className={`w-full ${className}`}
      variant={rest.variant ?? 'primary'}
    >
      {children}
    </Button>
  );
}

export function StatTile({
  label,
  value,
  unit,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string | number;
  unit?: string;
  hint?: string;
  tone?: 'neutral' | 'good' | 'warn' | 'bad';
}) {
  const toneClass =
    tone === 'good'
      ? 'text-good'
      : tone === 'warn'
        ? 'text-warn'
        : tone === 'bad'
          ? 'text-bad'
          : 'text-crust-50';
  return (
    <div className="rounded-xl border border-crust-800 bg-crust-900 p-3">
      <div className="text-[11px] font-medium uppercase tracking-wider text-crust-400">{label}</div>
      <div className={`tnum mt-1 text-2xl font-semibold leading-none ${toneClass}`}>
        {value}
        {unit ? <span className="ml-1 text-sm font-normal text-crust-400">{unit}</span> : null}
      </div>
      {hint ? <div className="mt-1 text-[11px] text-crust-500">{hint}</div> : null}
    </div>
  );
}

export function Chip({
  active,
  children,
  onClick,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`min-h-11 rounded-full border px-4 text-sm font-medium transition-colors ${
        active
          ? 'border-crust-100 bg-crust-100 text-crust-950'
          : 'border-crust-700 bg-transparent text-crust-200'
      }`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wider text-crust-400">
        {label}
      </span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] text-crust-500">{hint}</span> : null}
    </label>
  );
}

export function TextInput({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`min-h-14 w-full rounded-xl border border-crust-700 bg-crust-950 px-4 text-base text-crust-50 outline-none focus:border-crust-400 ${className}`}
      {...rest}
    />
  );
}

/** Shared by `Stepper` and `Keypad` so both round/bound a typed or stepped value the same way. */
export function clampNumeric(
  n: number,
  { min, max, decimals = 1 }: { min?: number; max?: number; decimals?: number },
): number {
  const bounded = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
  // Re-round after arithmetic so 16.5 + 0.5 shows as 17, not 16.999999999999998.
  return Number(bounded.toFixed(Math.max(decimals, 0)));
}

/**
 * Numeric entry with big +/- buttons flanking a real number input.
 *
 * Three routes in, all landing on the same `onChange`: the +/- buttons for one-handed
 * adjustment at the machine, tapping the number to open the `Keypad` (the primary route on a
 * phone), and typing directly into the input for anything that reads or scripts it — a
 * Bluetooth keyboard, an accessibility tool, or Playwright's `.fill()` in the e2e suite.
 * `inputMode="none"` only suppresses the OS's own on-screen keyboard; it changes nothing about
 * that third route.
 */
export function Stepper({
  value,
  onChange,
  step = 0.5,
  min,
  max,
  unit,
  decimals = 1,
  label,
}: {
  value: number;
  onChange: (next: number) => void;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  decimals?: number;
  label: string;
}) {
  const [keypadOpen, setKeypadOpen] = useState(false);
  const clamp = (n: number) => clampNumeric(n, { min, max, decimals });

  return (
    <div className="flex items-stretch gap-2">
      <Button
        type="button"
        aria-label={`Decrease ${label}`}
        onClick={() => onChange(clamp(value - step))}
        // 56px keeps a comfortable thumb target while leaving the value room to breathe.
        className="w-14 shrink-0 px-0 text-2xl"
      >
        −
      </Button>
      {/* `min-w-0` is what stops the value being squeezed to nothing by the two buttons when a
          stepper sits in a narrow column. */}
      <div className="relative min-w-0 flex-1">
        <input
          // Not readOnly/disabled — Playwright's `.fill()` requires an editable input, and a
          // real Bluetooth keyboard should still just work. `onClick` (not `onFocus`) is what
          // opens the keypad, and `.fill()` never dispatches a click, so the e2e suite bypasses
          // the overlay entirely and sets the value directly, same as before.
          inputMode="none"
          aria-label={label}
          value={Number.isFinite(value) ? value.toFixed(decimals) : ''}
          onClick={() => setKeypadOpen(true)}
          onChange={(e) => {
            const next = Number.parseFloat(e.target.value);
            if (!Number.isNaN(next)) onChange(clamp(next));
          }}
          className={`tnum min-h-14 w-full rounded-xl border border-crust-700 bg-crust-950 text-center text-2xl font-semibold text-crust-50 outline-none focus:border-crust-400 ${
            unit ? 'pl-4 pr-7' : 'px-3'
          }`}
        />
        {unit ? (
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-sm text-crust-500">
            {unit}
          </span>
        ) : null}
      </div>
      <Button
        type="button"
        aria-label={`Increase ${label}`}
        onClick={() => onChange(clamp(value + step))}
        className="w-14 shrink-0 px-0 text-2xl"
      >
        +
      </Button>
      {keypadOpen ? (
        <Keypad
          label={label}
          unit={unit}
          value={value}
          min={min}
          max={max}
          decimals={decimals}
          onCommit={onChange}
          onClose={() => setKeypadOpen(false)}
        />
      ) : null}
    </div>
  );
}

const KEYPAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'] as const;

/**
 * A purpose-built on-screen numeric keypad, standing in for the OS's own decimal keyboard.
 *
 * The typed buffer starts empty rather than pre-loaded with `value` — the first digit tapped
 * always starts a fresh number, so there's no separate "clear" step before correcting a
 * misread scale value. `value` itself only shows as a dimmed placeholder until something is
 * typed.
 */
export function Keypad({
  label,
  unit,
  value,
  min,
  max,
  decimals = 1,
  onCommit,
  onClose,
}: {
  label: string;
  unit?: string;
  value: number;
  min?: number;
  max?: number;
  decimals?: number;
  onCommit: (next: number) => void;
  onClose: () => void;
}) {
  const [buffer, setBuffer] = useState('');

  const press = (key: (typeof KEYPAD_KEYS)[number]) => {
    if (key === '⌫') {
      setBuffer((b) => b.slice(0, -1));
    } else if (key === '.') {
      if (decimals > 0 && !buffer.includes('.')) setBuffer((b) => b + key);
    } else {
      setBuffer((b) => b + key);
    }
  };

  const commit = () => {
    // Nothing typed: closing without a change is expected, not an error — the field just
    // keeps whatever it already had.
    if (buffer !== '') {
      const parsed = Number.parseFloat(buffer);
      if (!Number.isNaN(parsed)) onCommit(clampNumeric(parsed, { min, max, decimals }));
    }
    onClose();
  };

  return (
    <Sheet label={`Edit ${label}`} onClose={onClose}>
      <div className="text-center">
        <div className="text-xs font-semibold uppercase tracking-widest text-crust-400">
          {label}
        </div>
        <div className="tnum mt-1 text-4xl font-bold leading-none text-crust-50">
          {buffer !== '' ? buffer : <span className="text-crust-600">{value.toFixed(decimals)}</span>}
          {unit ? <span className="ml-1 text-lg font-normal text-crust-500">{unit}</span> : null}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {KEYPAD_KEYS.map((key) => (
          <Button
            key={key}
            type="button"
            variant="secondary"
            disabled={key === '.' && decimals === 0}
            aria-label={key === '⌫' ? 'Backspace' : key === '.' ? 'Decimal point' : key}
            onClick={() => press(key)}
            className="min-h-16 text-2xl"
          >
            {key}
          </Button>
        ))}
      </div>

      <div className="flex gap-2">
        <Button variant="ghost" className="flex-1" onClick={onClose}>
          Cancel
        </Button>
        <BigButton className="flex-1" onClick={commit}>
          Done
        </BigButton>
      </div>
    </Sheet>
  );
}

/**
 * A bottom sheet: backdrop tap-to-close plus a rounded panel anchored to the bottom edge.
 * `Keypad` is built on this; anything else that needs a modal on a phone screen should be too,
 * rather than reinventing the backdrop/safe-area handling.
 */
export function Sheet({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-30 flex items-end" role="dialog" aria-label={label}>
      <button
        type="button"
        aria-label="Cancel"
        onClick={onClose}
        className="absolute inset-0 bg-black/50"
      />
      <div className="relative w-full space-y-4 rounded-t-2xl border-t border-crust-800 bg-crust-900 p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
        {children}
      </div>
    </div>
  );
}

export function Rating({
  value,
  onChange,
}: {
  value: number | undefined;
  onChange: (next: number | undefined) => void;
}) {
  return (
    <div className="flex gap-2" role="group" aria-label="Rating">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          aria-label={`${n} out of 5`}
          aria-pressed={value === n}
          onClick={() => onChange(value === n ? undefined : n)}
          className={`h-12 flex-1 rounded-xl border text-base font-semibold ${
            value !== undefined && n <= value
              ? 'border-crust-100 bg-crust-100 text-crust-950'
              : 'border-crust-700 text-crust-400'
          }`}
        >
          {n}
        </button>
      ))}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex min-h-14 w-full items-center justify-between gap-4 rounded-xl border border-crust-800 bg-crust-900 px-4 text-left"
    >
      <span>
        <span className="block text-base font-medium text-crust-100">{label}</span>
        {hint ? <span className="block text-xs text-crust-500">{hint}</span> : null}
      </span>
      <span
        className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${
          checked ? 'bg-good' : 'bg-crust-700'
        }`}
      >
        <span
          className={`absolute top-1 h-5 w-5 rounded-full bg-white transition-all ${
            checked ? 'left-6' : 'left-1'
          }`}
        />
      </span>
    </button>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-crust-700 p-6 text-center">
      <h3 className="text-base font-semibold text-crust-100">{title}</h3>
      <p className="mx-auto mt-1 max-w-sm text-sm text-crust-400">{body}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
