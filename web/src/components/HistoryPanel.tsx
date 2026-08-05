/**
 * HistoryPanel — version history side-rail.
 *
 * Design treatment:
 *   - Vertical timeline rail with quiet accent dots.
 *   - "Latest" badge uses accent-tint pill.
 *   - Restore confirmation via Modal primitive.
 *   - Named snapshots get a Bookmark accent dot.
 *   - Aligned to CommentsPanel side-rail pattern.
 *
 * Props:
 *   fileId    string  — document ID
 *   onRestore fn      — called with restored File object
 *   onClose   fn      — close the panel
 */

import { useState, useEffect, useCallback } from 'react'
import { History, RotateCcw, Loader2, Bookmark, X, GitCompare, User } from 'lucide-react'
import { api } from '../lib/api'
import { timeAgoLong as formatRelative } from '../lib/format'
import { Button, IconButton, Modal, LoadingState, EmptyState, ErrorState } from './ui'

// ─── Local shapes — `api` returns `unknown` by design; these document just
// what this panel reads. ────────────────────────────────────────────────────
interface Version {
  id: string
  label?: string
  name: string
  created_at: string
  author?: string
}

interface DiffLine {
  op: string
  text?: string
}
interface DiffBody {
  kind: string
  lines?: DiffLine[]
  added: number
  removed: number
  summary?: string
}
interface DiffResult {
  type?: string
  against?: string
  old_label?: string
  new_label?: string
  diff?: DiffBody
}

// ─── VersionRow ───────────────────────────────────────────────────────────────
interface VersionRowProps {
  v: Version
  idx: number
  isLatest: boolean
  restoring: string | null
  onRestoreClick: (v: Version) => void
  onCompareClick: (v: Version) => void
}

function VersionRow({ v, isLatest, restoring, onRestoreClick, onCompareClick }: VersionRowProps) {
  const isNamed = !!v.label

  return (
    <li className="relative flex gap-3 px-4 py-3 group hover:bg-accent-tint transition-colors duration-fast">
      {/* Timeline rail */}
      <div className="flex flex-col items-center flex-shrink-0" style={{ width: 16 }}>
        {/* Dot */}
        <span
          className={[
            'w-2.5 h-2.5 rounded-full mt-1 flex-shrink-0 border-2',
            'transition-colors duration-fast',
            isNamed
              ? 'bg-warning border-warning'
              : isLatest
                ? 'bg-accent border-accent'
                : 'bg-line-strong border-line group-hover:bg-accent-press group-hover:border-accent-press',
          ].join(' ')}
        />
        {/* Rail line (not on last item — handled by parent) */}
        <span className="w-px flex-1 bg-line mt-1 mb-0" />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 pb-1">
        {/* Named label */}
        {isNamed && (
          <div className="flex items-center gap-1 mb-0.5">
            <Bookmark size={10} className="text-warning flex-shrink-0" />
            <span className="text-2xs font-semibold text-warning tracking-tightish truncate">{v.label}</span>
          </div>
        )}

        <p className="text-xs font-medium text-ink truncate tracking-tightish" title={v.name}>
          {v.name || 'Untitled'}
        </p>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          <span className="text-2xs text-ink-faint tracking-tightish">{formatRelative(v.created_at)}</span>
          {v.author && (
            <span className="text-2xs text-ink-faint tracking-tightish flex items-center gap-0.5" title={`Edited by ${v.author}`}>
              <User size={9} className="flex-shrink-0" />
              <span className="truncate max-w-[7rem]">{v.author}</span>
            </span>
          )}
          {isLatest && !isNamed && (
            <span className="text-2xs font-semibold text-accent bg-accent-tint px-1.5 py-px rounded-pill tracking-tightish">
              latest
            </span>
          )}
        </div>
      </div>

      {/* Actions — only show on hover */}
      <div
        className={[
          'flex-shrink-0 self-start mt-0.5 flex items-center gap-0.5',
          'transition-opacity duration-fast ease-out',
          'opacity-0 group-hover:opacity-100 focus-within:opacity-100',
        ].join(' ')}
      >
        <button
          onClick={() => onCompareClick(v)}
          title="Compare with current version"
          className="flex items-center gap-1 h-6 px-2 text-2xs font-medium rounded-sm text-ink-muted hover:bg-accent-tint-2 focus:outline-none focus-visible:shadow-focus"
        >
          <GitCompare size={11} /> Diff
        </button>
        <button
          onClick={() => onRestoreClick(v)}
          disabled={restoring === v.id}
          title="Restore this version"
          className={[
            'flex items-center gap-1 h-6 px-2 text-2xs font-medium rounded-sm',
            'text-accent-press hover:bg-accent-tint-2 focus:outline-none focus-visible:shadow-focus',
            'disabled:opacity-40 disabled:cursor-not-allowed',
          ].join(' ')}
        >
          {restoring === v.id
            ? <Loader2 size={11} className="animate-spin" />
            : <RotateCcw size={11} />
          }
          Restore
        </button>
      </div>
    </li>
  )
}

// ─── DiffModal ────────────────────────────────────────────────────────────────
// Renders a readable line-level diff (Docs) or a coarse summary (Sheets/Slides).
interface DiffModalProps {
  fileId: string
  version: Version | null
  onClose: () => void
}

function DiffModal({ fileId, version, onClose }: DiffModalProps) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [diff, setDiff] = useState<DiffResult | null>(null)

  useEffect(() => {
    let live = true
    if (!version) return
    setLoading(true)
    setError(null)
    api.diffVersion(fileId, version.id, 'current')
      .then((d) => { if (live) setDiff(d as DiffResult) })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : 'Could not load diff') })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [fileId, version])

  const body = diff?.diff
  return (
    <Modal open={!!version} onClose={onClose} title="Compare version" size="lg">
      <Modal.Body>
        <p className="text-2xs text-ink-faint mb-3">
          <span className="font-medium text-ink-muted">{diff?.old_label || (version ? formatRelative(version.created_at) : '')}</span>
          {' → '}
          <span className="font-medium text-ink-muted">{diff?.new_label || 'current'}</span>
        </p>
        {loading && <LoadingState size="sm" label="Computing diff…" className="py-8" />}
        {error && !loading && (
          <p className="text-xs text-danger" role="alert">{error}</p>
        )}
        {!loading && !error && body && (
          <>
            <div className="flex items-center gap-3 mb-2 text-2xs">
              <span className="text-success font-medium">+{body.added} added</span>
              <span className="text-danger font-medium">−{body.removed} removed</span>
              {body.summary && <span className="text-ink-faint">{body.summary}</span>}
            </div>
            {body.kind === 'line' && body.lines && body.lines.length > 0 ? (
              <div className="rounded-md border border-line overflow-hidden max-h-[50vh] overflow-y-auto font-mono text-2xs leading-relaxed">
                {body.lines.map((l, i) => (
                  <div
                    key={i}
                    className={[
                      'px-3 py-0.5 whitespace-pre-wrap break-words flex gap-2',
                      l.op === 'insert' ? 'bg-success-bg text-success' :
                        l.op === 'delete' ? 'bg-danger-bg text-danger line-through decoration-danger/40' :
                          'text-ink-muted',
                    ].join(' ')}
                  >
                    <span className="select-none opacity-60 w-3 flex-shrink-0">
                      {l.op === 'insert' ? '+' : l.op === 'delete' ? '−' : ' '}
                    </span>
                    <span>{l.text || ' '}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-ink-muted bg-bg-elev2 border border-line rounded-md px-3 py-3">
                {body.summary || 'No textual changes.'}
              </p>
            )}
          </>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" size="md" onClick={onClose}>Close</Button>
      </Modal.Footer>
    </Modal>
  )
}

// ─── HistoryPanel ─────────────────────────────────────────────────────────────
interface HistoryPanelProps {
  fileId: string
  onRestore?: (updated: unknown) => void
  onClose?: () => void
}

export default function HistoryPanel({ fileId, onRestore, onClose }: HistoryPanelProps) {
  const [versions, setVersions] = useState<Version[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [confirmVersion, setConfirmVersion] = useState<Version | null>(null)  // version to confirm restore
  const [compareVersion, setCompareVersion] = useState<Version | null>(null)  // version to diff vs current
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null)

  const showToast = (msg: string, ok = true) => {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 3000)
  }

  const load = useCallback(async () => {
    if (!fileId) return
    setLoading(true)
    setError(null)
    try {
      const data = await api.listVersions(fileId) as Version[]
      setVersions(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load history')
    } finally {
      setLoading(false)
    }
  }, [fileId])

  useEffect(() => { load() }, [load])

  const doRestore = async (v: Version | null) => {
    if (!v) return
    setConfirmVersion(null)
    setRestoring(v.id)
    try {
      const updated = await api.restoreVersion(fileId, v.id)
      showToast('Version restored')
      onRestore?.(updated)
      await load()
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Restore failed', false)
    } finally {
      setRestoring(null)
    }
  }

  return (
    <>
      <div className="w-72 flex flex-col border-l border-line bg-paper h-full overflow-hidden animate-slide-in-right">
        {/* ── Header ── */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-line bg-bg-elev2 flex-shrink-0">
          <div className="flex items-center gap-2">
            <History size={13} className="text-ink-faint" />
            <span className="text-sm font-semibold text-ink tracking-tightish">Version History</span>
          </div>
          {onClose && (
            <IconButton size="sm" onClick={onClose} title="Close">
              <X size={14} />
            </IconButton>
          )}
        </div>

        {/* ── Body ── */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <LoadingState size="sm" label="Loading history…" className="py-12" />
          )}

          {error && !loading && (
            <ErrorState size="sm" message={error} onRetry={load} />
          )}

          {!loading && !error && versions.length === 0 && (
            <EmptyState
              size="sm"
              icon={History}
              title="No saved versions yet."
              hint="Versions are created automatically on each save."
            />
          )}

          {!loading && !error && versions.length > 0 && (
            <ul className="divide-y divide-line">
              {versions.map((v, idx) => (
                <VersionRow
                  key={v.id}
                  v={v}
                  idx={idx}
                  isLatest={idx === 0}
                  restoring={restoring}
                  onRestoreClick={setConfirmVersion}
                  onCompareClick={setCompareVersion}
                />
              ))}
              {/* Rail bottom cap */}
              <li className="h-4" />
            </ul>
          )}
        </div>

        {/* ── Toast ── */}
        {toast && (
          <div
            className={[
              'mx-3 mb-3 flex items-center gap-2 px-3 py-2 rounded-md text-xs font-medium text-paper',
              'animate-rise-in',
              toast.ok ? 'bg-ink' : 'bg-danger',
            ].join(' ')}
          >
            <RotateCcw size={11} />
            {toast.msg}
          </div>
        )}
      </div>

      {/* ── Restore confirmation modal ── */}
      <Modal
        open={!!confirmVersion}
        onClose={() => setConfirmVersion(null)}
        title="Restore this version?"
        size="sm"
      >
        <Modal.Body>
          <p className="text-sm text-ink-muted leading-relaxed">
            The current document will be replaced with{' '}
            <span className="text-ink font-medium">
              {confirmVersion?.name || 'this version'}
            </span>
            {' '}from <span className="text-ink font-medium">
              {confirmVersion ? formatRelative(confirmVersion.created_at) : ''}
            </span>.
            {' '}A snapshot of the current state will be saved first.
          </p>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" size="md" onClick={() => setConfirmVersion(null)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={() => doRestore(confirmVersion)}
          >
            <RotateCcw size={13} /> Restore
          </Button>
        </Modal.Footer>
      </Modal>

      {/* ── Version diff modal ── */}
      <DiffModal
        fileId={fileId}
        version={compareVersion}
        onClose={() => setCompareVersion(null)}
      />
    </>
  )
}
