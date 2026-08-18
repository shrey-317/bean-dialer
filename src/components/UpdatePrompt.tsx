import { useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { Button } from './ui.tsx';

/**
 * Service-worker update notice.
 *
 * The worker is registered with `autoUpdate`, but a page that swaps itself out mid-shot would
 * be actively hostile — so the new version waits behind a button the user presses when they
 * are not busy. The offline-ready confirmation is worth showing once, because "does this work
 * without signal in my kitchen?" is the question a PWA has to answer.
 */
export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW();
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!offlineReady) return;
    const t = setTimeout(() => setOfflineReady(false), 4000);
    return () => clearTimeout(t);
  }, [offlineReady, setOfflineReady]);

  if (dismissed && !needRefresh) return null;
  if (!needRefresh && !offlineReady) return null;

  return (
    <div
      role="status"
      className="sticky top-0 z-30 mx-4 mt-2 flex items-center gap-3 rounded-xl border border-crust-700 bg-crust-800 px-4 py-3 text-sm"
    >
      {needRefresh ? (
        <>
          <span className="flex-1 text-crust-100">A new version is ready.</span>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void updateServiceWorker(true)}
          >
            Reload
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setNeedRefresh(false);
              setDismissed(true);
            }}
          >
            Later
          </Button>
        </>
      ) : (
        <span className="flex-1 text-crust-200">Ready to use offline.</span>
      )}
    </div>
  );
}
