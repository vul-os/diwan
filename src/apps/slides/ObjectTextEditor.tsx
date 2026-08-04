/**
 * ObjectTextEditor.jsx — inline rich-text editing for a single text object.
 *
 * When a text object is double-clicked on the canvas, this overlays a TipTap
 * editor at the object's box so authors get the full formatting stack (bold,
 * lists, colour, font, alignment) on positioned text — the same extensions the
 * legacy flow editor used. On blur/commit it writes the sanitized HTML back.
 *
 * SECURITY: the produced HTML is stored on the object and re-sanitized at every
 * ingress (sanitizeObject); nothing here bypasses that. Editing is a superuser
 * action on the user's own deck, so the editor itself renders trusted local
 * content, but the persisted value is always run back through the sanitizer.
 */

import { useEffect } from 'react'
import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import TextAlign from '@tiptap/extension-text-align'
import Underline from '@tiptap/extension-underline'
import TextStyle from '@tiptap/extension-text-style'
import Color from '@tiptap/extension-color'
import Highlight from '@tiptap/extension-highlight'
import { FontSize, FontFamily } from '../../lib/tiptap/fontStyle.js'
import { sanitizeSlideHtml } from '../../lib/sanitize'
import type { TextSlideObject } from './slideObjects'

interface ObjectTextEditorProps {
  obj: TextSlideObject
  onCommit?: (html: string) => void
  onClose?: () => void
  onEditorReady?: (editor: Editor | null) => void
}

export default function ObjectTextEditor({ obj, onCommit, onClose, onEditorReady }: ObjectTextEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Link.configure({ openOnClick: false }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Underline, TextStyle, Color,
      Highlight.configure({ multicolor: true }),
      FontSize, FontFamily,
    ],
    content: obj.html || '<p></p>',
    autofocus: 'end',
  })

  useEffect(() => {
    if (editor) onEditorReady?.(editor)
    return () => onEditorReady?.(null)
  }, [editor]) // eslint-disable-line

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { commit(); onClose?.() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }) // eslint-disable-line

  const commit = () => {
    if (!editor) return
    onCommit?.(sanitizeSlideHtml(editor.getHTML()))
  }

  return (
    <div
      data-object-text-editor
      className="absolute z-[300000] bg-paper/95 border-2 border-accent rounded-sm shadow-e2"
      style={{
        left: `${obj.x * 100}%`, top: `${obj.y * 100}%`,
        width: `${obj.w * 100}%`, height: `${obj.h * 100}%`,
        transform: `rotate(${obj.rotation || 0}deg)`,
        transformOrigin: 'center center',
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <EditorContent
        editor={editor}
        className="tiptap w-full h-full overflow-auto p-2 text-ink text-sm outline-none"
        onBlur={commit}
      />
    </div>
  )
}
