/**
 * SmartChipMenu — the @-menu that inserts smart chips into a Docs document.
 *
 * Watches the editor for an `@query` trigger immediately before the caret (via
 * the pure detectChipTrigger), builds a ranked suggestion list from the doc's
 * people + the user's files + date/place options (buildChipSuggestions), and
 * renders a keyboard-navigable floating menu at the caret. Choosing an item
 * deletes the `@query` text and inserts the corresponding smart chip.
 *
 * Props:
 *   editor  {Editor}                    TipTap editor instance
 *   people  {Array<{id,name}>}          collaborators on this document
 *   files   {Array<{id,name,type}>}     the user's files (for file chips)
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import type { Editor } from '@tiptap/react'
import { detectChipTrigger, buildChipSuggestions } from '../smartChips.js'
// insertSmartChip's Commands<> augmentation now lives in smartChips.ts, which
// this file's editor.chain()...insertSmartChip() call below relies on.

// Mirror the shapes buildChipSuggestions' JSDoc declares for sources.people /
// sources.files exactly, so passing these props through never needs a cast.
type ChipSources = Parameters<typeof buildChipSuggestions>[1]
export type ChipPerson = NonNullable<ChipSources>['people'][number]
export type ChipFile = NonNullable<ChipSources>['files'][number]

type ChipTrigger = ReturnType<typeof detectChipTrigger>
type ChipSuggestion = ReturnType<typeof buildChipSuggestions>[number]

// One-time chip + menu styles (mirrors the FindReplace self-injection pattern).
if (typeof document !== 'undefined') {
  const styleId = 'vulos-smart-chip-styles'
  if (!document.getElementById(styleId)) {
    const s = document.createElement('style')
    s.id = styleId
    s.textContent = `
      .smart-chip {
        display: inline-flex; align-items: center; gap: 2px;
        padding: 0 6px; margin: 0 1px; border-radius: 9999px;
        font-size: 0.92em; line-height: 1.5; white-space: nowrap;
        background: var(--chip-bg); color: var(--chip-fg);
        border: 1px solid var(--chip-bd); cursor: default;
        user-select: none;
      }
      /* Category chips ride the design tokens (per-app tints + signals) via
         color-mix, so they read correctly in BOTH light and dark themes. */
      .smart-chip-person { --chip-bg: color-mix(in srgb, var(--app-board) 14%, transparent);  --chip-fg: var(--app-board);  --chip-bd: color-mix(in srgb, var(--app-board) 34%, transparent); }
      .smart-chip-date   { --chip-bg: var(--signal-success-bg);                                 --chip-fg: var(--signal-success); --chip-bd: color-mix(in srgb, var(--signal-success) 34%, transparent); }
      .smart-chip-file   { --chip-bg: color-mix(in srgb, var(--app-docs) 14%, transparent);    --chip-fg: var(--app-docs);   --chip-bd: color-mix(in srgb, var(--app-docs) 34%, transparent); cursor:pointer; }
      .smart-chip-file:hover { text-decoration: underline; }
      .smart-chip-place  { --chip-bg: var(--signal-warning-bg);                                 --chip-fg: var(--signal-warning); --chip-bd: color-mix(in srgb, var(--signal-warning) 34%, transparent); }
    `
    document.head.appendChild(s)
  }
}

export interface SmartChipMenuProps {
  editor: Editor | null | undefined
  people?: ChipPerson[]
  files?: ChipFile[]
}

export default function SmartChipMenu({ editor, people = [], files = [] }: SmartChipMenuProps) {
  const [trigger, setTrigger] = useState<ChipTrigger>(null)
  const [items, setItems] = useState<ChipSuggestion[]>([])
  const [active, setActive] = useState(0)
  const [pos, setPos] = useState({ left: 0, top: 0 })
  const triggerRef = useRef<ChipTrigger>(null)
  const itemsRef = useRef<ChipSuggestion[]>([])
  const activeRef = useRef(0)
  triggerRef.current = trigger
  itemsRef.current = items
  activeRef.current = active

  const close = useCallback(() => {
    setTrigger(null)
    setItems([])
    setActive(0)
  }, [])

  const select = useCallback(
    (item: ChipSuggestion) => {
      const t = triggerRef.current
      if (!editor || !t || !item) return
      editor
        .chain()
        .focus()
        .deleteRange({ from: t.from, to: t.to })
        .insertSmartChip({
          chipType: item.chipType,
          label: item.label,
          refId: item.refId,
          refHref: item.refHref,
        })
        .run()
      close()
    },
    [editor, close],
  )

  // Recompute the trigger + suggestions whenever the document / selection moves.
  useEffect(() => {
    if (!editor) return
    const recompute = () => {
      const t = detectChipTrigger(editor.state)
      if (!t) {
        if (triggerRef.current) close()
        return
      }
      const next = buildChipSuggestions(t.query, { people, files })
      setTrigger(t)
      setItems(next)
      setActive(0)
      // Position the menu just below the caret's `@`.
      try {
        const coords = editor.view.coordsAtPos(t.from)
        setPos({ left: coords.left, top: coords.bottom + 4 })
      } catch {
        /* view may be mid-update; keep last position */
      }
    }
    editor.on('selectionUpdate', recompute)
    editor.on('update', recompute)
    // Compute once on mount so a trigger already present when this mounts is
    // reflected without waiting for the next editor event.
    recompute()
    return () => {
      editor.off('selectionUpdate', recompute)
      editor.off('update', recompute)
    }
  }, [editor, people, files, close])

  // Keyboard navigation. Captured at the window so it intercepts before the
  // editor sees the key (the caret stays in the editor while the menu is open).
  useEffect(() => {
    if (!trigger) return
    const onKey = (e: KeyboardEvent) => {
      const list = itemsRef.current
      if (!list.length) {
        if (e.key === 'Escape') { e.preventDefault(); close() }
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((i) => (i + 1) % list.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((i) => (i - 1 + list.length) % list.length)
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        select(list[activeRef.current])
      } else if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [trigger, select, close])

  if (!trigger || items.length === 0) return null

  return (
    <div
      data-testid="smart-chip-menu"
      role="listbox"
      aria-label="Insert smart chip"
      className="fixed z-50 min-w-[240px] max-w-[340px] max-h-[280px] overflow-auto rounded-lg border border-line bg-paper shadow-e3 py-1 text-sm animate-fade-in"
      style={{ left: `${pos.left}px`, top: `${pos.top}px` }}
      // Prevent the editor from losing focus when the user clicks an item.
      onMouseDown={(e) => e.preventDefault()}
    >
      {items.map((item, i) => (
        <button
          key={item.key}
          type="button"
          role="option"
          aria-selected={i === active}
          data-testid={`smart-chip-option-${item.chipType}`}
          onMouseEnter={() => setActive(i)}
          onClick={() => select(item)}
          className={[
            'flex w-full items-center gap-2 px-3 py-1.5 text-left',
            i === active ? 'bg-accent-tint text-ink' : 'text-ink-muted hover:bg-bg-elev2',
          ].join(' ')}
        >
          <span className={`smart-chip smart-chip-${item.chipType} pointer-events-none`}>
            {item.label}
          </span>
          <span className="ml-auto text-2xs text-ink-faint">{item.hint}</span>
        </button>
      ))}
    </div>
  )
}
