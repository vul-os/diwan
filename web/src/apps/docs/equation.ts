/**
 * equation.js — P4: math equations rendered with KaTeX.
 * ============================================================================
 * Two TipTap nodes give Docs first-class equations that read like Google Docs'
 * / Word's equation editor:
 *
 *   mathInline — an atomic INLINE node placed at the caret (e.g. `E = mc^2` in a
 *                sentence). Holds a `latex` string attribute; renders KaTeX in
 *                inline mode.
 *   mathBlock  — an atomic BLOCK node (a centred display equation on its own
 *                line). Holds the same `latex` attribute; renders KaTeX in
 *                display mode.
 *
 * ── SECURITY (the whole point of the containment design) ─────────────────────
 * The equation's ONLY document content is the LaTeX *source string* — a plain
 * text attribute. KaTeX HTML is NEVER stored in the document, never synced over
 * the CRDT, and never round-trips through sanitizeDocHtml as markup. Rendering
 * happens client-side, at view time, from the source string into a contained
 * element, and ALWAYS with KaTeX's safe defaults:
 *
 *   • trust:false (the default) — this DISABLES \href, \htmlData, \html*,
 *     \includegraphics and every other command that could emit a live href /
 *     data attribute / external fetch. A `\href{javascript:…}{x}` renders as
 *     inert text, not an <a href>. Verified in equations.test.js.
 *   • strict:'ignore' + throwOnError:false — a malformed / hostile input renders
 *     as a bounded error span (red text), never throws, never injects.
 *   • The KaTeX output is bounded MathML + <span>/<svg> with dimensional inline
 *     styles only — no script, no on* handler, no url()/fetch construct. For the
 *     EXPORT path (where the rendered HTML DOES leave our viewer) we still run it
 *     through sanitizeDocHtml as defence-in-depth (see renderEquationHtmlSafe).
 *
 * Because the node is atomic and carries only a text attribute, it syncs through
 * the wave-37 CRDT exactly like an image/table (see docHasStructuredNodes, which
 * treats math nodes as structured), and a malicious peer can at worst PUT a
 * hostile LaTeX *string* — which renders inertly under trust:false.
 */

import { Node, mergeAttributes, type NodeViewRendererProps } from '@tiptap/react'
import type { Node as PMNode } from '@tiptap/pm/model'
import katex from 'katex'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    mathInline: {
      insertMathInline: (latex?: string) => ReturnType
      updateMath: (latex: string) => ReturnType
    }
    mathBlock: {
      insertMathBlock: (latex?: string) => ReturnType
      updateMathBlock: (latex: string) => ReturnType
    }
  }
}

// Locked-down KaTeX options. `trust:false` is the default but we set it
// explicitly so a future refactor can't silently enable dangerous commands.
// `strict:'ignore'` keeps hostile / non-standard input from surfacing as a
// throw or a console-spamming warning while STILL disabling the HTML extension
// (which only activates under trust anyway).
export const KATEX_SAFE_OPTIONS = Object.freeze({
  throwOnError: false,
  strict: 'ignore',
  trust: false,
  output: 'htmlAndMathml',
})

/**
 * Render a LaTeX source string to a KaTeX HTML string with the safe options.
 * Never throws (throwOnError:false + a try/catch fallback). The output is
 * bounded KaTeX markup; callers that let it leave the sanitised viewer (export)
 * MUST additionally pass it through sanitizeDocHtml (renderEquationHtmlSafe does).
 *
 * @param {string} latex
 * @param {boolean} displayMode  true → block/display, false → inline
 * @returns {string} KaTeX HTML
 */
const XML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}

export function renderEquationHtml(latex: unknown, displayMode: unknown): string {
  const src = typeof latex === 'string' ? latex : ''
  try {
    return katex.renderToString(src, { ...KATEX_SAFE_OPTIONS, displayMode: !!displayMode })
  } catch {
    // throwOnError:false already prevents most throws; belt-and-braces so a
    // renderer bug can never break the editor. Show the raw source as text.
    const esc = src.replace(/[&<>"']/g, (c) => XML_ESCAPE_MAP[c] ?? c)
    return `<span class="katex-error" title="Invalid equation">${esc}</span>`
  }
}

// Render + escape a math node's live DOM (for the NodeView). Sets innerHTML from
// KaTeX output — safe because the source is a plain string rendered with
// trust:false (no script/href/fetch can be produced). We do NOT sanitise here on
// the hot path (KaTeX output is bounded by construction); the EXPORT path, which
// is the real trust boundary, sanitises via renderEquationHtmlSafe.
function paintMath(dom: HTMLElement, latex: unknown, displayMode: unknown, placeholder?: string) {
  const src = typeof latex === 'string' ? latex.trim() : ''
  if (!src) {
    dom.textContent = placeholder || '𝑓(𝑥)'
    dom.classList.add('math-empty')
    return
  }
  dom.classList.remove('math-empty')
  dom.innerHTML = renderEquationHtml(src, displayMode)
}

// Shared attribute schema: a single `latex` source string. Parsed from a
// `data-latex` attribute so a round-tripped export re-imports as an equation.
function latexAttribute() {
  return {
    latex: {
      default: '',
      parseHTML: (el: HTMLElement) => el.getAttribute('data-latex') || '',
      renderHTML: (attrs: { latex?: string }) => (attrs.latex ? { 'data-latex': attrs.latex } : {}),
    },
  }
}

/**
 * Build a NodeView that renders KaTeX into a contained element from the node's
 * `latex` attribute. The rendered KaTeX DOM is display-only; editing happens via
 * the equation editor dialog (see EquationEditor.jsx) which updates the `latex`
 * attribute through the TipTap chain.
 */
function makeMathNodeView(displayMode: boolean, tag: string) {
  return ({ node, HTMLAttributes }: NodeViewRendererProps) => {
    // node.attrs is tiptap's own Record<string, any> — narrow the one field
    // this view reads before handing it to a string-typed DOM API.
    const latexStr = (n: PMNode): string => (typeof n.attrs.latex === 'string' ? n.attrs.latex : '')
    const dom = document.createElement(tag)
    dom.className = displayMode ? 'math-block' : 'math-inline'
    dom.setAttribute('data-latex', latexStr(node))
    dom.setAttribute('contenteditable', 'false')
    // Copy through merged (safe) HTML attributes so classes/data survive.
    for (const [k, v] of Object.entries(mergeAttributes(HTMLAttributes))) {
      if (k === 'class') dom.className += ` ${v}`
      else if (v != null) dom.setAttribute(k, String(v))
    }
    paintMath(dom, node.attrs.latex, displayMode)
    return {
      dom,
      update(updatedNode: PMNode) {
        if (updatedNode.type.name !== node.type.name) return false
        dom.setAttribute('data-latex', latexStr(updatedNode))
        paintMath(dom, updatedNode.attrs.latex, displayMode)
        return true
      },
      // Atom: ProseMirror manages selection; no contentDOM.
      ignoreMutation: () => true,
    }
  }
}

export const MathInline = Node.create({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() { return latexAttribute() },

  parseHTML() {
    return [
      { tag: 'span[data-latex]' },
      { tag: 'span.math-inline' },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    // Static serialization (getHTML / copy): carry the source in data-latex so a
    // re-parse restores the node. The export path re-renders KaTeX into this
    // shell (numberless here); see docsExport renderMathInHtml.
    return ['span', mergeAttributes(HTMLAttributes, { class: 'math-inline', 'data-math': 'inline' })]
  },

  addNodeView() { return makeMathNodeView(false, 'span') },

  addCommands() {
    return {
      insertMathInline: (latex = '') => ({ chain }) =>
        chain().insertContent({ type: this.name, attrs: { latex } }).run(),
      updateMath: (latex: string) => ({ commands }) =>
        commands.updateAttributes(this.name, { latex }),
    }
  },
})

export const MathBlock = Node.create({
  name: 'mathBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() { return latexAttribute() },

  parseHTML() {
    return [
      { tag: 'div[data-latex]' },
      { tag: 'div.math-block' },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { class: 'math-block', 'data-math': 'block' })]
  },

  addNodeView() { return makeMathNodeView(true, 'div') },

  addCommands() {
    return {
      insertMathBlock: (latex = '') => ({ chain }) =>
        chain().insertContent({ type: this.name, attrs: { latex } }).run(),
      updateMathBlock: (latex: string) => ({ commands }) =>
        commands.updateAttributes(this.name, { latex }),
    }
  },
})
