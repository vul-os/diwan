#!/usr/bin/env node
/**
 * gen-logo-assets.mjs — rasterize the canonical Diwan mark (public/logo.svg)
 * into every PNG the repo + PWA manifest need, using headless Chromium so the
 * output is pixel-identical to what browsers render (gradients, sheen, AA).
 *
 *   Rounded-tile, transparent  → favicon-16/32/48/96
 *   Full-bleed ember, opaque    → icon-192/512, android-chrome-192/512,
 *                                 apple-touch-icon (180)
 *   OG banner 1200×630          → og-image.png  (mark + Bricolage wordmark)
 *
 * .ico is assembled from the small PNGs by ImageMagick (see package script).
 */
import { chromium } from 'playwright'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUB = path.join(ROOT, 'public')
const b64 = (p) => readFileSync(p).toString('base64')

// Rounded tile (transparent margin) — the browser-tab / README glyph.
// The iwan is a flat glyph on transparency, so the raster icons give it a warm
// paper ground to sit on rather than inverting its colours.
const roundedSVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect x="2" y="2" width="60" height="60" rx="17" fill="#FBF7F1"/>
  <rect x="2" y="2" width="60" height="60" rx="17" fill="none" stroke="#ECE4D6" stroke-width="1"/>
  <path d="M12 55 L12 31 A22.1 22.1 0 0 1 32 9 A22.1 22.1 0 0 1 52 31 L52 55 L44 55 L44 31 A14.17 14.17 0 0 0 32 17 A14.17 14.17 0 0 0 20 31 L20 55 Z" fill="#D0471F"/>
  <rect x="20" y="47" width="24" height="8" fill="#0E8B86"/>
</svg>`

// Full-bleed (edge-to-edge) — safe for maskable + apple-touch (iOS masks)
const fullbleedSVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect x="0" y="0" width="64" height="64" fill="#FBF7F1"/>
  <path d="M12 55 L12 31 A22.1 22.1 0 0 1 32 9 A22.1 22.1 0 0 1 52 31 L52 55 L44 55 L44 31 A14.17 14.17 0 0 0 32 17 A14.17 14.17 0 0 0 20 31 L20 55 Z" fill="#D0471F"/>
  <rect x="20" y="47" width="24" height="8" fill="#0E8B86"/>
</svg>`

const ROUNDED = [
  ['favicon-16x16.png', 16], ['favicon-32x32.png', 32],
  ['favicon-48x48.png', 48], ['favicon-96x96.png', 96],
]
const FULLBLEED = [
  ['icons/icon-192.png', 192], ['icons/icon-512.png', 512],
  ['android-chrome-192x192.png', 192], ['android-chrome-512x512.png', 512],
  ['apple-touch-icon.png', 180],
]

async function shotSVG(page, svg, size, out) {
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(
    `<!doctype html><style>html,body{margin:0;padding:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    { waitUntil: 'load' })
  await page.locator('svg').screenshot({ path: path.join(PUB, out), omitBackground: true })
  console.log('  ✓', out, `${size}×${size}`)
}

async function shotOG(page) {
  const bric = b64(path.join(ROOT, 'node_modules/@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-opsz-normal.woff2'))
  const schib = b64(path.join(ROOT, 'node_modules/@fontsource-variable/schibsted-grotesk/files/schibsted-grotesk-latin-wght-normal.woff2'))
  const W = 1200, H = 630
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face{font-family:'Bricolage';src:url(data:font/woff2;base64,${bric}) format('woff2');font-weight:200 800;font-display:block}
    @font-face{font-family:'Schibsted';src:url(data:font/woff2;base64,${schib}) format('woff2');font-weight:400 700;font-display:block}
    html,body{margin:0;padding:0}
    .stage{width:${W}px;height:${H}px;box-sizing:border-box;
      background:radial-gradient(120% 140% at 82% -10%, #FFFFFF 0%, #FBF7F1 42%, #F3ECE0 100%);
      display:flex;flex-direction:column;justify-content:center;padding:0 96px;position:relative;overflow:hidden}
    .rule{position:absolute;left:0;top:0;height:12px;width:100%;
      background:linear-gradient(90deg,#E8703F,#D0471F 55%,#B23A16)}
    .mark{width:132px;height:132px}
    .wordmark{font-family:'Bricolage';font-weight:800;font-size:150px;letter-spacing:-.03em;color:#2A2723;line-height:1;margin:34px 0 0}
    .tag{font-family:'Schibsted';font-weight:500;font-size:34px;color:#6B655C;margin-top:22px;max-width:900px;line-height:1.35}
    .eyebrow{font-family:'Schibsted';font-weight:600;font-size:20px;letter-spacing:.24em;text-transform:uppercase;color:#D0471F;margin-top:6px}
  </style></head><body>
    <div class="stage">
      <div class="rule"></div>
      <svg class="mark" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 55 L12 31 A22.1 22.1 0 0 1 32 9 A22.1 22.1 0 0 1 52 31 L52 55 L44 55 L44 31 A14.17 14.17 0 0 0 32 17 A14.17 14.17 0 0 0 20 31 L20 55 Z" fill="#D0471F"/>
  <rect x="20" y="47" width="24" height="8" fill="#0E8B86"/></svg>
      <h1 class="wordmark">Diwan</h1>
      <p class="eyebrow">Office Suite</p>
      <p class="tag">The warm, real-time office suite you own — documents, spreadsheets, slides &amp; whiteboards, one binary, your storage.</p>
    </div>
  </body></html>`
  await page.setViewportSize({ width: W, height: H, deviceScaleFactor: 2 })
  await page.setContent(html, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(150)
  await page.locator('.stage').screenshot({ path: path.join(PUB, 'og-image.png') })
  console.log('  ✓ og-image.png 1200×630 @2x')
}

const browser = await chromium.launch()
const page = await browser.newPage()
console.log('Rounded-tile favicons:')
for (const [out, size] of ROUNDED) await shotSVG(page, roundedSVG, size, out)
console.log('Full-bleed app icons:')
for (const [out, size] of FULLBLEED) await shotSVG(page, fullbleedSVG, size, out)
console.log('Open Graph banner:')
await shotOG(page)
await browser.close()
// Keep a canonical rounded copy for the README header (transparent, 512).
await (async () => {
  const b = await chromium.launch(); const p = await b.newPage()
  await shotSVG(p, roundedSVG, 512, '../docs/assets/diwan-logo.png')
  await b.close()
})()
console.log('Done.')
