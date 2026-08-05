/**
 * AnonDocView — anonymous, read-only, token-gated document viewer.
 *
 * Backs the public /view/:token route. It is intentionally MINIMAL and strictly
 * read-only: it fetches a single document via the share-link token and renders
 * its text. There is no editor, no save, no sharing, no ACL surface reachable
 * here — the server also enforces read-only, so this is defence in depth, not the
 * security boundary.
 *
 * Flow:
 *   1. GET /share/:token (viewShareLinkMeta) → tells us whether a password is
 *      required. If not, the content comes back immediately.
 *   2. If a password is required, prompt; POST /share/:token with the password
 *      (viewShareLink) to fetch content. A wrong password is rejected server-side.
 *
 * The token is the only credential; no Vulos session is needed.
 */

import { useCallback, useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import { Lock, FileText, Loader2, AlertCircle, Eye } from 'lucide-react'
import { api } from '../lib/api'
import { Button, Input, LoadingState } from './ui'

// Render a TipTap doc node tree to read-only React elements (headings, paragraphs,
// lists). Unknown nodes fall back to their text. This mirrors the server's
// extraction shape without pulling in the full editor.
/** A TipTap doc node, as returned by the server's extraction. Structure is
 *  dynamic/recursive (headings, paragraphs, lists, …) so fields stay optional. */
interface DocNode {
  type?: string
  attrs?: { level?: number; [key: string]: unknown }
  content?: DocNode[]
  text?: string
}

const HEADING_SIZES: Record<number, string> = { 1: 'text-2xl', 2: 'text-xl', 3: 'text-lg' }

function renderNode(node: DocNode | null | undefined, key: number): ReactNode {
  if (!node || typeof node !== 'object') return null
  const text = (node.content || []).map((c, i) =>
    c.type === 'text' ? c.text : renderNode(c, i)
  )
  switch (node.type) {
    case 'heading': {
      const lvl = node.attrs?.level || 2
      const Tag = `h${Math.min(Math.max(lvl, 1), 6)}` as keyof JSX.IntrinsicElements
      return <Tag key={key} className={`font-semibold text-ink mt-4 mb-1 ${HEADING_SIZES[lvl] || 'text-base'}`}>{text}</Tag>
    }
    case 'paragraph':
      return <p key={key} className="text-ink-muted leading-relaxed my-2">{text.length ? text : ' '}</p>
    case 'bulletList':
      return <ul key={key} className="list-disc pl-6 my-2 text-ink-muted">{(node.content || []).map((c, i) => renderNode(c, i))}</ul>
    case 'orderedList':
      return <ol key={key} className="list-decimal pl-6 my-2 text-ink-muted">{(node.content || []).map((c, i) => renderNode(c, i))}</ol>
    case 'listItem':
      return <li key={key}>{(node.content || []).map((c, i) => renderNode(c, i))}</li>
    case 'codeBlock':
      return <pre key={key} className="bg-bg-elev2 border border-line rounded-md p-3 my-2 font-mono text-xs overflow-x-auto">{text}</pre>
    case 'blockquote':
      return <blockquote key={key} className="border-l-2 border-line pl-3 my-2 text-ink-faint italic">{(node.content || []).map((c, i) => renderNode(c, i))}</blockquote>
    default:
      return text.length ? <div key={key}>{text}</div> : null
  }
}

function DocBody({ doc }: { doc?: DocNode | null | undefined }) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.content)) {
    // Not a TipTap doc (sheet/slide or raw) — show a plain read-only notice.
    return (
      <p className="text-sm text-ink-faint">
        This document type opens read-only. Its text content is shown where available.
      </p>
    )
  }
  return <div className="prose-none">{doc.content.map((n, i) => renderNode(n, i))}</div>
}

interface ShareFile {
  id?: string
  name?: string
  type?: string
  content?: DocNode
  read_only?: boolean
}

interface ShareMeta extends ShareFile {
  requires_password?: boolean
}

interface AnonViewState {
  loading: boolean
  error: string | null
  requiresPassword: boolean
  file: ShareFile | null
}

export default function AnonDocView() {
  const { token } = useParams()
  const [state, setState] = useState<AnonViewState>({ loading: true, error: null, requiresPassword: false, file: null })
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const loadMeta = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const meta = await api.viewShareLinkMeta(token as string) as ShareMeta
      if (meta.requires_password) {
        setState({ loading: false, error: null, requiresPassword: true, file: null })
      } else {
        setState({ loading: false, error: null, requiresPassword: false, file: meta })
      }
    } catch (e) {
      setState({ loading: false, error: (e as Error)?.message || 'This link is unavailable', requiresPassword: false, file: null })
    }
  }, [token])

  useEffect(() => { void loadMeta() }, [loadMeta])

  const submitPassword = async (e?: FormEvent) => {
    e?.preventDefault?.()
    setSubmitting(true)
    setState((s) => ({ ...s, error: null }))
    try {
      const file = await api.viewShareLink(token as string, password) as ShareFile
      setState({ loading: false, error: null, requiresPassword: false, file })
    } catch (err) {
      setState((s) => ({ ...s, error: (err as Error)?.message || 'Incorrect password' }))
    } finally {
      setSubmitting(false)
    }
  }

  const { loading, error, requiresPassword, file } = state

  return (
    <div className="min-h-screen bg-bg flex flex-col items-center py-10 px-4">
      <div className="w-full max-w-2xl">
        {/* Read-only banner */}
        <div className="flex items-center gap-2 text-2xs text-ink-faint mb-4 justify-center">
          <Eye size={12} /> Read-only shared document
        </div>

        {loading && <LoadingState label="Opening document…" className="py-16" />}

        {error && !loading && (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <div className="w-12 h-12 rounded-full bg-danger-bg flex items-center justify-center">
              <AlertCircle size={22} className="text-danger" />
            </div>
            <p className="text-sm text-danger max-w-sm">{error}</p>
            {requiresPassword && (
              <Button variant="secondary" size="sm" onClick={() => void loadMeta()}>Try again</Button>
            )}
          </div>
        )}

        {!loading && requiresPassword && !file && (
          <form onSubmit={(e) => void submitPassword(e)} className="max-w-sm mx-auto mt-10 space-y-3 text-center">
            <div className="w-12 h-12 rounded-full bg-accent-tint flex items-center justify-center mx-auto">
              <Lock size={20} className="text-accent" />
            </div>
            <p className="text-sm text-ink">This document is password protected.</p>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              aria-label="Document password"
              leading={<Lock size={13} />}
              autoFocus
            />
            <Button type="submit" variant="primary" size="md" disabled={submitting || !password} className="w-full justify-center">
              {submitting ? <Loader2 size={14} className="animate-spin" /> : <Eye size={14} />}
              View document
            </Button>
          </form>
        )}

        {!loading && file && (
          <div className="bg-paper border border-line rounded-lg shadow-e2 p-8">
            <div className="flex items-center gap-2 pb-4 mb-4 border-b border-line">
              <FileText size={16} className="text-ink-faint" />
              <h1 className="text-lg font-semibold text-ink tracking-tightish truncate">{file.name || 'Untitled'}</h1>
            </div>
            <DocBody doc={file.content} />
          </div>
        )}
      </div>
    </div>
  )
}
