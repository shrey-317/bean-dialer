import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { BigButton, Button, Card, Chip, Field, SectionTitle, Stepper, Toggle } from '../components/ui.tsx';
import { SyncCard } from '../components/SyncCard.tsx';
import { downloadFile, exportBackup, exportShotsCsv, importBackup } from '../db/backup.ts';
import { settingsRepo } from '../db/repo/settings.ts';
import type { Targets, TimingBasis } from '../domain/types.ts';
import { useSettings } from '../hooks/data.ts';
import { canVibrate } from '../platform/haptics.ts';
import { isIos, useInstall } from '../platform/install.ts';
import { wakeLockSupported } from '../platform/wakeLock.ts';

const BASIS: { value: TimingBasis; label: string; hint: string }[] = [
  {
    value: 'extraction',
    label: 'Extraction only',
    hint: 'Times the pull after pre-infusion ends — the part the grind governs.',
  },
  { value: 'total', label: 'Whole pull', hint: 'Includes pre-infusion, like a wall clock.' },
  { value: 'first-drip', label: 'To first drip', hint: 'Judges puck resistance instead of shot length.' },
];

export function SettingsScreen() {
  const settings = useSettings();
  const [status, setStatus] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  if (!settings) {
    return <p className="mt-8 text-center text-sm text-crust-500">Loading…</p>;
  }

  const targets = settings.defaultTargets;
  const setTargets = (patch: Partial<Targets>) =>
    void settingsRepo.update({ defaultTargets: { ...targets, ...patch } });

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xs font-semibold uppercase tracking-[0.2em] text-crust-500">Setup</h1>
        <Link to="/gear" className="text-xs text-crust-500 underline">
          Gear
        </Link>
      </div>

      <InstallCard />

      <SyncCard />

      <SectionTitle>Default recipe</SectionTitle>
      <Card className="mb-6 space-y-3">
        <p className="text-xs text-crust-500">
          Used for new sessions. Changing these leaves sessions already in progress alone.
        </p>
        <div className="space-y-3">
          <Field label="Dose">
            <Stepper label="Dose" value={targets.doseG} onChange={(v) => setTargets({ doseG: v })} step={0.5} min={0} unit="g" />
          </Field>
          <Field label="Yield">
            <Stepper label="Yield" value={targets.yieldG} onChange={(v) => setTargets({ yieldG: v })} step={1} min={0} unit="g" />
          </Field>
        </div>
        <Field label="Brew temperature">
          <Stepper
            label="Brew temperature"
            value={targets.tempC}
            onChange={(v) => setTargets({ tempC: v })}
            step={1}
            decimals={0}
            unit="°C"
          />
        </Field>
        <div className="space-y-3">
          <Field label="Target min">
            <Stepper
              label="Target minimum seconds"
              value={targets.timeWindowSec[0]}
              onChange={(v) => setTargets({ timeWindowSec: [v, targets.timeWindowSec[1]] })}
              step={1}
              min={0}
              decimals={0}
              unit="s"
            />
          </Field>
          <Field label="Target max">
            <Stepper
              label="Target maximum seconds"
              value={targets.timeWindowSec[1]}
              onChange={(v) => setTargets({ timeWindowSec: [targets.timeWindowSec[0], v] })}
              step={1}
              min={0}
              decimals={0}
              unit="s"
            />
          </Field>
        </div>
      </Card>

      <SectionTitle>What the target time measures</SectionTitle>
      <Card className="mb-6">
        <div className="flex flex-wrap gap-2">
          {BASIS.map(({ value, label }) => (
            <Chip
              key={value}
              active={targets.timingBasis === value}
              onClick={() => setTargets({ timingBasis: value })}
            >
              {label}
            </Chip>
          ))}
        </div>
        <p className="mt-2 text-xs text-crust-500">
          {BASIS.find((b) => b.value === targets.timingBasis)?.hint}
        </p>
      </Card>

      <SectionTitle>During a shot</SectionTitle>
      <div className="mb-6 space-y-2">
        <Toggle
          checked={settings.soundEnabled}
          onChange={(v) => void settingsRepo.update({ soundEnabled: v })}
          label="Sound on stage changes"
          hint="A tone when pre-infusion ends and extraction begins."
        />
        <Toggle
          checked={settings.hapticsEnabled}
          onChange={(v) => void settingsRepo.update({ hapticsEnabled: v })}
          label="Vibrate on stage changes"
          hint={
            canVibrate()
              ? 'Buzzes at each transition.'
              : 'This browser has no vibration API — iPhones never buzz, so the tone and colour carry it.'
          }
        />
        <Toggle
          checked={settings.keepAwakeDuringShot}
          onChange={(v) => void settingsRepo.update({ keepAwakeDuringShot: v })}
          label="Keep the screen awake"
          hint={
            wakeLockSupported()
              ? 'Holds the screen on while a shot is running.'
              : 'Not supported in this browser; the screen may dim mid-shot.'
          }
        />
      </div>

      <SectionTitle>Your data</SectionTitle>
      <Card className="mb-6 space-y-3">
        <p className="text-xs text-crust-500">
          Shots are stored on this phone first and always work offline. Export is a backup you hold
          yourself — worth having whether or not sync is switched on.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Button
            onClick={async () => {
              const backup = await exportBackup();
              downloadFile(
                `espresso-backup-${new Date().toISOString().slice(0, 10)}.json`,
                JSON.stringify(backup, null, 2),
                'application/json',
              );
              setStatus('Backup downloaded.');
            }}
          >
            Export JSON
          </Button>
          <Button
            onClick={async () => {
              downloadFile(
                `espresso-shots-${new Date().toISOString().slice(0, 10)}.csv`,
                await exportShotsCsv(),
                'text/csv',
              );
              setStatus('Shot log downloaded.');
            }}
          >
            Export CSV
          </Button>
        </div>

        <Button variant="ghost" className="w-full" onClick={() => fileRef.current?.click()}>
          Import a backup
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
              const result = await importBackup(JSON.parse(await file.text()));
              setStatus(
                `Imported ${result.beans} beans, ${result.gear} gear, ${result.sessions} sessions, ${result.shots} shots.`,
              );
            } catch (err) {
              setStatus(err instanceof Error ? err.message : 'That file could not be read.');
            } finally {
              // Allow re-picking the same file after a failure.
              e.target.value = '';
            }
          }}
        />
        <p className="text-xs text-crust-500">
          Importing merges rather than replaces — where a shot exists in both, the more recently
          edited one wins.
        </p>
        {status ? <p className="text-xs font-medium text-crust-200">{status}</p> : null}
      </Card>
    </>
  );
}

/** Install offer, which has to be entirely different on the two platforms. */
function InstallCard() {
  const { mode, install } = useInstall();
  if (mode === 'installed') return null;

  return (
    <Card className="mb-6">
      <SectionTitle>Install on your phone</SectionTitle>
      {mode === 'prompt' ? (
        <>
          <p className="mb-3 text-xs text-crust-400">
            Adds it to your home screen and runs it full-screen and offline.
          </p>
          <BigButton onClick={() => void install()}>Install app</BigButton>
        </>
      ) : mode === 'ios-instructions' || isIos() ? (
        <ol className="space-y-1.5 text-xs text-crust-300">
          <li>
            1. Tap the <span className="font-semibold">Share</span> button in Safari's toolbar.
          </li>
          <li>
            2. Choose <span className="font-semibold">Add to Home Screen</span>.
          </li>
          <li>3. Open it from the home screen — it then runs full-screen and works offline.</li>
          <li className="pt-1 text-crust-500">
            Safari has no one-tap install, so this is the only route on iPhone. It must be Safari:
            other iOS browsers can't add to the home screen.
          </li>
        </ol>
      ) : (
        <p className="text-xs text-crust-400">
          Open this page on your phone to install it. On Android use Chrome's install button; on
          iPhone use Safari's Share → Add to Home Screen.
        </p>
      )}
    </Card>
  );
}
