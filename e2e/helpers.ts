import { expect, type Page } from '@playwright/test';

/**
 * Shared e2e helpers.
 *
 * Shots are driven through the real UI — start the timer, advance the clock, stop, fill in the
 * log — rather than by writing rows into IndexedDB. That way each test covers the path the user
 * actually takes: timer → phase split → advice engine → suggestion on screen.
 *
 * Playwright's clock API mocks `performance.now()`, `Date.now()` and rAF together, so a 22-second
 * extraction takes no real time while the app still sees a consistent 22 seconds.
 */

/**
 * Load the app on a first-run database.
 *
 * No storage clearing needed: Playwright gives every test its own browser context with its own
 * IndexedDB partition, so each test genuinely starts from the first-run seed. (Deleting the
 * database from inside the page is actively worse — the delete blocks on Dexie's open connection
 * and the reload can race it.)
 *
 * The clock is installed before the first navigation so the app never sees the real time.
 */
export async function gotoFresh(page: Page): Promise<void> {
  await page.clock.install();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Ethiopia Sidama' })).toBeVisible();
}

export interface ShotSpec {
  /** Seconds of extraction *after* pre-infusion ends. */
  extractionSec: number;
  yieldG: number;
  /** Seconds from the start of the pull. Omitted means "didn't tap first drip". */
  firstDripSec?: number;
  channeling?: boolean;
  taste?: string[];
  rating?: number;
  discard?: boolean;
}

/** Seeded pre-infusion: 3 s saturation + 6 s bloom. */
export const PRE_INFUSION_SEC = 9;

/**
 * Runs one shot end to end and saves it, leaving the app on the post-shot screen where the
 * coach's verdict is shown.
 */
export async function pullShot(page: Page, spec: ShotSpec): Promise<void> {
  await nav(page, 'Pull').click();
  await page.getByRole('button', { name: /^Start/ }).click();

  if (spec.firstDripSec !== undefined) {
    await page.clock.runFor(spec.firstDripSec * 1000);
    await page.getByRole('button', { name: 'First drip' }).click();
    await page.clock.runFor((PRE_INFUSION_SEC + spec.extractionSec - spec.firstDripSec) * 1000);
  } else {
    await page.clock.runFor((PRE_INFUSION_SEC + spec.extractionSec) * 1000);
  }

  await page.getByRole('button', { name: 'Stop' }).click();

  // Log sheet.
  await expect(page.getByText('What the timer saw')).toBeVisible();
  await page.getByLabel('Yield', { exact: true }).fill(spec.yieldG.toFixed(1));

  if (spec.channeling) await page.getByRole('switch', { name: 'It channelled' }).click();
  if (spec.discard) await page.getByRole('switch', { name: "Don't count this shot" }).click();
  for (const tag of spec.taste ?? []) {
    await page.getByRole('button', { name: tag, exact: true }).click();
  }
  if (spec.rating !== undefined) {
    await page.getByRole('button', { name: `${spec.rating} out of 5` }).click();
  }

  await page.getByRole('button', { name: 'Save shot' }).click();
  await expect(page.getByRole('button', { name: 'Pull another' })).toBeVisible();
  await settle(page);
}

/**
 * Let deferred work run.
 *
 * Under an installed clock, time only moves when the test says so — and Dexie's live-query
 * change notifications are scheduled on a timer. Without this the UI keeps showing pre-write
 * data forever, which looks exactly like a broken query. Advancing a beat flushes them.
 */
export async function settle(page: Page, ms = 250): Promise<void> {
  await page.clock.runFor(ms);
}

/** The coach's headline on the post-shot screen. */
export function adviceHeadline(page: Page) {
  return page.getByRole('heading', { level: 2 }).first();
}

/**
 * A bottom-navigation link, scoped to the nav.
 *
 * Screens contain their own links to the same places ("Go to beans" on an empty state), so an
 * unscoped `getByRole('link', { name: 'Beans' })` matches more than one and fails on strictness.
 */
export function nav(page: Page, name: 'Home' | 'Beans' | 'Pull' | 'Stats' | 'Setup') {
  return page.getByRole('navigation').getByRole('link', { name, exact: true });
}
