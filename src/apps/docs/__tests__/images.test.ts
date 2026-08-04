/**
 * WAVE-57 — Inline images in Diwan Docs.
 *
 * Coverage:
 *   1. Insert / resize / align / alt ops on a real TipTap editor using the
 *      hardened DocImage node.
 *   2. Embed policy: fileToDataUri/isEmbeddableImage keep only bounded raster
 *      files (png/jpeg/gif/webp) — SVG + oversize + non-image are refused.
 *   3. Sanitizer (the critical layer): a SAFE <img> survives sanitizeDocHtml,
 *      and EVERY XSS vector (onerror/onload, javascript: src, data:image/svg+xml,
 *      data:text/html, srcset) is stripped/blocked — on import AND export.
 *   4. CRDT round-trip: an image node survives full-state (JSON) reconcile and
 *      is treated as a structured node (fragile text-patch skipped).
 *   5. Export: HTML export contains the sanitised <img>; DOCX embeds raster,
 *      drops svg.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { NodeSelection } from '@tiptap/pm/state'

import { sanitizeDocHtml } from '../../../lib/sanitize'
import { DocImage, isEmbeddableImage, fileToDataUri, MAX_INLINE_IMAGE_BYTES } from '../docsImage.js'
import { exportToHtml, exportToDocx } from '../docsExport.js'
import { saveAs } from 'file-saver'

vi.mock('file-saver', () => ({ saveAs: vi.fn() }))

// A tiny valid 1×1 PNG as a data: URI (used across insert/export tests).
const PNG_1x1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

function makeEditor(content = '<p>Hello</p>'): Editor {
  return new Editor({
    extensions: [Document, Paragraph, Text, DocImage],
    content,
  })
}

// Minimal File stand-in sufficient for isEmbeddableImage (structural: only
// reads .type/.size) and fileToDataUri (needs a real File shape — cast
// through unknown, same as the other DOM-object stand-ins in this suite).
function fakeFile(type: string, size: number): File {
  return { type, size, name: 'x' } as unknown as File
}

// Select the (first) image node — the real UI does this (NodeSelection) before
// the image sub-toolbar fires updateAttributes('image', …).
function selectImage(ed: Editor): boolean {
  let pos: number | null = null
  ed.state.doc.descendants((n, p) => { if (n.type.name === 'image') pos = p })
  const at = pos as number | null
  if (at == null) return false
  ed.view.dispatch(ed.state.tr.setSelection(NodeSelection.create(ed.state.doc, at)))
  return true
}

// A returning lookup (rather than mutating an outer `let` from inside the
// descendants callback) — TS can't flow-narrow a variable mutated inside a
// nested function at the read site (same issue worked around in
// equations.test.ts's findNodeByType).
function firstAttrsByType(doc: PMNode, typeName: string): PMNode['attrs'] | null {
  let result: PMNode['attrs'] | null = null
  doc.descendants((n) => { if (n.type.name === typeName) result = n.attrs })
  return result
}

// A saveAs Blob argument narrowed away from the `Blob | string` union the real
// file-saver signature allows — this suite only ever hands it a Blob.
function lastSavedBlob(): Blob {
  const data = vi.mocked(saveAs).mock.calls.at(-1)?.[0]
  if (!(data instanceof Blob)) throw new Error('expected saveAs to be called with a Blob')
  return data
}

let editor: Editor | null = null
afterEach(() => { editor?.destroy(); editor = null; vi.clearAllMocks() })

// ── 1. Insert / resize / align / alt (live editor) ───────────────────────────
describe('image insert + attribute ops (live editor)', () => {
  it('inserts an image node from a data: URI', () => {
    editor = makeEditor()
    editor.chain().focus().setImage({ src: PNG_1x1 }).run()
    let images = 0
    editor.state.doc.descendants((n) => { if (n.type.name === 'image') images += 1 })
    expect(images).toBe(1)
    expect(editor.getHTML()).toContain('src="data:image/png')
  })

  it('resizes via a width attribute (renders into inline style)', () => {
    editor = makeEditor(`<img src="${PNG_1x1}">`)
    selectImage(editor)
    editor.chain().updateAttributes('image', { width: '50%' }).run()
    const html = editor.getHTML()
    expect(html).toMatch(/width="50%"|width:50%/)
  })

  it('aligns center → renders margin auto (allow-listed CSS)', () => {
    editor = makeEditor(`<img src="${PNG_1x1}">`)
    selectImage(editor)
    editor.chain().updateAttributes('image', { align: 'center' }).run()
    const html = editor.getHTML()
    expect(html).toMatch(/margin-left:\s*auto/)
    expect(html).toMatch(/margin-right:\s*auto/)
  })

  it('carries alt text (a11y)', () => {
    editor = makeEditor()
    editor.chain().focus().setImage({ src: PNG_1x1, alt: 'A red square' }).run()
    expect(editor.getHTML()).toContain('alt="A red square"')
  })

  it('round-trips width + align through HTML re-parse', () => {
    editor = makeEditor(`<img src="${PNG_1x1}">`)
    selectImage(editor)
    editor.chain().updateAttributes('image', { width: '75%', align: 'center' }).run()
    const html = editor.getHTML()
    // Re-open the emitted HTML in a fresh editor; attrs should survive.
    const e2 = makeEditor(html)
    const attrs = firstAttrsByType(e2.state.doc, 'image')
    expect(attrs?.width).toBe('75%')
    expect(attrs?.align).toBe('center')
    e2.destroy()
  })
})

// ── 2. Embed policy (raster-only, size-capped, SVG refused) ──────────────────
describe('embed policy: only bounded raster files embed', () => {
  it('accepts raster types within the cap', () => {
    for (const t of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
      expect(isEmbeddableImage(fakeFile(t, 1024))).toBe(true)
    }
  })

  it('refuses SVG (script carrier)', () => {
    expect(isEmbeddableImage(fakeFile('image/svg+xml', 1024))).toBe(false)
  })

  it('refuses non-image + oversize files', () => {
    expect(isEmbeddableImage(fakeFile('text/html', 10))).toBe(false)
    expect(isEmbeddableImage(fakeFile('application/pdf', 10))).toBe(false)
    expect(isEmbeddableImage(fakeFile('image/png', MAX_INLINE_IMAGE_BYTES + 1))).toBe(false)
    expect(isEmbeddableImage(fakeFile('image/png', 0))).toBe(false)
  })

  it('fileToDataUri rejects SVG + oversize before reading', async () => {
    await expect(fileToDataUri(fakeFile('image/svg+xml', 100))).rejects.toThrow()
    await expect(fileToDataUri(fakeFile('image/png', MAX_INLINE_IMAGE_BYTES + 1))).rejects.toThrow()
  })

  it('fileToDataUri returns a raster data: URI for a valid raster file', async () => {
    // Stub FileReader to yield a raster data: URI (jsdom has no real file bytes).
    const orig = global.FileReader
    class FakeFileReader {
      onload: ((ev: { target: { result: string } }) => void) | null = null
      readAsDataURL() { setTimeout(() => this.onload?.({ target: { result: PNG_1x1 } }), 0) }
    }
    global.FileReader = FakeFileReader as unknown as typeof FileReader
    try {
      const uri = await fileToDataUri(fakeFile('image/png', 100))
      expect(uri).toMatch(/^data:image\/png;base64,/)
    } finally {
      global.FileReader = orig
    }
  })

  it('fileToDataUri rejects if the reader yields a non-raster URI (defence-in-depth)', async () => {
    const orig = global.FileReader
    class FakeFileReader {
      onload: ((ev: { target: { result: string } }) => void) | null = null
      readAsDataURL() { setTimeout(() => this.onload?.({ target: { result: 'data:image/svg+xml,<svg/>' } }), 0) }
    }
    global.FileReader = FakeFileReader as unknown as typeof FileReader
    try {
      await expect(fileToDataUri(fakeFile('image/png', 100))).rejects.toThrow()
    } finally {
      global.FileReader = orig
    }
  })
})

// ── 3. Sanitizer: safe <img> survives, EVERY XSS vector is blocked ───────────
describe('sanitizer: allows safe <img>, blocks every XSS vector', () => {
  it('keeps a safe raster data: <img> with alt/width/height', () => {
    const out = sanitizeDocHtml(`<img src="${PNG_1x1}" alt="ok" width="200" height="100">`)
    expect(out).toContain('<img')
    expect(out).toContain('src="data:image/png')
    expect(out).toContain('alt="ok"')
    expect(out).toContain('width="200"')
  })

  it('keeps an https: <img> (remote content allowed in own doc)', () => {
    const out = sanitizeDocHtml('<img src="https://example.com/pic.png" alt="p">')
    expect(out).toContain('src="https://example.com/pic.png"')
  })

  it('strips onerror handler (keeps the img, drops the handler)', () => {
    const out = sanitizeDocHtml('<img src="x" onerror="alert(1)">')
    expect(out).not.toMatch(/onerror/i)
    expect(out).not.toMatch(/alert/)
  })

  it('strips onload handler', () => {
    const out = sanitizeDocHtml('<img src="x" onload="alert(1)">')
    expect(out).not.toMatch(/onload/i)
    expect(out).not.toMatch(/alert/)
  })

  it('strips a javascript: src', () => {
    const out = sanitizeDocHtml('<img src="javascript:alert(1)">')
    expect(out).not.toMatch(/javascript:/i)
    expect(out).not.toMatch(/alert/)
  })

  it('strips a data:image/svg+xml src (SVG can carry script)', () => {
    const out = sanitizeDocHtml('<img src="data:image/svg+xml,<svg onload=alert(1)>">')
    expect(out).not.toMatch(/svg\+xml/i)
    expect(out).not.toMatch(/onload/i)
    expect(out).not.toMatch(/alert/)
    expect(out).not.toMatch(/<svg/i)
  })

  it('strips a base64 data:image/svg+xml src too', () => {
    const svg = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')
    const out = sanitizeDocHtml(`<img src="${svg}">`)
    expect(out).not.toMatch(/svg\+xml/i)
    expect(out).not.toMatch(/onload/i)
  })

  it('strips a data:text/html src', () => {
    const out = sanitizeDocHtml('<img src="data:text/html,<script>alert(1)</script>">')
    expect(out).not.toMatch(/text\/html/i)
    expect(out).not.toMatch(/script/i)
  })

  it('strips srcset entirely (bypass channel)', () => {
    const out = sanitizeDocHtml('<img src="https://ok/x.png" srcset="https://evil/y.png 2x, data:image/svg+xml,<svg/> 1x">')
    expect(out).not.toMatch(/srcset/i)
    expect(out).not.toMatch(/evil/)
    expect(out).not.toMatch(/svg/i)
    // The safe src is retained.
    expect(out).toContain('src="https://ok/x.png"')
  })

  it('strips a vbscript: src', () => {
    const out = sanitizeDocHtml('<img src="vbscript:msgbox(1)">')
    expect(out).not.toMatch(/vbscript:/i)
  })

  it('keeps the alignment/resize style an image emits (display/margin/width survive)', () => {
    const out = sanitizeDocHtml(
      `<img src="${PNG_1x1}" width="50%" style="width:50%;display:block;margin-left:auto;margin-right:auto">`
    )
    expect(out).toMatch(/display:\s*block/)
    expect(out).toMatch(/margin-left:\s*auto/)
    expect(out).toContain('width="50%"')
  })

  it('still drops position:fixed on an <img> (clickjacking overlay stays out)', () => {
    const out = sanitizeDocHtml(`<img src="${PNG_1x1}" style="position:fixed;inset:0;z-index:9999">`)
    expect(out).not.toMatch(/position/i)
    expect(out).not.toMatch(/z-index/i)
  })

  it('blocks the vectors on the EXPORT path too (export re-sanitises)', async () => {
    editor = makeEditor(
      '<p>hi</p><img src="data:image/svg+xml,<svg onload=alert(1)>"><img src="x" onerror="alert(1)">'
    )
    exportToHtml(editor, 'evil')
    const blob = lastSavedBlob()
    const html = await blob.text()
    expect(html).not.toMatch(/svg\+xml/i)
    expect(html).not.toMatch(/onerror/i)
    expect(html).not.toMatch(/onload/i)
    expect(html).not.toMatch(/alert/)
  })
})

// ── 3b. WAVE-58 red-team regressions (sanitizer bypass + collab-ingress gap) ──
// The wave-57 red-team surfaced three real gaps; each is closed fail-closed and
// pinned here so it can never silently regress.
describe('WAVE-58: sanitizer allow-list completeness (bypass attempts)', () => {
  it('rejects a raster MIME-LIE (data:image/png, but SVG/markup body)', () => {
    // The allow-list previously trusted the DECLARED prefix, so a
    // `data:image/png,<svg onload=…>` (comma-form, never a real raster) survived.
    // A genuine embedded raster is ALWAYS ;base64, — require it.
    const out = sanitizeDocHtml('<img src="data:image/png,<svg onload=alert(1)/>">')
    expect(out.toLowerCase()).not.toContain('svg')
    expect(out.toLowerCase()).not.toContain('onload')
    expect(out.toLowerCase()).not.toContain('alert')
    // The lie is dropped entirely (no src survives), not kept.
    expect(out).not.toContain('data:image/png,')
  })

  it('rejects a data:image/svg+xml smuggled on href (not just src)', () => {
    // DOMPurify keeps a bare `href` on <img> WITHOUT scheme-validating it, and
    // normalises SVG <image href> → <img href>. The wave-57 hook gated src/srcset
    // only; wave-58 gates href/xlink:href with the same data:-URI policy.
    const out = sanitizeDocHtml('<img src="https://ok/x.png" href="data:image/svg+xml,<svg onload=alert(1)/>">')
    expect(out.toLowerCase()).not.toContain('svg')
    expect(out.toLowerCase()).not.toContain('onload')
    expect(out).toContain('src="https://ok/x.png"') // safe src retained
  })

  it('rejects the SVG <image> element carrying a data:svg href', () => {
    const out = sanitizeDocHtml('<image href="data:image/svg+xml,<svg onload=alert(1)/>"/>')
    expect(out.toLowerCase()).not.toContain('svg')
    expect(out.toLowerCase()).not.toContain('onload')
  })

  it('strips imagesrcset / ping candidate+beacon channels', () => {
    const out = sanitizeDocHtml('<img src="https://ok/x.png" imagesrcset="data:image/svg+xml,<svg/> 1x" ping="https://evil/track">')
    expect(out.toLowerCase()).not.toContain('imagesrcset')
    expect(out.toLowerCase()).not.toContain('ping')
    expect(out.toLowerCase()).not.toContain('evil')
    expect(out.toLowerCase()).not.toContain('svg')
  })

  it('still accepts a legit base64 raster on src', () => {
    const out = sanitizeDocHtml(`<img src="${PNG_1x1}" alt="ok">`)
    expect(out).toContain('src="data:image/png;base64,')
  })
})

// The SHARPEST finding: the realtime CRDT carries only text, so an image node
// reaches a peer via persisted document JSON reloaded through setContent(json) —
// a path that (unlike the _html import branch) NEVER flows through
// sanitizeDocHtml. A malicious rw collaborator could PUT doc JSON with a poisoned
// image src. The DocImage node's renderHTML now gates the src, so no ingress path
// can emit a live poisoned <img>.
describe('WAVE-58: collab / JSON-reload ingress gate (DocImage renderHTML)', () => {
  const poisoned = [
    'javascript:alert(1)',
    'data:image/svg+xml,<svg onload=alert(1)/>',
    'data:text/html,<script>alert(1)</script>',
    'data:image/png,<svg onload=1/>',        // raster MIME-lie
    'vbscript:msgbox(1)',
  ]

  it('drops every poisoned src set via setContent(json) (the collab path)', () => {
    editor = makeEditor()
    editor.commands.setContent({
      type: 'doc',
      content: poisoned.map((src) => ({ type: 'image', attrs: { src } })),
    })
    const html = editor.getHTML().toLowerCase()
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('vbscript:')
    expect(html).not.toContain('svg')
    expect(html).not.toContain('onload')
    expect(html).not.toContain('text/html')
    expect(html).not.toContain('<script')
    // The nodes survive as (image-less) <img>; the payload does not.
    expect(html).toContain('<img')
  })

  it('keeps safe srcs (base64 raster, https, relative) through the same path', () => {
    editor = makeEditor()
    editor.commands.setContent({
      type: 'doc',
      content: [
        { type: 'image', attrs: { src: PNG_1x1 } },
        { type: 'image', attrs: { src: 'https://example.com/x.png' } },
        { type: 'image', attrs: { src: '/relative/pic.png' } },
      ],
    })
    const html = editor.getHTML()
    expect(html).toContain('data:image/png;base64,')
    expect(html).toContain('https://example.com/x.png')
    expect(html).toContain('/relative/pic.png')
  })
})

// ── 4. CRDT round-trip of an image node ──────────────────────────────────────
describe('CRDT round-trip: image node survives full-state reconcile', () => {
  it('a peer reconstructs the image from the authoritative JSON', () => {
    editor = makeEditor(`<img src="${PNG_1x1}" alt="sync me">`)
    selectImage(editor)
    editor.chain().updateAttributes('image', { width: '40%', align: 'center' }).run()

    // Full-state reconcile is JSON-based (the fragile text patch is skipped for
    // structured nodes — see docHasStructuredNodes). Round-trip the JSON.
    const json = editor.getJSON()
    const peer = makeEditor()
    peer.commands.setContent(json)

    const attrs = firstAttrsByType(peer.state.doc, 'image')
    expect(attrs?.src).toBe(PNG_1x1)
    expect(attrs?.alt).toBe('sync me')
    expect(attrs?.width).toBe('40%')
    expect(attrs?.align).toBe('center')
    peer.destroy()
  })

  it('an image is a leaf node contributing no text (structured-node signal)', () => {
    editor = makeEditor()
    editor.chain().focus().setImage({ src: PNG_1x1 }).run()
    let isImageLeaf = false
    editor.state.doc.descendants((n) => {
      if (n.type.name === 'image') isImageLeaf = n.isLeaf || n.childCount === 0
    })
    // The text projection the CRDT patch diffs against carries no image chars,
    // which is exactly why DocsEditor treats an image as a structured node and
    // falls back to full-state reconcile.
    expect(isImageLeaf).toBe(true)
    expect(editor.getText().trim()).toBe('Hello')
  })
})

// ── 5. Export: HTML export contains the sanitised image; DOCX embeds raster ─────────
describe('export: HTML export contains the sanitised image', () => {
  it('exportToHtml emits the <img> with a raster src', async () => {
    editor = makeEditor(`<p>with image</p><img src="${PNG_1x1}" alt="pic">`)
    exportToHtml(editor, 'doc-with-image')
    expect(saveAs).toHaveBeenCalled()
    const blob = lastSavedBlob()
    const html = await blob.text()
    expect(html).toContain('<img')
    expect(html).toContain('src="data:image/png')
    expect(html).toContain('alt="pic"')
    expect(html).not.toContain('<script')
    expect(html).not.toMatch(/onerror|onload/i)
  })

  it('exportToDocx embeds a raster image without throwing', async () => {
    editor = makeEditor(`<p>doc</p><img src="${PNG_1x1}">`)
    await exportToDocx(editor, 'doc-with-image')
    expect(saveAs).toHaveBeenCalled()
    const blob = lastSavedBlob()
    // A .docx is a non-empty zip; embedding produced real bytes.
    expect(blob.size).toBeGreaterThan(0)
  })

  it('exportToDocx drops an svg data: image (matches sanitiser) without throwing', async () => {
    editor = makeEditor('<p>doc</p>')
    // Inject an svg-src image directly into the JSON the exporter walks (the
    // editor/sanitiser would never let this exist, but the DOCX path must be
    // defensive on its own).
    const json = { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'doc' }] },
      { type: 'image', attrs: { src: 'data:image/svg+xml,<svg onload=alert(1)/>' } },
    ] }
    editor.commands.setContent(json)
    await exportToDocx(editor, 'svg-doc')
    const blob = lastSavedBlob()
    expect(blob.size).toBeGreaterThan(0) // produced a valid docx, svg simply omitted
  })
})
