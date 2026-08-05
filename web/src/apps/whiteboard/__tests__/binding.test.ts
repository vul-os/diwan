/**
 * ExcalidrawYBinding — multi-peer CRDT convergence through the REAL binding.
 *
 * Ported from @vulos/board-ui's binding.convergence test. It proves the property
 * that matters for a collaborative whiteboard: independent peers, each driving
 * their own editor through their own binding over their own Y.Doc, converge to
 * byte-identical scene state — including under concurrent partitioned edits and
 * deletes/tombstones. The transport is faked with a full-mesh update relay; the
 * Y.Docs, the CRDT merge and the bindings are all real.
 */

import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { ExcalidrawYBinding } from '../binding.js'
import { ELEMENTS_KEY, FILES_KEY } from '../../../lib/crdt/boardYdoc.js'

interface BoardElement {
  id: string
  version: number
  versionNonce?: number
  isDeleted?: boolean
  index?: string
  [k: string]: unknown
}

interface BoardFile {
  id: string
  mimeType: string
  dataURL: string
  created: number
  [k: string]: unknown
}

interface TestNode {
  doc: Y.Doc
  binding: ExcalidrawYBinding
  editorFiles: () => Record<string, BoardFile>
  sceneIds: () => string[]
  sceneEl: (id: string) => BoardElement | undefined
}

function makeNode(): TestNode {
  let scene: BoardElement[] = []
  const files: Record<string, BoardFile> = {}
  const api = {
    updateScene(s: { elements?: BoardElement[] }) { if (s.elements) scene = [...s.elements] },
    getSceneElementsIncludingDeleted() { return scene },
    addFiles(fs: BoardFile[]) { for (const f of fs) files[f.id] = f },
    getFiles() { return files },
  }
  const doc = new Y.Doc()
  doc.getMap(ELEMENTS_KEY); doc.getMap(FILES_KEY)
  const binding = new ExcalidrawYBinding(doc, api)
  return {
    doc, binding,
    editorFiles: () => files,
    sceneIds: () => scene.map((e) => e.id),
    sceneEl: (id) => scene.find((e) => e.id === id),
  }
}

/** Full-mesh live relay: every non-relayed local update is applied to the others. */
function link(...nodes: TestNode[]) {
  const handlers: Array<[Y.Doc, (update: Uint8Array, origin: unknown) => void]> = []
  for (const n of nodes) {
    const others = nodes.filter((o) => o !== n)
    const h = (update: Uint8Array, origin: unknown) => {
      if (origin === 'relay') return
      for (const o of others) Y.applyUpdate(o.doc, update, 'relay')
    }
    n.doc.on('update', h)
    handlers.push([n.doc, h])
  }
  return () => handlers.forEach(([doc, h]) => doc.off('update', h))
}

function heal(...nodes: TestNode[]) {
  const updates = nodes.map((n) => Y.encodeStateAsUpdate(n.doc))
  for (const n of nodes) for (const u of updates) Y.applyUpdate(n.doc, u)
}

function docElements(doc: Y.Doc): Record<string, BoardElement> {
  const out: Record<string, BoardElement> = {}
  doc.getMap(ELEMENTS_KEY).forEach((v: unknown, k: string) => { out[k] = v as BoardElement })
  return out
}

function el(id: string, extra: Partial<BoardElement> = {}): BoardElement {
  return { id, version: 1, type: 'rectangle', ...extra }
}

describe('ExcalidrawYBinding convergence', () => {
  it('concurrent edits to DIFFERENT elements merge on both peers', () => {
    const a = makeNode(); const b = makeNode()
    a.binding.handleChange([el('a', { index: 'a0' })], {}, {})
    b.binding.handleChange([el('b', { index: 'a1' })], {}, {})
    expect(Object.keys(docElements(a.doc))).toEqual(['a'])
    expect(Object.keys(docElements(b.doc))).toEqual(['b'])

    heal(a, b)

    expect(docElements(a.doc)).toEqual(docElements(b.doc))
    expect(Object.keys(docElements(a.doc)).sort()).toEqual(['a', 'b'])
    expect(a.sceneIds()).toEqual(['a', 'b'])
    expect(b.sceneIds()).toEqual(['a', 'b'])
    a.binding.destroy(); b.binding.destroy()
  })

  it('a concurrent edit to the SAME element resolves identically on both peers', () => {
    const a = makeNode(); const b = makeNode()
    const unlink = link(a, b)
    a.binding.handleChange([el('x', { version: 1, strokeColor: '#000' })], {}, {})
    expect(b.sceneEl('x')?.strokeColor).toBe('#000')

    unlink()
    a.binding.handleChange([el('x', { version: 2, strokeColor: '#ff0000' })], {}, {})
    b.binding.handleChange([el('x', { version: 2, strokeColor: '#0000ff' })], {}, {})

    heal(a, b)
    expect(docElements(a.doc)).toEqual(docElements(b.doc))
    expect(a.sceneEl('x')).toEqual(b.sceneEl('x'))
    expect(['#ff0000', '#0000ff']).toContain(a.sceneEl('x')!.strokeColor)
    a.binding.destroy(); b.binding.destroy()
  })

  it('an isDeleted tombstone propagates and both peers keep it deleted', () => {
    const a = makeNode(); const b = makeNode()
    const unlink = link(a, b)
    a.binding.handleChange([el('t', { version: 1 })], {}, {})
    expect(b.sceneEl('t')?.isDeleted).toBeUndefined()
    a.binding.handleChange([el('t', { version: 2, isDeleted: true })], {}, {})
    expect((b.doc.getMap(ELEMENTS_KEY).get('t') as BoardElement | undefined)?.isDeleted).toBe(true)
    expect(b.sceneEl('t')?.isDeleted).toBe(true)
    expect(docElements(a.doc)).toEqual(docElements(b.doc))
    unlink(); a.binding.destroy(); b.binding.destroy()
  })

  it('a hard removal (element pruned from the scene) converges to gone', () => {
    const a = makeNode(); const b = makeNode()
    const unlink = link(a, b)
    a.binding.handleChange([el('p', { version: 1 }), el('q', { version: 1 })], {}, {})
    expect(b.sceneIds().sort()).toEqual(['p', 'q'])
    a.binding.handleChange([el('q', { version: 1 })], {}, {})
    expect(b.doc.getMap(ELEMENTS_KEY).has('p')).toBe(false)
    expect(b.sceneIds()).toEqual(['q'])
    unlink(); a.binding.destroy(); b.binding.destroy()
  })

  it('a remote image blob reaches the editor only when it is a raster image', () => {
    const a = makeNode(); const b = makeNode()
    const unlink = link(a, b)
    // A hostile peer pushes an "image" that is really an SVG (a script vector),
    // alongside a legitimate PNG.
    a.doc.transact(() => {
      a.doc.getMap(FILES_KEY).set('evil', {
        id: 'evil', mimeType: 'image/svg+xml',
        dataURL: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', created: 1,
      })
      a.doc.getMap(FILES_KEY).set('ok', {
        id: 'ok', mimeType: 'image/png',
        dataURL: 'data:image/png;base64,iVBORw0KGgo=', created: 2,
      })
    })
    // The blobs converged into the raw CRDT (that IS the doc)…
    expect(b.doc.getMap(FILES_KEY).has('evil')).toBe(true)
    // …but the binding handed ONLY the raster PNG to the editor's file store —
    // the active-content SVG never reaches Excalidraw.
    expect(b.editorFiles().ok).toBeTruthy()
    expect(b.editorFiles().evil).toBeUndefined()
    unlink(); a.binding.destroy(); b.binding.destroy()
  })
})
