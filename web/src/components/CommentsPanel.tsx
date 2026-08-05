/**
 * CommentsPanel — OFFICE-26
 *
 * A side-panel showing all comments for a file:
 *   - Anchored to text range / cell / slide
 *   - Threaded replies
 *   - Resolve / reopen
 *   - Author identity (authorId prop or "You")
 *   - Backed by the CRDT CommentStore; persists via REST
 *
 * Props
 * -----
 *   fileId    {string}   the open document's id
 *   anchorCtx {object}   context passed by the editor when adding a comment:
 *                          { type, from, to, snapshot }     (Docs)
 *                          { type, sheet, row, col, snapshot } (Sheets)
 *                          { type, slideId, snapshot }      (Slides)
 *   authorId  {string}   identity of the current user (Vulos account address / session id)
 *   onClose   {function} called when the user clicks the X
 */

import { useEffect, useState, useRef, useCallback } from 'react'
import { X, MessageSquare, CheckCircle, RotateCcw, Trash2, Send, ChevronDown, ChevronUp, Crosshair, UserCheck } from 'lucide-react'
import { api } from '../lib/api'
import { getCommentStore } from '../lib/crdt/comments'
import type { CommentAnchor, CommentWithReplies, Reply } from '../lib/crdt/comments'
import { formatTs } from '../lib/format'
import { IconButton, Tabs, LoadingState, EmptyState } from './ui'
import MentionInput, { getMentions, renderMentions } from './MentionInput'

// ---------------------------------------------------------------------------
// Local shapes — the shared CRDT/api modules return/accept `unknown`-ish or
// intentionally open types; these document just what this panel reads/writes.
// ---------------------------------------------------------------------------

// Anchor as this panel actually uses it: `CommentAnchor` stays open (index
// signature) for product-specific fields, so this pins the ones read here
// (Docs text-range, Sheets cell, Slides).
type PanelAnchor = CommentAnchor & {
  snapshot?: string
  sheet?: string
  row?: number
  col?: number
  slide_id?: string
}

// `assignee` is a server-only field (see handleAssign) not tracked by the
// CRDT store, so it is layered on top of CommentWithReplies here.
type PanelComment = Omit<CommentWithReplies, 'anchor'> & { anchor: PanelAnchor; assignee?: string | undefined }

interface Collaborator {
  account_id: string
  role: string
  [key: string]: unknown
}
interface CollaboratorsResponse {
  collaborators?: Collaborator[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function anchorLabel(anchor: PanelAnchor | null | undefined): string {
  if (!anchor) return ''
  if (anchor.orphaned) return '(anchor removed)'
  if (anchor.type === 'text_range') return anchor.snapshot || `chars ${anchor.from}–${anchor.to}`
  if (anchor.type === 'cell') return `${anchor.sheet} ${anchor.row}:${anchor.col}`
  if (anchor.type === 'slide') return `slide ${anchor.slide_id}`
  return ''
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface ReplyItemProps {
  reply: Reply
  fileId: string
  commentId: string
  authorId: string
  collaborators?: Collaborator[]
  onDeleted: (replyId: string) => void
}

function ReplyItem({ reply, fileId, commentId, authorId, collaborators = [], onDeleted }: ReplyItemProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(reply.body)
  const [busy, setBusy] = useState(false)

  const handleSave = async () => {
    if (!draft.trim() || draft === reply.body) { setEditing(false); return }
    setBusy(true)
    try {
      await api.updateReply(fileId, commentId, reply.id, { body: draft.trim() })
      const store = getCommentStore(fileId)
      store.editReply(commentId, reply.id, draft.trim())
      setEditing(false)
    } catch (err) {
      // BUG FIX: try/finally with no catch — a network failure here (and in
      // every sibling action below: delete reply, add reply, resolve/reopen,
      // delete comment, save comment edit, assign) rejected uncaught and left
      // the user with no idea the edit never saved (busy just cleared via
      // finally, editing stayed open, nothing else changed).
      console.error('updateReply failed', err)
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async () => {
    setBusy(true)
    try {
      await api.deleteReply(fileId, commentId, reply.id)
      const store = getCommentStore(fileId)
      store.deleteReply(commentId, reply.id)
      onDeleted(reply.id)
    } catch (err) {
      console.error('deleteReply failed', err)
    } finally {
      setBusy(false)
    }
  }

  if (reply.deleted) {
    return (
      <div className="pl-3 text-2xs text-ink-faint italic py-1 border-l border-line">
        [deleted]
      </div>
    )
  }

  const isOwn = reply.author_id === authorId

  return (
    <div className="pl-3 border-l border-accent-tint-2 py-1.5 space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-2xs font-semibold text-ink-muted tracking-tightish">{reply.author_id || 'Anonymous'}</span>
        <span className="text-2xs text-ink-faint">{formatTs(reply.created_at)}</span>
      </div>
      {editing ? (
        <div className="space-y-1">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            className="w-full text-xs bg-paper border border-line rounded-sm px-2 py-1 resize-none outline-none focus:border-accent focus:shadow-focus transition-colors"
          />
          <div className="flex gap-1">
            <button
              onClick={() => void handleSave()}
              disabled={busy}
              className="px-2 py-0.5 text-2xs bg-accent text-white rounded-xs hover:bg-accent-hover disabled:opacity-60 transition-colors focus-visible:outline-none focus-visible:shadow-focus"
            >
              Save
            </button>
            <button
              onClick={() => { setEditing(false); setDraft(reply.body) }}
              className="px-2 py-0.5 text-2xs border border-line text-ink-muted rounded-xs hover:bg-bg-elev2 transition-colors focus-visible:outline-none focus-visible:shadow-focus"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <p className="text-xs text-ink whitespace-pre-wrap leading-snug">{renderMentions(reply.body, collaborators)}</p>
      )}
      {isOwn && !editing && (
        <div className="flex gap-2">
          <button onClick={() => setEditing(true)} className="text-2xs text-accent hover:underline rounded-sm focus-visible:outline-none focus-visible:shadow-focus">Edit</button>
          <button onClick={() => void handleDelete()} disabled={busy} className="text-2xs text-danger/80 hover:text-danger rounded-sm focus-visible:outline-none focus-visible:shadow-focus">Delete</button>
        </div>
      )}
    </div>
  )
}

interface CommentItemProps {
  item: PanelComment
  fileId: string
  authorId: string
  collaborators?: Collaborator[]
  onUpdated: (updated: PanelComment) => void
  onDeleted: (commentId: string) => void
  onChange?: (() => void) | undefined
  onJump?: ((commentId: string) => void) | undefined
  isActive: boolean
}

function CommentItem({ item, fileId, authorId, collaborators = [], onUpdated, onDeleted, onChange, onJump, isActive }: CommentItemProps) {
  const [expanded, setExpanded] = useState(true)
  const rootRef = useRef<HTMLDivElement>(null)

  // When this comment becomes active (a highlight was clicked in the body),
  // scroll it into view within the panel and expand it.
  useEffect(() => {
    if (isActive && rootRef.current) {
      setExpanded(true)
      rootRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [isActive])
  const [replyDraft, setReplyDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editDraft, setEditDraft] = useState(item.body)
  const [replies, setReplies] = useState<Reply[]>(item.replies || [])

  // Keep replies in sync with parent updates
  useEffect(() => { setReplies(item.replies || []) }, [item.replies])

  const handleReply = async () => {
    const body = replyDraft.trim()
    if (!body) return
    const mentions = getMentions(body, collaborators)
    setBusy(true)
    try {
      const r = await api.createReply(fileId, item.id, authorId, body, mentions) as Reply
      const store = getCommentStore(fileId)
      store.addReply(item.id, authorId, body)
      setReplies((prev) => [...prev, r])
      setReplyDraft('')
    } catch (err) {
      console.error('createReply failed', err)
    } finally {
      setBusy(false)
    }
  }

  const handleResolve = async () => {
    setBusy(true)
    try {
      const updated = await api.updateComment(fileId, item.id, { state: 'resolved' }) as Partial<PanelComment>
      const store = getCommentStore(fileId)
      store.resolve(item.id)
      onUpdated({ ...item, ...updated })
      onChange?.()
    } catch (err) {
      console.error('resolve comment failed', err)
    } finally {
      setBusy(false)
    }
  }

  const handleReopen = async () => {
    setBusy(true)
    try {
      const updated = await api.updateComment(fileId, item.id, { state: 'open' }) as Partial<PanelComment>
      const store = getCommentStore(fileId)
      store.reopen(item.id)
      onUpdated({ ...item, ...updated })
      onChange?.()
    } catch (err) {
      console.error('reopen comment failed', err)
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async () => {
    if (!window.confirm('Delete this comment and all replies?')) return
    setBusy(true)
    try {
      await api.deleteComment(fileId, item.id)
      onDeleted(item.id)
      onChange?.()
    } catch (err) {
      console.error('deleteComment failed', err)
    } finally {
      setBusy(false)
    }
  }

  const handleSaveEdit = async () => {
    const body = editDraft.trim()
    if (!body || body === item.body) { setEditing(false); return }
    setBusy(true)
    try {
      const updated = await api.updateComment(fileId, item.id, { body }) as Partial<PanelComment>
      const store = getCommentStore(fileId)
      store.editComment(item.id, body)
      onUpdated({ ...item, ...updated })
      onChange?.()
      setEditing(false)
    } catch (err) {
      console.error('updateComment (edit) failed', err)
    } finally {
      setBusy(false)
    }
  }

  // ASSIGNMENT: (re)assign or clear the task. The server validates the assignee
  // against the file's collaborators (an invalid id is dropped) and notifies the
  // assignee, so we simply reflect whatever it returns.
  const [assignOpen, setAssignOpen] = useState(false)
  const handleAssign = async (acct: string) => {
    setAssignOpen(false)
    setBusy(true)
    try {
      const updated = await api.updateComment(fileId, item.id, { assignee: acct }) as Partial<PanelComment>
      onUpdated({ ...item, ...updated })
      onChange?.()
    } catch (err) {
      console.error('assign comment failed', err)
    } finally {
      setBusy(false)
    }
  }

  const isResolved = item.state === 'resolved'
  const isOwn = item.author_id === authorId

  const canJump = !!onJump && item.anchor?.type === 'text_range' && !item.anchor?.orphaned

  return (
    <div
      ref={rootRef}
      className={[
        'rounded-md border p-3 space-y-2 transition-colors animate-rise-in',
        isResolved ? 'bg-bg-elev2 border-line opacity-70' : 'bg-paper border-line',
        isActive ? 'ring-2 ring-accent border-accent' : '',
      ].join(' ')}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs font-semibold text-ink tracking-tightish">{item.author_id || 'Anonymous'}</span>
            {isResolved && (
              <span className="text-2xs bg-success-bg text-success px-1.5 py-0.5 rounded-pill font-medium">Resolved</span>
            )}
            {!isResolved && item.assignee && (
              <span
                className="inline-flex items-center gap-0.5 text-2xs bg-accent-tint text-accent px-1.5 py-0.5 rounded-pill font-medium"
                title={`Assigned to ${item.assignee}`}
              >
                <UserCheck size={9} aria-hidden /> {item.assignee}
              </span>
            )}
            {item.anchor?.orphaned && (
              <span className="text-2xs bg-warning-bg text-warning px-1.5 py-0.5 rounded-pill font-medium" title="The commented text was edited or removed; this comment may have moved.">
                May have moved
              </span>
            )}
            <span className="text-2xs text-ink-faint">{formatTs(item.created_at)}</span>
          </div>
          {item.anchor && (
            canJump ? (
              <button
                onClick={() => onJump?.(item.id)}
                title={`Jump to “${anchorLabel(item.anchor)}”`}
                aria-label={`Jump to commented text: ${anchorLabel(item.anchor)}`}
                className="group flex items-center gap-1 text-2xs text-accent mt-0.5 max-w-full hover:underline rounded-sm focus-visible:outline-none focus-visible:shadow-focus"
              >
                <Crosshair size={10} className="flex-shrink-0 opacity-70 group-hover:opacity-100" aria-hidden />
                <span className="truncate font-serif italic">“{anchorLabel(item.anchor)}”</span>
              </button>
            ) : (
              <p className="text-2xs text-accent mt-0.5 truncate font-serif italic" title={anchorLabel(item.anchor)}>
                “{anchorLabel(item.anchor)}”
              </p>
            )
          )}
        </div>
        <button
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse comment' : 'Expand comment'}
          className="text-ink-faint hover:text-ink-muted flex-shrink-0 mt-0.5 transition-colors rounded-sm focus-visible:outline-none focus-visible:shadow-focus"
        >
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>

      {expanded && (
        <>
          {/* Body */}
          {editing ? (
            <div className="space-y-1.5">
              <textarea
                value={editDraft}
                onChange={(e) => setEditDraft(e.target.value)}
                rows={3}
                className="w-full text-sm bg-paper border border-line rounded-sm px-2 py-1.5 resize-none outline-none focus:border-accent focus:shadow-focus transition-colors"
              />
              <div className="flex gap-1.5">
                <button
                  onClick={() => void handleSaveEdit()}
                  disabled={busy}
                  className="px-2.5 py-1 text-xs bg-accent text-white rounded-sm hover:bg-accent-hover disabled:opacity-60 transition-colors focus-visible:outline-none focus-visible:shadow-focus"
                >
                  Save
                </button>
                <button
                  onClick={() => { setEditing(false); setEditDraft(item.body) }}
                  className="px-2.5 py-1 text-xs border border-line text-ink-muted rounded-sm hover:bg-bg-elev2 transition-colors focus-visible:outline-none focus-visible:shadow-focus"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-ink whitespace-pre-wrap leading-snug">{renderMentions(item.body, collaborators)}</p>
          )}

          {/* Replies */}
          {replies.length > 0 && (
            <div className="space-y-2 pt-1">
              {replies.map((r) => (
                <ReplyItem
                  key={r.id}
                  reply={r}
                  fileId={fileId}
                  commentId={item.id}
                  authorId={authorId}
                  collaborators={collaborators}
                  onDeleted={(rid) => setReplies((prev) => prev.filter((x) => x.id !== rid))}
                />
              ))}
            </div>
          )}

          {/* Reply input */}
          {!isResolved && (
            <div className="flex items-end gap-1.5 pt-1">
              <MentionInput
                value={replyDraft}
                onChange={setReplyDraft}
                onEnter={() => void handleReply()}
                collaborators={collaborators}
                rows={1}
                placeholder="Reply…"
                wrapperClassName="flex-1"
                className="w-full text-xs bg-paper border border-line rounded-sm px-2 py-1 resize-none outline-none focus:border-accent focus:shadow-focus transition-colors min-h-[28px]"
              />
              <button
                onClick={() => void handleReply()}
                disabled={!replyDraft.trim() || busy}
                aria-label="Post reply"
                className="p-1.5 bg-accent text-white rounded-sm hover:bg-accent-hover disabled:opacity-40 flex-shrink-0 transition-colors focus-visible:outline-none focus-visible:shadow-focus"
              >
                <Send size={12} />
              </button>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-3 pt-0.5 flex-wrap">
            {isResolved ? (
              <button
                onClick={() => void handleReopen()}
                disabled={busy}
                className="flex items-center gap-1 text-2xs text-ink-faint hover:text-accent transition-colors rounded-sm focus-visible:outline-none focus-visible:shadow-focus"
              >
                <RotateCcw size={10} /> Reopen
              </button>
            ) : (
              <button
                onClick={() => void handleResolve()}
                disabled={busy}
                className="flex items-center gap-1 text-2xs text-success hover:text-accent-press transition-colors rounded-sm focus-visible:outline-none focus-visible:shadow-focus"
              >
                <CheckCircle size={10} /> Resolve
              </button>
            )}
            {!isResolved && (
              <div className="relative">
                <button
                  onClick={() => setAssignOpen((v) => !v)}
                  disabled={busy}
                  aria-haspopup="listbox"
                  aria-expanded={assignOpen}
                  className="flex items-center gap-1 text-2xs text-ink-faint hover:text-accent transition-colors rounded-sm focus-visible:outline-none focus-visible:shadow-focus"
                >
                  <UserCheck size={10} /> {item.assignee ? 'Reassign' : 'Assign'}
                </button>
                {assignOpen && (
                  <ul
                    role="listbox"
                    className="absolute z-10 mt-1 min-w-[9rem] max-h-48 overflow-y-auto rounded-md border border-line bg-paper shadow-e2 py-1 text-xs"
                  >
                    {item.assignee && (
                      <li>
                        <button
                          onClick={() => void handleAssign('')}
                          className="w-full text-left px-2.5 py-1 text-ink-muted hover:bg-bg-elev2 rounded-sm"
                        >
                          Unassign
                        </button>
                      </li>
                    )}
                    {collaborators.length === 0 && (
                      <li className="px-2.5 py-1 text-ink-faint">Share the file to assign people</li>
                    )}
                    {collaborators.map((p) => (
                      <li key={p.account_id}>
                        <button
                          onClick={() => void handleAssign(p.account_id)}
                          className={[
                            'w-full text-left px-2.5 py-1 hover:bg-bg-elev2 rounded-sm truncate',
                            item.assignee === p.account_id ? 'text-accent font-medium' : 'text-ink',
                          ].join(' ')}
                        >
                          {p.account_id} <span className="text-ink-faint text-2xs">{p.role}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {isOwn && !editing && (
              <>
                <button
                  onClick={() => setEditing(true)}
                  className="text-2xs text-accent hover:underline rounded-sm focus-visible:outline-none focus-visible:shadow-focus"
                >
                  Edit
                </button>
                <button
                  onClick={() => void handleDelete()}
                  disabled={busy}
                  className="flex items-center gap-0.5 text-2xs text-danger/80 hover:text-danger transition-colors rounded-sm focus-visible:outline-none focus-visible:shadow-focus"
                >
                  <Trash2 size={10} /> Delete
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// CommentsPanel (main export)
// ---------------------------------------------------------------------------

interface CommentsPanelProps {
  fileId: string
  anchorCtx?: PanelAnchor | null
  authorId?: string
  onClose?: () => void
  onJump?: (commentId: string) => void
  onChange?: () => void
  activeCommentId?: string | null
}

export default function CommentsPanel({ fileId, anchorCtx, authorId = 'You', onClose, onJump, onChange, activeCommentId }: CommentsPanelProps) {
  const [comments, setComments] = useState<PanelComment[]>([])
  const [newBody, setNewBody] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState<'all' | 'open' | 'resolved'>('all')
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]) // for @-mention autocomplete
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Hydrate from server + CRDT store on mount
  useEffect(() => {
    if (!fileId) return
    setLoading(true)
    api.listComments(fileId)
      .then((items) => {
        const store = getCommentStore(fileId)
        store.loadFromServer(items as Parameters<typeof store.loadFromServer>[0])
        setComments(store.list())
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [fileId])

  // Load the file's collaborator roster for @-mention autocomplete. The server
  // returns only accounts that actually have access, so a mention can never
  // target — or notify — a non-participant. Best-effort: a failure just means
  // no autocomplete (typing a bare "@name" simply won't resolve to an id).
  useEffect(() => {
    if (!fileId) return
    api.listFileCollaborators(fileId)
      .then((res) => setCollaborators((res as CollaboratorsResponse)?.collaborators || []))
      .catch(() => setCollaborators([]))
  }, [fileId])

  const handleAdd = async () => {
    const body = newBody.trim()
    if (!body) return
    const anchor: PanelAnchor = anchorCtx || { type: 'slide', slide_id: '', snapshot: '' }
    const mentions = getMentions(body, collaborators)
    setBusy(true)
    try {
      await api.createComment(fileId, anchor, authorId, body, mentions)
      const store = getCommentStore(fileId)
      store.addComment(anchor, authorId, body)
      setComments(store.list())
      setNewBody('')
      onChange?.()
    } catch (err) {
      console.error('createComment failed', err)
    } finally {
      setBusy(false)
    }
  }

  const handleUpdated = useCallback((updated: PanelComment) => {
    const store = getCommentStore(fileId)
    // The CRDT store tracks body/state/replies but NOT server-only fields like
    // `assignee` (assignment is a server-validated, notify-bearing action, not a
    // CRDT field). A blind re-read from the store would therefore WIPE the assignee
    // badge on every update. So we re-read the store for the collaborative fields,
    // then overlay: the just-updated server payload for its comment, and the
    // previously-known server-only fields for the rest.
    setComments((prev) => {
      const byId = new Map(prev.map((c) => [c.id, c]))
      return (store.list() as PanelComment[]).map((c) => {
        const prior = byId.get(c.id)
        const merged = prior ? { ...c, assignee: prior.assignee } : c
        return updated && c.id === updated.id ? { ...merged, ...updated } : merged
      })
    })
  }, [fileId])

  const handleDeleted = useCallback((commentId: string) => {
    setComments((prev) => prev.filter((c) => c.id !== commentId))
  }, [])

  const filtered = filter === 'all'
    ? comments
    : comments.filter((c) => c.state === filter)

  /*
   * Side rail (clean, not stacked overlay):
   *   - lives inline as a 288px right column under the topbar
   *   - paper-elev2 background so it reads as "the side", not as a popover
   *   - sticky header / tabs / composer; comments are the only thing that scrolls
   */
  const openCount     = comments.filter((c) => c.state !== 'resolved').length
  const resolvedCount = comments.filter((c) => c.state === 'resolved').length

  return (
    <aside className="w-72 flex-shrink-0 border-l border-line bg-bg-elev2 flex flex-col overflow-hidden animate-slide-in-right">
      {/* Header — discreet, no coloured accent on title */}
      <div className="flex items-center justify-between px-3 h-11 border-b border-line bg-paper flex-shrink-0">
        <div className="flex items-center gap-2">
          <MessageSquare size={14} className="text-ink-muted" />
          <span className="text-sm font-semibold text-ink tracking-tightish">Comments</span>
          {comments.length > 0 && (
            <span className="text-2xs bg-bg-elev2 text-ink-faint rounded-pill px-1.5 py-0.5 font-medium">
              {comments.length}
            </span>
          )}
        </div>
        <IconButton size="sm" title="Close" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </div>

      {/* Filter tabs — using design system Tabs primitive */}
      <div className="bg-paper flex-shrink-0">
        <Tabs
          value={filter}
          onChange={(v) => setFilter(v as 'all' | 'open' | 'resolved')}
          items={[
            { value: 'all',      label: 'All',      count: comments.length },
            { value: 'open',     label: 'Open',     count: openCount       },
            { value: 'resolved', label: 'Resolved', count: resolvedCount   },
          ]}
        />
      </div>

      {/* Composer — paper bg, accent only on the Post button */}
      <div className="p-3 border-b border-line bg-paper flex-shrink-0 space-y-2">
        {anchorCtx && (
          <p className="text-2xs text-accent font-serif italic truncate" title={anchorLabel(anchorCtx)}>
            On “{anchorLabel(anchorCtx)}”
          </p>
        )}
        <MentionInput
          textareaRef={textareaRef}
          value={newBody}
          onChange={setNewBody}
          onEnter={() => void handleAdd()}
          collaborators={collaborators}
          rows={2}
          placeholder="Add a comment…"
          className="w-full text-sm bg-bg-elev2 border border-line rounded-sm px-2 py-1.5 resize-none outline-none focus:border-accent focus:shadow-focus focus:bg-paper transition-colors"
        />
        <button
          onClick={() => void handleAdd()}
          disabled={!newBody.trim() || busy}
          className="w-full h-7 text-xs font-medium bg-accent text-white rounded-sm hover:bg-accent-hover disabled:opacity-50 transition-colors tracking-tightish focus-visible:outline-none focus-visible:shadow-focus"
        >
          {busy ? 'Posting…' : 'Comment'}
        </button>
      </div>

      {/* Comment list — only the comments scroll */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
        {loading && (
          <LoadingState size="sm" label="Loading comments…" className="py-6" />
        )}
        {!loading && filtered.length === 0 && (
          <EmptyState
            size="sm"
            icon={MessageSquare}
            title={filter === 'all' ? 'No comments yet.' : `No ${filter} comments.`}
            hint={filter === 'all' ? 'Select text in the document to leave the first note.' : undefined}
          />
        )}
        {filtered.map((item) => (
          <CommentItem
            key={item.id}
            item={item}
            fileId={fileId}
            authorId={authorId}
            collaborators={collaborators}
            onUpdated={handleUpdated}
            onDeleted={handleDeleted}
            onChange={onChange}
            onJump={onJump}
            isActive={item.id === activeCommentId}
          />
        ))}
      </div>
    </aside>
  )
}
