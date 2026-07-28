/**
 * Playwright E2E config — Diwan (WAVE-28).
 *
 * Runs browser-level end-to-end tests against a production `vite preview`
 * build. Every `/api` and doc endpoint is mocked in-browser via `page.route`
 * (see e2e/fixtures.js) so the suite is hermetic — no Go backend required.
 *
 * Prereqs:
 *   npm run build:frontend      # produces dist/ that vite preview serves
 *   npx playwright install --with-deps chromium
 *
 * Run:  npm run test:e2e
 */

import { defineConfig, devices } from '@playwright/test'

// Uncommon port to avoid colliding with other Vulos apps' dev/preview servers
// (a stale preview on a shared port would otherwise be reused and serve the
// wrong app). Override with E2E_PORT if needed.
const PORT = process.env.E2E_PORT ? Number(process.env.E2E_PORT) : 47317
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.js',
  // A cold vite preview + first navigation can be slow in CI.
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // Block service workers so a stale PWA cache (from this app or another app
    // that previously ran on the same localhost port) can never shadow the
    // page.route API mocks. The app must render live from the mocked backend.
    serviceWorkers: 'block',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  // Build must already exist (npm run build:frontend). We serve it with vite
  // preview; reuse an already-running server locally for a fast inner loop.
  webServer: {
    command: `npx vite preview --port ${PORT} --strictPort`,
    url: BASE_URL,
    // Always spawn our own Office preview — never reuse a server on this port,
    // so we can't accidentally test a different app that happens to be running.
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
