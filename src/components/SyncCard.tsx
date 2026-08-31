import { useState } from 'react';
import { describeError, loadConfig, syncEngine } from '../db/sync/engine.ts';
import { describeLastSync, useSyncStatus } from '../hooks/useSync.ts';
import { BigButton, Button, Card, Field, SectionTitle, TextInput } from './ui.tsx';

/**
 * Sync setup.
 *
 * Framed throughout as optional, because it is: the app is offline-first and every screen works
 * with sync switched off. Nothing here is allowed to imply that shots are at risk without it.
 *
 * The flow is deliberately three visible steps — connect a project, sign in, then share a
 * household — because that is the actual shape of the thing, and hiding it behind one button
 * makes the inevitable "why isn't it syncing?" impossible to answer.
 */
export function SyncCard() {
  const status = useSyncStatus();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SectionTitle
        action={
          status.session ? (
            <StatusPill status={status} />
          ) : (
            <span className="text-[11px] uppercase tracking-wider text-crust-500">optional</span>
          )
        }
      >
        Sync between phones
      </SectionTitle>

      <Card className="mb-6 space-y-4">
        {!status.configured ? (
          <ProjectForm busy={busy} onSubmit={(config) => run(() => syncEngine.configure(config))} />
        ) : !status.session ? (
          <SignInForm
            busy={busy}
            onSignIn={(email, password) => run(() => syncEngine.signIn(email, password))}
            onSignUp={(email, password) => run(() => syncEngine.signUp(email, password))}
            onForget={() => run(() => syncEngine.configure(null))}
          />
        ) : (
          <SignedIn
            busy={busy}
            status={status}
            onSyncNow={() => run(() => syncEngine.syncNow())}
            onSignOut={() => run(() => syncEngine.signOut())}
            onJoin={(household) => run(() => syncEngine.joinHousehold(household))}
          />
        )}

        {(error ?? status.error) ? (
          <p className="rounded-lg border border-bad p-2 text-xs text-crust-200">
            {error ?? status.error}
          </p>
        ) : null}
      </Card>
    </>
  );
}

function StatusPill({ status }: { status: ReturnType<typeof useSyncStatus> }) {
  const label =
    status.phase === 'syncing'
      ? 'syncing…'
      : status.phase === 'error'
        ? 'error'
        : status.phase === 'offline'
          ? 'offline'
          : status.pending > 0
            ? `${status.pending} to send`
            : `synced ${describeLastSync(status.lastSyncedAt)}`;

  const tone =
    status.phase === 'error'
      ? 'border-bad text-bad'
      : status.phase === 'offline' || status.pending > 0
        ? 'border-warn text-warn'
        : 'border-good text-good';

  return (
    <span
      role="status"
      className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider ${tone}`}
    >
      {label}
    </span>
  );
}

function ProjectForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (config: { url: string; anonKey: string }) => void;
}) {
  const [url, setUrl] = useState('');
  const [anonKey, setAnonKey] = useState('');

  return (
    <div className="space-y-3">
      <p className="text-xs text-crust-400">
        Everything already works without this. Connect a free Supabase project and both phones can
        share one shot log — otherwise each keeps its own.
      </p>
      <Field label="Project URL" hint="Supabase → Settings → API.">
        <TextInput
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://xxxx.supabase.co"
          inputMode="url"
          autoCapitalize="none"
          spellCheck={false}
        />
      </Field>
      <Field
        label="Anon public key"
        hint="The anon key, not the service_role key. It's designed to be public — the database's own policies are what protect your data."
      >
        <TextInput
          value={anonKey}
          onChange={(e) => setAnonKey(e.target.value)}
          placeholder="eyJhbGciOi…"
          autoCapitalize="none"
          spellCheck={false}
        />
      </Field>
      <BigButton
        disabled={busy || !url.trim() || !anonKey.trim()}
        onClick={() => onSubmit({ url: url.trim(), anonKey: anonKey.trim() })}
      >
        {busy ? 'Connecting…' : 'Connect'}
      </BigButton>
      <p className="text-xs text-crust-500">
        Run <span className="font-mono">supabase/schema.sql</span> in the project's SQL editor first,
        or the first sync will be refused.
      </p>
    </div>
  );
}

function SignInForm({
  busy,
  onSignIn,
  onSignUp,
  onForget,
}: {
  busy: boolean;
  onSignIn: (email: string, password: string) => void;
  onSignUp: (email: string, password: string) => void;
  onForget: () => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const ready = !busy && email.trim().length > 0 && password.length >= 6;

  return (
    <div className="space-y-3">
      <p className="text-xs text-crust-400">
        Project connected. Sign in — or create an account on the first phone, then sign in with the
        same one on the second.
      </p>
      <Field label="Email">
        <TextInput
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoCapitalize="none"
          autoComplete="email"
          spellCheck={false}
        />
      </Field>
      <Field label="Password" hint="At least 6 characters.">
        <TextInput
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
      </Field>
      <BigButton disabled={!ready} onClick={() => onSignIn(email.trim(), password)}>
        {busy ? 'Signing in…' : 'Sign in'}
      </BigButton>
      <div className="flex gap-2">
        <Button
          variant="ghost"
          className="flex-1"
          disabled={!ready}
          onClick={() => onSignUp(email.trim(), password)}
        >
          Create account
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onForget}>
          Change project
        </Button>
      </div>
    </div>
  );
}

function SignedIn({
  busy,
  status,
  onSyncNow,
  onSignOut,
  onJoin,
}: {
  busy: boolean;
  status: ReturnType<typeof useSyncStatus>;
  onSyncNow: () => void;
  onSignOut: () => void;
  onJoin: (householdId: string) => void;
}) {
  const [joining, setJoining] = useState(false);
  const [household, setHousehold] = useState('');
  const config = loadConfig();
  const mine = status.session?.householdId ?? '';

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm text-crust-100">{status.session?.email}</p>
        <p className="text-xs text-crust-500">
          {new URL(config?.url ?? 'https://unknown').host} · last synced{' '}
          {describeLastSync(status.lastSyncedAt)}
          {status.pending > 0 ? ` · ${status.pending} waiting to send` : ''}
        </p>
      </div>

      <Field
        label="Household code"
        hint="Paste this into the other phone so both share one log. Treat it like a password — anyone with it can join."
      >
        <div className="flex gap-2">
          <TextInput readOnly value={mine} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
          <Button
            size="sm"
            className="shrink-0"
            onClick={() => void navigator.clipboard?.writeText(mine)}
          >
            Copy
          </Button>
        </div>
      </Field>

      {joining ? (
        <div className="space-y-2">
          <Field
            label="Join a household"
            hint="Shots already on this phone are kept and pushed into the household you join."
          >
            <TextInput
              value={household}
              onChange={(e) => setHousehold(e.target.value)}
              placeholder="paste the code from the other phone"
              autoCapitalize="none"
              spellCheck={false}
              className="font-mono text-xs"
            />
          </Field>
          <div className="flex gap-2">
            <Button
              variant="primary"
              className="flex-1"
              disabled={busy || household.trim().length < 8}
              onClick={() => {
                onJoin(household);
                setJoining(false);
                setHousehold('');
              }}
            >
              Join
            </Button>
            <Button variant="ghost" onClick={() => setJoining(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="ghost" className="w-full" onClick={() => setJoining(true)}>
          Join the other phone's household
        </Button>
      )}

      <div className="flex gap-2">
        <Button variant="secondary" className="flex-1" disabled={busy} onClick={onSyncNow}>
          {status.phase === 'syncing' ? 'Syncing…' : 'Sync now'}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onSignOut}>
          Sign out
        </Button>
      </div>
      <p className="text-xs text-crust-500">
        Signing out leaves every shot on this phone; it only stops them being sent.
      </p>
    </div>
  );
}
