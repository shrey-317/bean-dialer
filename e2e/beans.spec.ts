import { expect, test } from '@playwright/test';
import { gotoFresh, nav } from './helpers.ts';

/**
 * Bean records: multi-process bags, free-text tasting notes, and re-buying a bag already
 * dialled in.
 */

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test('a bag can have more than one process, and its own tasting notes', async ({ page }) => {
  await nav(page, 'Beans').click();
  await page.getByRole('button', { name: 'Add bag' }).click();

  await page.getByLabel('Name').fill('Kenya Kiamabara');
  await page.getByLabel('Roaster').fill('Prodigal');

  // Not a single process — a co-ferment of two.
  await page.getByRole('button', { name: 'washed', exact: true }).click();
  await page.getByRole('button', { name: 'natural', exact: true }).click();

  await page.getByPlaceholder('black cherry').fill('black cherry');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByPlaceholder('black cherry').fill('blackcurrant');
  await page.getByRole('button', { name: 'Add', exact: true }).click();

  await page.getByRole('button', { name: 'Save bag' }).click();

  await page.getByRole('link', { name: /Kenya Kiamabara/ }).click();
  await expect(page.getByText('washed + natural')).toBeVisible();
  await expect(page.getByText('black cherry')).toBeVisible();
  await expect(page.getByText('blackcurrant')).toBeVisible();
});

test('a tasting note can be removed before saving', async ({ page }) => {
  await nav(page, 'Beans').click();
  await page.getByRole('button', { name: 'Add bag' }).click();
  await page.getByLabel('Name').fill('Colombia Wush Wush');

  await page.getByPlaceholder('black cherry').fill('floral');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('button', { name: 'floral ×' })).toBeVisible();

  // Tapping an added note chip removes it, same as toggling any other chip.
  await page.getByRole('button', { name: 'floral ×' }).click();
  await expect(page.getByRole('button', { name: 'floral ×' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Save bag' }).click();
  await page.getByRole('link', { name: /Colombia Wush Wush/ }).click();
  await expect(page.getByText('floral')).toHaveCount(0);
});

test('buying a bag again pre-fills roaster and process but asks for a fresh roast date', async ({
  page,
}) => {
  await nav(page, 'Beans').click();
  await page.getByRole('link', { name: /Ethiopia Sidama/ }).click();
  const originalUrl = page.url();

  await page.getByRole('button', { name: 'Buy this again' }).click();

  await expect(page.getByLabel('Name')).toHaveValue('Ethiopia Sidama');
  await expect(page.getByLabel('Roaster')).toHaveValue('Joe Van Gogh');
  await expect(page.getByRole('button', { name: 'natural', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // A new bag needs its own roast date — it must not silently inherit (or omit) the old one.
  await expect(page.getByLabel('Roast date')).not.toHaveValue('');

  await page.getByRole('button', { name: 'Save new bag' }).click();

  // Saving and navigating are both async, so assert on something that only becomes true once
  // the new page has actually rendered before trusting `page.url()` — the seed bag has no roast
  // date, so its absence here means this is genuinely the new bean's page, not a stale read of
  // the old one mid-navigation.
  await expect(page.getByText('no roast date')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Ethiopia Sidama' })).toBeVisible();
  await expect(page.getByText('Joe Van Gogh', { exact: false })).toBeVisible();
  expect(page.url()).not.toBe(originalUrl);
});
