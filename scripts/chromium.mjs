import { existsSync } from 'node:fs';

/**
 * Finds a Chromium to drive.
 *
 * Some environments pre-install browsers at `PLAYWRIGHT_BROWSERS_PATH` under a build number
 * that doesn't match what the installed `@playwright/test` expects. Playwright then refuses to
 * launch and tells you to run `playwright install`, which in a sandboxed or offline environment
 * either fails or wastes a large download. Pointing at the binary that is already on disk
 * sidesteps that entirely.
 *
 * Returns `undefined` when nothing pre-installed is found, which lets Playwright fall back to
 * its own managed browser — the normal case in CI.
 */
export function resolveChromium() {
  const explicit = process.env.CHROMIUM_PATH;
  if (explicit && existsSync(explicit)) return explicit;

  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root) return undefined;

  const candidates = [
    `${root}/chromium`,
    `${root}/chromium-1194/chrome-linux/chrome`,
    `${root}/chromium_headless_shell-1194/chrome-linux/headless_shell`,
  ];
  return candidates.find((p) => existsSync(p));
}

/** Launch options that use the pre-installed browser when there is one. */
export function chromiumLaunchOptions() {
  const executablePath = resolveChromium();
  return executablePath ? { executablePath } : {};
}
