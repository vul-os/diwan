#!/usr/bin/env node
/**
 * Diwan — Playwright screenshotter
 *
 * Captures every major app surface at 1440×900 into docs/screenshots/.
 *
 * Default (local) mode:
 *   1. Writes static seed files to /tmp/vulos-demo-data
 *   2. Builds the Go binary (which embeds the compiled frontend via //go:embed)
 *   3. Starts it on port 8083 pointed at the demo data dir
 *   4. Captures all screenshots
 *   5. Stops the server
 *
 * Usage:
 *   npm run screenshots
 *   BASE_URL=https://office.example.com npm run screenshots
 *   BASE_URL=https://office.example.com npm run screenshots -- --seed
 *
 * Prerequisites:
 *   npm install && npm run build     (builds the frontend into dist/)
 *   npx playwright install chromium
 */

import { chromium } from 'playwright'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { spawn, execSync } from 'node:child_process'

import { seedStaticFiles, seedLocalDriveFiles, DEMO_DATA_DIR, DEMO_HOME_DIR } from './seed-demo.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT       = path.resolve(__dirname, '..')
const OUT        = path.join(ROOT, 'docs', 'screenshots')

const EXTERNAL_URL = process.env.BASE_URL
const FORCE_SEED   = process.argv.includes('--seed')

// Use port 8083 so we don't collide with a running dev server on :8080/:8082
const LOCAL_PORT   = 8083
const LOCAL_BASE   = `http://localhost:${LOCAL_PORT}`

const SCREENSHOT_BASE = EXTERNAL_URL ?? LOCAL_BASE
const API_SEED_BASE   = EXTERNAL_URL ?? LOCAL_BASE

// ── Routes to capture ─────────────────────────────────────────────────────────
// Every surface is shot in BOTH light and dark (Diwan is light-first) at retina
// (deviceScaleFactor 2) into `<name>-light.png` / `<name>-dark.png`.
const ROUTES = [
  { name: 'home',          path: '/',               description: 'Home / workspace' },
  { name: 'apphome-docs',  path: '/docs',           description: 'Docs — file list' },
  {
    name: 'docs-editor',
    path: '/docs/demo',
    description: 'Documents editor — Q2 Product Update',
    waitFor: '.ProseMirror, [data-testid="docs-editor"], .tiptap',
  },
  {
    name: 'sheets-editor',
    path: '/sheets/demo-sheet',
    description: 'Spreadsheets editor — Revenue Tracker',
    // Wait for the SEEDED sheet's tab, not the grid chrome: the grid mounts
    // immediately with an empty fallback "Sheet1" while the document is still
    // loading, so waiting on .fortune-sheet-container photographed a blank
    // spreadsheet. Cells are painted to canvas (no DOM to wait on), which makes
    // the tab label the only signal that the content actually arrived. Exact
    // text — the doc title "Revenue Tracker H1 2026" also contains "Revenue".
    waitFor: 'text="Revenue"',
  },
  {
    name: 'slides-editor',
    path: '/slides/demo-slides',
    description: 'Presentations editor — Product Overview',
    waitFor: '.reveal, [data-testid="slides-editor"]',
  },
  {
    name: 'whiteboard-editor',
    path: '/whiteboards/demo-board',
    description: 'Whiteboard editor — Excalidraw canvas on the P2P collab engine',
    // The real Excalidraw canvas mounts its own .excalidraw container; give the
    // scene a moment to paint the seeded shapes before the shot.
    waitFor: '.excalidraw, [data-testid="whiteboard-editor"]',
    settleMs: 1500,
  },
  {
    name: 'pdf-editor',
    path: '/pdf/demo',
    description: 'PDF viewer / annotator',
    waitFor: '[data-testid="pdf-editor"], .pdf-viewer, canvas',
  },
  {
    name: 'settings',
    path: '/settings',
    description: 'Settings — standalone account / storage / admin',
  },
]

// ── Local server management ───────────────────────────────────────────────────

let serverProc = null

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function waitForHTTP(url, maxMs = 45_000) {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1_500) })
      if (r.status < 600) return
    } catch { /* not yet */ }
    await sleep(500)
  }
  throw new Error(`${url} did not become ready within ${maxMs}ms`)
}

async function startLocalServer() {
  console.log('\n  setting up demo environment …')

  // 1. Write static JSON seed files (docs / sheets / slides) + a sandboxed HOME
  //    of fabricated local-drive files (so the "on your computer" scanner never
  //    photographs the operator's real Documents/Downloads/Desktop).
  seedStaticFiles()
  seedLocalDriveFiles()

  // 2. Ensure the frontend is built (dist/ must exist with index.html).
  //    dist/ itself stays at the repo root (go:embed requires it there), but
  //    the frontend project (package.json, node_modules) lives in web/ now,
  //    so `npm run build:frontend` has to run from there.
  if (!existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    console.log('  building frontend (dist/) …')
    execSync('npm run build:frontend', { cwd: path.join(ROOT, 'web'), stdio: 'pipe' })
    console.log('  frontend built')
  }

  // 3. Build Go binary
  const binPath = '/tmp/diwan-screenshots-bin'
  console.log('  building Go binary …')
  execSync(`go build -o "${binPath}" .`, { cwd: ROOT, stdio: 'pipe' })
  console.log('  Go binary built')

  // 4. Write a minimal config.yaml into a temp workdir
  const tmpWD = '/tmp/diwan-ss-wd'
  mkdirSync(tmpWD, { recursive: true })
  mkdirSync(`${DEMO_DATA_DIR}/uploads`, { recursive: true })
  writeFileSync(`${tmpWD}/config.yaml`, [
    'server:',
    `  addr: ":${LOCAL_PORT}"`,
    `  data_dir: "${DEMO_DATA_DIR}"`,
    `  uploads_dir: "${DEMO_DATA_DIR}/uploads"`,
    'auth:',
    '  enabled: false',
    'storage:',
    '  type: "local"',
  ].join('\n') + '\n')

  // 5. Start the Go server (it serves both API + embedded frontend).
  //    HOME/USERPROFILE are pinned to the sandboxed demo home so the local-drive
  //    scanner (os.UserHomeDir) walks the fabricated files, not the real ones.
  serverProc = spawn(binPath, [], {
    cwd: tmpWD,
    env: { ...process.env, HOME: DEMO_HOME_DIR, USERPROFILE: DEMO_HOME_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  serverProc.stdout.on('data', d => process.stdout.write(`  [go] ${d}`))
  serverProc.stderr.on('data', d => process.stdout.write(`  [go] ${d}`))
  serverProc.on('exit', code => { if (code !== null && code > 0) console.warn(`  [go] exited with code ${code}`) })

  // 6. Wait for the server to be ready
  await waitForHTTP(`${LOCAL_BASE}/version`)
  console.log(`  server ready at ${LOCAL_BASE}`)

  // Brief pause for static-file writes to settle
  await sleep(1_000)
}

function stopLocalServer() {
  if (serverProc) { try { serverProc.kill() } catch {} ; serverProc = null }
}

// ── Screenshot capture ────────────────────────────────────────────────────────

async function capture(page, route, theme) {
  const url = `${SCREENSHOT_BASE}${route.path}`
  console.log(`  → [${theme}] ${route.description}`)

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 })

    if (route.waitFor) {
      try {
        await page.waitForSelector(route.waitFor, { timeout: 10_000 })
      } catch {
        // Element not present — still capture what's visible
        await page.waitForTimeout(3_000)
      }
    } else {
      try {
        await page.waitForLoadState('networkidle', { timeout: 8_000 })
      } catch {
        await page.waitForTimeout(2_000)
      }
    }

    // Extra pause for CSS transitions / async renders (routes with a canvas that
    // paints asynchronously — e.g. the whiteboard — can ask for a longer settle).
    await page.waitForTimeout(route.settleMs || 800)

    const outPath = path.join(OUT, `${route.name}-${theme}.png`)
    await page.screenshot({ path: outPath, fullPage: false })
    console.log(`     saved ${path.relative(ROOT, outPath)}`)
    return { name: route.name, theme, status: 'ok', path: outPath }
  } catch (err) {
    console.warn(`     FAILED: ${err.message}`)
    return { name: route.name, theme, status: 'failed', error: err.message }
  }
}

// A theme-pinned browser context at retina scale. The app resolves its palette
// from `[data-theme]`, driven by localStorage 'diwan.theme' (set before any page
// script runs) and backstopped by the OS-level colorScheme.
async function makeThemeContext(browser, theme) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: theme,
    locale: 'en-US',
  })
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem('diwan.theme', t)
      localStorage.setItem('vulos.theme', t) // legacy key, still honoured
    } catch {}
  }, theme)
  return ctx
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(OUT, { recursive: true })

  const usingExternal = Boolean(EXTERNAL_URL)

  console.log('\nDiwan screenshotter')
  console.log(`  screenshots → ${SCREENSHOT_BASE}`)
  console.log(`  output      : ${path.relative(ROOT, OUT)}/`)
  console.log(`  viewport    : 1440×900 @2x (retina), light + dark`)
  console.log(`  seed mode   : ${usingExternal ? (FORCE_SEED ? 'forced (--seed)' : 'skipped') : 'auto (local server)'}`)

  if (!usingExternal) {
    await startLocalServer()
  } else if (FORCE_SEED) {
    seedStaticFiles()
    await seedViaAPI(EXTERNAL_URL)
  }

  const browser = await chromium.launch({ headless: true })

  // Light-first: capture the light gallery, then the dark gallery. Each theme
  // gets its own retina context so the palette resolves cleanly from the start.
  const results = []
  for (const theme of ['light', 'dark']) {
    const context = await makeThemeContext(browser, theme)
    const page = await context.newPage()
    page.on('console', () => {})
    page.on('pageerror', () => {})
    for (const route of ROUTES) {
      results.push(await capture(page, route, theme))
    }
    await context.close()
  }

  await browser.close()
  stopLocalServer()

  const ok     = results.filter(r => r.status === 'ok')
  const failed = results.filter(r => r.status === 'failed')

  console.log(`\nDone — ${ok.length} captured, ${failed.length} failed`)
  if (failed.length > 0) {
    console.log('\nFailed routes:')
    for (const r of failed) console.log(`  ${r.name}: ${r.error}`)
  }

  // Write per-directory README
  const notes = [
    '# docs/screenshots',
    '',
    'Generated by `npm run screenshots` (scripts/screenshots.mjs).',
    'Every surface is captured in **light and dark** at retina (1440×900 @2x),',
    'populated with realistic demo data from `scripts/seed-demo.mjs`.',
    '',
    '| File | Surface | Status |',
    '|------|---------|--------|',
    ...results.map(r =>
      `| ${r.name}-${r.theme}.png | ${ROUTES.find(rt => rt.name === r.name)?.description ?? r.name} | ${r.status === 'ok' ? 'populated' : 'needs live instance'} |`
    ),
    '',
    'To regenerate: `npm run screenshots`',
    'Against a live instance: `BASE_URL=https://... npm run screenshots`',
    '',
    '## Seed data',
    '',
    '- **Docs** `demo`: "Q2 2026 Product Update" — prose, table, bullet lists',
    '- **Sheets** `demo-sheet`: "Revenue Tracker H1 2026" — 6 months, SUM + margin formulas, 2 sheets',
    '- **Slides** `demo-slides`: "Diwan Product Overview" — 5 slides',
  ].join('\n')

  writeFileSync(path.join(OUT, 'README.md'), notes + '\n')
  console.log('  wrote docs/screenshots/README.md\n')

  if (failed.length > 0) process.exit(1)
}

main().catch(err => {
  stopLocalServer()
  console.error('Fatal:', err)
  process.exit(1)
})
