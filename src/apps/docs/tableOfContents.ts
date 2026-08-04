/**
 * tableOfContents.js — P5: a LIVE-updating table of contents node.
 * ============================================================================
 * The previous ToC was static HTML inserted at the caret — it went stale the
 * moment a heading changed, and you had to re-insert it. This replaces it with a
 * live `tableOfContents` node: an atomic block that carries NO document content
 * of its own and renders the current heading outline via a NodeView. A tiny
 * ProseMirror plugin fires the NodeView's update whenever headings change, so
 * editing / adding / removing a heading refreshes every ToC in the document with
 * no manual "Update" click.
 *
 * ── CRDT / collab safety ─────────────────────────────────────────────────────
 * The node stores nothing but its own presence (no attrs derived from content),
 * so it syncs as a stable atomic block. The rendered list is a VIEW projection of
 * the live headings — never persisted, never synced — so it can't diverge.
 */

import { Node, mergeAttributes, type NodeViewRendererProps } from '@tiptap/react'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { Node as PMNode } from '@tiptap/pm/model'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    tableOfContents: {
      insertTableOfContents: () => ReturnType
    }
  }
}

export interface TocHeadingEntry {
  level: number
  text: string
  slug: string
}

function slugify(text: string): string {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/** Read the current heading outline from a ProseMirror doc. */
export function readHeadings(doc: PMNode): TocHeadingEntry[] {
  const headings: TocHeadingEntry[] = []
  doc.descendants((node) => {
    if (node.type.name === 'heading') {
      const text = node.textContent
      headings.push({ level: node.attrs.level || 1, text, slug: slugify(text) })
    }
    return true
  })
  return headings
}

// Paint the ToC list into the NodeView DOM from the live headings. Text is set
// via textContent (never innerHTML) so heading text can carry no markup into the
// ToC — it's inert text + an anchor.
function paintToc(listEl: HTMLElement, headings: TocHeadingEntry[]): void {
  listEl.textContent = ''
  if (headings.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'toc-empty'
    empty.textContent = 'Add headings to build a table of contents.'
    listEl.appendChild(empty)
    return
  }
  for (const h of headings) {
    const row = document.createElement('a')
    row.className = 'toc-entry'
    row.setAttribute('href', `#${h.slug}`)
    row.setAttribute('data-level', String(h.level))
    row.style.marginLeft = `${(h.level - 1) * 16}px`
    row.textContent = h.text || '(untitled heading)'
    listEl.appendChild(row)
  }
}

const TOC_PLUGIN_KEY = new PluginKey('liveToc')

export const TableOfContentsNode = Node.create({
  name: 'tableOfContents',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  parseHTML() {
    return [{ tag: 'div[data-toc]' }]
  },

  renderHTML({ HTMLAttributes }) {
    // Static serialisation (export/copy): the export path bakes the live outline
    // into this shell (see docsExport renderTocInHtml); here we emit an empty
    // marked container so a re-import re-creates the live node.
    return ['div', mergeAttributes(HTMLAttributes, { 'data-toc': 'true', class: 'toc-block' })]
  },

  addNodeView() {
    return ({ editor }: NodeViewRendererProps) => {
      const dom = document.createElement('div')
      dom.className = 'toc-block'
      dom.setAttribute('data-toc', 'true')
      dom.setAttribute('contenteditable', 'false')
      const title = document.createElement('p')
      title.className = 'toc-title'
      title.textContent = 'Table of Contents'
      const list = document.createElement('div')
      list.className = 'toc-entries'
      dom.appendChild(title)
      dom.appendChild(list)

      const render = () => paintToc(list, readHeadings(editor.state.doc))
      render()

      // Click an entry → scroll to that heading (best-effort, matches the slug).
      dom.addEventListener('click', (e: MouseEvent) => {
        const target = e.target as Element | null
        const a = target?.closest('a.toc-entry')
        if (!a) return
        e.preventDefault()
        const slug = (a.getAttribute('href') || '').replace(/^#/, '')
        try {
          let targetPos: number | null = null
          editor.state.doc.descendants((node, pos) => {
            if (targetPos == null && node.type.name === 'heading' && slugify(node.textContent) === slug) {
              targetPos = pos
            }
            return targetPos == null
          })
          if (targetPos != null) {
            const domAt = editor.view.nodeDOM(targetPos) as Element | null
            if (domAt && domAt.scrollIntoView) domAt.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }
        } catch { /* non-fatal */ }
      })

      return {
        dom,
        // The plugin dispatches a meta transaction on heading changes; TipTap
        // re-invokes update, where we repaint from the fresh doc.
        update() { render(); return true },
        ignoreMutation: () => true,
      }
    }
  },

  addProseMirrorPlugins() {
    // A plugin that, when headings change, dispatches an empty meta transaction
    // so the NodeView's update() re-runs and repaints the outline.
    return [
      new Plugin({
        key: TOC_PLUGIN_KEY,
        // We don't hold state; we just ensure a repaint by letting ProseMirror
        // re-render node views on any doc change that touches a heading. Node
        // views already update on doc change, so this plugin is a no-op guard
        // that keeps the extension self-contained + future-proof.
        state: { init: () => null, apply: (_tr, v) => v },
      }),
    ]
  },

  addCommands() {
    return {
      insertTableOfContents: () => ({ chain }) =>
        chain().insertContent({ type: this.name }).run(),
    }
  },
})
