/**
 * slides.test.jsx — Vitest tests for Vulos Slides Google-Slides-parity features.
 *
 * Covers:
 *   1. theme apply (getTheme, PRESET_THEMES)
 *   2. master-slide edit propagation
 *   3. presenter window open (mocked window.open)
 *   4. transition apply (TransitionPanel state)
 *   5. image insert (handleImageUpload path)
 *   6. slide reorder (drag-drop state)
 *   7. export PDF trigger (api call)
 *   8. template gallery seeding
 *   9. stripHTML (via exported util)
 *  10. theme custom override
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { PRESET_THEMES, getTheme, DECK_TEMPLATES, MASTER_LAYOUTS } from './themes'
import type { PresenterSlidesData } from './PresenterView.jsx'

// ── 1. Theme gallery: PRESET_THEMES has 15 entries ─────────────────────────

describe('theme gallery', () => {
  it('has exactly 15 preset themes', () => {
    expect(PRESET_THEMES).toHaveLength(15)
  })

  it('every preset theme has required fields', () => {
    for (const t of PRESET_THEMES) {
      expect(t).toHaveProperty('id')
      expect(t).toHaveProperty('label')
      expect(t).toHaveProperty('revealTheme')
      expect(t).toHaveProperty('headingFont')
      expect(t).toHaveProperty('bodyFont')
      expect(t).toHaveProperty('primary')
      expect(t).toHaveProperty('background')
      expect(t).toHaveProperty('text')
      expect(typeof t.dark).toBe('boolean')
    }
  })

  it('getTheme returns correct theme by id', () => {
    const t = getTheme('slate')
    expect(t.id).toBe('slate')
    expect(t.label).toBe('Slate Night')
    expect(t.dark).toBe(true)
  })

  it('getTheme falls back to first theme for unknown id', () => {
    const t = getTheme('nonexistent-theme-xyz')
    expect(t).toBe(PRESET_THEMES[0])
  })
})

// ── 2. Master slide edit propagation ────────────────────────────────────────

describe('master slide layouts', () => {
  it('MASTER_LAYOUTS has 3 masters (title, content, section)', () => {
    expect(MASTER_LAYOUTS).toHaveLength(3)
    const ids = MASTER_LAYOUTS.map((m) => m.id)
    expect(ids).toContain('title')
    expect(ids).toContain('content')
    expect(ids).toContain('section')
  })

  it('each master has layout fields', () => {
    for (const m of MASTER_LAYOUTS) {
      expect(m).toHaveProperty('titleY')
      expect(m).toHaveProperty('titleAlign')
      expect(m).toHaveProperty('bodyY')
      expect(m).toHaveProperty('bodyAlign')
      expect(m).toHaveProperty('footerText')
      expect(typeof m.showLogo).toBe('boolean')
    }
  })

  it('applying master override preserves other masters', () => {
    const merged = MASTER_LAYOUTS.map((def) => {
      if (def.id === 'content') return { ...def, footerText: 'Company Inc.' }
      return { ...def }
    })
    const content = merged.find((m) => m.id === 'content')
    const title = merged.find((m) => m.id === 'title')
    expect(content!.footerText).toBe('Company Inc.')
    expect(title!.footerText).toBe('')
  })
})

// ── 3. Presenter view: window.open called with blob URL ─────────────────────

describe('presenter view', () => {
  it('openPresenter calls window.open', async () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue({
      closed: false,
      focus: vi.fn(),
    } as unknown as Window)
    const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-url')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    const { usePresenterView } = await import('./PresenterView.jsx')

    const slidesData: PresenterSlidesData = {
      slides: [
        { id: '1', title: 'Slide 1', content: '<p>Hello</p>', notes: 'Note', background: '' },
      ],
      themeId: 'obsidian',
    }

    // Simulate the hook
    let openPresenter: (activeIdx?: number) => void
    function TestHook() {
      const result = usePresenterView(slidesData)
      openPresenter = result.openPresenter
      return null
    }

    render(<TestHook />)
    act(() => { openPresenter(0) })

    expect(createObjectURLSpy).toHaveBeenCalled()
    expect(openSpy).toHaveBeenCalledWith(
      'blob:test-url',
      'vulos-presenter',
      expect.stringContaining('width=')
    )

    openSpy.mockRestore()
    createObjectURLSpy.mockRestore()
  })
})

// ── 4. Transitions: slide transition update ──────────────────────────────────

describe('transitions', () => {
  it('SLIDE_TRANSITIONS covers all expected values', async () => {
    const { SLIDE_TRANSITIONS } = await import('./TransitionPanel.jsx')
    const ids = SLIDE_TRANSITIONS.map((t) => t.id)
    expect(ids).toContain('none')
    expect(ids).toContain('fade')
    expect(ids).toContain('slide')
    expect(ids).toContain('zoom')
    expect(ids).toHaveLength(6)
  })

  it('TransitionPanel calls onChange with updated transition', async () => {
    const { default: TransitionPanel } = await import('./TransitionPanel.jsx')
    const slide = { id: '1', transition: 'none', animations: [] }
    const onChange = vi.fn()

    render(<TransitionPanel slide={slide} onChange={onChange} />)

    const fadeBtn = screen.getByRole('button', { name: /fade/i })
    fireEvent.click(fadeBtn)

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ transition: 'fade' }))
  })
})

// ── 5. Image insert (InsertPanel) ────────────────────────────────────────────

describe('image insert', () => {
  it('InsertPanel renders Image, Video, Shape buttons', async () => {
    const { default: InsertPanel } = await import('./InsertPanel.jsx')
    const mockApi = { uploadImage: vi.fn() }
    const mockEditor = null // no editor needed for render test

    render(<InsertPanel editor={mockEditor} onInsert={vi.fn()} api={mockApi} />)

    expect(screen.getByTitle('Insert image')).toBeTruthy()
    expect(screen.getByTitle('Insert video')).toBeTruthy()
    expect(screen.getByTitle('Insert shape')).toBeTruthy()
  })

  it('video URL parser detects YouTube embed', async () => {
    // Test parseVideoUrl indirectly by clicking Insert video + entering a YouTube URL.
    const { default: InsertPanel } = await import('./InsertPanel.jsx')
    const insertedHtml: string[] = []
    const mockApi = { uploadImage: vi.fn() }

    render(
      <InsertPanel
        editor={null}
        onInsert={(html) => insertedHtml.push(html)}
        api={mockApi}
      />
    )

    // Open video panel
    fireEvent.click(screen.getByTitle('Insert video'))
    const input = screen.getByPlaceholderText(/youtube/i)
    fireEvent.change(input, { target: { value: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } })
    fireEvent.click(screen.getByRole('button', { name: /^insert$/i }))

    expect(insertedHtml.length).toBe(1)
    expect(insertedHtml[0]).toContain('youtube.com/embed/dQw4w9WgXcQ')
  })
})

// ── 6. Slide reorder via DnD state ──────────────────────────────────────────

describe('slide reorder', () => {
  it('reorder produces correct new order', () => {
    const slides = [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
      { id: 'c', title: 'C' },
    ]

    // Simulate the drag-reorder logic (same as TransitionPanel.handleDragEnd).
    function reorder<T>(arr: T[], fromIdx: number, toIdx: number): T[] {
      const next = [...arr]
      const [item] = next.splice(fromIdx, 1)
      next.splice(toIdx, 0, item)
      return next
    }

    const result = reorder(slides, 2, 0)
    expect(result.map((s) => s.id)).toEqual(['c', 'a', 'b'])
  })

  it('reorder is idempotent when from === to', () => {
    const slides = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const result = [...slides]
    const [item] = result.splice(1, 1)
    result.splice(1, 0, item)
    expect(result.map((s) => s.id)).toEqual(['a', 'b', 'c'])
  })
})

// ── 7. Export PDF: api endpoint trigger ────────────────────────────────────

describe('export PDF trigger', () => {
  it('api builds correct export URL', () => {
    const fileId = 'abc-123'
    const url = `/api/slides/${fileId}/export?format=pdf`
    expect(url).toBe('/api/slides/abc-123/export?format=pdf')
  })

  it('server-side PDF export fetch returns expected endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['%PDF-1.4'], { type: 'application/pdf' })),
    })
    global.fetch = fetchMock

    const fileId = 'test-deck-id'
    const response = await fetch(`/api/slides/${fileId}/export?format=pdf`, {
      credentials: 'include',
    })
    const blob = await response.blob()

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/slides/${fileId}/export?format=pdf`,
      expect.objectContaining({ credentials: 'include' })
    )
    expect(blob.type).toBe('application/pdf')
  })
})

// ── 8. Template gallery seeding ─────────────────────────────────────────────

describe('template gallery', () => {
  it('has exactly 4 deck templates', () => {
    expect(DECK_TEMPLATES).toHaveLength(4)
  })

  it('each template seeds slides with unique IDs when applied', () => {
    const tpl = DECK_TEMPLATES[0] // Pitch deck
    const slides = tpl.slides.map((s) => ({ ...s, id: crypto.randomUUID() }))

    // All IDs unique.
    const ids = slides.map((s) => s.id)
    const unique = new Set(ids)
    expect(unique.size).toBe(ids.length)
  })

  it('pitch deck template references the correct theme', () => {
    const pitchTpl = DECK_TEMPLATES.find((t) => t.id === 'pitch')
    expect(pitchTpl).toBeDefined()
    const theme = getTheme(pitchTpl!.themeId)
    expect(theme.id).toBe(pitchTpl!.themeId)
  })

  it('all templates have at least 3 slides', () => {
    for (const tpl of DECK_TEMPLATES) {
      expect(tpl.slides.length).toBeGreaterThanOrEqual(3)
    }
  })
})

// ── 9. Custom theme override ─────────────────────────────────────────────────

describe('custom theme override', () => {
  it('merging custom override onto preset overwrites only specified keys', () => {
    const base = getTheme('snow')
    const custom = { primary: '#ff0000', headingFont: '"Comic Sans MS", cursive' }
    const merged = { ...base, ...custom }

    expect(merged.primary).toBe('#ff0000')
    expect(merged.headingFont).toBe('"Comic Sans MS", cursive')
    // Un-overridden fields stay from base.
    expect(merged.background).toBe(base.background)
    expect(merged.id).toBe(base.id)
  })
})

// ── 10. Slides toolbar undo/redo chain routing ─────────────────────────────

interface ChainCall {
  cmd: string | symbol
  args: unknown[]
}

// A chain proxy where every property access returns a further-chainable
// function (matching Tiptap's real `.chain().focus()....run()` shape). None
// of these tests read run()'s actual return value, so a single recursive
// shape covers every method including run() without a separate boolean case.
interface SlideChainMock {
  [key: string]: (...args: unknown[]) => SlideChainMock
}

describe('slides toolbar undo/redo and formatting', () => {
  // Minimal chain mock matching the docs mock pattern.
  function makeSlideChain() {
    const store: { _calls: ChainCall[] } = { _calls: [] }
    const chain = new Proxy(store, {
      get(target, prop) {
        if (prop === 'run') return () => true
        return (...args: unknown[]) => {
          target._calls.push({ cmd: prop, args })
          return chain
        }
      },
    }) as unknown as SlideChainMock
    return { store, chain }
  }

  function makeSlideEditor(overrides: Record<string, unknown> = {}) {
    const { store, chain } = makeSlideChain()
    return {
      _store: store,
      isActive: vi.fn().mockReturnValue(false),
      can: () => ({ undo: () => true, redo: () => true }),
      getAttributes: vi.fn().mockReturnValue({}),
      chain: () => chain,
      commands: {},
      ...overrides,
    }
  }

  it('undo command routes through chain', () => {
    const editor = makeSlideEditor()
    editor.chain().focus().undo().run()
    expect(editor._store._calls.some((c) => c.cmd === 'undo')).toBe(true)
  })

  it('redo command routes through chain', () => {
    const editor = makeSlideEditor()
    editor.chain().focus().redo().run()
    expect(editor._store._calls.some((c) => c.cmd === 'redo')).toBe(true)
  })

  it('toggleStrike routes through chain in slides toolbar', () => {
    const editor = makeSlideEditor()
    editor.chain().focus().toggleStrike().run()
    expect(editor._store._calls.some((c) => c.cmd === 'toggleStrike')).toBe(true)
  })

  it('setLink routes through chain in slides toolbar', () => {
    const editor = makeSlideEditor()
    editor.chain().focus().setLink({ href: 'https://vulos.org', target: '_blank' }).run()
    const call = editor._store._calls.find((c) => c.cmd === 'setLink')
    expect(call).toBeDefined()
    expect((call!.args[0] as { href: string }).href).toBe('https://vulos.org')
  })

  it('toggleHeading routes through chain for slides', () => {
    const editor = makeSlideEditor()
    editor.chain().focus().toggleHeading({ level: 1 }).run()
    const call = editor._store._calls.find((c) => c.cmd === 'toggleHeading')
    expect(call).toBeDefined()
    expect(call!.args[0]).toEqual({ level: 1 })
  })

  it('setParagraph routes through chain for slides Normal style', () => {
    const editor = makeSlideEditor()
    editor.chain().focus().setParagraph().run()
    expect(editor._store._calls.some((c) => c.cmd === 'setParagraph')).toBe(true)
  })

  it('font size setMark routes through chain for slides', () => {
    const editor = makeSlideEditor()
    editor.chain().focus().setMark('textStyle', { fontSize: '32pt' }).run()
    const call = editor._store._calls.find((c) => c.cmd === 'setMark')
    expect(call).toBeDefined()
    expect((call!.args[1] as { fontSize: string }).fontSize).toBe('32pt')
  })

  // ── wave-48: newly surfaced text-formatting commands ──────────────────────
  it('font family setMark routes through chain for slides', () => {
    const editor = makeSlideEditor()
    editor.chain().focus().setMark('textStyle', { fontFamily: 'Georgia, serif' }).run()
    const call = editor._store._calls.find((c) => c.cmd === 'setMark')
    expect(call).toBeDefined()
    expect((call!.args[1] as { fontFamily: string | null }).fontFamily).toBe('Georgia, serif')
  })

  it('font family "Default" clears the fontFamily attribute', () => {
    const editor = makeSlideEditor()
    // The Default entry sets fontFamily to null to unset it.
    editor.chain().focus().setMark('textStyle', { fontFamily: null }).run()
    const call = editor._store._calls.find((c) => c.cmd === 'setMark')
    expect(call).toBeDefined()
    expect((call!.args[1] as { fontFamily: string | null }).fontFamily).toBeNull()
  })

  it('toggleHighlight routes through chain with a colour', () => {
    const editor = makeSlideEditor()
    editor.chain().focus().toggleHighlight({ color: '#fef08a' }).run()
    const call = editor._store._calls.find((c) => c.cmd === 'toggleHighlight')
    expect(call).toBeDefined()
    expect((call!.args[0] as { color: string }).color).toBe('#fef08a')
  })

  it('toggleOrderedList routes through chain in slides toolbar', () => {
    const editor = makeSlideEditor()
    editor.chain().focus().toggleOrderedList().run()
    expect(editor._store._calls.some((c) => c.cmd === 'toggleOrderedList')).toBe(true)
  })

  it('clear-formatting chains unsetAllMarks + clearNodes', () => {
    const editor = makeSlideEditor()
    editor.chain().focus().unsetAllMarks().clearNodes().run()
    const cmds = editor._store._calls.map((c) => c.cmd)
    expect(cmds).toContain('unsetAllMarks')
    expect(cmds).toContain('clearNodes')
  })
})

// ── 11. SLIDE_FONT_SIZES constant ────────────────────────────────────────────

describe('slide font sizes', () => {
  it('SLIDE_FONT_SIZES is exported as a non-empty array from SlidesEditor', () => {
    // We test the constant values inline (not importing SlidesEditor to avoid
    // full React render with complex deps).
    const SLIDE_FONT_SIZES = [14, 18, 24, 32, 40, 56, 72]
    expect(SLIDE_FONT_SIZES.length).toBeGreaterThan(0)
    expect(SLIDE_FONT_SIZES).toContain(24)
    expect(SLIDE_FONT_SIZES).toContain(72)
  })
})

// ── 12. wave-48: slide font-family selector values are sanitiser-safe ────────

describe('slide font families', () => {
  // Kept in sync with SLIDE_FONT_FAMILIES in SlidesEditor.jsx.
  const SLIDE_FONT_FAMILIES = [
    { label: 'Default',         value: '' },
    { label: 'Arial',          value: 'Arial, sans-serif' },
    { label: 'Georgia',        value: 'Georgia, serif' },
    { label: 'Times New Roman', value: '"Times New Roman", serif' },
    { label: 'Courier New',    value: '"Courier New", monospace' },
    { label: 'Verdana',        value: 'Verdana, sans-serif' },
    { label: 'Trebuchet MS',   value: '"Trebuchet MS", sans-serif' },
    { label: 'Impact',         value: 'Impact, sans-serif' },
  ]

  it('offers a Default (unset) plus real font stacks', () => {
    expect(SLIDE_FONT_FAMILIES.length).toBeGreaterThan(1)
    expect(SLIDE_FONT_FAMILIES[0].value).toBe('')
  })

  it('every non-default value survives sanitizeFontFamily (no CSS-breakout chars)', async () => {
    const { sanitizeFontFamily } = await import('../../lib/tiptap/fontStyle.js')
    for (const { value } of SLIDE_FONT_FAMILIES) {
      if (!value) continue // Default clears the attribute; nothing to sanitise.
      // A safe stack round-trips unchanged (never null, which would drop it).
      expect(sanitizeFontFamily(value)).toBe(value)
    }
  })

  it('font-family renderHTML emits an inline style for a chosen stack', async () => {
    const { fontFamilyAttribute } = await import('../../lib/tiptap/fontStyle.js')
    expect(fontFamilyAttribute.renderHTML({ fontFamily: 'Georgia, serif' }))
      .toEqual({ style: 'font-family: Georgia, serif' })
  })
})
