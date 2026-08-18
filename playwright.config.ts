import { defineConfig, devices } from '@playwright/test';
import { chromiumLaunchOptions } from './scripts/chromium.mjs';

/**
 * The e2e suite runs against a production build served by `vite preview`, not the dev
 * server, because the service worker (and therefore the offline test) only exists in a
 * real build. BASE_PATH=/ keeps preview URLs at the root so specs can navigate to '/'.
 */
const PORT = 4173;
/** Where the fake Supabase project listens; the sync spec points the app at it. */
export const STUB_PORT = 54_321;

export default defineConfig({
  testDir: './e2e',
  // Each spec drives a multi-second shot through the real UI, so the 30s default is tight once
  // several run in parallel.
  timeout: 90_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  // Both projects run on Chromium: the point is to exercise the two viewport sizes the app
  // will actually be installed on, not to test WebKit's rendering.
  projects: [
    {
      name: 'pixel',
      use: { ...devices['Pixel 7'], launchOptions: chromiumLaunchOptions() },
    },
    {
      name: 'iphone',
      use: {
        ...devices['iPhone 14'],
        defaultBrowserType: 'chromium',
        launchOptions: chromiumLaunchOptions(),
      },
    },
  ],
  webServer: [
    {
      command: 'BASE_PATH=/ npm run build && BASE_PATH=/ npx vite preview --port ' + PORT,
      port: PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
    {
      // Stands in for a Supabase project so the sync spec can prove two devices converge.
      // See e2e/stub-supabase.mjs for what it does and does not model.
      command: `STUB_PORT=${STUB_PORT} node e2e/stub-supabase.mjs`,
      port: STUB_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
