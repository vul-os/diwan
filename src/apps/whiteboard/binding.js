/**
 * src/apps/whiteboard/binding.js — the Yjs <-> Excalidraw binding.
 *
 * PROVENANCE. This is @vulos/board-ui's `src/binding.ts` (MIT, Vulos
 * contributors), converted to JS and vendored into Ofisi so the
 * whiteboard document type rides Office's OWN distributed P2P collab engine
 * (yP2PSession + FabricClient) rather than board-ui's separate transport. The
 * Excalidraw editor it drives is the MIT-licensed
 * https://github.com/excalidraw/excalidraw (see LICENSE / THIRD-PARTY-NOTICES).
 *
 * One instance bridges a Y.Doc (the source of truth) and a live Excalidraw
 * editor. It runs in both directions and guards against feedback loops:
 *
 *   local edit  : Excalidraw onChange -> diff vs Y.Map -> write changed/added/
 *                 deleted elements inside a single ydoc.transact(..., origin).
 *   remote edit : ymap.observeDeep -> rebuild the elements array -> updateScene.
 *                 Changes whose transaction origin is *this* binding are
 *                 skipped (we caused them), and updateScene is wrapped so the
 *                 onChange it triggers does not echo back to Yjs.
 *
 * Elements are stored one-per-id in a Y.Map so concurrent edits to different
 * elements merge cleanly. Image blobs (Excalidraw `files`) are mirrored into a
 * second Y.Map keyed by fileId.
 */

import { ELEMENTS_KEY, FILES_KEY } from '../../lib/crdt/boardYdoc.js'

/**
 * @typedef {{ id: string, version: number, versionNonce?: number,
 *   isDeleted?: boolean, index?: string, [k: string]: unknown }} BoardElement
 * @typedef {{ id: string, mimeType: string, dataURL: string, created: number,
 *   [k: string]: unknown }} BoardFile
 */

/**
 * Raster image mime types we accept from remote peers. SVG (image/svg+xml) and
 * markup (text/html, …) are deliberately excluded: they can carry script and
 * would be a stored-XSS vector if a peer-supplied dataURL were ever rendered as
 * markup. Defence-in-depth — a malicious/compromised peer must not be able to
 * push an active-content "image" into our editor via the CRDT.
 */
const ALLOWED_IMAGE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/x-icon',
  'image/avif',
])

/**
 * Accept a remote file only when BOTH its declared `mimeType` and the mime
 * encoded in the dataURL itself are in the raster-image allow-list. Checking the
 * dataURL prefix too stops a `mimeType: image/png` / `dataURL: data:text/html…`
 * mismatch from slipping through.
 * @param {BoardFile} f
 * @returns {boolean}
 */
export function isAllowedImage(f) {
  if (!f || !ALLOWED_IMAGE_MIME.has(f.mimeType)) return false
  const m = /^data:([^;,]+)[;,]/.exec(typeof f.dataURL === 'string' ? f.dataURL : '')
  const declared = m?.[1]?.toLowerCase()
  return !!declared && ALLOWED_IMAGE_MIME.has(declared)
}

/** Order elements the way Excalidraw expects (fractional index when present). */
function sortElements(elements) {
  return elements.sort((a, b) => {
    const ai = a.index
    const bi = b.index
    if (ai != null && bi != null) return ai < bi ? -1 : ai > bi ? 1 : 0
    if (ai != null) return -1
    if (bi != null) return 1
    return 0
  })
}

export class ExcalidrawYBinding {
  /**
   * @param {import('yjs').Doc} doc
   * @param {object} api  the subset of Excalidraw's imperative API we need:
   *   { updateScene, getSceneElementsIncludingDeleted, addFiles, getFiles }
   */
  constructor(doc, api) {
    this.doc = doc
    this.api = api
    /** Transaction origin tag so we can ignore our own updates on the way back. */
    this.origin = Symbol('@vulos/office-whiteboard')
    /** True while we are applying a *remote* change to Excalidraw. */
    this.applyingRemote = false
    this.disposed = false
    this.yElements = doc.getMap(ELEMENTS_KEY)
    this.yFiles = doc.getMap(FILES_KEY)

    this.onRemoteElements = this.onRemoteElements.bind(this)
    this.onRemoteFiles = this.onRemoteFiles.bind(this)
    this.handleChange = this.handleChange.bind(this)

    this.yElements.observeDeep(this.onRemoteElements)
    this.yFiles.observe(this.onRemoteFiles)
  }

  /** Push whatever is already in the Y.Doc into a freshly-mounted editor. */
  loadInitial() {
    if (this.yElements.size === 0 && this.yFiles.size === 0) return
    this.renderFromDoc()
  }

  /** Excalidraw `onChange` handler — local edits flow into the Y.Doc here. */
  handleChange(elements, _appState, files) {
    if (this.applyingRemote || this.disposed) return

    this.doc.transact(() => {
      const seen = new Set()
      for (const el of elements) {
        seen.add(el.id)
        const prev = this.yElements.get(el.id)
        // Write only when new or actually changed (Excalidraw bumps `version`).
        if (
          !prev ||
          prev.version !== el.version ||
          prev.versionNonce !== el.versionNonce ||
          prev.isDeleted !== el.isDeleted
        ) {
          this.yElements.set(el.id, el)
        }
      }
      // True removals: an id we track that Excalidraw dropped entirely.
      // (Excalidraw usually keeps deleted elements with isDeleted=true, handled
      // above; this covers the case where they are pruned from the scene.)
      for (const id of [...this.yElements.keys()]) {
        if (!seen.has(id)) this.yElements.delete(id)
      }

      if (files) {
        for (const [id, f] of Object.entries(files)) {
          if (f && !this.yFiles.has(id)) this.yFiles.set(id, f)
        }
      }
    }, this.origin)
  }

  onRemoteElements(_events, txn) {
    if (txn.origin === this.origin) return // our own write — already in the editor
    this.renderFromDoc()
  }

  onRemoteFiles(_event, txn) {
    if (txn.origin === this.origin) return
    this.pushFiles()
  }

  /** Rebuild the scene from the Y.Doc and apply it without echoing back. */
  renderFromDoc() {
    const elements = sortElements([...this.yElements.values()])
    this.applyingRemote = true
    try {
      this.pushFiles()
      this.api.updateScene({ elements })
    } finally {
      this.applyingRemote = false
    }
  }

  pushFiles() {
    if (this.yFiles.size === 0) return
    const existing = this.api.getFiles()
    const incoming = [...this.yFiles.values()].filter((f) => {
      if (!f || existing[f.id]) return false
      if (!isAllowedImage(f)) {
        // Drop non-image / active-content blobs from peers (e.g. svg+xml,
        // text/html). They never reach Excalidraw's file store.
        console.warn(`[vulos-whiteboard] rejected remote file with disallowed mime "${f?.mimeType}"`)
        return false
      }
      return true
    })
    if (incoming.length > 0) this.api.addFiles(incoming)
  }

  destroy() {
    this.disposed = true
    this.yElements.unobserveDeep(this.onRemoteElements)
    this.yFiles.unobserve(this.onRemoteFiles)
  }
}
