/**
 * Playwright config — REAL P2P integration suite (e2e-p2p/).
 *
 * Deliberately separate from playwright.config.js. That suite is hermetic and
 * fast: a `vite preview` build with every /api call mocked in-browser. This one
 * is the opposite — it builds and runs real binaries (a `vulos-relayd` from the
 * sibling Ephor checkout plus two standalone `diwan` servers) and
 * negotiates real WebRTC between two browser contexts. It is slower and depends
 * on a Go toolchain and that sibling checkout, so it must never be able to
 * destabilise the fast suite. Run it with `npm run test:e2e:p2p`.
 *
 * There is no `webServer` here: the suite boots its own processes (e2e-p2p/stack.mjs)
 * because it needs several of them, on ports it chooses, with per-instance config.
 */

import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e-p2p',
  testMatch: '**/*.e2e.js',
  // Building three binaries + ICE negotiation. The build happens once, in the
  // first test's beforeAll, so the budget has to cover it.
  timeout: 300_000,
  expect: { timeout: 30_000 },
  // One worker, no parallelism: the suite owns real ports and real processes.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    serviceWorkers: 'block',
    launchOptions: {
      args: [
        // Chromium hides local IPs behind mDNS (.local) candidates by default,
        // which two contexts on loopback cannot resolve for each other — ICE
        // would never find a candidate pair even though both peers are on the
        // same machine. Disabling it exposes the real 127.0.0.1 host candidates
        // so a genuinely DIRECT connection can form. This is a headless-testing
        // accommodation for candidate visibility only: it changes no protocol,
        // no signaling path and no crypto.
        '--disable-features=WebRtcHideLocalIpsWithMdns',
        // The two peers are served from different loopback ORIGINS
        // (127.0.0.1:<portA> vs :<portB>). Loopback is a secure context, so
        // WebCrypto (the room key derivation) works without TLS.
        '--allow-loopback-in-peer-connection',
      ],
    },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
})
