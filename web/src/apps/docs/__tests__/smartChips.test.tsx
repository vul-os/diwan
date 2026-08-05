/**
 * SMART CHIPS — Docs @-menu people/date/file/place chips.
 *
 * Coverage:
 *   1. Pure trigger detection — @query opens the menu, an email does NOT, and
 *      from/to/query are correct.
 *   2. Pure suggestion building — people/files filtered, date (Today/Tomorrow +
 *      parse) with an injected clock, place free-text; people come only from the
 *      passed collaborators.
 *   3. The SmartChip node: insertSmartChip inserts an inline atom that round-trips
 *      through getJSON()/getHTML() carrying chipType/label/ref.
 *   4. SECURITY — a hostile label (`<img onerror>`) renders as INERT TEXT (never
 *      a live element) in getHTML() AND survives sanitizeDocHtml with no markup;
 *      a hostile refHref (javascript:/external URL) is DROPPED on parse and by
 *      isSafeChipHref, so a chip can never navigate off-app.
 *   5. Export preservation — the chip's label survives HTML export (no silent
 *      drop) and carries no script.
 *   6. The @-menu component renders suggestion options for a triggered editor.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'

import {
  SmartChip,
  detectChipTrigger,
  buildChipSuggestions,
  isSafeChipHref,
  routeForFileType,
  MAX_CHIP_LABEL,
} from '../smartChips.js'
import SmartChipMenu from '../components/SmartChipMenu.js'
import { sanitizeDocHtml } from '../../../lib/sanitize'
import { exportToHtml } from '../docsExport.js'
import { saveAs } from 'file-saver'

vi.mock('file-saver', () => ({ saveAs: vi.fn() }))

function makeEditor(content = '<p></p>'): Editor {
  return new Editor({
    extensions: [Document, Paragraph, Text, SmartChip],
    content,
  })
}

let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
  vi.clearAllMocks()
})

// A saveAs Blob argument narrowed away from the `Blob | string` union the real
// file-saver signature allows — this suite only ever hands it a Blob.
function savedBlob(): Blob {
  const data = vi.mocked(saveAs).mock.calls[0][0]
  if (!(data instanceof Blob)) throw new Error('expected saveAs to be called with a Blob')
  return data
}

// ── 1. Trigger detection ─────────────────────────────────────────────────────
describe('detectChipTrigger', () => {
  it('detects @query at the caret', () => {
    editor = makeEditor('<p>hello @bob</p>')
    editor.commands.setTextSelection(editor.state.doc.content.size - 1) // end of text
    editor.commands.focus('end')
    const t = detectChipTrigger(editor.state)
    expect(t).toBeTruthy()
    expect(t!.query).toBe('bob')
    // from/to bound exactly the "@bob" text.
    expect(t!.to - t!.from).toBe(4)
  })

  it('does NOT trigger on an email address', () => {
    editor = makeEditor('<p>mail me at alice@bob</p>')
    editor.commands.focus('end')
    expect(detectChipTrigger(editor.state)).toBeNull()
  })

  it('triggers on a bare @ (empty query)', () => {
    editor = makeEditor('<p>@</p>')
    editor.commands.focus('end')
    const t = detectChipTrigger(editor.state)
    expect(t).toBeTruthy()
    expect(t!.query).toBe('')
  })

  it('returns null when the selection is not collapsed', () => {
    editor = makeEditor('<p>@bob</p>')
    editor.commands.selectAll()
    expect(detectChipTrigger(editor.state)).toBeNull()
  })
})

// ── 2. Suggestion building ───────────────────────────────────────────────────
describe('buildChipSuggestions', () => {
  const now = new Date(2026, 6, 14) // Jul 14 2026 (month is 0-based)
  const people = [{ id: 'alice', name: 'Alice Doe' }, { id: 'bob', name: 'Bob Roe' }]
  const files = [
    { id: 'f1', name: 'Q3 Plan', type: 'doc' },
    { id: 'f2', name: 'Budget', type: 'sheet' },
  ]

  it('filters people by name and only from the passed list', () => {
    const s = buildChipSuggestions('ali', { people, files, now })
    const persons = s.filter((x) => x.chipType === 'person')
    expect(persons).toHaveLength(1)
    expect(persons[0].label).toBe('Alice Doe')
    expect(persons[0].refId).toBe('alice')
  })

  it('builds file chips with a validated internal route', () => {
    const s = buildChipSuggestions('budget', { people, files, now })
    const f = s.find((x) => x.chipType === 'file')
    expect(f).toBeTruthy()
    expect(f!.refHref).toBe('sheets/f2')
    expect(isSafeChipHref(f!.refHref)).toBe(true)
  })

  it('offers Today/Tomorrow using the injected clock', () => {
    const s = buildChipSuggestions('today', { people, files, now })
    const d = s.find((x) => x.chipType === 'date')
    expect(d).toBeTruthy()
    expect(d!.refId).toBe('2026-07-14')
    expect(d!.label).toContain('Jul 14, 2026')
  })

  it('parses an explicit ISO date query', () => {
    const s = buildChipSuggestions('2026-08-01', { people, files, now })
    const d = s.find((x) => x.chipType === 'date' && x.refId === '2026-08-01')
    expect(d).toBeTruthy()
  })

  it('offers a free-text place chip for a non-empty query', () => {
    const s = buildChipSuggestions('Paris Office', { people, files, now })
    const p = s.find((x) => x.chipType === 'place')
    expect(p).toBeTruthy()
    expect(p!.label).toBe('Paris Office')
  })
})

// ── routeForFileType ─────────────────────────────────────────────────────────
describe('routeForFileType', () => {
  it('maps known types and rejects unknown', () => {
    expect(routeForFileType('doc')).toBe('docs')
    expect(routeForFileType('sheet')).toBe('sheets')
    expect(routeForFileType('presentation')).toBe('slides')
    expect(routeForFileType('mystery')).toBeNull()
  })
})

// ── 3. Node insertion + round-trip ───────────────────────────────────────────
describe('SmartChip node', () => {
  it('inserts a chip that round-trips through getJSON/getHTML', () => {
    editor = makeEditor('<p>hi </p>')
    editor.commands.focus('end')
    editor.commands.insertSmartChip({ chipType: 'person', label: 'Alice Doe', refId: 'alice' })
    const json = editor.getJSON()
    const chip = JSON.stringify(json).includes('"smartChip"')
    expect(chip).toBe(true)
    const html = editor.getHTML()
    expect(html).toContain('data-smart-chip')
    expect(html).toContain('data-chip-type="person"')
    expect(html).toContain('Alice Doe')

    // Re-parse the HTML back into a fresh editor: the chip survives.
    const e2 = makeEditor(html)
    expect(JSON.stringify(e2.getJSON())).toContain('"smartChip"')
    e2.destroy()
  })

  it('clamps an over-long label', () => {
    editor = makeEditor('<p></p>')
    editor.commands.insertSmartChip({ chipType: 'place', label: 'x'.repeat(500) })
    // node.attrs is ProseMirror's own Attrs (`{[key: string]: any}`).
    const rawLabel: unknown = editor.getJSON().content![0].content!.find((n) => n.type === 'smartChip')!.attrs!.label
    const label = typeof rawLabel === 'string' ? rawLabel : ''
    expect(label.length).toBe(MAX_CHIP_LABEL)
  })
})

// ── 4. SECURITY ──────────────────────────────────────────────────────────────
describe('SmartChip security', () => {
  it('renders a hostile label as inert text (no live element)', () => {
    editor = makeEditor('<p></p>')
    editor.commands.insertSmartChip({
      chipType: 'place',
      label: '<img src=x onerror=alert(1)>',
    })
    const html = editor.getHTML()
    // The label is a text node — the angle brackets are escaped, never an <img>.
    expect(html).not.toMatch(/<img/i)
    expect(html).toContain('&lt;img')
    // And it survives the export sanitiser with no LIVE markup. Parse the
    // sanitised HTML into a real DOM and assert the true security property: no
    // <img> ELEMENT exists and no element carries an onerror HANDLER attribute.
    // (The word "onerror" surviving as ESCAPED text content is correct/inert.)
    const clean = sanitizeDocHtml(html)
    const dom = new DOMParser().parseFromString(clean, 'text/html')
    expect(dom.querySelector('img')).toBeNull()
    expect(dom.querySelector('[onerror]')).toBeNull()
    // The label round-trips as visible text.
    expect(dom.body.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('drops a hostile refHref on parse (only internal routes survive)', () => {
    // A malicious import carrying a javascript: href on a chip.
    const hostile =
      '<p><span data-smart-chip data-chip-type="file" data-chip-label="evil" ' +
      'data-chip-href="javascript:alert(1)">evil</span></p>'
    editor = makeEditor(hostile)
    const chip = editor.getJSON().content![0].content!.find((n) => n.type === 'smartChip')
    expect(chip!.attrs!.refHref).toBe('')
    expect(editor.getHTML()).not.toContain('javascript:')
  })

  it('isSafeChipHref accepts only allow-listed internal routes', () => {
    expect(isSafeChipHref('docs/abc123')).toBe(true)
    expect(isSafeChipHref('sheets/f2')).toBe(true)
    expect(isSafeChipHref('javascript:alert(1)')).toBe(false)
    expect(isSafeChipHref('https://evil.example/x')).toBe(false)
    expect(isSafeChipHref('../../etc/passwd')).toBe(false)
    expect(isSafeChipHref('docs/a/b')).toBe(false)
  })
})

// ── 5. Export preservation ───────────────────────────────────────────────────
describe('SmartChip export', () => {
  it('preserves the chip label in HTML export with no script', () => {
    editor = makeEditor('<p>See </p>')
    editor.commands.focus('end')
    editor.commands.insertSmartChip({ chipType: 'date', label: 'Jul 14, 2026', refId: '2026-07-14' })
    exportToHtml(editor, 'doc')
    expect(saveAs).toHaveBeenCalled()
    const blob = savedBlob()
    return blob.text().then((txt) => {
      expect(txt).toContain('Jul 14, 2026')
      expect(txt).not.toMatch(/<script/i)
    })
  })
})

// ── 6. Menu component ────────────────────────────────────────────────────────
describe('SmartChipMenu', () => {
  it('renders suggestion options for a triggered editor', () => {
    editor = makeEditor('<p>@a</p>')
    editor.commands.focus('end')
    render(
      <SmartChipMenu
        editor={editor}
        people={[{ id: 'alice', name: 'Alice Doe' }]}
        files={[{ id: 'f1', name: 'Apollo', type: 'doc' }]}
      />,
    )
    // The trigger recompute runs on mount via selectionUpdate/update; force it by
    // dispatching a no-op selection so the effect fires.
    editor.commands.focus('end')
    const menu = screen.queryByTestId('smart-chip-menu')
    expect(menu).toBeTruthy()
    // Alice matches "@a"; a place chip is always offered for a non-empty query.
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0)
  })
})
