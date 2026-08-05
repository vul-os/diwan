/**
 * slideCanvas.test.jsx — tests for the free-positioning object canvas work.
 *
 * Covers:
 *   P1  animations actually play (class resolution + DOM playback + reduced-motion)
 *   P2  object model + migration + CRDT-safety validation/clamp (peer ingress)
 *   P2  SlideCanvas select / drag / resize / rotate interaction
 *   P3  arrange ops: z-order, group/ungroup, align, distribute
 *   Export: PPTX carries object positions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import type pptxgen from 'pptxgenjs'

import {
  ensureObjects, sanitizeObject, sanitizeObjects, clampFinite,
  MAX_OBJECTS_PER_SLIDE, flowContentFromObjects, sortByZ, normalizeZ, sanitizeColor,
  type SlideObject, type TextSlideObject, type ImageSlideObject, type ShapeSlideObject,
} from './slideObjects'
import {
  bringToFront, sendToBack, bringForward, sendBackward,
  groupObjects, ungroupObjects, expandSelectionToGroups, align, distribute,
} from './slideArrange'
import { animationClassFor, playAnimationsOn, prefersReducedMotion, type SlideAnimation } from './slideAnimations'
import SlideCanvas from './SlideCanvas.jsx'

// Test fixtures below are deliberately loose (arrange-op tests only care about
// id/x/y/w/h/z/group; ingress-validation tests deliberately pass malformed
// shapes). Casting through this alias documents that intent once instead of
// scattering `as unknown as SlideObject[]` at each call site.
type Fixture = SlideObject[]

// ── P2: object model + migration ────────────────────────────────────────────
describe('object model — migration (ensureObjects)', () => {
  it('migrates legacy title + content into positioned text objects', () => {
    const slide = { id: 's1', title: 'My Title', content: '<p>Body text</p>' }
    const objs = ensureObjects(slide)
    expect(objs.length).toBe(2)
    expect(objs.every((o) => o.type === 'text')).toBe(true)
    // Title object carries the escaped title inside an <h2>.
    expect((objs[0] as TextSlideObject).html).toContain('My Title')
    expect((objs[1] as TextSlideObject).html).toContain('Body text')
    // All geometry is finite + normalized.
    for (const o of objs) {
      expect(Number.isFinite(o.x)).toBe(true)
      expect(o.x).toBeGreaterThanOrEqual(-2)
      expect(o.w).toBeGreaterThan(0)
    }
  })

  it('escapes HTML in a migrated plain-text title (no injection)', () => {
    const slide = { id: 's', title: '<img src=x onerror=alert(1)>', content: '' }
    const objs = ensureObjects(slide)
    // The <img> is neutralised into inert escaped text (no live element/attr).
    expect((objs[0] as TextSlideObject).html).not.toContain('<img')
    expect((objs[0] as TextSlideObject).html).toContain('&lt;img')
  })

  it('returns existing objects[] when present (sanitized)', () => {
    const slide = {
      id: 's', objects: [
        { id: 'a', type: 'text', x: 0.1, y: 0.1, w: 0.3, h: 0.2, z: 1, html: '<p>hi</p>' },
      ],
    }
    const objs = ensureObjects(slide)
    expect(objs).toHaveLength(1)
    expect(objs[0].id).toBe('a')
  })

  it('seeds a single empty text box for a blank slide', () => {
    const objs = ensureObjects({ id: 's', title: '', content: '<p></p>' })
    expect(objs).toHaveLength(1)
    expect(objs[0].type).toBe('text')
  })
})

// ── P2: CRDT-safety validation (wave-55/56 discipline) ──────────────────────
describe('object ingress validation — sanitizeObject / sanitizeObjects', () => {
  it('clamps non-finite geometry to a safe box', () => {
    const o = sanitizeObject({ type: 'shape', shape: 'rect', x: NaN, y: Infinity, w: -5, h: 'foo' })
    expect(Number.isFinite(o!.x)).toBe(true)
    expect(Number.isFinite(o!.y)).toBe(true)
    expect(o!.w).toBeGreaterThan(0)
    expect(o!.h).toBeGreaterThan(0)
  })

  it('drops objects with an unknown type', () => {
    expect(sanitizeObject({ type: 'evil', x: 0, y: 0, w: 1, h: 1 })).toBeNull()
    expect(sanitizeObject(null)).toBeNull()
    expect(sanitizeObject(42)).toBeNull()
  })

  it('sanitizes untrusted text html (strips script/on*)', () => {
    const o = sanitizeObject({ type: 'text', html: '<p onclick="x">hi</p><script>alert(1)</script>' })
    const text = o as TextSlideObject
    expect(text.html).not.toContain('onclick')
    expect(text.html).not.toContain('<script')
    expect(text.html).toContain('hi')
  })

  it('gates image src — drops an object with an exec-scheme src', () => {
    expect(sanitizeObject({ type: 'image', src: 'javascript:alert(1)' })).toBeNull()
    expect(sanitizeObject({ type: 'image', src: 'data:text/html,<script>' })).toBeNull()
    const ok = sanitizeObject({ type: 'image', src: 'https://example.com/a.png', x: 0, y: 0, w: 0.3, h: 0.3 })
    expect(ok).not.toBeNull()
    expect((ok as ImageSlideObject).src).toBe('https://example.com/a.png')
  })

  it('clamps a hostile z and bounds object count', () => {
    const o = sanitizeObject({ type: 'shape', shape: 'rect', z: 1e12 })
    expect(o!.z).toBeLessThanOrEqual(100000)
    const many = Array.from({ length: MAX_OBJECTS_PER_SLIDE + 50 }, () => ({ type: 'shape', shape: 'rect' }))
    expect(sanitizeObjects(many).length).toBe(MAX_OBJECTS_PER_SLIDE)
  })

  it('sanitizeColor rejects url()/expression() fetch constructs', () => {
    expect(sanitizeColor('url(http://evil)', '#000')).toBe('#000')
    expect(sanitizeColor('expression(alert(1))', '#000')).toBe('#000')
    expect(sanitizeColor('#7c6af7', '#000')).toBe('#7c6af7')
    expect(sanitizeColor('rgba(1,2,3,0.5)', '#000')).toBe('rgba(1,2,3,0.5)')
  })

  it('never throws on arbitrary garbage input', () => {
    expect(() => sanitizeObjects([undefined, {}, [], 'x', { type: 'text', html: 12 }])).not.toThrow()
    expect(() => sanitizeObjects('not-an-array')).not.toThrow()
    expect(sanitizeObjects('not-an-array')).toEqual([])
  })

  it('CRDT round-trip: a valid objects[] survives JSON serialize/parse + re-sanitize', () => {
    const original = [
      { id: 'a', type: 'text', x: 0.1, y: 0.2, w: 0.4, h: 0.3, rotation: 45, z: 2, html: '<p>Round</p>' },
      { id: 'b', type: 'shape', shape: 'star', x: 0.5, y: 0.5, w: 0.2, h: 0.2, z: 1, fill: '#ff0000', stroke: '#00ff00', strokeWidth: 3, opacity: 0.5 },
    ]
    const roundTripped = sanitizeObjects(JSON.parse(JSON.stringify(original)))
    expect(roundTripped).toHaveLength(2)
    const a = roundTripped.find((o) => o.id === 'a')
    expect(a!.rotation).toBe(45)
    expect(a!.x).toBeCloseTo(0.1)
    const b = roundTripped.find((o) => o.id === 'b') as ShapeSlideObject
    expect(b.shape).toBe('star')
    expect(b.fill).toBe('#ff0000')
    expect(b.opacity).toBe(0.5)
  })
})

describe('clampFinite', () => {
  it('clamps to bounds and falls back for non-finite', () => {
    expect(clampFinite(5, 0, 10, 1)).toBe(5)
    expect(clampFinite(-3, 0, 10, 1)).toBe(0)
    expect(clampFinite(99, 0, 10, 1)).toBe(10)
    expect(clampFinite(NaN, 0, 10, 7)).toBe(7)
    expect(clampFinite('nope', 0, 10, 7)).toBe(7)
  })
})

describe('flowContentFromObjects (legacy content sync)', () => {
  it('concatenates text objects top-to-bottom into HTML', () => {
    const html = flowContentFromObjects([
      { id: 'b', type: 'text', x: 0, y: 0.5, w: 1, h: 0.2, html: '<p>second</p>' },
      { id: 'a', type: 'text', x: 0, y: 0.1, w: 1, h: 0.2, html: '<p>first</p>' },
      { id: 'c', type: 'shape', shape: 'rect', x: 0, y: 0, w: 0.2, h: 0.2 },
    ])
    expect(html.indexOf('first')).toBeLessThan(html.indexOf('second'))
  })
})

// ── P1: animation playback ──────────────────────────────────────────────────
describe('animation playback (P1)', () => {
  it('resolves entrance/exit/emphasis effects to distinct CSS classes', () => {
    expect(animationClassFor({ type: 'entrance', effect: 'fade-in', order: 0 })!.className).toBe('vslide-anim-fade-in')
    expect(animationClassFor({ type: 'exit', effect: 'fade-in', order: 0 })!.className).toBe('vslide-anim-fade-out')
    expect(animationClassFor({ type: 'emphasis', effect: 'bounce', order: 1 })!.className).toBe('vslide-anim-bounce-emph')
  })

  it('staggers by order', () => {
    expect(animationClassFor({ type: 'entrance', effect: 'fade-in', order: 0 })!.delayMs).toBe(0)
    expect(animationClassFor({ type: 'entrance', effect: 'fade-in', order: 2 })!.delayMs).toBeGreaterThan(0)
  })

  it('returns null for an unknown effect', () => {
    expect(animationClassFor({ type: 'entrance', effect: 'nope' } as unknown as SlideAnimation)).toBeNull()
    expect(animationClassFor(null)).toBeNull()
  })

  it('applies animation classes to real DOM elements', () => {
    const el = document.createElement('div')
    const cleanup = playAnimationsOn([el], [{ id: 'x', type: 'entrance', effect: 'zoom-in', order: 0 }])
    expect(el.classList.contains('vslide-anim-zoom-in')).toBe(true)
    cleanup()
    expect(el.classList.contains('vslide-anim-zoom-in')).toBe(false)
  })

  it('honours prefers-reduced-motion (no class applied)', () => {
    const el = document.createElement('div')
    // matchMedia is a WebIDL platform-object method (same class as
    // registerProtocolHandler/RTCDataChannel.send elsewhere in this fleet) —
    // bind it to window before holding it bare, so the restored reference
    // below is never a detached, receiver-less call. jsdom itself does not
    // implement matchMedia (slideAnimations.ts's own prefersReducedMotion
    // guards with `typeof window.matchMedia === 'function'` for exactly this
    // reason), so window.matchMedia is undefined here outside of the stub
    // this test installs below — optional-chain the bind so that undefined
    // case round-trips through the finally block instead of throwing.
    const prior = window.matchMedia?.bind(window)
    window.matchMedia = (q: string) => ({
      matches: q.includes('reduce'), media: q, onchange: null, addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false },
    })
    try {
      expect(prefersReducedMotion()).toBe(true)
      playAnimationsOn([el], [{ id: 'x', type: 'entrance', effect: 'fade-in', order: 0 }])
      expect(el.classList.contains('vslide-anim-fade-in')).toBe(false)
    } finally {
      window.matchMedia = prior
    }
  })
})

// ── P3: arrange operations ──────────────────────────────────────────────────
describe('arrange — z-order (P3)', () => {
  const objs = (): Fixture => ([
    { id: 'a', type: 'shape', shape: 'rect', x: 0, y: 0, w: 0.2, h: 0.2, z: 1 },
    { id: 'b', type: 'shape', shape: 'rect', x: 0, y: 0, w: 0.2, h: 0.2, z: 2 },
    { id: 'c', type: 'shape', shape: 'rect', x: 0, y: 0, w: 0.2, h: 0.2, z: 3 },
  ] as unknown as Fixture)
  it('bringToFront moves selection above all others', () => {
    const r = bringToFront(objs(), ['a'])
    const sorted = sortByZ(r).map((o) => o.id)
    expect(sorted[sorted.length - 1]).toBe('a')
  })
  it('sendToBack moves selection below all others', () => {
    const r = sendToBack(objs(), ['c'])
    expect(sortByZ(r)[0].id).toBe('c')
  })
  it('bringForward swaps up one slot', () => {
    const r = bringForward(objs(), ['a'])
    const sorted = sortByZ(r).map((o) => o.id)
    expect(sorted).toEqual(['b', 'a', 'c'])
  })
  it('sendBackward swaps down one slot', () => {
    const r = sendBackward(objs(), ['c'])
    const sorted = sortByZ(r).map((o) => o.id)
    expect(sorted).toEqual(['a', 'c', 'b'])
  })
  it('normalizeZ produces a dense 1..N sequence', () => {
    const r = normalizeZ(objs())
    expect(r.map((o) => o.z).sort((x, y) => x - y)).toEqual([1, 2, 3])
  })
})

describe('arrange — group/ungroup (P3)', () => {
  const objs = (): Fixture => ([
    { id: 'a', type: 'shape', shape: 'rect', x: 0, y: 0, w: 0.2, h: 0.2, z: 1 },
    { id: 'b', type: 'shape', shape: 'rect', x: 0, y: 0, w: 0.2, h: 0.2, z: 2 },
  ] as unknown as Fixture)
  it('group tags selected objects with a shared group id', () => {
    const r = groupObjects(objs(), ['a', 'b'])
    expect(r[0].group).toBeTruthy()
    expect(r[0].group).toBe(r[1].group)
  })
  it('ungroup removes the group tag', () => {
    const grouped = groupObjects(objs(), ['a', 'b'])
    const r = ungroupObjects(grouped, ['a'])
    expect(r[0].group).toBeUndefined()
    expect(r[1].group).toBeUndefined()
  })
  it('expandSelectionToGroups pulls in grouped siblings', () => {
    const grouped = groupObjects(objs(), ['a', 'b'])
    const expanded = expandSelectionToGroups(grouped, ['a'])
    expect(expanded.sort()).toEqual(['a', 'b'])
  })
  it('group is a no-op for a single object', () => {
    const r = groupObjects(objs(), ['a'])
    expect(r[0].group).toBeUndefined()
  })
})

describe('arrange — align + distribute (P3)', () => {
  const objs = (): Fixture => ([
    { id: 'a', type: 'shape', shape: 'rect', x: 0.1, y: 0.1, w: 0.2, h: 0.2, z: 1 },
    { id: 'b', type: 'shape', shape: 'rect', x: 0.5, y: 0.3, w: 0.2, h: 0.2, z: 2 },
    { id: 'c', type: 'shape', shape: 'rect', x: 0.7, y: 0.6, w: 0.2, h: 0.2, z: 3 },
  ] as unknown as Fixture)
  it('align left snaps all to the selection min-x', () => {
    const r = align(objs(), ['a', 'b', 'c'], 'left')
    expect(r.every((o) => o.x === 0.1)).toBe(true)
  })
  it('align top snaps all to the selection min-y', () => {
    const r = align(objs(), ['a', 'b', 'c'], 'top')
    expect(r.every((o) => o.y === 0.1)).toBe(true)
  })
  it('align center on a single object centres it on the slide', () => {
    const r = align(objs(), ['a'], 'center')
    const a = r.find((o) => o.id === 'a')
    expect(a!.x).toBeCloseTo(0.5 - 0.2 / 2)
  })
  it('distribute horizontal evens the centre spacing', () => {
    const r = distribute(objs(), ['a', 'b', 'c'], 'horizontal')
    const cx = (o: SlideObject) => o.x + o.w / 2
    const rc = r.slice().sort((x, y) => cx(x) - cx(y))
    const gap1 = cx(rc[1]) - cx(rc[0])
    const gap2 = cx(rc[2]) - cx(rc[1])
    expect(gap1).toBeCloseTo(gap2)
  })
  it('distribute is a no-op with fewer than 3 objects', () => {
    const two = objs().slice(0, 2)
    expect(distribute(two, ['a', 'b'], 'horizontal')).toEqual(two)
  })
})

// The onChange/onSelect mocks below are typed against SlideCanvas's own prop
// signatures so mock.calls carries real SlideObject[]/opts types instead of
// vi.fn()'s untyped-Procedure default (any[][]).
type OnChangeMock = (next: SlideObject[], opts: { commit: boolean }) => void
type OnSelectMock = (ids: string[]) => void

// ── P2: SlideCanvas interaction ─────────────────────────────────────────────
describe('SlideCanvas interaction (P2)', () => {
  const baseObjects = [
    { id: 'a', type: 'shape', shape: 'rect', x: 0.2, y: 0.2, w: 0.3, h: 0.3, rotation: 0, z: 1, fill: '#7c6af7', stroke: '#5b4dd0', strokeWidth: 2, opacity: 1 },
  ] as unknown as Fixture

  // jsdom has no layout — stub getBoundingClientRect so px⇄fraction maths runs.
  beforeEach(() => {
    Element.prototype.getBoundingClientRect = vi.fn(() => ({
      x: 0, y: 0, left: 0, top: 0, right: 960, bottom: 540, width: 960, height: 540, toJSON() { return {} },
    }))
  })

  it('renders each object with a data-object-id handle', () => {
    render(<SlideCanvas objects={baseObjects} selectedIds={[]} onSelect={() => {}} onChange={() => {}} />)
    expect(document.querySelector('[data-object-id="a"]')).toBeTruthy()
  })

  it('clicking an object selects it', () => {
    const onSelect = vi.fn<OnSelectMock>()
    render(<SlideCanvas objects={baseObjects} selectedIds={[]} onSelect={onSelect} onChange={() => {}} />)
    const el = document.querySelector('[data-object-id="a"]')
    fireEvent.pointerDown(el!, { clientX: 300, clientY: 200 })
    expect(onSelect).toHaveBeenCalledWith(['a'])
  })

  it('dragging a selected object moves it (onChange with new x/y)', () => {
    const onChange = vi.fn<OnChangeMock>()
    render(<SlideCanvas objects={baseObjects} selectedIds={['a']} onSelect={() => {}} onChange={onChange} />)
    const el = document.querySelector('[data-object-id="a"]')
    fireEvent.pointerDown(el!, { clientX: 300, clientY: 200 })
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 400, clientY: 260 }))
      window.dispatchEvent(new MouseEvent('pointerup', {}))
    })
    const moveCall = onChange.mock.calls.find((c) => c[1] && c[1].commit === false)
    expect(moveCall).toBeTruthy()
    const movedA = moveCall![0].find((o) => o.id === 'a')
    // Moved ~100px right (of 960) and ~60px down (of 540).
    expect(movedA!.x).toBeGreaterThan(0.2)
    expect(movedA!.y).toBeGreaterThan(0.2)
  })

  it('resize handle grows the object', () => {
    const onChange = vi.fn<OnChangeMock>()
    render(<SlideCanvas objects={baseObjects} selectedIds={['a']} onSelect={() => {}} onChange={onChange} />)
    const seHandle = screen.getByLabelText('Resize se')
    fireEvent.pointerDown(seHandle, { clientX: 480, clientY: 480 })
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 580, clientY: 580 }))
      window.dispatchEvent(new MouseEvent('pointerup', {}))
    })
    const call = onChange.mock.calls.find((c) => c[1] && c[1].commit === false)
    expect(call).toBeTruthy()
    const a = call![0].find((o) => o.id === 'a')
    expect(a!.w).toBeGreaterThan(0.3)
    expect(a!.h).toBeGreaterThan(0.3)
  })

  it('rotate handle changes rotation', () => {
    const onChange = vi.fn<OnChangeMock>()
    render(<SlideCanvas objects={baseObjects} selectedIds={['a']} onSelect={() => {}} onChange={onChange} />)
    const rot = screen.getByLabelText('Rotate')
    fireEvent.pointerDown(rot, { clientX: 336, clientY: 80 })
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 500, clientY: 300 }))
      window.dispatchEvent(new MouseEvent('pointerup', {}))
    })
    const call = onChange.mock.calls.find((c) => c[1] && c[1].commit === false)
    expect(call).toBeTruthy()
    const a = call![0].find((o) => o.id === 'a')
    expect(a!.rotation).not.toBe(0)
  })

  // Regression: the FINAL commit on pointer-up must carry the DRAGGED geometry,
  // not the stale pre-gesture snapshot. Before the fix, onPointerUp committed the
  // `objects` prop captured when the drag started, so releasing the mouse snapped
  // the object right back to where it began (the live commit:false updates are
  // transient state; the commit:true on release is what persists). We assert the
  // commit:true payload equals the last committed live geometry.
  it('pointer-up commits the dragged geometry, not the original (revert-on-release guard)', () => {
    const onChange = vi.fn<OnChangeMock>()
    render(<SlideCanvas objects={baseObjects} selectedIds={['a']} onSelect={() => {}} onChange={onChange} />)
    const seHandle = screen.getByLabelText('Resize se')
    fireEvent.pointerDown(seHandle, { clientX: 480, clientY: 480 })
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 600, clientY: 600 }))
      window.dispatchEvent(new MouseEvent('pointerup', {}))
    })
    const lastLive = [...onChange.mock.calls].reverse().find((c) => c[1] && c[1].commit === false)
    const committed = [...onChange.mock.calls].reverse().find((c) => c[1] && c[1].commit === true)
    expect(lastLive).toBeTruthy()
    expect(committed).toBeTruthy()
    const grew = lastLive![0].find((o) => o.id === 'a')
    const saved = committed![0].find((o) => o.id === 'a')
    // The persisted object is the enlarged one (w grew past its 0.3 origin), i.e.
    // the release did NOT revert to the original geometry.
    expect(grew!.w).toBeGreaterThan(0.3)
    expect(saved!.w).toBeCloseTo(grew!.w, 5)
    expect(saved!.w).toBeGreaterThan(0.3)
  })

  it('keyboard arrow nudges the selected object', () => {
    const onChange = vi.fn<OnChangeMock>()
    render(<SlideCanvas objects={baseObjects} selectedIds={['a']} onSelect={() => {}} onChange={onChange} />)
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    const call = onChange.mock.calls.find((c) => c[1] && c[1].commit === true)
    expect(call).toBeTruthy()
    expect(call![0].find((o) => o.id === 'a')!.x).toBeGreaterThan(0.2)
  })
})

// ── Accessibility: selection announce + handle affordances (polish/office) ───
describe('SlideCanvas accessibility', () => {
  const baseObjects = [
    { id: 'a', type: 'shape', shape: 'rect', x: 0.2, y: 0.2, w: 0.3, h: 0.3, rotation: 0, z: 1, fill: '#7c6af7', stroke: '#5b4dd0', strokeWidth: 2, opacity: 1 },
    { id: 'b', type: 'text', x: 0.6, y: 0.2, w: 0.3, h: 0.2, rotation: 0, z: 2, html: '<p>hi</p>' },
  ] as unknown as Fixture

  beforeEach(() => {
    Element.prototype.getBoundingClientRect = vi.fn(() => ({
      x: 0, y: 0, left: 0, top: 0, right: 960, bottom: 540, width: 960, height: 540, toJSON() { return {} },
    }))
  })

  it('exposes a polite live region that announces the single selection by type', () => {
    const { rerender } = render(
      <SlideCanvas objects={baseObjects} selectedIds={[]} onSelect={() => {}} onChange={() => {}} />)
    const live = document.querySelector('[role="status"][aria-live="polite"]')
    expect(live).toBeTruthy()
    expect(live!.textContent).toBe('')
    rerender(<SlideCanvas objects={baseObjects} selectedIds={['b']} onSelect={() => {}} onChange={() => {}} />)
    expect(live!.textContent).toBe('text object selected')
  })

  it('announces a multi-selection as a count', () => {
    render(<SlideCanvas objects={baseObjects} selectedIds={['a', 'b']} onSelect={() => {}} onChange={() => {}} />)
    const live = document.querySelector('[role="status"][aria-live="polite"]')
    expect(live!.textContent).toBe('2 objects selected')
  })

  it('marks the selected object aria-pressed and includes "selected" in its label', () => {
    render(<SlideCanvas objects={baseObjects} selectedIds={['a']} onSelect={() => {}} onChange={() => {}} />)
    const el = document.querySelector('[data-object-id="a"]')
    expect(el!.getAttribute('aria-pressed')).toBe('true')
    expect(el!.getAttribute('aria-label')).toContain('selected')
  })

  it('resize + rotate handles carry the affordance classes (hover/focus ladder)', () => {
    render(<SlideCanvas objects={baseObjects} selectedIds={['a']} onSelect={() => {}} onChange={() => {}} />)
    const seHandle = screen.getByLabelText('Resize se')
    expect(seHandle.className).toContain('vslide-handle')
    const rot = screen.getByLabelText('Rotate')
    expect(rot.className).toContain('vslide-rotate')
  })
})

// ── Export: PPTX carries positions ──────────────────────────────────────────
describe('PPTX export fidelity', () => {
  it('addSlide receives positioned text/shape/image with x/y/w/h/rotate', async () => {
    vi.resetModules()
    const addText = vi.fn()
    const addShape = vi.fn()
    const addImage = vi.fn()
    const addNotes = vi.fn()
    const slideObj = { addText, addShape, addImage, addNotes, background: null }
    const addSlide = vi.fn(() => slideObj)
    vi.doMock('pptxgenjs', () => ({
      default: class {
        layout: string
        constructor() { this.layout = '' }
        addSlide() { return addSlide() }
        stream() { return Promise.resolve(new Blob(['x'])) }
      },
    }))
    vi.doMock('file-saver', () => ({ saveAs: vi.fn() }))

    const { exportSlidesToPptx } = await import('./slidesExport.js')
    const data = {
      theme: 'black',
      slides: [{
        id: 's1', background: '', notes: 'n',
        objects: [
          { id: 't', type: 'text', x: 0.1, y: 0.2, w: 0.5, h: 0.3, rotation: 10, z: 1, html: '<h2>Hi</h2>' },
          { id: 'sh', type: 'shape', shape: 'oval', x: 0.5, y: 0.5, w: 0.2, h: 0.2, rotation: 0, z: 2, fill: '#ff0000', stroke: '#00ff00', strokeWidth: 2, opacity: 1 },
          { id: 'im', type: 'image', x: 0.0, y: 0.0, w: 0.4, h: 0.4, rotation: 0, z: 3, src: 'https://example.com/a.png' },
        ],
      }],
    }
    await exportSlidesToPptx(data, 'deck')

    // Text placed with real geometry (0.1 * 13.333 ≈ 1.333in) + rotation.
    expect(addText).toHaveBeenCalled()
    // addText's spy has no generic signature (vi.fn() infers unknown[] args),
    // and vitest's own expect.any() is typed `(constructor: unknown) => any` —
    // both any-return boundaries, typed at this one read/assert site.
    const textOpt = addText.mock.calls[0][1] as pptxgen.TextPropsOptions
    expect(textOpt.x).toBeCloseTo(0.1 * 13.333, 1)
    expect(textOpt.y).toBeCloseTo(0.2 * 7.5, 1)
    expect(textOpt.rotate).toBe(10)

    // Shape mapped to pptx ellipse with positioned box.
    expect(addShape).toHaveBeenCalledWith('ellipse', expect.objectContaining({
      x: expect.any(Number) as number, y: expect.any(Number) as number,
      w: expect.any(Number) as number, h: expect.any(Number) as number,
    }))

    // Image placed via path with geometry.
    expect(addImage).toHaveBeenCalledWith(expect.objectContaining({
      path: 'https://example.com/a.png', x: 0, y: 0,
    }))
    vi.doUnmock('pptxgenjs')
    vi.doUnmock('file-saver')
  })
})
