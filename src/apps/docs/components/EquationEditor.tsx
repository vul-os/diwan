/**
 * EquationEditor — P4: LaTeX input with a live KaTeX preview.
 *
 * A modal that edits ONE math node's LaTeX source. The preview renders through
 * the same locked-down renderEquationHtml (trust:false) as the node itself, so
 * what you see in the preview is exactly (and only) what the safe renderer emits
 * — a `\href{javascript:…}` shows as inert text here too. The dialog never sets
 * innerHTML from raw user input; it always goes through KaTeX.
 *
 * On insert/apply it calls back with { latex, display } and the caller runs the
 * TipTap command (insertMathInline / insertMathBlock / updateMath).
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import Modal from '../../../components/ui/Modal'
import { Button } from '../../../components/ui'
import { renderEquationHtml } from '../equation.js'

// A few common templates to make the editor feel first-class (Docs/Word parity).
const SNIPPETS = [
  { label: 'Fraction', latex: '\\frac{a}{b}' },
  { label: 'Square root', latex: '\\sqrt{x}' },
  { label: 'Power', latex: 'x^{2}' },
  { label: 'Subscript', latex: 'x_{i}' },
  { label: 'Sum', latex: '\\sum_{i=1}^{n} i' },
  { label: 'Integral', latex: '\\int_{a}^{b} f(x)\\,dx' },
  { label: 'Limit', latex: '\\lim_{x \\to \\infty}' },
  { label: 'Matrix', latex: '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}' },
  { label: 'Greek', latex: '\\alpha + \\beta = \\gamma' },
]

export interface EquationEditorSubmitArgs {
  latex: string
  display: boolean
}

export interface EquationEditorProps {
  open: boolean
  initialLatex?: string
  initialDisplay?: boolean
  onSubmit?: (args: EquationEditorSubmitArgs) => void
  onClose?: () => void
}

export default function EquationEditor({
  open,
  initialLatex = '',
  initialDisplay = false,
  onSubmit,
  onClose,
}: EquationEditorProps) {
  const [latex, setLatex] = useState(initialLatex)
  const [display, setDisplay] = useState(initialDisplay)
  const taRef = useRef<HTMLTextAreaElement>(null)

  // Reset local state whenever the dialog is (re)opened for a different node.
  useEffect(() => {
    if (open) {
      setLatex(initialLatex)
      setDisplay(initialDisplay)
    }
  }, [open, initialLatex, initialDisplay])

  // Live preview HTML — rendered by the safe KaTeX path. useMemo so we only
  // re-render KaTeX when the source / mode actually changes.
  const previewHtml = useMemo(
    () => (latex.trim() ? renderEquationHtml(latex, display) : ''),
    [latex, display],
  )

  const insertSnippet = (snippet: string) => {
    const ta = taRef.current
    if (!ta) { setLatex((v) => v + snippet); return }
    const start = ta.selectionStart ?? latex.length
    const end = ta.selectionEnd ?? latex.length
    const next = latex.slice(0, start) + snippet + latex.slice(end)
    setLatex(next)
    // Restore focus + caret after the inserted snippet.
    requestAnimationFrame(() => {
      ta.focus()
      const pos = start + snippet.length
      try { ta.setSelectionRange(pos, pos) } catch { /* noop */ }
    })
  }

  const handleSubmit = () => {
    const trimmed = latex.trim()
    if (!trimmed) { onClose?.(); return }
    onSubmit?.({ latex: trimmed, display })
  }

  return (
    <Modal open={open} onClose={onClose} title="Equation" size="lg">
      <Modal.Body className="space-y-3">
        {/* Live preview */}
        <div
          className="min-h-[64px] flex items-center justify-center px-4 py-3 rounded-md border border-line bg-bg-elev2 text-ink overflow-x-auto"
          aria-live="polite"
          aria-label="Equation preview"
        >
          {previewHtml
            ? <span dangerouslySetInnerHTML={{ __html: previewHtml }} />
            : <span className="text-ink-faint text-sm">Preview appears here</span>}
        </div>

        {/* LaTeX source input */}
        <label className="block">
          <span className="text-2xs font-semibold text-ink-faint tracking-eyebrow uppercase">
            LaTeX
          </span>
          <textarea
            ref={taRef}
            value={latex}
            onChange={(e) => setLatex(e.target.value)}
            onKeyDown={(e) => {
              // Cmd/Ctrl+Enter submits (Enter alone is a newline in LaTeX).
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault()
                handleSubmit()
              }
            }}
            rows={3}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="e.g.  E = mc^2   or   \frac{-b \pm \sqrt{b^2-4ac}}{2a}"
            aria-label="LaTeX source"
            className="mt-1 w-full font-mono text-sm px-3 py-2 rounded-md border border-line bg-paper text-ink placeholder:text-ink-faint focus:outline-none focus:border-accent resize-y"
          />
        </label>

        {/* Snippet palette */}
        <div className="flex flex-wrap gap-1.5">
          {SNIPPETS.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => insertSnippet(s.latex)}
              className="h-6 px-2 rounded-sm border border-line text-2xs text-ink-muted hover:border-accent hover:text-ink transition-colors"
              title={s.latex}
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* Display mode toggle */}
        <label className="flex items-center gap-2 text-sm text-ink-muted">
          <input
            type="checkbox"
            checked={display}
            onChange={(e) => setDisplay(e.target.checked)}
          />
          Display (block) equation — centred on its own line
        </label>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={handleSubmit} disabled={!latex.trim()}>
          Insert equation
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
