/**
 * FindReplace — floating find/replace bar for DocsEditor.
 *
 * Cmd+F  → opens in "find only" mode
 * Cmd+H  → opens in "find + replace" mode
 * Esc    → closes
 *
 * Highlights ALL matches in the document canvas using ProseMirror decorations
 * (registered via editor.registerPlugin). The current match uses a brighter
 * highlight class. Also supports regex mode via the .* toggle.
 */

import { useState, useEffect, useRef, useCallback, type KeyboardEvent } from 'react'
import { X, ChevronUp, ChevronDown, Replace, ReplaceAll } from 'lucide-react'
import type { Editor } from '@tiptap/react'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

// ---------------------------------------------------------------------------
// Inject highlight styles once into document head
// ---------------------------------------------------------------------------
if (typeof document !== 'undefined') {
  const styleId = 'vulos-find-highlight-styles'
  if (!document.getElementById(styleId)) {
    const s = document.createElement('style')
    s.id = styleId
    s.textContent = `
      .find-highlight { background: rgba(255, 213, 0, 0.45); border-radius: 2px; }
      .find-highlight-current { background: rgba(255, 140, 0, 0.65); border-radius: 2px; outline: 1px solid rgba(255, 140, 0, 0.8); }
    `
    document.head.appendChild(s)
  }
}

// Key name for the find-highlight plugin (registered in DocsEditor)
export const FIND_HIGHLIGHT_PLUGIN_KEY_NAME = 'findHighlight'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface TextMatch {
  index: number
  length: number
}

export function findAllMatches(doc: PMNode, term: string, caseSensitive: boolean, useRegex: boolean): TextMatch[] {
  if (!term) return []
  const fullText = doc.textContent || ''
  const flags = caseSensitive ? 'g' : 'gi'
  let re: RegExp
  try {
    re = new RegExp(useRegex ? term : escapeRegex(term), flags)
  } catch { return [] }
  const matches: TextMatch[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(fullText)) !== null) {
    matches.push({ index: m.index, length: m[0].length })
    if (re.lastIndex === m.index) re.lastIndex++
  }
  return matches
}

function buildDecorations(doc: PMNode, matches: TextMatch[], currentIdx: number): DecorationSet {
  if (!matches || matches.length === 0) return DecorationSet.empty
  const decos: Decoration[] = []
  let textOffset = 0
  let matchIdx = 0
  doc.descendants((node, pos) => {
    if (!node.isText) return
    const nodeText = node.text || ''
    while (matchIdx < matches.length) {
      const m = matches[matchIdx]
      const localStart = m.index - textOffset
      if (localStart < 0) { matchIdx++; continue }
      if (localStart >= nodeText.length) break
      const localEnd = localStart + m.length
      if (localEnd > nodeText.length) break // spans multiple nodes — skip
      const from = pos + localStart
      const to = pos + localEnd
      const cls = matchIdx === currentIdx
        ? 'find-highlight find-highlight-current'
        : 'find-highlight'
      decos.push(Decoration.inline(from, to, { class: cls }))
      matchIdx++
    }
    textOffset += nodeText.length
  })
  return DecorationSet.create(doc, decos)
}

/** Loose shape covering the plugin-key internals this lookup reaches for — the
 *  same kind of local cast helper as commentDecorations.ts's DecorationLike.
 *  PluginKey's public .d.ts exposes only get()/getState(), not the internal
 *  string `key` field ("findHighlight$") this uses to find the pre-registered
 *  plugin by name without importing its actual PluginKey instance; some pm
 *  versions instead surface a plain string `.key` on the Plugin itself, so
 *  both are checked, exactly as before. */
interface PluginLike {
  spec?: { key?: { key?: string } }
  key?: unknown
}

// Dispatch highlight decorations via the plugin pre-registered in DocsEditor.
// If the plugin is not present (e.g. in tests), this is a no-op.
//
// Accepts a possibly-null editor (goNext/goPrev below call this without a
// prior `if (!editor)` guard, same as the original untyped helper) — the cast
// keeps `editor.view` a genuine property access, so a null/undefined editor
// still throws here and is swallowed by the catch below exactly as before,
// rather than silently short-circuiting on an added optional-chain.
function applyHighlights(editor: Editor | null | undefined, matches: TextMatch[], currentIdx: number): void {
  try {
    const e = editor as Editor
    const plugins = e.view?.state?.plugins as unknown as PluginLike[] | undefined
    const pluginKey = plugins?.find?.(
      (p) => p.spec?.key?.key === FIND_HIGHLIGHT_PLUGIN_KEY_NAME + '$'
        || (p.key && typeof p.key === 'string' && p.key.startsWith(FIND_HIGHLIGHT_PLUGIN_KEY_NAME))
    )
    if (!pluginKey) return
    const set = buildDecorations(e.state.doc, matches, currentIdx)
    const tr = e.state.tr.setMeta(FIND_HIGHLIGHT_PLUGIN_KEY_NAME, set)
    e.view.dispatch(tr)
  } catch { /* non-fatal: plugin may not be registered */ }
}

function clearHighlights(editor: Editor): void {
  try {
    const tr = editor.state.tr.setMeta(FIND_HIGHLIGHT_PLUGIN_KEY_NAME, DecorationSet.empty)
    editor.view.dispatch(tr)
  } catch { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export interface FindReplaceProps {
  editor: Editor | null | undefined
  mode?: 'find' | 'replace'
  onClose: () => void
}

export default function FindReplace({ editor, mode: initialMode, onClose }: FindReplaceProps) {
  const [mode, setMode] = useState<'find' | 'replace'>(initialMode || 'find')
  const [term, setTerm] = useState('')
  const [replace, setReplace] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [useRegex, setUseRegex] = useState(false)
  const [regexError, setRegexError] = useState(false)
  const [matches, setMatches] = useState<TextMatch[]>([])
  const [current, setCurrent] = useState(0)
  const termRef = useRef<HTMLInputElement>(null)

  // Clear highlights when the bar is unmounted
  useEffect(() => {
    return () => { if (editor) clearHighlights(editor) }
  }, [editor])

  // Focus the search input on mount
  useEffect(() => { termRef.current?.focus() }, [])

  // Re-compute matches whenever term, case, or regex mode changes
  useEffect(() => {
    if (!editor || !term) {
      setMatches([])
      setCurrent(0)
      setRegexError(false)
      if (editor) clearHighlights(editor)
      return
    }
    // Validate regex if in regex mode
    if (useRegex) {
      try { new RegExp(term) } catch {
        setRegexError(true); setMatches([]); setCurrent(-1)
        clearHighlights(editor); return
      }
    }
    setRegexError(false)
    const found = findAllMatches(editor.state.doc, term, caseSensitive, useRegex)
    setMatches(found)
    const idx = found.length > 0 ? 0 : -1
    setCurrent(idx)
    applyHighlights(editor, found, idx)
  }, [term, caseSensitive, useRegex, editor])

  // Scroll to and select the current match
  const selectMatch = useCallback((idx: number, matchList?: TextMatch[]) => {
    const m = matchList ?? matches
    if (!editor || m.length === 0 || idx < 0) return
    const match = m[idx]
    let pos = 0
    let found = false
    editor.state.doc.descendants((node, nodePos) => {
      if (found || !node.isText) return
      const start = pos
      const end = pos + (node.text || '').length
      if (match.index >= start && match.index < end) {
        const from = nodePos + (match.index - start)
        const to = from + match.length
        editor.commands.setTextSelection({ from, to })
        found = true
        return false
      }
      pos += node.isText ? (node.text || '').length : 0
    })
  }, [editor, matches])

  const goNext = () => {
    if (matches.length === 0) return
    const next = (current + 1) % matches.length
    setCurrent(next)
    selectMatch(next)
    applyHighlights(editor, matches, next)
  }

  const goPrev = () => {
    if (matches.length === 0) return
    const prev = (current - 1 + matches.length) % matches.length
    setCurrent(prev)
    selectMatch(prev)
    applyHighlights(editor, matches, prev)
  }

  const doReplace = () => {
    if (!editor || matches.length === 0 || current < 0) return
    const { from, to } = editor.state.selection
    if (from !== to) {
      editor.chain().focus().deleteRange({ from, to }).insertContentAt(from, replace).run()
    }
    // Recompute + advance
    const newMatches = findAllMatches(editor.state.doc, term, caseSensitive, useRegex)
    setMatches(newMatches)
    const next = Math.min(current, newMatches.length - 1)
    setCurrent(next)
    selectMatch(next, newMatches)
    applyHighlights(editor, newMatches, next)
  }

  const doReplaceAll = () => {
    if (!editor || !term) return
    const flags = caseSensitive ? 'g' : 'gi'
    let re: RegExp
    try { re = new RegExp(useRegex ? term : escapeRegex(term), flags) } catch { return }
    const { doc } = editor.state
    const edits: { from: number; to: number }[] = []
    doc.descendants((node, pos) => {
      if (!node.isText) return
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(node.text || '')) !== null) {
        edits.push({ from: pos + m.index, to: pos + m.index + m[0].length })
      }
    })
    let chain = editor.chain().focus()
    for (let i = edits.length - 1; i >= 0; i--) {
      const e = edits[i]
      chain = chain.deleteRange({ from: e.from, to: e.to }).insertContentAt(e.from, replace)
    }
    chain.run()
    setMatches([])
    setCurrent(-1)
    clearHighlights(editor)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { onClose(); return }
    if (e.key === 'Enter') {
      if (e.shiftKey) goPrev()
      else goNext()
    }
  }

  const countLabel = term
    ? regexError
      ? 'Invalid regex'
      : matches.length === 0
        ? 'No results'
        : `${current + 1} / ${matches.length}`
    : ''

  return (
    <div
      role="dialog"
      aria-label="Find and replace"
      className={[
        'absolute top-2 right-4 z-50 bg-paper border border-line rounded-lg shadow-e3',
        'flex flex-col gap-0 overflow-hidden animate-scale-in',
        'w-80',
      ].join(' ')}
      style={{ minWidth: 260 }}
    >
      {/* Find row */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-line">
        <input
          ref={termRef}
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Find…"
          aria-label="Search term"
          className={[
            'flex-1 min-w-0 text-sm bg-transparent outline-none placeholder:text-ink-faint',
            regexError ? 'text-danger' : 'text-ink',
          ].join(' ')}
        />
        {/* Count indicator */}
        {countLabel && (
          <span className={`text-2xs flex-shrink-0 tabular-nums ${regexError ? 'text-danger' : 'text-ink-faint'}`}>
            {countLabel}
          </span>
        )}
        {/* Case sensitive */}
        <button
          title="Match case"
          onClick={() => setCaseSensitive((v) => !v)}
          className={`flex-shrink-0 w-6 h-6 rounded-sm flex items-center justify-center text-2xs font-bold transition-colors ${caseSensitive ? 'bg-accent text-white' : 'text-ink-faint hover:bg-bg-elev2'}`}
          aria-pressed={caseSensitive}
        >
          Aa
        </button>
        {/* Regex mode */}
        <button
          title="Use regular expression"
          onClick={() => setUseRegex((v) => !v)}
          className={`flex-shrink-0 w-6 h-6 rounded-sm flex items-center justify-center text-2xs font-mono font-bold transition-colors ${useRegex ? 'bg-accent text-white' : 'text-ink-faint hover:bg-bg-elev2'} ${regexError ? 'outline outline-1 outline-danger' : ''}`}
          aria-pressed={useRegex}
        >
          .*
        </button>
        {/* Prev / Next */}
        <button
          onClick={goPrev}
          disabled={matches.length === 0}
          title="Previous match (Shift+Enter)"
          aria-label="Previous match"
          className="flex-shrink-0 w-6 h-6 rounded-sm flex items-center justify-center text-ink-faint hover:bg-bg-elev2 disabled:opacity-30 transition-colors"
        >
          <ChevronUp size={13} />
        </button>
        <button
          onClick={goNext}
          disabled={matches.length === 0}
          title="Next match (Enter)"
          aria-label="Next match"
          className="flex-shrink-0 w-6 h-6 rounded-sm flex items-center justify-center text-ink-faint hover:bg-bg-elev2 disabled:opacity-30 transition-colors"
        >
          <ChevronDown size={13} />
        </button>
        {/* Toggle replace */}
        <button
          onClick={() => setMode((m) => (m === 'find' ? 'replace' : 'find'))}
          title={mode === 'find' ? 'Show replace' : 'Hide replace'}
          aria-label="Toggle replace"
          className="flex-shrink-0 w-6 h-6 rounded-sm flex items-center justify-center text-ink-faint hover:bg-bg-elev2 transition-colors"
        >
          <Replace size={13} />
        </button>
        {/* Close */}
        <button
          onClick={onClose}
          title="Close (Esc)"
          aria-label="Close find bar"
          className="flex-shrink-0 w-6 h-6 rounded-sm flex items-center justify-center text-ink-faint hover:bg-bg-elev2 transition-colors"
        >
          <X size={13} />
        </button>
      </div>

      {/* Replace row */}
      {mode === 'replace' && (
        <div className="flex items-center gap-1 px-2 py-1.5">
          <input
            value={replace}
            onChange={(e) => setReplace(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
            placeholder="Replace with…"
            aria-label="Replace with"
            className="flex-1 min-w-0 text-sm bg-transparent outline-none text-ink placeholder:text-ink-faint"
          />
          <button
            onClick={doReplace}
            disabled={matches.length === 0}
            title="Replace current"
            aria-label="Replace"
            className="flex-shrink-0 h-6 px-2 text-2xs font-medium rounded-sm border border-line text-ink-muted hover:bg-accent-tint disabled:opacity-30 transition-colors"
          >
            Replace
          </button>
          <button
            onClick={doReplaceAll}
            disabled={!term}
            title="Replace all"
            aria-label="Replace all"
            className="flex-shrink-0 h-6 px-2 text-2xs font-medium rounded-sm border border-line text-ink-muted hover:bg-accent-tint disabled:opacity-30 transition-colors flex items-center gap-1"
          >
            <ReplaceAll size={11} /> All
          </button>
        </div>
      )}
    </div>
  )
}
