import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.tsx';
import { onLocalWrite } from './db/repo/base.ts';
import { seedIfEmpty } from './db/seed.ts';
import { syncEngine } from './db/sync/engine.ts';
import './styles.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root missing from index.html');


/**
 * `import.meta.env.BASE_URL` comes from vite.config's `base`, so the router basename can
 * never drift from the deployed subpath. Trailing slash is stripped: React Router wants
 * '/Home-Manager', Vite gives '/Home-Manager/'.
 */
const basename = import.meta.env.BASE_URL.replace(/\/$/, '');

function render() {
  createRoot(rootEl!).render(
    <StrictMode>
      <BrowserRouter basename={basename}>
        <App />
      </BrowserRouter>
    </StrictMode>,
  );
}

/**
 * Seed before the first paint, so the app never flashes an empty state it is about to fill.
 *
 * Deliberately a promise chain rather than top-level await: TLA would force the build target
 * up to browsers that support it, and this needs to run on the Safari version already on the
 * phone. A failure is not fatal either — private-mode Safari can refuse IndexedDB outright —
 * so we render regardless and let each screen show its own empty state.
 */
seedIfEmpty()
  .catch((err: unknown) => {
    console.error('Could not prepare the local database', err);
  })
  .finally(() => {
    render();
    startSync();
  });

/**
 * Sync is started *after* the first render and never awaited, because it is optional: an
 * unconfigured project, an expired session or a dead network must all leave the app exactly as
 * usable as it was before sync existed. The engine catches its own failures and reports them as
 * status on the Setup screen.
 */
function startSync() {
  onLocalWrite(() => syncEngine.notifyLocalChange());
  syncEngine.attachWindowListeners();
  void syncEngine.start();
}
