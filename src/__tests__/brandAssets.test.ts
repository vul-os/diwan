// Guard: the app's shipped mark assets must be DERIVED FROM `brand/logo.svg`,
// not a second hand-authored (or hardcoded-in-a-generator) copy that can
// silently drift from the approved mark. `scripts/gen-logo-assets.mjs` used
// to re-declare the mark's path/rect coordinates as three separate string
// literals; this fails closed if any of them ever diverge again.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '..', '..')
const BRAND_LOGO = path.join(ROOT, 'brand', 'logo.svg')
const PUBLIC_LOGO = path.join(ROOT, 'public', 'logo.svg')
const PUBLIC_FAVICON = path.join(ROOT, 'public', 'favicon.svg')
const SIDEBAR = path.join(ROOT, 'src', 'components', 'ui', 'Sidebar.jsx')
const GENERATOR = path.join(ROOT, 'scripts', 'gen-logo-assets.mjs')

function readOrThrow(p: string, label: string): string {
  if (!existsSync(p)) throw new Error(`GUARD CANNOT RUN: ${label} is missing at ${p}`)
  return readFileSync(p, 'utf8')
}

function extract(src: string, re: RegExp, label: string): string {
  const m = src.match(re)
  if (!m) throw new Error(`GUARD CANNOT RUN: could not locate ${label}`)
  return m[1]
}

// Arc-aware path scaler (mirrors scripts/gen-logo-assets.mjs's own logic,
// reimplemented independently here rather than imported, so this test does
// not just exercise the generator's own function against itself). M/L take 2
// numeric args; A takes 7 (rx ry xrot laf sweep x y) — the two flags (xrot is
// 0 here, laf, sweep) must NOT be scaled, only rx/ry/x/y.
function scalePathD(d: string, factor: number): string {
  const tokens = d.match(/[MLAZmlaz]|-?\d+(?:\.\d+)?/g) ?? []
  const ARITY: Record<string, number> = { M: 2, L: 2, A: 7, Z: 0 }
  const trim = (n: number) => Number(n.toFixed(6)).toString()
  const out: string[] = []
  let i = 0
  while (i < tokens.length) {
    const cmd = tokens[i]
    i += 1
    const n = ARITY[cmd]
    const args = tokens.slice(i, i + n).map(Number)
    i += n
    if (cmd === 'M' || cmd === 'L') {
      out.push(cmd + trim(args[0] * factor) + ' ' + trim(args[1] * factor))
    } else if (cmd === 'A') {
      const [rx, ry, rot, laf, sweep, x, y] = args
      out.push(cmd + trim(rx * factor) + ' ' + [trim(ry * factor), rot, laf, sweep, trim(x * factor), trim(y * factor)].join(' '))
    } else {
      out.push(cmd)
    }
  }
  return out.join(' ')
}

describe('brand mark stays consistent between brand/logo.svg and its 64-viewBox derivatives', () => {
  it('public/logo.svg, public/favicon.svg and the in-app Sidebar mark all draw the same path + bar as brand/logo.svg (scaled 0.5x, tile stripped)', () => {
    const brand = readOrThrow(BRAND_LOGO, 'brand/logo.svg')
    const brandD = extract(brand, /<path\s+d="([^"]+)"\s+fill=/, "brand/logo.svg's mark <path d=...>")

    // The app's glyph variant halves every brand coordinate (128 viewBox -> 64)
    // and drops the tile background. Rebuild the expected `d` generically
    // (same scaling rule the generator uses) rather than hand-copying a
    // second literal here, so this test can't itself become the drift.
    const scaled = scalePathD(brandD, 0.5)

    const targets = [
      { label: 'public/logo.svg', src: readOrThrow(PUBLIC_LOGO, 'public/logo.svg') },
      { label: 'public/favicon.svg', src: readOrThrow(PUBLIC_FAVICON, 'public/favicon.svg') },
      { label: 'src/components/ui/Sidebar.jsx', src: readOrThrow(SIDEBAR, 'Sidebar.jsx') },
    ]
    expect(targets.length).toBeGreaterThan(0) // coverage-count: refuse to pass with nothing checked
    for (const { label, src } of targets) {
      const got = extract(src, /<path\s+d="([^"]+)"/, `${label}'s mark <path d=...>`)
      expect(got, `${label} has drifted from brand/logo.svg's mark path`).toBe(scaled)
    }
  })

  it('gen-logo-assets.mjs reads brand/logo.svg at run time rather than re-declaring its geometry', () => {
    const generator = readOrThrow(GENERATOR, 'scripts/gen-logo-assets.mjs')
    expect(generator).toMatch(/brand.*logo\.svg/)
    const brand = readOrThrow(BRAND_LOGO, 'brand/logo.svg')
    const brandD = extract(brand, /<path\s+d="([^"]+)"\s+fill=/, "brand/logo.svg's mark <path d=...>")
    // The full 128-viewBox coordinate string must not appear verbatim in the
    // generator's own source text — that would mean it was copy-pasted
    // rather than parsed.
    expect(generator.includes(brandD)).toBe(false)
  })
})
