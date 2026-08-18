import { lazy, Suspense } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { UpdatePrompt } from './components/UpdatePrompt.tsx';
import { Beans } from './screens/Beans.tsx';
import { Gear } from './screens/Gear.tsx';
import { Home } from './screens/Home.tsx';
import { SettingsScreen } from './screens/Settings.tsx';
import { TimerScreen } from './screens/Timer.tsx';

/**
 * The charting library is roughly two thirds of the bundle and is only needed on the two
 * screens that plot anything. Splitting it out keeps the path that actually matters — open the
 * app, pull a shot, log it — small and fast, which is the whole point on a phone in a kitchen.
 * Both chunks are precached by the service worker, so they're still available offline.
 */
const Analytics = lazy(() =>
  import('./screens/Analytics.tsx').then((m) => ({ default: m.Analytics })),
);
const BeanDetail = lazy(() =>
  import('./screens/BeanDetail.tsx').then((m) => ({ default: m.BeanDetail })),
);

/**
 * Five destinations, bottom-anchored, because this is a phone app used one-handed. The timer
 * sits in the middle and is visually the loudest: it's the thing you open while standing at
 * the machine, and everything else is read afterwards.
 */
const NAV = [
  { to: '/', label: 'Home', icon: '⌂' },
  { to: '/beans', label: 'Beans', icon: '◗' },
  { to: '/timer', label: 'Pull', icon: '⏱', primary: true },
  { to: '/stats', label: 'Stats', icon: '◫' },
  { to: '/settings', label: 'Setup', icon: '⚙' },
] as const;

export default function App() {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-lg flex-col">
      <UpdatePrompt />

      <main className="flex-1 px-4 pb-28 pt-[calc(var(--safe-top)+1rem)]">
        <Suspense fallback={<p className="mt-8 text-center text-sm text-crust-500">Loading…</p>}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/timer" element={<TimerScreen />} />
            <Route path="/beans" element={<Beans />} />
            <Route path="/beans/:beanId" element={<BeanDetail />} />
            <Route path="/gear" element={<Gear />} />
            <Route path="/stats" element={<Analytics />} />
            <Route path="/settings" element={<SettingsScreen />} />
            {/* Unknown deep links land on Home rather than a dead end — an installed app has
                no address bar to correct a bad URL with. */}
            <Route path="*" element={<Home />} />
          </Routes>
        </Suspense>
      </main>

      <nav
        className="fixed inset-x-0 bottom-0 z-20 border-t border-crust-800 bg-crust-950/95 backdrop-blur"
        style={{ paddingBottom: 'var(--safe-bottom)' }}
      >
        <ul className="mx-auto flex max-w-lg items-stretch">
          {NAV.map((item) => (
            <li key={item.to} className="flex-1">
              <NavLink
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  `flex min-h-16 flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${
                    isActive ? 'text-crust-50' : 'text-crust-500'
                  }`
                }
              >
                <span
                  aria-hidden
                  className={
                    'primary' in item && item.primary
                      ? 'flex h-9 w-9 items-center justify-center rounded-full bg-crust-100 text-lg text-crust-950'
                      : 'text-lg leading-none'
                  }
                >
                  {item.icon}
                </span>
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
