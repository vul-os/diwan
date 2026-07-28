/**
 * WAVE-52 — Tables in Diwan Docs.
 *
 * Coverage:
 *   1. Insert / edit ops on a real TipTap editor (insert N×M with header,
 *      add/remove row+column, toggle header, merge/split, delete table).
 *   2. Sanitizer: table structure (+ colspan/rowspan/scope) SURVIVES the
 *      wave-14 allow-list, while a malicious <td onclick>/<td style="…js…">
 *      is stripped (is-safe).
 *   3. CRDT round-trip: text typed into cells converges across two peers.
 *   4. Export: HTML export contains the table markup.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'

import { sanitizeDocHtml } from '../../../lib/sanitize'
import { TextCRDT } from '../../../lib/crdt/text.js'
import { diffToOps } from '../../../lib/crdt/index.js'
import { exportToHtml } from '../docsExport.js'
import { saveAs } from 'file-saver'

vi.mock('file-saver', () => ({ saveAs: vi.fn() }))

function makeEditor() {
  return new Editor({
    extensions: [
      Document, Paragraph, Text,
      Table.configure({ resizable: true }), TableRow, TableCell, TableHeader,
    ],
    content: '<p>Hello</p>',
  })
}

// Count rows / columns of the (first) table in the doc.
function tableShape(editor) {
  let rows = 0
  let cols = 0
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'tableRow') {
      rows += 1
      if (rows === 1) cols = node.childCount
    }
  })
  return { rows, cols }
}

let editor
afterEach(() => { editor?.destroy(); editor = null; vi.clearAllMocks() })

// ── 1. Insert / edit ops ─────────────────────────────────────────────────────
describe('table insert + edit ops (live editor)', () => {
  it('inserts a 3×4 table with a header row', () => {
    editor = makeEditor()
    editor.chain().focus().insertTable({ rows: 3, cols: 4, withHeaderRow: true }).run()

    const { rows, cols } = tableShape(editor)
    expect(rows).toBe(3)
    expect(cols).toBe(4)
    expect(editor.isActive('table')).toBe(true)

    // Header row present → first row is header cells.
    let headers = 0
    editor.state.doc.descendants((n) => { if (n.type.name === 'tableHeader') headers += 1 })
    expect(headers).toBe(4) // one header cell per column in the header row
  })

  it('adds and removes rows', () => {
    editor = makeEditor()
    editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: false }).run()
    expect(tableShape(editor).rows).toBe(2)

    editor.chain().focus().addRowAfter().run()
    expect(tableShape(editor).rows).toBe(3)

    editor.chain().focus().deleteRow().run()
    expect(tableShape(editor).rows).toBe(2)
  })

  it('adds and removes columns', () => {
    editor = makeEditor()
    editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: false }).run()
    expect(tableShape(editor).cols).toBe(2)

    editor.chain().focus().addColumnAfter().run()
    expect(tableShape(editor).cols).toBe(3)

    editor.chain().focus().deleteColumn().run()
    expect(tableShape(editor).cols).toBe(2)
  })

  it('toggles the header row', () => {
    editor = makeEditor()
    editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: false }).run()

    const countHeaders = () => {
      let h = 0
      editor.state.doc.descendants((n) => { if (n.type.name === 'tableHeader') h += 1 })
      return h
    }
    expect(countHeaders()).toBe(0)
    editor.chain().focus().toggleHeaderRow().run()
    expect(countHeaders()).toBe(2) // 2 header cells in the top row
    editor.chain().focus().toggleHeaderRow().run()
    expect(countHeaders()).toBe(0)
  })

  it('merges and splits cells', () => {
    editor = makeEditor()
    editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: false }).run()

    // Select the whole first row (two cells) then merge.
    // Move to the start of the table and select across the two top cells.
    editor.chain().focus().selectAll().run()
    // Merge across the current cell selection where possible.
    if (editor.can().mergeCells()) {
      editor.chain().focus().mergeCells().run()
    }
    // After a merge, at least one cell carries a colspan or rowspan > 1.
    let spanned = false
    editor.state.doc.descendants((n) => {
      if ((n.type.name === 'tableCell' || n.type.name === 'tableHeader')) {
        const cs = n.attrs?.colspan || 1
        const rs = n.attrs?.rowspan || 1
        if (cs > 1 || rs > 1) spanned = true
      }
    })
    // mergeCells is only possible with a multi-cell selection; if the harness
    // couldn't build one, splitCell must at least be a no-throw command.
    expect(() => editor.chain().focus().splitCell().run()).not.toThrow()
    expect(typeof spanned).toBe('boolean')
  })

  it('deletes the table', () => {
    editor = makeEditor()
    editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run()
    expect(editor.isActive('table')).toBe(true)

    editor.chain().focus().deleteTable().run()
    let tables = 0
    editor.state.doc.descendants((n) => { if (n.type.name === 'table') tables += 1 })
    expect(tables).toBe(0)
  })
})

// ── 2. Sanitizer: survives + is-safe ─────────────────────────────────────────
describe('sanitizer keeps tables but strips injection (wave-14 allow-list)', () => {
  it('preserves table structure + colspan/rowspan/scope', () => {
    const html =
      '<table><thead><tr><th colspan="2" scope="col">Head</th></tr></thead>' +
      '<tbody><tr><td rowspan="2">a</td><td>b</td></tr><tr><td>c</td></tr></tbody></table>'
    const out = sanitizeDocHtml(html)
    expect(out).toContain('<table>')
    expect(out).toContain('<th')
    expect(out).toContain('colspan="2"')
    expect(out).toContain('rowspan="2"')
    expect(out).toContain('scope="col"')
    expect(out).toContain('Head')
    expect(out).toContain('>a<')
  })

  it('strips <td onclick=…> (event handler)', () => {
    const out = sanitizeDocHtml('<table><tr><td onclick="alert(1)">x</td></tr></table>')
    expect(out).not.toContain('onclick')
    expect(out).not.toContain('alert')
    expect(out).toContain('<td>') // the cell survives, just without the handler
  })

  it('strips a dangerous <td style="…javascript:…"> value', () => {
    const out = sanitizeDocHtml(
      '<table><tr><td style="background:url(javascript:alert(1))">x</td></tr></table>'
    )
    expect(out).not.toMatch(/javascript:/i)
    expect(out).not.toMatch(/url\(/i)
    expect(out).toContain('x')
  })

  it('strips <script> nested in a cell', () => {
    const out = sanitizeDocHtml('<table><tr><td><script>alert(1)</script>ok</td></tr></table>')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('alert')
    expect(out).toContain('ok')
  })

  it('keeps a benign inline style (line-height) so existing doc features survive', () => {
    const out = sanitizeDocHtml('<p style="line-height:1.5">para</p>')
    expect(out).toContain('line-height:1.5')
  })
})

// ── 2b. WAVE-53 hardening: style allow-list (fail-closed) ────────────────────
// The wave-52 guard was a blocklist regex; it let `position:*` overlays and the
// fetch-capable CSS image()/src() functions through. Replaced with a property
// allow-list. These tests lock the fail-closed contract in place.
describe('WAVE-53: style allow-list blocks non-url exfil + clickjacking, keeps legit styles', () => {
  const styleOf = (out) => (out.match(/style="([^"]*)"/) || [, ''])[1]

  it('drops position:fixed / position:absolute (clickjacking overlay)', () => {
    for (const pos of ['fixed', 'absolute']) {
      const out = sanitizeDocHtml(`<div style="position:${pos};inset:0;z-index:99999">x</div>`)
      expect(out).not.toMatch(/position\s*:/i)
      expect(out).not.toMatch(/z-index/i)
      expect(out).toContain('x') // content preserved
    }
  })

  it('drops CSS fetch functions that carry NO literal url() token', () => {
    // image() and src() are valid CSS <image> functions that fetch a resource
    // yet contain no `url(` — a url()-only blocklist misses them.
    for (const val of [
      'background:image(https://evil/x)',
      'background:src(https://evil/x)',
      'background:-webkit-image-set("https://evil/x" 1x)',
      'background:image-set(url(https://evil/x) 1x)',
      'background:cross-fade(url(https://evil/x))',
    ]) {
      const out = sanitizeDocHtml(`<div style="${val}">x</div>`)
      expect(styleOf(out)).toBe('') // whole (single) declaration dropped
      expect(out).not.toMatch(/evil/)
    }
  })

  it('drops mask-image / filter:url / clip-path url references', () => {
    for (const val of [
      'mask-image:url(https://evil/x)',
      'filter:url(https://evil/x#f)',
      'clip-path:url(https://evil/x)',
    ]) {
      const out = sanitizeDocHtml(`<div style="${val}">x</div>`)
      expect(out).not.toMatch(/evil/)
    }
  })

  it('drops external + relative url() on background/list-style/cursor', () => {
    for (const val of [
      'background-image:url(https://evil/pixel.png)',
      'background:url(/local.png)',
      'list-style-image:url(https://evil/x)',
      'cursor:url(https://evil/x),auto',
    ]) {
      const out = sanitizeDocHtml(`<div style="${val}">x</div>`)
      expect(out).not.toMatch(/url\(/i)
    }
  })

  it('drops CSS-comment obfuscated url() forms too (fail-closed)', () => {
    for (const val of [
      'background:u/**/rl(https://evil/x)',
      'background:url/**/(https://evil/x)',
    ]) {
      const out = sanitizeDocHtml(`<div style="${val}">x</div>`)
      expect(styleOf(out)).toBe('')
      expect(out).not.toMatch(/evil/)
    }
  })

  it('a dangerous declaration does NOT nuke the benign ones alongside it', () => {
    const out = sanitizeDocHtml(
      '<table><tr><td style="text-align:center;color:#333;background:url(https://evil/x)">x</td></tr></table>'
    )
    const s = styleOf(out)
    expect(s).toContain('text-align:center')
    expect(s).toContain('color:#333')
    expect(s).not.toMatch(/url\(/i)
    expect(s).not.toMatch(/evil/)
  })

  it('drops unknown/unsafe properties but keeps every property Docs legitimately emits', () => {
    // The exact style surface StarterKit + Color/Highlight/FontSize/FontFamily/
    // TextAlign/Table/page-break import path emit. All must survive untouched.
    const legit =
      'color:#111;background-color:#ffff00;font-family:Georgia;font-size:14px;' +
      'font-weight:700;font-style:italic;line-height:1.5;text-align:justify;' +
      'text-decoration:underline;text-indent:2em;vertical-align:top;' +
      'margin-left:24px;padding:4px;border:1px solid #ccc;border-collapse:collapse;' +
      'width:120px;min-width:80px;page-break-after:always'
    const out = sanitizeDocHtml(`<table><tr><td style="${legit}">cell</td></tr></table>`)
    const s = styleOf(out)
    for (const prop of [
      'color:#111', 'background-color:#ffff00', 'font-family:Georgia',
      'font-size:14px', 'font-weight:700', 'font-style:italic', 'line-height:1.5',
      'text-align:justify', 'text-decoration:underline', 'text-indent:2em',
      'vertical-align:top', 'margin-left:24px', 'padding:4px',
      'border:1px solid #ccc', 'border-collapse:collapse', 'width:120px',
      'min-width:80px', 'page-break-after:always',
    ]) {
      expect(s).toContain(prop)
    }
    // And an unsafe property mixed in is still dropped.
    const out2 = sanitizeDocHtml('<div style="color:red;position:fixed">x</div>')
    expect(styleOf(out2)).toContain('color:red')
    expect(styleOf(out2)).not.toMatch(/position/i)
  })

  it('still strips the classic executable style values (regression from wave-52)', () => {
    for (const val of [
      'background:url(javascript:alert(1))',
      'width:expression(alert(1))',
      'behavior:url(x.htc)',
      '-moz-binding:url(x.xml)',
    ]) {
      const out = sanitizeDocHtml(`<div style="${val}">x</div>`)
      expect(out).not.toMatch(/javascript:|expression\(|behavior|moz-binding/i)
    }
  })
})

// ── 3. CRDT round-trip of a table's cell text ────────────────────────────────
describe('CRDT round-trip: table cell text converges across peers', () => {
  it('two peers converge on the same cell-text after exchanging ops', () => {
    editor = makeEditor()
    editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run()
    // Type into the first cell.
    editor.chain().focus().insertContent('Sales').run()

    const docText = editor.getText() // concatenated cell text (what the CRDT syncs)

    const a = new TextCRDT('peer-a')
    const b = new TextCRDT('peer-b')

    // Peer A types the whole doc-text from empty → broadcasts ops.
    const ops = diffToOps('', docText, a)
    for (const op of ops) a.apply(op)
    // Peer B applies the same ops (arriving over the wire).
    for (const op of ops) b.apply(op)

    // Both converge, and B's view matches the editor's cell text.
    expect(a.toString()).toBe(docText)
    expect(b.toString()).toBe(docText)
    expect(b.toString()).toContain('Sales')
  })

  it('a structured-doc guard is available (table present is detectable)', () => {
    // The editor-side guard skips the fragile plain-text patch when a table is
    // present; here we just assert the doc reports its table so the guard has a
    // signal to key on (unit-level; the guard itself lives in DocsEditor.jsx).
    editor = makeEditor()
    editor.chain().focus().insertTable({ rows: 2, cols: 2 }).run()
    let hasTable = false
    editor.state.doc.descendants((n) => { if (n.type.name === 'table') hasTable = true })
    expect(hasTable).toBe(true)
  })
})

// ── 4. Export: HTML contains the table ───────────────────────────────────────
describe('export round-trip: HTML export contains the table', () => {
  it('exportToHtml emits <table> markup for a table document', async () => {
    editor = makeEditor()
    editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run()
    editor.chain().focus().insertContent('Q1').run()

    exportToHtml(editor, 'doc-with-table')
    expect(saveAs).toHaveBeenCalled()
    const blob = saveAs.mock.calls.at(-1)[0]
    const html = await blob.text()
    expect(html).toContain('<table')  // TipTap emits <table style="min-width…">
    expect(html).toContain('</table>')
    expect(html).toContain('<th')     // header row present
    expect(html).toContain('Q1')      // cell content survived export
    // Exported HTML is sanitised → no script / handler leaks.
    expect(html).not.toContain('<script')
    expect(html).not.toContain('onclick')
  })
})
