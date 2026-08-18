import { expect, test } from '@playwright/test';
import { gotoFresh, nav, pullShot, settle } from './helpers.ts';

/**
 * The PWA promises this app makes: it installs, it works with no network, and the data you
 * logged is still there afterwards. Those are the claims worth testing, because a kitchen is
 * exactly where signal is worst.
 */

test('registers a service worker and precaches the app shell', async ({ page }) => {
  await page.goto('/');
  const registered = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return Boolean(reg.active);
  });
  expect(registered).toBe(true);
});

test('serves a manifest whose scope and start_url agree with where it is served', async ({
  page,
  request,
}) => {
  await page.goto('/');
  const href = await page.getAttribute('link[rel="manifest"]', 'href');
  expect(href).toBeTruthy();

  const res = await request.get(new URL(href!, page.url()).toString());
  expect(res.ok()).toBe(true);
  const manifest = (await res.json()) as {
    scope: string;
    start_url: string;
    display: string;
    icons: { sizes: string; purpose?: string }[];
  };

  // A scope that disagrees with the deployed base path yields an install that either refuses
  // or opens a blank page, so it is checked against the page's own path rather than a literal.
  const base = new URL('.', page.url()).pathname;
  expect(manifest.scope).toBe(base);
  expect(manifest.start_url).toBe(base);
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.map((i) => i.sizes)).toContain('512x512');
  expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
});

test('the icons the manifest promises actually exist', async ({ page, request }) => {
  await page.goto('/');
  for (const path of [
    'icons/icon-192.png',
    'icons/icon-512.png',
    'icons/icon-maskable-512.png',
    'icons/apple-touch-icon.png',
  ]) {
    const res = await request.get(new URL(path, page.url()).toString());
    expect(res.ok(), `${path} should be served`).toBe(true);
    expect(res.headers()['content-type']).toContain('image/png');
  }
});

test('loads and logs a shot with the network offline', async ({ page, context }) => {
  await gotoFresh(page);

  // Wait for the worker to finish precaching before cutting the network.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await context.setOffline(true);
  await page.reload();

  // Served entirely from the precache.
  await expect(page.getByRole('heading', { name: 'Ethiopia Sidama' })).toBeVisible();

  // And still fully usable: the data lives on the device, so nothing here needs a network.
  await pullShot(page, { extractionSec: 22, yieldG: 40 });
  await expect(page.getByRole('heading', { level: 2 }).first()).toContainText('16.5 → 17.0');

  await context.setOffline(false);
});

test('a saved shot survives a reload and is not offered for logging twice', async ({ page }) => {
  await gotoFresh(page);
  await pullShot(page, { extractionSec: 27, yieldG: 40 });

  await page.reload();
  await settle(page);

  // The reload lands back on the timer. It must be ready for the next pull, not still holding
  // the one just logged — otherwise the same shot gets saved again.
  await expect(page.getByRole('button', { name: /^Start/ })).toBeVisible();
  await expect(page.getByText('What the timer saw')).toHaveCount(0);

  await nav(page, 'Home').click();
  await expect(page.getByRole('heading', { level: 2 }).first()).toContainText('pull one more');
  // ~27s, not exactly 27.0: real time passes between pressing Start and advancing the clock.
  await expect(page.getByText(/27\.\d/).first()).toBeVisible();
});

test('a pull interrupted by a reload resumes instead of being lost', async ({ page }) => {
  await gotoFresh(page);
  await nav(page, 'Pull').click();
  await page.getByRole('button', { name: /^Start/ }).click();

  // 9 s pre-infusion + 15 s of extraction, then the page reloads under us.
  await page.clock.runFor(24_000);
  await expect(page.getByText('Extracting')).toBeVisible();
  await page.reload();

  // The timer picks the pull back up rather than resetting to a ready state.
  await expect(page.getByText('Extracting')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
});
