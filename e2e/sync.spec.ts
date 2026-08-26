import { expect, test, type Browser, type Page } from '@playwright/test';
import { STUB_PORT } from '../playwright.config.ts';
import { adviceHeadline, gotoFresh, nav, pullShot, settle } from './helpers.ts';

/**
 * Two devices, one shot log.
 *
 * Each browser context is its own device: separate IndexedDB, separate localStorage, separate
 * sign-in — the same separation a phone and a Pixel have. They talk to the stub project described
 * in `stub-supabase.mjs` through the real supabase-js client, so what's under test is the app's own
 * sync behaviour rather than a mock of it.
 *
 * What this cannot prove: that `supabase/schema.sql` and its row-level security are correct. That
 * needs a real project, and the README says so.
 */

const STUB_URL = `http://localhost:${STUB_PORT}`;
const ANON_KEY = 'stub-anon-key';

/** Connects a device to the stub project and signs it in. */
async function connectSync(
  page: Page,
  email: string,
  { create }: { create: boolean },
): Promise<void> {
  await nav(page, 'Setup').click();

  await page.getByLabel('Project URL').fill(STUB_URL);
  await page.getByLabel('Anon public key').fill(ANON_KEY);
  await page.getByRole('button', { name: 'Connect' }).click();

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('correct-horse');
  await page.getByRole('button', { name: create ? 'Create account' : 'Sign in' }).click();

  await expect(page.getByText(email)).toBeVisible();
}

/** Waits for the status pill to report a completed sync. */
async function syncSettled(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Sync now|^Syncing/ }).click();
  await expect(page.getByText(/synced (just now|\d+ min ago)/i)).toBeVisible({ timeout: 15_000 });
}

async function openDevice(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await gotoFresh(page);
  return { context, page };
}

test.describe('sync between two devices', () => {
  // Real network round trips through a local server, plus two full app loads.
  test.setTimeout(120_000);

  test('a shot logged on one device appears on the other', async ({ browser }) => {
    const mine = await openDevice(browser);
    const hers = await openDevice(browser);

    try {
      // Device one creates the household and logs a shot.
      await connectSync(mine.page, `me-${Date.now()}@example.com`, { create: true });
      const household = await mine.page.getByLabel('Household code').inputValue();
      expect(household).toBeTruthy();

      await pullShot(mine.page, { extractionSec: 22, yieldG: 40 });
      await nav(mine.page, 'Setup').click();
      await syncSettled(mine.page);

      // Device two joins that household.
      await connectSync(hers.page, `her-${Date.now()}@example.com`, { create: true });
      await hers.page.getByRole('button', { name: /Join the other phone/ }).click();
      await hers.page.getByLabel('Join a household').fill(household);
      await hers.page.getByRole('button', { name: 'Join', exact: true }).click();
      await syncSettled(hers.page);

      // The shot — and therefore the coach's verdict on it — crossed over.
      await nav(hers.page, 'Home').click();
      await settle(hers.page);
      await expect(adviceHeadline(hers.page)).toContainText('Grind finer');
      await expect(adviceHeadline(hers.page)).toContainText('16.5 → 16.0');
    } finally {
      await mine.context.close();
      await hers.context.close();
    }
  });

  test('a shot logged offline syncs when the network returns', async ({ browser }) => {
    const device = await openDevice(browser);

    try {
      await connectSync(device.page, `offline-${Date.now()}@example.com`, { create: true });
      await syncSettled(device.page);

      // Go offline and log a shot — this must work exactly as it always did.
      await device.context.setOffline(true);
      await pullShot(device.page, { extractionSec: 34, yieldG: 40 });
      await expect(adviceHeadline(device.page)).toContainText('Grind coarser');

      await nav(device.page, 'Setup').click();
      await expect(device.page.getByText(/waiting to send/)).toBeVisible();

      // Back online, the backlog goes out.
      await device.context.setOffline(false);
      await syncSettled(device.page);
      await expect(device.page.getByText(/waiting to send/)).toHaveCount(0);
    } finally {
      await device.context.close();
    }
  });

  test('the app is fully usable with sync switched off', async ({ browser }) => {
    const device = await openDevice(browser);

    try {
      // No project configured at all — the original offline-first behaviour must be untouched.
      await pullShot(device.page, { extractionSec: 22, yieldG: 40 });
      await expect(adviceHeadline(device.page)).toContainText('16.5 → 16.0');

      await nav(device.page, 'Setup').click();
      // Sync presents itself as optional rather than as something broken.
      await expect(device.page.getByText('optional')).toBeVisible();
      await expect(device.page.getByRole('button', { name: 'Connect' })).toBeVisible();
    } finally {
      await device.context.close();
    }
  });

  test('a wrong password is reported plainly and changes nothing', async ({ browser }) => {
    const device = await openDevice(browser);
    const email = `wrong-${Date.now()}@example.com`;

    try {
      await connectSync(device.page, email, { create: true });
      await device.page.getByRole('button', { name: 'Sign out' }).click();

      await device.page.getByLabel('Email').fill(email);
      await device.page.getByLabel('Password').fill('not-the-password');
      await device.page.getByRole('button', { name: 'Sign in' }).click();

      await expect(device.page.getByText(/did not match/i)).toBeVisible();
      // And the app still works.
      await pullShot(device.page, { extractionSec: 27, yieldG: 40 });
      await expect(adviceHeadline(device.page)).toContainText('pull one more');
    } finally {
      await device.context.close();
    }
  });
});
