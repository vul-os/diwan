/**
 * WhiteboardEditor — Diwan's whiteboard document type.
 *
 * A whiteboard is an Excalidraw canvas (MIT — https://github.com/excalidraw/excalidraw)
 * backed by a Y.Doc, mounted on Office's OWN distributed peer-to-peer collab
 * engine — the SAME one Docs uses:
 *
 *   • The scene is a Yjs CRDT: elements live one-per-id in a Y.Map so concurrent
 *     edits to different shapes merge cleanly (see lib/crdt/boardYdoc.js).
 *   • It syncs over an E2E-encrypted P2P room via Diwan's own first-party
 *     src/lib/collab/webrtc/fabric.js FabricClient — DIRECT WebRTC data
 *     channels, relay/TURN only on hard-NAT
 *     failure and content-blind even then. The room key lives in the URL
 *     #fragment, never on a server. This is yP2PSession + useP2PCollab, unchanged
 *     from Docs — the session just validates an Excalidraw scene (the board ctx's
 *     applyUpdate) instead of a ProseMirror document.
 *   • There is NO central whiteboard/collab server. The Y.Doc is hydrated LOCALLY
 *     from the file's own authoritative scene (sovereign storage), exactly like
 *     DocsEditor seeds its Y.Doc from the document's content, and saved back to
 *     the file's own storage.
 *
 * Transport is the three-way choice in transportSelection.js: this server's own
 * peering fabric (`/api/peering/*`) when present, else any configured
 * rendezvous URL (no Vulos OS / host box needed at all), else local-only +
 * autosave with an honest "Offline" pill rather than a fake "Live". See
 * docs/COLLABORATION.md §3.
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import type { ExcalidrawImperativeAPI, ExcalidrawProps } from '@excalidraw/excalidraw/types'
import { ArrowLeft, Users, Eye, Share2, Info, WifiOff } from 'lucide-react'
import { useFilesStore, getSaveState, onSaveStateChange, type DiwanFile } from '../../store/filesStore'
import { api } from '../../lib/api'
import { useAuthStore } from '../../store/authStore'
import { useResolvedTheme } from '../../components/ui/useTheme'
import { Topbar, IconButton, Tooltip, SaveStatus, LoadingState, useToast } from '../../components/ui'
import { docsCollabEnabled, DOCS_COLLAB_OFF_NOTICE, updateLogEnabled } from '../../lib/flags.js'
import { UpdateLogSync } from '../../lib/collab/updateLog.js'
import { Y, SEED_ORIGIN } from '../../lib/crdt/ydoc.js'
import {
  createBoardYContext,
  seedBoardUpdateFromScene,
  isBoardDocEmpty,
  boardDocToScene,
} from '../../lib/crdt/boardYdoc.js'
import { ExcalidrawYBinding, type BoardEditorAPI } from './binding.js'
import { useP2PCollab } from '../docs/useP2PCollab.js'
import P2PShareModal from '../docs/components/P2PShareModal.jsx'

type OnChangeArgs = Parameters<NonNullable<ExcalidrawProps['onChange']>>

const AUTOSAVE_DELAY_MS = 1500

export default function WhiteboardEditor() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { showToast } = useToast()
  // Concrete 'light' | 'dark' (resolves 'system' + follows OS live) so the
  // Excalidraw canvas flips in lock-step with the shared tokens.
  const resolvedTheme = useResolvedTheme()
  // The SAME flag governs the whole P2P collab engine (Docs + whiteboards): when
  // off, no peering transport is opened and the UI says so plainly.
  const collabEnabled = useMemo(() => docsCollabEnabled(), [])

  const { files, saveFileWithDraft, markDirty } = useFilesStore()
  const [file, setFile] = useState<DiwanFile | undefined>(files.find((f) => f.id === id))
  const [title, setTitle] = useState(file?.name || 'Untitled whiteboard')
  const [saveStatus, setSaveStatus] = useState(getSaveState(id as string))
  const [seeded, setSeeded] = useState(false)
  const [showShare, setShowShare] = useState(false)
  useAuthStore((s) => s.accountId) // ensure identity resolves for share UI

  const titleRef = useRef(title)
  titleRef.current = title
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const bindingRef = useRef<ExcalidrawYBinding | null>(null)
  const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawImperativeAPI | null>(null)

  // ── The collaborative whiteboard (Yjs) — ALWAYS the local data model ────────
  // Unlike Docs (where TipTap can hold content solo), the Y.Doc + binding IS the
  // whiteboard's model whether or not co-editing is on: it is how Excalidraw's
  // scene is diffed, persisted and — when enabled — synced. Only the P2P session
  // is gated by collabEnabled.
  const ydoc = useMemo(() => (id ? new Y.Doc() : null), [id])
  const ctx = useMemo(() => (ydoc ? createBoardYContext(ydoc) : null), [ydoc])

  // ── P2P collab (invite-link, E2E, ro-enforced) — the SAME hook Docs uses ────
  const p2p = useP2PCollab({ fileId: id as string, ctx, enabled: collabEnabled })

  // Subscribe to this file's save state.
  useEffect(() => {
    const unsub = onSaveStateChange(id as string, (s) => setSaveStatus({ ...s }))
    return unsub
  }, [id])

  // Load the file (from the store cache, else the API).
  useEffect(() => {
    if (file || !id) return
    api.getFile(id)
      .then((f) => { const loaded = f as DiwanFile; setFile(loaded); setTitle(loaded.name || 'Untitled whiteboard') })
      .catch(() => navigate('/whiteboards'))
  }, [id, file, navigate])

  // ── Local hydration of the Y.Doc from the file's authoritative scene ────────
  // There is NO central whiteboard server: the Y.Doc is seeded HERE, locally and
  // deterministically, from the file's own content (sovereign storage). A P2P
  // sharer's seeded scene propagates to joiners over the E2E room; a joiner seeds
  // from its local copy, then the room's state-vector resync folds in the peers'
  // edits (a union merge — nothing dropped). The seed is content-derived, so two
  // identical scenes merge to one.
  useEffect(() => {
    if (!ctx || !file || seeded) return
    try {
      if (isBoardDocEmpty(ctx.ydoc)) {
        const update = seedBoardUpdateFromScene(file.content)
        Y.applyUpdate(ctx.ydoc, update, SEED_ORIGIN)
      }
    } catch (err) {
      console.warn('[whiteboard] local seed failed (editor stays usable):', (err as { message?: string } | null | undefined)?.message)
    }
    setSeeded(true)
  }, [ctx, file, seeded])

  // ── CRDT-native persistence (phase 2): mirror the board Y.Doc into the durable
  // per-file update log (behind the flag), IN ADDITION to the whole-scene
  // autosave below. The whiteboard is a plain Y.Doc, so it reuses the SAME
  // Yjs UpdateLogSync as Docs verbatim: on open it applies snapshot + missing
  // frames; on edit it appends the debounced delta. Runs only after the local
  // seed so the deterministic content seed is not logged; self-disables on 404.
  useEffect(() => {
    if (!updateLogEnabled()) return
    if (!ctx?.ydoc || !id || !seeded) return
    let cancelled = false
    const sync = new UpdateLogSync({ ydoc: ctx.ydoc, fileId: id })
    sync.hydrate().then((ok) => {
      if (cancelled || !ok) return
      sync.start()
    }).catch(() => { /* transport down — whole-scene autosave still covers durability */ })
    return () => {
      cancelled = true
      sync.stop().catch(() => {})
    }
  }, [ctx, id, seeded])

  // ── Bind Excalidraw <-> Y.Doc once the editor API is available ──────────────
  useEffect(() => {
    if (!excalidrawAPI || !ctx) return
    // binding.ts's BoardEditorAPI is a deliberately loose, vendored-shared
    // subset of Excalidraw's real imperative API (see its own doc comment —
    // BoardElement is read defensively, not the full ExcalidrawElement union).
    // Real Excalidraw elements always carry the fuller shape, so this is a
    // type-level-only bridge, not a behavioural cast.
    const binding = new ExcalidrawYBinding(ctx.ydoc, excalidrawAPI as unknown as BoardEditorAPI)
    bindingRef.current = binding
    binding.loadInitial()
    return () => { binding.destroy(); bindingRef.current = null }
  }, [excalidrawAPI, ctx])

  // ── Persist the scene to the file's own storage (debounced) ─────────────────
  // Save on EVERY change to the Y.Doc — local edits and merged remote edits alike
  // — except the one-time seed (which is what we just loaded). The document's
  // authoritative content should reflect what the board now shows, whoever drew it.
  const doSave = useCallback(async () => {
    if (!ctx || !id) return
    try {
      await saveFileWithDraft(id, titleRef.current, boardDocToScene(ctx.ydoc))
    } catch { /* the filesStore surfaces the error via saveStatus */ }
  }, [ctx, id, saveFileWithDraft])

  useEffect(() => {
    if (!ctx) return
    const onUpdate = (_update: Uint8Array, origin: unknown) => {
      if (origin === SEED_ORIGIN) return
      markDirty(id as string)
      clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => { void doSave() }, AUTOSAVE_DELAY_MS)
    }
    ctx.ydoc.on('update', onUpdate)
    return () => { ctx.ydoc.off('update', onUpdate); clearTimeout(saveTimer.current) }
  }, [ctx, id, doSave, markDirty])

  // Excalidraw local edits → drive the binding (which writes into the Y.Doc).
  const onChange = useCallback((...args: OnChangeArgs) => {
    bindingRef.current?.handleChange(...args)
  }, [])

  // Honesty guards (mirrors DocsEditor): an invite link that this deployment
  // cannot honour must SAY so rather than silently fail.
  useEffect(() => {
    if (!p2p.inviteIgnored) return
    showToast(
      'This is a collaboration invite link, but live co-editing is turned off on ' +
      'this deployment — it cannot connect you to the other editor. You are viewing ' +
      'your own copy of the whiteboard.',
      'error',
    )
  }, [p2p.inviteIgnored, showToast])

  useEffect(() => {
    if (!p2p.peeringUnavailable) return
    showToast(
      "This invite link needs P2P collaboration support this server doesn't provide " +
      '(standalone deployment, no rendezvous URL configured). Ask the whiteboard owner to ' +
      'share your account instead, host Office behind a Vulos OS/Relay server, or point ' +
      'this deployment at a self-hosted relayd.',
      'error',
    )
  }, [p2p.peeringUnavailable, showToast])

  const handleTitleChange = (v: string) => {
    setTitle(v)
    markDirty(id as string)
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => { void doSave() }, AUTOSAVE_DELAY_MS)
  }

  const startShare = async () => {
    try {
      await p2p.startShare()
      setShowShare(true)
    } catch (err) {
      const message = (err as { message?: string } | null | undefined)?.message
      if (message === 'peering-unavailable') setShowShare(true) // modal explains
      else if (message !== 'collab-disabled') {
        showToast('Could not start a collaboration room.', 'error')
      }
    }
  }

  if (!id) return null

  const saveStatusText =
    saveStatus.status === 'error' ? 'Save failed — retrying' : undefined

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-bg" data-testid="whiteboard-editor">
      <Topbar
        leading={
          <Tooltip label="Back to Whiteboards">
            <IconButton size="sm" onClick={() => void navigate('/whiteboards')}>
              <ArrowLeft size={15} />
            </IconButton>
          </Tooltip>
        }
        title={
          <input
            value={title}
            onChange={(e) => handleTitleChange(e.target.value)}
            placeholder="Untitled whiteboard"
            aria-label="Whiteboard title"
            className={[
              'flex-1 min-w-0 text-sm font-semibold tracking-tightish',
              'bg-transparent border border-transparent rounded-sm px-2 py-1',
              'text-ink placeholder:text-ink-faint',
              'hover:border-line focus:border-line-strong focus:bg-paper',
              'transition-[border-color,background] duration-fast ease-out outline-none',
            ].join(' ')}
          />
        }
        meta={
          <>
            {saveStatus.status && (
              <SaveStatus
                status={saveStatus.status as 'saved' | 'saving' | 'dirty' | 'error' | 'offline' | undefined}
                text={saveStatusText}
                title={saveStatus.error || undefined}
              />
            )}
            {!collabEnabled && (
              <Tooltip label={DOCS_COLLAB_OFF_NOTICE}>
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-pill bg-bg-elev2 text-ink-muted border border-line"
                  data-testid="collab-off-pill"
                >
                  <Users size={11} />
                  Live co-editing off
                </span>
              </Tooltip>
            )}
            {collabEnabled && p2p.active && (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-pill bg-accent-tint text-accent-press"
                title={`Peer-to-peer collaboration (${p2p.peerCount} peer(s), end-to-end encrypted)`}
              >
                <Users size={11} />
                {p2p.peerCount} · P2P
              </span>
            )}
            {collabEnabled && p2p.peeringUnavailable && !p2p.active && (
              <Tooltip label="This deployment has no reachable peer-to-peer transport (no peering fabric, no rendezvous URL configured), so live co-editing is unavailable. Your changes still save.">
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-pill bg-bg-elev2 text-ink-muted border border-line"
                  data-testid="whiteboard-offline-pill"
                >
                  <WifiOff size={11} />
                  Offline
                </span>
              </Tooltip>
            )}
            {p2p.readOnly && (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-pill bg-bg-elev2 text-ink-muted border border-line"
                title="You joined with a view-only link — you can watch live edits but not change the whiteboard."
              >
                <Eye size={11} />
                View only
              </span>
            )}
          </>
        }
        actions={
          <>
            <Tooltip label="Built on Excalidraw (MIT)">
              <span className="hidden md:inline-flex items-center gap-1 px-1.5 py-0.5 text-2xs text-ink-faint">
                <Info size={11} />
                Excalidraw · MIT
              </span>
            </Tooltip>
            {collabEnabled && !p2p.readOnly && (
              <Tooltip label="Collaborate via end-to-end-encrypted link">
                <IconButton size="sm" active={showShare} onClick={() => void startShare()}>
                  <Share2 size={14} />
                </IconButton>
              </Tooltip>
            )}
          </>
        }
      />

      <div className="flex-1 relative min-h-0" style={{ position: 'relative' }}>
        {!seeded && (
          <div className="absolute inset-0 flex items-center justify-center bg-bg z-10" role="status" aria-label="Opening whiteboard…">
            <LoadingState label="Opening whiteboard…" />
          </div>
        )}
        <Excalidraw
          excalidrawAPI={(a) => setExcalidrawAPI(a)}
          onChange={onChange}
          viewModeEnabled={p2p.readOnly}
          isCollaborating={Boolean(collabEnabled && p2p.active)}
          theme={resolvedTheme}
        />
      </div>

      <P2PShareModal
        open={showShare}
        onClose={() => setShowShare(false)}
        links={p2p.links}
        roomId={p2p.roomId}
        unavailable={p2p.peeringUnavailable}
        onRotate={() => {
          // BUG FIX (same class as DocsEditor's onRotate — see its commit):
          // p2p.rotate() (== startShare()) genuinely rejects (collab
          // disabled, document not ready, no reachable peering transport).
          // This call site had no catch at all — an unhandled rejection with
          // no feedback on a transient failure.
          p2p.rotate().catch((err: unknown) => {
            console.warn('[p2p] rotate failed:', (err as Error)?.message)
          })
        }}
      />

      {/* MIT attribution — the whiteboard is built on the Excalidraw editor. */}
      <span className="sr-only">
        Whiteboards are built on Excalidraw, MIT-licensed
        (https://github.com/excalidraw/excalidraw).
      </span>
    </div>
  )
}
