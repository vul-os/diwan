/**
 * P1 — Real pagination (measured page breaks) + P3 page-setup geometry.
 *
 * jsdom doesn't lay out real pixel heights, so we drive measurePageBreaks with a
 * synthetic content element whose children report controllable getBoundingClient-
 * Rect values. This lets us assert the packing logic deterministically:
 *   - content that fits on one page → no breaks, pageCount 1
 *   - content taller than a page → breaks + correct page count
 *   - an explicit page break forces the next block to a new page
 *   - page-setup geometry (size/orientation/margins) drives contentHeightPx
 */

import { describe, it, expect } from 'vitest'
import { measurePageBreaks, createDebouncedMeasure } from '../pagination.js'
import {
  pageDimensions, normalizePageSetup, pageSetupToCssAtPage,
  PAGE_SIZES, DEFAULT_PAGE_SETUP,
} from '../pageSetup.js'

// measurePageBreaks only reads these members off contentEl / its children — a
// minimal stand-in cast through a narrow local type rather than a real
// HTMLElement (jsdom doesn't lay out real pixel heights anyway).
interface FakeRect {
  top: number
  bottom: number
  height: number
}
interface FakeBlockEl {
  nodeType: number
  getBoundingClientRect: () => FakeRect
  hasAttribute: (name: string) => boolean
  getAttribute: (name: string) => string | null
}
interface FakeContentEl {
  getBoundingClientRect: () => FakeRect
  children: FakeBlockEl[]
}

// Build a fake content element whose children have deterministic layout rects.
// Each block is `blockH` tall, stacked from `top0`. `contentTop` is the
// container's own top. Optionally mark some indices as explicit page breaks.
function fakeContent(
  blockHeights: number[],
  { contentTop = 0, breakIndices = [] as number[] } = {},
): HTMLElement {
  let y = contentTop
  const children: FakeBlockEl[] = blockHeights.map((h, i) => {
    const top = y
    const bottom = y + h
    y = bottom
    const attrs = new Map<string, string>()
    if (breakIndices.includes(i)) attrs.set('data-page-break', 'true')
    return {
      nodeType: 1,
      getBoundingClientRect: () => ({ top, bottom, height: h }),
      hasAttribute: (n: string) => attrs.has(n),
      getAttribute: (n: string) => attrs.get(n) ?? null,
    }
  })
  const totalBottom = y
  const fake: FakeContentEl = {
    getBoundingClientRect: () => ({ top: contentTop, bottom: totalBottom, height: totalBottom - contentTop }),
    children,
  }
  return fake as unknown as HTMLElement
}

describe('measurePageBreaks', () => {
  it('single short page → no breaks, pageCount 1', () => {
    const el = fakeContent([100, 100, 100]) // 300px total
    const { breaks, pageCount } = measurePageBreaks(el, 900)
    expect(breaks).toEqual([])
    expect(pageCount).toBe(1)
  })

  it('content taller than one page → breaks + correct page count', () => {
    // Page content height = 300px. 6 blocks of 100px = 600px → 2 pages.
    const el = fakeContent([100, 100, 100, 100, 100, 100])
    const { breaks, pageCount } = measurePageBreaks(el, 300)
    expect(pageCount).toBeGreaterThanOrEqual(2)
    expect(breaks.length).toBe(pageCount - 1)
    // First break should fall around the 300px mark (block 4 spills page 1).
    expect(breaks[0]).toBeGreaterThan(250)
    expect(breaks[0]).toBeLessThanOrEqual(400)
  })

  it('three pages worth of content produces two breaks', () => {
    const el = fakeContent(new Array<number>(9).fill(100)) // 900px, page = 300 → 3 pages
    const { breaks, pageCount } = measurePageBreaks(el, 300)
    expect(pageCount).toBe(3)
    expect(breaks.length).toBe(2)
    // Breaks are ascending + unique.
    expect(breaks[0]).toBeLessThan(breaks[1])
  })

  it('honours an explicit page break (forces next block to a new page)', () => {
    // 2 blocks of 100px would fit on a 900px page, but block 0 forces a break.
    const el = fakeContent([100, 100], { breakIndices: [0] })
    const { breaks, pageCount } = measurePageBreaks(el, 900)
    expect(pageCount).toBe(2)
    expect(breaks.length).toBe(1)
    expect(breaks[0]).toBe(100) // break at the bottom of block 0
  })

  it('accounts for a container top offset', () => {
    const el = fakeContent([100, 100, 100, 100], { contentTop: 500 })
    const { pageCount } = measurePageBreaks(el, 250) // 400px content, page 250
    expect(pageCount).toBe(2)
  })

  it('returns page 1 for empty content', () => {
    const el = fakeContent([])
    const { breaks, pageCount } = measurePageBreaks(el, 900)
    expect(breaks).toEqual([])
    expect(pageCount).toBe(1)
  })

  it('a block taller than a page does not produce a zero-height page', () => {
    const el = fakeContent([100, 700, 100]) // middle block > page(300)
    const { breaks, pageCount } = measurePageBreaks(el, 300)
    expect(pageCount).toBeGreaterThanOrEqual(2)
    // No duplicate / zero-gap breaks.
    const uniq = new Set(breaks)
    expect(uniq.size).toBe(breaks.length)
  })
})

describe('createDebouncedMeasure', () => {
  it('coalesces bursts and flush runs immediately', async () => {
    let calls = 0
    const d = createDebouncedMeasure(() => { calls++ }, 50)
    d(); d(); d()
    expect(calls).toBe(0)     // debounced, not yet run
    d.flush()
    await new Promise((r) => requestAnimationFrame(r))
    expect(calls).toBe(1)
    d.cancel()
  })
})

// ── P3 page setup geometry ────────────────────────────────────────────────────
describe('pageDimensions (P3)', () => {
  it('Letter portrait: 8.5×11in → 816×1056px at 96dpi', () => {
    const geo = pageDimensions({ size: 'letter', orientation: 'portrait' })
    expect(geo.pageWidthPx).toBe(816)
    expect(geo.pageHeightPx).toBe(1056)
    // 1in margins → content = 6.5×9in = 624×864px.
    expect(geo.contentWidthPx).toBe(624)
    expect(geo.contentHeightPx).toBe(864)
  })

  it('landscape swaps width/height', () => {
    const p = pageDimensions({ size: 'letter', orientation: 'portrait' })
    const l = pageDimensions({ size: 'letter', orientation: 'landscape' })
    expect(l.pageWidthPx).toBe(p.pageHeightPx)
    expect(l.pageHeightPx).toBe(p.pageWidthPx)
  })

  it('A4 and Legal differ from Letter', () => {
    const a4 = pageDimensions({ size: 'a4' })
    const legal = pageDimensions({ size: 'legal' })
    expect(a4.pageHeightPx).not.toBe(legal.pageHeightPx)
    expect(PAGE_SIZES.a4).toBeTruthy()
    expect(PAGE_SIZES.legal).toBeTruthy()
  })

  it('margins drive the content box', () => {
    const wide = pageDimensions({ size: 'letter', margins: { top: 2, right: 2, bottom: 2, left: 2 } })
    const narrow = pageDimensions({ size: 'letter', margins: { top: 0.5, right: 0.5, bottom: 0.5, left: 0.5 } })
    expect(narrow.contentHeightPx).toBeGreaterThan(wide.contentHeightPx)
  })

  it('normalizePageSetup fails closed on hostile / unknown input', () => {
    const bad = normalizePageSetup({ size: 'evil', orientation: 'diagonal', margins: { top: 999, left: -5 } })
    expect(bad.size).toBe(DEFAULT_PAGE_SETUP.size)
    expect(bad.orientation).toBe('portrait')
    expect(bad.margins.top).toBeLessThanOrEqual(4)   // clamped
    expect(bad.margins.left).toBeGreaterThanOrEqual(0)
    expect(normalizePageSetup(null).size).toBe('letter')
    expect(normalizePageSetup('nope').size).toBe('letter')
  })

  it('pageSetupToCssAtPage emits an @page rule', () => {
    const css = pageSetupToCssAtPage({ size: 'a4', orientation: 'landscape', margins: { top: 1, right: 1, bottom: 1, left: 1 } })
    expect(css).toMatch(/@page/)
    expect(css).toMatch(/size:/)
    expect(css).toMatch(/margin:/)
  })
})
