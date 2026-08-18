import { useEffect, useState } from 'react';

/**
 * Home-screen install, which works completely differently on the two platforms this app
 * targets:
 *
 * - **Android / Chrome** fires `beforeinstallprompt`, which can be stashed and replayed from
 *   a button press. That gives a real one-tap install.
 * - **iOS / Safari** has no such event and no programmatic install at all. The only route is
 *   Share → "Add to Home Screen", so the honest thing is to show those instructions.
 *
 * Both cases are exposed through one hook so the UI has a single shape to render.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallMode = 'prompt' | 'ios-instructions' | 'installed' | 'unavailable';

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone;
  return window.matchMedia('(display-mode: standalone)').matches || iosStandalone === true;
}

export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  // iPadOS 13+ reports as Macintosh, distinguished by touch support.
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

export function useInstall(): {
  mode: InstallMode;
  install: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
} {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(() => isStandalone());

  useEffect(() => {
    const onPrompt = (e: Event) => {
      // Chrome shows its own mini-infobar unless the event is prevented; we want the
      // install offer to live in Settings, where it isn't in the way of pulling a shot.
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };

    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const mode: InstallMode = installed
    ? 'installed'
    : deferred
      ? 'prompt'
      : isIos()
        ? 'ios-instructions'
        : 'unavailable';

  return {
    mode,
    async install() {
      if (!deferred) return 'unavailable';
      await deferred.prompt();
      const { outcome } = await deferred.userChoice;
      // The event is single-use: Chrome will fire a fresh one if still installable.
      setDeferred(null);
      return outcome;
    },
  };
}
