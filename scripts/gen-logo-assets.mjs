#!/usr/bin/env node
/**
 * gen-logo-assets.mjs — rasterize the canonical Diwan mark into every PNG the
 * repo + PWA manifest need, using headless Chromium so the output is
 * pixel-identical to what browsers render (gradients, sheen, AA).
 *
 * SOURCE OF TRUTH: `brand/logo.svg` (128×128, tile + mark). This script parses
 * it at run time — it does not re-declare the mark's path/rect coordinates as
 * literals — and derives a scaled, tile-less 64-viewBox glyph from it, which
 * `public/logo.svg` and `public/favicon.svg` are then also written from. That
 * way if the approved mark ever changes, every one of these assets changes
 * with it instead of quietly going stale.
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
const BRAND_LOGO = path.join(ROOT, 'brand', 'logo.svg')
const b64 = (p) => readFileSync(p).toString('base64')

// ---------------------------------------------------------------------------
// Parse the approved mark out of brand/logo.svg. This is the one place the
// mark's geometry is read from disk; everything else below is a transform
// (scale, colour-swap, tile-vs-transparent) of what comes out of here.
// ---------------------------------------------------------------------------
function trimNum(n) {
  return Number(n.toFixed(6)).toString()
}

// Tokenize an SVG path `d` string into {cmd, args} commands. Handles the
// commands this mark uses: M/L (2 numeric args), A (7: rx ry xrot laf sweep
// x y — the two flags must NOT be scaled), Z (0 args).
function parsePathD(d) {
  const tokens = d.match(/[MLAZmlaz]|-?\d+(?:\.\d+)?/g)
  if (!tokens) throw new Error(`could not tokenize path data: ${d}`)
  const ARITY = { M: 2, L: 2, A: 7, Z: 0 }
  const commands = []
  let i = 0
  while (i < tokens.length) {
    const cmd = tokens[i]
    if (!(cmd in ARITY)) throw new Error(`unsupported path command "${cmd}" in: ${d}`)
    i += 1
    const n = ARITY[cmd]
    const args = tokens.slice(i, i + n).map(Number)
    if (args.length !== n) throw new Error(`command ${cmd} expected ${n} args, got ${args.length} in: ${d}`)
    i += n
    commands.push({ cmd, args })
  }
  return commands
}

function formatPathD(commands) {
  return commands
    .map((c) => (c.args.length === 0 ? c.cmd : c.cmd + c.args[0] + (c.args.length > 1 ? ' ' + c.args.slice(1).join(' ') : '')))
    .join(' ')
}

function scalePathD(d, factor) {
  const commands = parsePathD(d)
  for (const c of commands) {
    if (c.cmd === 'M' || c.cmd === 'L') {
      c.args = [trimNum(c.args[0] * factor), trimNum(c.args[1] * factor)]
    } else if (c.cmd === 'A') {
      const [rx, ry, rot, laf, sweep, x, y] = c.args
      c.args = [trimNum(rx * factor), trimNum(ry * factor), rot, laf, sweep, trimNum(x * factor), trimNum(y * factor)]
    }
  }
  return formatPathD(commands)
}

function parseBrandMark(svgPath) {
  const src = readFileSync(svgPath, 'utf8')
  const vb = src.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/)
  if (!vb) throw new Error(`${svgPath}: could not find a viewBox`)
  const unit = Number(vb[1])
  if (unit !== Number(vb[2])) throw new Error(`${svgPath}: expected a square viewBox, got ${vb[1]}x${vb[2]}`)

  const pathMatch = src.match(/<path\s+d="([^"]+)"\s+fill="(#[0-9a-fA-F]{3,8})"\s*\/>/)
  if (!pathMatch) throw new Error(`${svgPath}: could not find the mark's <path>`)
  const [, markD, markFill] = pathMatch

  // The threshold bar: the one <rect> that is NOT the full-viewBox background tile.
  const rectMatches = [...src.matchAll(/<rect\s+x="(-?\d+(?:\.\d+)?)"\s+y="(-?\d+(?:\.\d+)?)"\s+width="(\d+(?:\.\d+)?)"\s+height="(\d+(?:\.\d+)?)"\s+fill="(#[0-9a-fA-F]{3,8})"\s*\/>/g)]
  const bar = rectMatches.find((m) => !(Number(m[3]) === unit && Number(m[4]) === unit))
  if (!bar) throw new Error(`${svgPath}: could not find the mark's threshold-bar <rect>`)
  const [, bx, by, bw, bh, barFill] = bar

  return { unit, markD, markFill, bar: { x: Number(bx), y: Number(by), w: Number(bw), h: Number(bh), fill: barFill } }
}

const MARK = parseBrandMark(BRAND_LOGO)
const SCALE = 64 / MARK.unit // brand mark is 128×128; the app's glyph variant is drawn on a 64 viewBox
console.log(
  `[gen-logo-assets] parsed brand/logo.svg: viewBox 0 0 ${MARK.unit} ${MARK.unit}, ` +
    `mark fill ${MARK.markFill}, bar fill ${MARK.bar.fill}, scale ${SCALE} -> 64 viewBox`,
)

const GLYPH_D = scalePathD(MARK.markD, SCALE)
const GLYPH_BAR = {
  x: trimNum(MARK.bar.x * SCALE),
  y: trimNum(MARK.bar.y * SCALE),
  w: trimNum(MARK.bar.w * SCALE),
  h: trimNum(MARK.bar.h * SCALE),
}
const glyphMarkup = () =>
  `<path d="${GLYPH_D}" fill="${MARK.markFill}"/>\n  <rect x="${GLYPH_BAR.x}" y="${GLYPH_BAR.y}" width="${GLYPH_BAR.w}" height="${GLYPH_BAR.h}" fill="${MARK.bar.fill}"/>`

// public/logo.svg + public/favicon.svg: the bare glyph on transparency, at the
// 64-unit viewBox the rest of this script (and the in-app Sidebar mark) uses.
const PUBLIC_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="512" height="512" role="img" aria-labelledby="diwan-title">
  <title id="diwan-title">Diwan</title>
  <!-- The Diwan mark is an iwan: the vaulted portal at the heart of Persian and
       Ottoman architecture — the opening onto the room where the registers were
       kept. Turned a quarter turn clockwise, the arch's two legs become the
       bars of a D and the teal threshold becomes its stem. -->
  ${glyphMarkup()}
</svg>
`
const PUBLIC_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="32" height="32" role="img" aria-labelledby="diwan-title">
  <title id="diwan-title">Diwan</title>
  <!-- An iwan — the vaulted portal. A quarter turn makes it a D. -->
  ${glyphMarkup()}
</svg>
`

// Rounded tile (transparent margin) — the browser-tab / README glyph.
// The iwan is a flat glyph on transparency, so the raster icons give it a warm
// paper ground to sit on rather than inverting its colours. (The paper tile
// itself is a deliberate favicon-specific background choice, independent of
// the mark's own geometry parsed above.)
const roundedSVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect x="2" y="2" width="60" height="60" rx="17" fill="#FBF7F1"/>
  <rect x="2" y="2" width="60" height="60" rx="17" fill="none" stroke="#ECE4D6" stroke-width="1"/>
  ${glyphMarkup()}
</svg>`

// Full-bleed (edge-to-edge) — safe for maskable + apple-touch (iOS masks)
const fullbleedSVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect x="0" y="0" width="64" height="64" fill="#FBF7F1"/>
  ${glyphMarkup()}
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
        ${glyphMarkup()}</svg>
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

console.log('Vector glyph (derived from brand/logo.svg, 64 viewBox):')
writeFileSync(path.join(PUB, 'logo.svg'), PUBLIC_LOGO_SVG)
console.log('  ✓ logo.svg')
writeFileSync(path.join(PUB, 'favicon.svg'), PUBLIC_FAVICON_SVG)
console.log('  ✓ favicon.svg')

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
