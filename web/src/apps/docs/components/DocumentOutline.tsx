/**
 * DocumentOutline — a persistent, navigable outline rail (Google Docs style).
 *
 * Unlike TableOfContents (which inserts a static ToC block into the body), this
 * is a live left-rail that:
 *   - lists every heading in reading order, indented by level;
 *   - highlights the heading for the section currently in view;
 *   - scrolls to (and places the caret in) a heading on click;
 *   - updates as the document changes.
 *
 * The pure helpers (`extractOutline`, `computeActiveHeadingIndex`) are exported
 * so the navigation logic can be unit-tested without a real editor/DOM.
 *
 * Props
 * -----
 *   editor              {Editor}   TipTap editor instance
 *   scrollContainerRef  {ref}      the scrollable canvas element (for active
 *                                  section tracking); optional
 *   onClose             {function} dismiss the rail
 */

import { useEffect, useState, useCallback, useRef } from 'react'
import type { RefObject } from 'react'
import { ListTree, X } from 'lucide-react'
import type { Editor } from '@tiptap/react'

export interface OutlineHeading {
  level: number
  text: string
  pos: number
  key: string
}

/**
 * extractOutline — walk the document and collect its headings with the
 * ProseMirror position of each (needed to scroll/select on click).
 * Returns `[{ level, text, pos, key }]` in document order.
 */
export function extractOutline(editor: Editor | null | undefined): OutlineHeading[] {
  const out: OutlineHeading[] = []
  if (!editor?.state?.doc) return out
  let i = 0
  editor.state.doc.descendants((node, pos) => {
    if (node.type?.name === 'heading') {
      const text = node.textContent || ''
      // node.attrs is ProseMirror's own Attrs (`{[key: string]: any}`).
      const rawLevel: unknown = node.attrs?.level
      const level = typeof rawLevel === 'number' && Number.isFinite(rawLevel) ? rawLevel : 1
      out.push({
        level,
        text,
        pos,
        key: `${pos}-${i++}`,
      })
    }
    return true
  })
  return out
}

/**
 * computeActiveHeadingIndex — given each heading's top offset (px, relative to
 * the scroll container) and the current scroll position, return the index of
 * the heading whose section is currently in view: the last heading at or above
 * the reading line (scrollTop + threshold).
 *
 * Pure + deterministic so it can be unit-tested.
 */
export function computeActiveHeadingIndex(tops: number[], scrollTop: number, threshold = 24): number {
  if (!Array.isArray(tops) || tops.length === 0) return -1
  const line = scrollTop + threshold
  let active = 0
  for (let i = 0; i < tops.length; i++) {
    if (tops[i] <= line) active = i
    else break
  }
  return active
}

export interface DocumentOutlineProps {
  editor: Editor | null | undefined
  scrollContainerRef?: RefObject<HTMLElement | null>
  onClose?: () => void
}

export default function DocumentOutline({ editor, scrollContainerRef, onClose }: DocumentOutlineProps) {
  const [headings, setHeadings] = useState<OutlineHeading[]>(() => extractOutline(editor))
  const [activeIdx, setActiveIdx] = useState(-1)
  const headingsRef = useRef(headings)
  headingsRef.current = headings

  // Re-extract on every document change (debounced by React batching).
  useEffect(() => {
    if (!editor) return
    const update = () => setHeadings(extractOutline(editor))
    editor.on('update', update)
    editor.on('selectionUpdate', update)
    update()
    return () => {
      editor.off('update', update)
      editor.off('selectionUpdate', update)
    }
  }, [editor])

  // Track which section is in view as the canvas scrolls.
  const recomputeActive = useCallback(() => {
    const container = scrollContainerRef?.current
    if (!editor?.view || !container) return
    const list = headingsRef.current
    if (list.length === 0) { setActiveIdx(-1); return }
    const containerTop = container.getBoundingClientRect().top
    const tops = list.map((h) => {
      try {
        const dom = editor.view.nodeDOM(h.pos)
        const el: Element | null = dom?.nodeType === 1 ? (dom as Element) : (dom?.parentElement ?? null)
        if (!el) return Number.POSITIVE_INFINITY
        return el.getBoundingClientRect().top - containerTop + container.scrollTop
      } catch {
        return Number.POSITIVE_INFINITY
      }
    })
    setActiveIdx(computeActiveHeadingIndex(tops, container.scrollTop))
  }, [editor, scrollContainerRef])

  useEffect(() => {
    const container = scrollContainerRef?.current
    if (!container) return
    recomputeActive()
    container.addEventListener('scroll', recomputeActive, { passive: true })
    return () => container.removeEventListener('scroll', recomputeActive)
  }, [recomputeActive, scrollContainerRef, headings])

  const goToHeading = (h: OutlineHeading) => {
    if (!editor?.view) return
    try {
      const dom = editor.view.nodeDOM(h.pos)
      const el: Element | null = dom?.nodeType === 1 ? (dom as Element) : (dom?.parentElement ?? null)
      if (el?.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      // Place the caret just inside the heading so keyboard nav continues there.
      editor.chain().setTextSelection(h.pos + 1).focus().run()
    } catch {
      // best-effort — outline navigation never throws into the editor
    }
  }

  return (
    <aside
      className="w-60 flex-shrink-0 border-r border-line bg-bg-elev2 flex flex-col overflow-hidden animate-slide-in-left"
      aria-label="Document outline"
    >
      <div className="flex items-center justify-between px-3 h-11 border-b border-line bg-paper flex-shrink-0">
        <div className="flex items-center gap-2">
          <ListTree size={14} className="text-ink-muted" aria-hidden="true" />
          <span className="text-sm font-semibold text-ink tracking-tightish">Outline</span>
          {headings.length > 0 && (
            <span className="text-2xs bg-bg-elev2 text-ink-faint rounded-pill px-1.5 py-0.5 font-medium tabular-nums">
              {headings.length}
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          className="text-ink-faint hover:text-ink transition-colors"
          aria-label="Close outline"
        >
          <X size={14} />
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto py-2">
        {headings.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="text-xs text-ink-faint font-serif italic leading-relaxed">
              Headings you add will appear here.
            </p>
            <p className="text-2xs text-ink-faint mt-2">
              Use the styles menu to add a Heading 1–6.
            </p>
          </div>
        ) : (
          <ul className="space-y-0.5 px-1.5">
            {headings.map((h, i) => (
              <li key={h.key}>
                <button
                  onClick={() => goToHeading(h)}
                  aria-current={i === activeIdx ? 'true' : undefined}
                  title={h.text || 'Untitled heading'}
                  className={[
                    'w-full text-left truncate rounded-sm py-1 pr-2 transition-colors',
                    'text-xs leading-snug',
                    i === activeIdx
                      ? 'bg-accent-tint text-accent-press font-medium'
                      : 'text-ink-muted hover:bg-accent-tint/60 hover:text-ink',
                  ].join(' ')}
                  style={{ paddingLeft: `${8 + (h.level - 1) * 12}px` }}
                >
                  {h.text || <span className="italic text-ink-faint">Untitled</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>
    </aside>
  )
}
