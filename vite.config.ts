// `vitest/config` re-exports Vite's defineConfig widened with the `test` block.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * The app is served from a GitHub Pages project subpath (`/Home-Manager/`), so the
 * base, the router basename, and the manifest scope/start_url must all agree. If they
 * drift apart you get either a blank installed app or an install that silently refuses.
 * `BASE_PATH` is the single source of truth; the router reads it from `import.meta.env.BASE_URL`.
 *
 * Set BASE_PATH=/ for local dev against a root-served origin, or when deploying to a
 * custom domain / user-pages site.
 */
const BASE_PATH = process.env.BASE_PATH ?? '/Home-Manager/';

export default defineConfig({
  base: BASE_PATH,
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      // v1 makes zero network requests at runtime, so offline is purely a precache concern.
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: `${BASE_PATH}index.html`,
        cleanupOutdatedCaches: true,
      },
      manifest: {
        name: 'Espresso Dial-In Coach',
        short_name: 'Dial-In',
        description:
          'Offline espresso dial-in coach: staged pre-infusion timer, shot log, and grind suggestions.',
        scope: BASE_PATH,
        start_url: BASE_PATH,
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#171310',
        theme_color: '#171310',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      // Lets the e2e suite exercise the real service worker against `vite preview`.
      devOptions: { enabled: false },
    }),
  ],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    globals: true,
    // Playwright specs live in e2e/ and must not be picked up by Vitest.
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
});
