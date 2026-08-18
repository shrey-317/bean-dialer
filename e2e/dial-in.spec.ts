import { expect, test } from '@playwright/test';
import { PRE_INFUSION_SEC, adviceHeadline, gotoFresh, nav, pullShot, settle } from './helpers.ts';

/**
 * End-to-end coverage of the dial-in loop.
 *
 * The direction assertions here are the ones that matter most: on the seeded DF54, **finer means
 * a higher dial number**. If someone "fixes" the engine to assume the usual convention, the
 * 22-second test below flips to 16.0 and fails — which is the point of it.
 */

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test('first run is seeded with the documented setup', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Ethiopia Sidama' })).toBeVisible();
  await expect(page.getByText('Joe Van Gogh', { exact: false })).toBeVisible();

  // Dose, yield, temperature and target window from the handover.
  await expect(page.getByText('18g', { exact: true })).toBeVisible();
  await expect(page.getByText('40g', { exact: true })).toBeVisible();
  await expect(page.getByText('95°', { exact: true })).toBeVisible();
  await expect(page.getByText('25–30s', { exact: true })).toBeVisible();

  // Starting dial, already corrected for the self-levelling tamper.
  await expect(page.getByText('16.5', { exact: true })).toBeVisible();

  // With no shots logged, the coach says where to begin rather than inventing advice.
  await expect(adviceHeadline(page)).toContainText('Start at 16.5');
});

test('a fast shot is corrected finer, which on this grinder means a HIGHER dial', async ({ page }) => {
  await pullShot(page, { extractionSec: 22, yieldG: 40 });

  await expect(adviceHeadline(page)).toContainText('Grind finer');
  // 16.5 → 17.0. A regression to 16.0 means the dial direction was hardcoded.
  await expect(adviceHeadline(page)).toContainText('16.5 → 17.0');
  await expect(page.getByRole('button', { name: 'Set dial to 17' })).toBeVisible();
});

test('a slow shot is corrected coarser, to a lower dial', async ({ page }) => {
  await pullShot(page, { extractionSec: 34, yieldG: 40 });

  await expect(adviceHeadline(page)).toContainText('Grind coarser');
  await expect(adviceHeadline(page)).toContainText('16.5 → 16.0');
});

test('a badly missed yield gets no grind change, just a flow rate', async ({ page }) => {
  // 52 g in 22 s only *looks* fast: the extra 12 g of liquid took extra seconds.
  await pullShot(page, { extractionSec: 22, yieldG: 52 });

  await expect(adviceHeadline(page)).toContainText('Yield was over by 12 g');
  await expect(page.getByText('g/s')).toBeVisible();
  await expect(page.getByRole('button', { name: /Set dial to/ })).toHaveCount(0);
});

test('applying advice moves the dial and returns to the timer', async ({ page }) => {
  await pullShot(page, { extractionSec: 22, yieldG: 40 });
  await page.getByRole('button', { name: 'Set dial to 17' }).click();

  // Straight back to a ready timer, now showing the accepted dial.
  await expect(page.getByRole('button', { name: /^Start/ })).toBeVisible();
  await expect(page.getByText('Dial 17')).toBeVisible();

  await nav(page, 'Home').click();
  await expect(page.getByText('17.0', { exact: true })).toBeVisible();
});

test('two matching on-target shots offer to lock the dial in', async ({ page }) => {
  await pullShot(page, { extractionSec: 27, yieldG: 40 });
  // One good shot is not a dial — the coach asks for a repeat first.
  await expect(adviceHeadline(page)).toContainText('pull one more');

  await page.getByRole('button', { name: 'Pull another' }).click();
  await pullShot(page, { extractionSec: 28, yieldG: 40 });

  await expect(adviceHeadline(page)).toContainText('Locked in at 16.5');
  await page.getByRole('button', { name: 'Lock in 16.5' }).click();

  // Locking in must not empty the home screen: the bean is still what you're pulling.
  await expect(page.getByText('Dialled in at 16.5')).toBeVisible();
  await expect(page.getByText('No bean being dialled in')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Pull a shot' })).toBeVisible();

  await nav(page, 'Beans').click();
  await expect(page.getByRole('link', { name: /Ethiopia Sidama/ })).toBeVisible();
});

test('channelling is blamed on the puck, never on the self-levelling tamper', async ({ page }) => {
  await pullShot(page, { extractionSec: 27, yieldG: 40, channeling: true });

  await expect(adviceHeadline(page)).toContainText('fix the puck, not the grind');
  await expect(page.getByText(/no pressure override/i)).toBeVisible();
  await expect(page.getByText(/tamp harder|press harder/i)).toHaveCount(0);
});

test('the shot log records what the coach said', async ({ page }) => {
  await pullShot(page, { extractionSec: 22, yieldG: 40, firstDripSec: 14, rating: 3 });

  await nav(page, 'Home').click();
  await page.getByRole('link', { name: /All 1 shots?/ }).click();

  await expect(page.getByText('Coach said:')).toBeVisible();
  await expect(page.getByText(/Grind finer/)).toBeVisible();
  await expect(page.getByText('3/5')).toBeVisible();
});

test('a discarded shot is logged but kept out of the advice', async ({ page }) => {
  await pullShot(page, { extractionSec: 12, yieldG: 40, discard: true });

  // A flush shouldn't produce a grind suggestion at all.
  await expect(page.getByRole('button', { name: /Set dial to/ })).toHaveCount(0);

  await nav(page, 'Home').click();
  await expect(adviceHeadline(page)).toContainText('Start at 16.5');
});

test('the dial can be edited with the on-screen keypad, and the edit carries into the next pull', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Edit dial' }).click();
  await page.getByRole('button', { name: '1', exact: true }).click();
  await page.getByRole('button', { name: '3', exact: true }).click();
  await page.getByRole('button', { name: 'Done' }).click();

  // Home reflects the typed value immediately.
  await expect(page.getByText('13.0', { exact: true })).toBeVisible();

  // So does the Timer's pre-start screen, and so does the log sheet once a shot is pulled.
  await nav(page, 'Pull').click();
  await expect(page.getByText('Dial 13')).toBeVisible();

  await page.getByRole('button', { name: /^Start/ }).click();
  await page.clock.runFor((PRE_INFUSION_SEC + 25) * 1000);
  await page.getByRole('button', { name: 'Stop' }).click();

  await expect(page.getByLabel('Dial', { exact: true })).toHaveValue('13.0');
});

test('a manually corrected dial becomes the working dial even without applying advice', async ({
  page,
}) => {
  await nav(page, 'Pull').click();
  await page.getByRole('button', { name: /^Start/ }).click();
  await page.clock.runFor((PRE_INFUSION_SEC + 22) * 1000);
  await page.getByRole('button', { name: 'Stop' }).click();

  await expect(page.getByText('What the timer saw')).toBeVisible();
  await page.getByLabel('Yield', { exact: true }).fill('40.0');
  // Hand-turned the grinder to 13 instead of following any suggestion — nothing here ever taps
  // an "Apply"/"Set dial to" button, which is the point of the test.
  await page.getByLabel('Dial', { exact: true }).fill('13.0');
  await page.getByRole('button', { name: 'Save shot' }).click();
  await expect(page.getByRole('button', { name: 'Pull another' })).toBeVisible();
  await settle(page);

  await nav(page, 'Home').click();
  await expect(page.getByText('13.0', { exact: true })).toBeVisible();

  await nav(page, 'Pull').click();
  await expect(page.getByText('Dial 13')).toBeVisible();
});
