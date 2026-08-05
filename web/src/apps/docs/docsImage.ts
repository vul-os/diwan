/**
 * docsImage — inline-image embedding policy + a hardened TipTap Image node.
 * ----------------------------------------------------------------------------
 * WAVE-57: Docs gained real image content. Two concerns live here:
 *
 *  1. Embed policy (mirrors vulos-mail-ui wave-42 inline-image safety): a
 *     pasted / dropped / picked file is embedded as a bounded base64 `data:`
 *     URI. Only RASTER mime types are allowed (png/jpeg/gif/webp) — SVG is
 *     deliberately excluded because an SVG can carry <script>/on* handlers, and
 *     an `<img>`-referenced SVG data: URI is exactly the vector the sanitiser
 *     rejects; refusing it at the source keeps the two layers consistent. A hard
 *     byte cap keeps a single inline image from bloating the CRDT doc / autosave.
 *
 *  2. A DocImage node extending @tiptap/extension-image with three attributes
 *     Google-Docs users expect — width (resize), align (left/center/right), and
 *     alt (a11y) — all rendered as plain <img width>/style attrs that survive
 *     `sanitizeDocHtml` (width is an allow-listed html attr; text-align / margin
 *     / display are allow-listed CSS props). The node stays a single atomic
 *     block, so it syncs through the wave-37 CRDT like any other structured node
 *     (see docHasStructuredNodes — image is treated as structured too).
 */

import Image from '@tiptap/extension-image'
import { isSafeImageSrc } from '../../lib/sanitize'

// Raster-only allow-list. Same set the sanitiser keeps as SAFE_RASTER_DATA_URI
// and the mail-ui compose path embeds. SVG excluded on purpose (script carrier).
export const INLINE_IMAGE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
])

// Cap a single inline image. base64 inflates ~33%, so a 5 MiB source file lands
// ~6.7 MiB in the doc — generous for a document image, bounded enough to keep
// the CRDT/autosave payload sane.
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024

/** True if a File is an embeddable raster image within the size cap. */
export function isEmbeddableImage(file: { type?: string; size?: number } | null | undefined): boolean {
  return !!file &&
    INLINE_IMAGE_TYPES.has(file.type ?? '') &&
    (file.size ?? 0) > 0 &&
    (file.size ?? Infinity) <= MAX_INLINE_IMAGE_BYTES
}

/**
 * Read a raster File to a base64 data: URI, enforcing the raster allow-list +
 * size cap. Rejects with a caller-presentable Error otherwise. The returned URI
 * is always `data:image/<raster>;base64,…` — never svg/xml/html.
 *
 * @param {File} file
 * @returns {Promise<string>} data: URI
 */
export function fileToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file || !INLINE_IMAGE_TYPES.has(file.type)) {
      reject(new Error('Only PNG, JPEG, GIF, or WebP images can be inserted'))
      return
    }
    if (file.size > MAX_INLINE_IMAGE_BYTES) {
      reject(new Error(`Image is larger than ${Math.round(MAX_INLINE_IMAGE_BYTES / (1024 * 1024))} MB and can't be embedded`))
      return
    }
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Could not read image file'))
    reader.onload = (ev) => {
      const uri = ev.target?.result
      // Defence-in-depth: the FileReader result must be a raster data: URI.
      if (typeof uri === 'string' && /^data:image\/(?:png|jpe?g|gif|webp);/i.test(uri)) {
        resolve(uri)
      } else {
        reject(new Error('Image could not be embedded'))
      }
    }
    reader.readAsDataURL(file)
  })
}

// Map an alignment keyword to the inline style the <img> renders. Center + right
// use `display:block` + `margin` auto; left is the default flow. We express
// alignment purely through `margin`/`display` — both allow-listed CSS props — so
// it survives `sanitizeDocHtml` (no data-* attr dependency, which the doc config
// does not guarantee) and round-trips through HTML export/import via the style.
function alignStyle(align: unknown): string {
  switch (align) {
    case 'center': return 'display:block;margin-left:auto;margin-right:auto'
    case 'right':  return 'display:block;margin-left:auto;margin-right:0'
    case 'left':   return 'display:block;margin-left:0;margin-right:auto'
    default:       return ''
  }
}

// Recover the alignment keyword from an <img>'s inline style on import so a
// round-tripped doc keeps its alignment (mirrors alignStyle above).
function parseAlign(el: HTMLElement): string | null {
  const style = (el.getAttribute('style') || '').replace(/\s+/g, '').toLowerCase()
  if (!/display:block/.test(style)) return null
  const l = /margin-left:auto/.test(style)
  const r = /margin-right:auto/.test(style)
  if (l && r) return 'center'
  if (l && !r) return 'right'
  if (!l && r) return 'left'
  return null
}

/**
 * DocImage — @tiptap/extension-image + width / align / alt attributes.
 *
 * `alt` is already provided by the base Image extension. We add `width` (resize)
 * and `align` (left/center/right). Both render into plain <img width> + inline
 * `style` that pass the sanitiser: `width` is an allow-listed html attribute and
 * every emitted CSS property (width / display / margin*) is on SAFE_CSS_PROPS.
 *
 * allowBase64 is on so pasted/dropped data: URIs become image nodes (the embed
 * helpers above guarantee only raster data: URIs reach here). The node is a
 * single atomic block, so it syncs through the wave-37 CRDT like a table.
 */
export const DocImage = Image.extend({
  name: 'image',

  addAttributes() {
    return {
      ...this.parent?.(),
      // width / align are folded into the <img>'s width attr + inline style by
      // the node-level renderHTML below, so their per-attribute renderHTML is a
      // no-op (returning {} keeps them out of the merged attribute set here).
      width: {
        default: null,
        parseHTML: (el) => el.getAttribute('width') || el.style?.width || null,
        renderHTML: () => ({}),
      },
      align: {
        default: null,
        parseHTML: (el) => parseAlign(el),
        renderHTML: () => ({}),
      },
    }
  },

  // Read from `node.attrs` (not the merged HTMLAttributes, which have already had
  // width/align stripped by their no-op renderHTML) so the values actually reach
  // the emitted markup. width → the html `width` attr (allow-listed) + `width`
  // CSS; align → margin/display CSS. All survive sanitizeDocHtml.
  //
  // WAVE-58 SECURITY (collab-ingress gate): the realtime CRDT carries only text,
  // so an image node reaches a peer via the persisted document JSON — reloaded by
  // resolveContent()/setContent(json), a path that (unlike the _html import
  // branch) NEVER flows through sanitizeDocHtml. A malicious rw collaborator could
  // therefore PUT doc JSON with an image node whose src is `javascript:` /
  // `data:image/svg+xml` / `data:text/html` and it would render into the live
  // editor DOM unsanitised. We close that hole AT THE NODE: renderHTML refuses to
  // emit a src that isn't allow-list-safe (same policy as the sanitiser), so no
  // ingress path — JSON reload, draft/history restore, or a peer op — can produce
  // a live poisoned <img> src. Fail-closed: an unsafe src is dropped, the node
  // renders as an (empty) <img> rather than executing/leaking.
  renderHTML({ node, HTMLAttributes }) {
    // node.attrs / HTMLAttributes are tiptap's own Record<string, any> —
    // narrow the two fields this override actually reads/writes.
    const width: unknown = node.attrs.width
    const align: unknown = node.attrs.align
    const { style: baseStyle, src, ...rest } = HTMLAttributes as Record<string, unknown>
    if (src != null && !isSafeImageSrc(src)) {
      // Drop an unsafe src entirely; keep the (now image-less) node.
      delete rest.src
    } else if (src != null) {
      rest.src = src
    }
    const widthStr = typeof width === 'string' || typeof width === 'number' ? String(width) : ''
    const parts = []
    if (widthStr) parts.push(`width:${widthStr}`)
    const a = alignStyle(align)
    if (a) parts.push(a)
    const attrs: Record<string, unknown> = { ...rest }
    if (width) attrs.width = width
    const style = [baseStyle, parts.join(';')].filter(Boolean).join(';')
    if (style) attrs.style = style
    return ['img', attrs]
  },
}).configure({ allowBase64: true })
