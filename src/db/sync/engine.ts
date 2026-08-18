import { db, type EspressoDB } from '../schema.ts';
import { pendingCount, prunePending, syncOnce } from './outbox.ts';
import {
  SupabaseSync,
  type SupabaseConfig,
  type SupabaseFactory,
  type SyncSession,
} from './supabase.ts';

/**
 * Sync orchestration.
 *
 * The governing rule: **sync is never allowed to affect using the app.** Every failure is
 * caught and reported as status, never thrown at a screen and never blocking a write. The app
 * worked offline before sync existed and still does; this is an opportunistic background chore.
 *
 * Deliberately not realtime-subscribed. Push-on-change plus a poll while the app is open is
 * enough for two phones that are rarely used at the same moment, and it avoids holding a
 * websocket open on a device in someone's pocket.
 */

const CONFIG_KEY = 'espresso.sync.config.v1';
const WATERMARK_KEY = 'espresso.sync.watermark.v1';

/** How long after a local write to push, so a burst of edits becomes one request. */
export const PUSH_DEBOUNCE_MS = 2_000;
/** Poll interval while the app is open and signed in. */
export const POLL_INTERVAL_MS = 60_000;

export type SyncPhase = 'off' | 'idle' | 'syncing' | 'error' | 'offline';

export interface SyncStatus {
  phase: SyncPhase;
  session: SyncSession | null;
  configured: boolean;
  pending: number;
  lastSyncedAt: number | null;
  /** Human-readable, already safe to show; never a raw stack. */
  error: string | null;
}

type Listener = (status: SyncStatus) => void;

// --- Persisted config ------------------------------------------------------

/**
 * Stored locally rather than baked in at build time, so the same deployed site works for both
 * phones without a rebuild, and so no key needs to live in CI. The anon key is public by
 * design — see the note in supabase.ts.
 */
export function loadConfig(): SupabaseConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SupabaseConfig>;
      if (parsed.url && parsed.anonKey) return { url: parsed.url, anonKey: parsed.anonKey };
    }
  } catch {
    /* fall through to the build-time default */
  }

  // Optional build-time default, for convenience if you'd rather configure it once in CI.
  const url = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  return url && anonKey ? { url, anonKey } : null;
}

export function saveConfig(config: SupabaseConfig | null): void {
  try {
    if (config) localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    else localStorage.removeItem(CONFIG_KEY);
  } catch {
    /* ignore */
  }
}

function loadWatermark(): number {
  try {
    const raw = localStorage.getItem(WATERMARK_KEY);
    const value = raw === null ? 0 : Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

function saveWatermark(value: number): void {
  try {
    localStorage.setItem(WATERMARK_KEY, String(value));
  } catch {
    /* ignore */
  }
}

/**
 * Turns whatever went wrong into something worth showing a person.
 *
 * Supabase rejects with plain objects (`PostgrestError`, `AuthError`) rather than `Error`
 * instances, so a naive `String(err)` renders "[object Object]" — which is exactly the message a
 * user would have seen for a real permissions problem.
 */
export function describeError(err: unknown): string {
  const message = extractMessage(err);
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return "Can't reach the server. Your shots are saved on this phone and will sync later.";
  }
  if (/jwt|token|not signed in/i.test(message)) return 'Sign-in expired — sign in again.';
  if (/invalid login credentials/i.test(message)) return 'That email and password did not match.';
  if (/permission denied|row-level security/i.test(message)) {
    return 'The database refused the change. Check the schema and policies were applied.';
  }
  return message;
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const { message, error_description: description } = err as {
      message?: unknown;
      error_description?: unknown;
    };
    if (typeof message === 'string' && message) return message;
    if (typeof description === 'string' && description) return description;
  }
  return 'Something went wrong syncing.';
}

export class SyncEngine {
  private adapter: SupabaseSync | null = null;
  private listeners = new Set<Listener>();
  private pushTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  /** Set when a sync is requested while one is already in flight. */
  private queued = false;

  private status: SyncStatus = {
    phase: 'off',
    session: null,
    configured: false,
    pending: 0,
    lastSyncedAt: null,
    error: null,
  };

  private readonly pushDebounceMs: number;
  private readonly pollIntervalMs: number;

  /**
   * `clientFactory` exists so the tests can drive a real engine against an in-memory Supabase
   * stand-in; the timings are injectable so they can be tested in real time rather than with fake
   * timers, which deadlock against IndexedDB's own use of the timer queue.
   */
  constructor(
    private readonly dbi: EspressoDB = db,
    private readonly clientFactory?: SupabaseFactory,
    options: { pushDebounceMs?: number; pollIntervalMs?: number } = {},
  ) {
    this.pushDebounceMs = options.pushDebounceMs ?? PUSH_DEBOUNCE_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  private emit(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const listener of this.listeners) listener(this.status);
  }

  private async refreshPending(): Promise<void> {
    try {
      this.emit({ pending: await pendingCount(this.dbi) });
    } catch {
      /* a count is not worth failing over */
    }
  }

  /**
   * Wires up the engine. Restores an existing session if there is one, then starts the
   * background schedule. Never throws — a broken config leaves the app fully usable.
   */
  async start(): Promise<void> {
    const config = loadConfig();
    this.emit({ configured: config !== null });
    // Clears entries left by an older version for tables that no longer sync.
    await prunePending(this.dbi).catch(() => 0);
    await this.refreshPending();
    if (!config) return;

    this.adapter = new SupabaseSync(config, this.clientFactory);
    try {
      const session = await this.adapter.restore();
      this.emit({ session, phase: session ? 'idle' : 'off', error: null });
      if (session) {
        this.schedulePolling();
        void this.syncNow();
      }
    } catch (err) {
      this.emit({ phase: 'error', error: describeError(err) });
    }
  }

  /** Rebuilds the adapter after the URL or key changes. */
  async configure(config: SupabaseConfig | null): Promise<void> {
    saveConfig(config);
    this.stopTimers();
    this.adapter = config ? new SupabaseSync(config, this.clientFactory) : null;
    this.emit({
      configured: config !== null,
      session: null,
      phase: 'off',
      error: null,
    });
    if (config) await this.start();
  }

  private requireAdapter(): SupabaseSync {
    if (!this.adapter) throw new Error('Sync is not configured yet.');
    return this.adapter;
  }

  async signIn(email: string, password: string): Promise<void> {
    const session = await this.requireAdapter().signIn(email, password);
    this.emit({ session, phase: 'idle', error: null });
    this.schedulePolling();
    await this.syncNow();
  }

  async signUp(email: string, password: string): Promise<void> {
    const session = await this.requireAdapter().signUp(email, password);
    this.emit({ session, phase: 'idle', error: null });
    this.schedulePolling();
    await this.syncNow();
  }

  async signOut(): Promise<void> {
    this.stopTimers();
    try {
      await this.requireAdapter().signOut();
    } finally {
      // Local data is untouched by signing out — it lives on the device either way.
      this.emit({ session: null, phase: 'off', error: null });
    }
  }

  async joinHousehold(householdId: string): Promise<void> {
    const session = await this.requireAdapter().joinHousehold(householdId.trim());
    // The watermark belongs to the old household; keep it and this device would never pull the
    // new household's existing history.
    saveWatermark(0);
    this.emit({ session, error: null });
    await this.syncNow();
  }

  /**
   * Runs one sync cycle. Resolves even on failure — the outcome is in the status.
   *
   * Overlapping calls collapse: a request arriving mid-flight sets a flag and one more cycle
   * runs afterwards, rather than two cycles racing on the same outbox.
   */
  async syncNow(): Promise<void> {
    if (!this.adapter || !this.status.session) return;
    if (this.running) {
      this.queued = true;
      return;
    }

    this.running = true;
    this.emit({ phase: 'syncing', error: null });

    try {
      const since = loadWatermark();
      const result = await syncOnce(this.adapter, since, this.dbi);
      saveWatermark(result.watermark);
      this.emit({ phase: 'idle', lastSyncedAt: Date.now(), error: null });
    } catch (err) {
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      this.emit({ phase: offline ? 'offline' : 'error', error: describeError(err) });
    } finally {
      this.running = false;
      await this.refreshPending();
      if (this.queued) {
        this.queued = false;
        void this.syncNow();
      }
    }
  }

  /** Called after a local write. Debounced, so logging a shot doesn't fire a request per field. */
  notifyLocalChange(): void {
    void this.refreshPending();
    if (!this.status.session) return;
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => void this.syncNow(), this.pushDebounceMs);
  }

  private schedulePolling(): void {
    this.stopTimers();
    this.pollTimer = setInterval(() => {
      // Pointless while hidden or offline; the visibility and online handlers cover coming back.
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      void this.syncNow();
    }, this.pollIntervalMs);
  }

  private stopTimers(): void {
    clearTimeout(this.pushTimer);
    clearInterval(this.pollTimer);
    this.pushTimer = undefined;
    this.pollTimer = undefined;
  }

  /** Sync when the app comes back to the foreground or the network returns. */
  attachWindowListeners(): () => void {
    const onWake = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void this.syncNow();
    };
    const onOnline = () => void this.syncNow();

    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('online', onOnline);
    };
  }

  dispose(): void {
    this.stopTimers();
    this.listeners.clear();
  }
}

/** The app's single engine. */
export const syncEngine = new SyncEngine();
