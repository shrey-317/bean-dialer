import { expect, test } from '@playwright/test';
import { PRE_INFUSION_SEC, gotoFresh, nav, pullShot, settle } from './helpers.ts';

/**
 * Captures the main screens into `screenshots/` for eyeballing after a change. Not assertions —
 * the validator checks colour, but only looking at the output catches label collisions, clipped
 * text and layout that technically passes every check while being unreadable.
 */
// One test walking the whole app, with a dozen full-page captures — well past the default budget.
test.setTimeout(180_000);

test('capture the main screens', async ({ page }, testInfo) => {
  const dir = `screenshots/${testInfo.project.name}`;
  const shot = (name: string) => page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });

  await gotoFresh(page);
  await shot('01-home-first-run');

  // Mid-extraction, which is the screen that has to be readable from across the kitchen.
  await nav(page, 'Pull').click();
  await shot('02-timer-ready');
  await page.getByRole('button', { name: /^Start/ }).click();
  await page.clock.runFor(2_000);
  await shot('03-timer-preinfusion');
  await page.clock.runFor((PRE_INFUSION_SEC + 18) * 1000);
  await shot('04-timer-extracting');
  await page.getByRole('button', { name: 'Stop' }).click();
  await shot('05-log-shot');

  await page.getByLabel('Yield', { exact: true }).fill('40.0');
  await page.getByRole('button', { name: 'Save shot' }).click();
  await settle(page);
  await shot('06-advice-after-shot');

  // A few more shots so the charts have something to show.
  await page.getByRole('button', { name: 'Pull another' }).click();
  await pullShot(page, { extractionSec: 24, yieldG: 40, firstDripSec: 13 });
  await page.getByRole('button', { name: 'Pull another' }).click();
  await pullShot(page, { extractionSec: 27, yieldG: 40, firstDripSec: 14, rating: 4 });

  await nav(page, 'Home').click();
  await shot('07-home-with-shots');

  // Stats and bean detail are lazily loaded, so wait for their content rather than a beat —
  // otherwise the capture catches the Suspense fallback.
  await nav(page, 'Stats').click();
  await expect(page.getByText('Grind setting vs shot time')).toBeVisible();
  await expect(page.getByText('Rating vs days off roast')).toBeVisible();
  await shot('08-stats');

  await nav(page, 'Beans').click();
  await shot('09-beans');

  await page.getByRole('link', { name: /Ethiopia Sidama/ }).click();
  await expect(page.getByRole('heading', { name: 'Ethiopia Sidama', level: 1 })).toBeVisible();
  await expect(page.getByText('Coach said:').first()).toBeVisible();
  await shot('10-bean-detail');

  await nav(page, 'Setup').click();
  await shot('11-setup');

  await page.getByRole('link', { name: 'Gear' }).click();
  await shot('12-gear');
});
