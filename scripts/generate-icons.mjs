/**
 * Generates the PWA icon PNGs from the SVG defined below.
 *
 * Run with `npm run icons`. Uses the Chromium that Playwright already provides, so there is no
 * image-processing dependency to install — the icons stay reproducible from source instead of
 * being opaque binaries someone has to redraw by hand.
 *
 * Maskable variant: Android crops maskable icons to an arbitrary shape (circle, squircle,
 * teardrop), keeping only the inner ~80%. So it uses a full-bleed background and a smaller
 * glyph, while the standard icon uses a rounded square that is already the final shape.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { chromiumLaunchOptions } from './chromium.mjs';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const BG = '#171310';
const CUP = '#f0e9e2';
const CREMA = '#c98500';
const SAUCER = '#a3866d';

/**
 * A side-on espresso cup with a crema surface, plus a dial tick above it.
 * `scale` shrinks the glyph for the maskable variant so nothing lands in the crop zone.
 */
function svg({ size, rounded, scale }) {
  const glyph = `
    <g transform="translate(256 256) scale(${scale}) translate(-256 -256)">
      <!-- dial marks: the grinder setting, which is what this app is really about -->
      <g stroke="${SAUCER}" stroke-width="14" stroke-linecap="round" opacity="0.85">
        <path d="M150 120 L150 96" />
        <path d="M203 110 L203 92" />
        <path d="M256 104 L256 74" />
        <path d="M309 110 L309 92" />
        <path d="M362 120 L362 96" />
      </g>
      <!-- cup body -->
      <path d="M120 200 h240 v56 a120 120 0 0 1 -240 0 z" fill="${CUP}" />
      <!-- crema surface -->
      <ellipse cx="240" cy="200" rx="120" ry="26" fill="${CREMA}" />
      <!-- handle -->
      <path d="M360 214 h26 a52 52 0 0 1 0 104 h-14"
            fill="none" stroke="${CUP}" stroke-width="26" stroke-linecap="round" />
      <!-- saucer -->
      <rect x="92" y="392" width="296" height="26" rx="13" fill="${SAUCER}" />
    </g>`;

  const background = rounded
    ? `<rect width="512" height="512" rx="112" fill="${BG}" />`
    : `<rect width="512" height="512" fill="${BG}" />`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}">
    ${background}
    ${glyph}
  </svg>`;
}

const TARGETS = [
  { file: 'icon-192.png', size: 192, rounded: true, scale: 0.92 },
  { file: 'icon-512.png', size: 512, rounded: true, scale: 0.92 },
  // iOS applies its own rounding, so this one is square-edged with a full-bleed background.
  { file: 'apple-touch-icon.png', size: 180, rounded: false, scale: 0.86 },
  // Android maskable: content confined to the inner 80% safe zone.
  { file: 'icon-maskable-512.png', size: 512, rounded: false, scale: 0.7 },
];

const browser = await chromium.launch(chromiumLaunchOptions());
try {
  await mkdir(OUT_DIR, { recursive: true });
  for (const { file, size, rounded, scale } of TARGETS) {
    const markup = svg({ size, rounded, scale });
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<body style="margin:0;background:transparent">${markup}</body>`,
      { waitUntil: 'load' },
    );
    // Always opaque: a transparent icon shows the launcher's own background through it.
    const png = await page.screenshot({ type: 'png' });
    await writeFile(join(OUT_DIR, file), png);
    await page.close();
    console.log(`wrote ${file} (${size}×${size}, ${png.length} bytes)`);
  }
  // Keep the source SVG beside the PNGs; handy as a favicon and for future resizes.
  await writeFile(join(OUT_DIR, 'icon.svg'), svg({ size: 512, rounded: true, scale: 0.92 }));
  console.log('wrote icon.svg');
} finally {
  await browser.close();
}
