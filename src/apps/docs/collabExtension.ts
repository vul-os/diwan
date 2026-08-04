/**
 * src/apps/docs/collabExtension.js — the TipTap ↔ Yjs bridge.
 *
 * ySyncPlugin keeps the ProseMirror document and the Y.XmlFragment in lock-step:
 * a local transaction is written into the Y.Doc, and a remote Yjs update is
 * turned back into a ProseMirror TRANSACTION with correctly mapped positions.
 * That mapping is the entire point of this change — the old transport applied a
 * remote edit at a plain-text character offset, which does not address a position
 * in a structured document at all.
 *
 * UNDO must come from Yjs too (yUndoPlugin). ProseMirror's own history is
 * disabled when collaboration is on (see DocsEditor's StarterKit config), because
 * a shared-document undo has to be USER-SCOPED: plain history would let Ctrl+Z
 * revert a REMOTE peer's change (which then re-broadcasts as a local delete and
 * corrupts the shared document). The Yjs UndoManager only ever undoes the local
 * user's own changes.
 *
 * Because StarterKit's history is off, `editor.commands.undo()` / `.redo()` would
 * otherwise vanish from the command API — and other features call them (e.g.
 * suggestion mode reverts the local edit before recording it as a proposal). We
 * re-provide both commands, backed by the Yjs undo manager, so the editor's
 * public command surface is unchanged.
 */

import { Extension } from '@tiptap/react'
import {
  ySyncPlugin, yUndoPlugin, yUndoPluginKey,
  undo as yUndo, redo as yRedo,
} from 'y-prosemirror'
import type * as Y from 'yjs'
import type { Command } from '@tiptap/core'

export interface YCollabOptions {
  /** the document's Y fragment */
  fragment: Y.XmlFragment | null
}

type UndoRedoFn = typeof yUndo | typeof yRedo

export const YCollab = Extension.create<YCollabOptions>({
  name: 'yCollab',

  addOptions() {
    return {
      fragment: null,
    }
  },

  addProseMirrorPlugins() {
    const fragment = this.options.fragment
    if (!fragment) return []
    return [
      ySyncPlugin(fragment),
      yUndoPlugin(),
    ]
  },

  addCommands() {
    // The Yjs undo manager dispatches its own transaction on the view (the Y.Doc
    // change flows back through the sync plugin). TipTap, meanwhile, has already
    // opened a transaction for this command — dispatching that stale `tr` after
    // the view has moved on throws "Applying a mismatched transaction". So we tell
    // TipTap not to dispatch it and let Yjs own the update.
    const run = (fn: UndoRedoFn): (() => Command) => () => ({ tr, state, dispatch }) => {
      tr.setMeta('preventDispatch', true)
      const undoManager = yUndoPluginKey.getState(state)?.undoManager
      if (!undoManager) return false
      const stack = fn === yUndo ? undoManager.undoStack : undoManager.redoStack
      if (stack.length === 0) return false
      if (!dispatch) return true
      return fn(state)
    }
    return {
      undo: run(yUndo),
      redo: run(yRedo),
    }
  },

  addKeyboardShortcuts() {
    return {
      'Mod-z': () => this.editor.commands.undo(),
      'Mod-y': () => this.editor.commands.redo(),
      'Shift-Mod-z': () => this.editor.commands.redo(),
    }
  },
})

export default YCollab
