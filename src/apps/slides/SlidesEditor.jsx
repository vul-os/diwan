import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'
import TextAlign from '@tiptap/extension-text-align'
import Underline from '@tiptap/extension-underline'
import TextStyle from '@tiptap/extension-text-style'
import Color from '@tiptap/extension-color'
import Highlight from '@tiptap/extension-highlight'
import Placeholder from '@tiptap/extension-placeholder'
import { FontSize, FontFamily } from '../../lib/tiptap/fontStyle.js'
import {
  ArrowLeft, Save, Loader2, Play, Plus, Trash2,
  ChevronUp, ChevronDown, Download, EyeOff, MessageSquare,
  Bold, Italic, Underline as UnderlineIcon, Strikethrough, Link as LinkIcon,
  AlignLeft, AlignCenter, AlignRight, List, ListOrdered, Image as ImageIcon,
  StickyNote, Palette, Layout, Highlighter, RemoveFormatting,
  Copy, FileText, GripVertical, Monitor, Zap, Undo, Redo, AlertCircle,
  ChevronDown as ChevronDownIcon, Type as TypeIcon, LayoutGrid, X, Square, Share2,
} from 'lucide-react'
import { sanitizeSlideHtml as sanitize } from '../../lib/sanitize'
import { useFilesStore } from '../../store/filesStore'
import { api } from '../../lib/api'
import SlidePreview from './SlidePreview'
import { exportSlidesToPdf, exportSlidesToPptx } from './slidesExport'
import { slideImportLossItems } from './importNotes.js'
import { buildNotesPrintHtml } from './notesPrint.js'
import SlideCanvas from './SlideCanvas.jsx'
import ObjectTextEditor from './ObjectTextEditor.jsx'
import ArrangeToolbar from './ArrangeToolbar.jsx'
import {
  ensureObjects, sanitizeObjects, newObjectId, flowContentFromObjects, sortByZ,
} from './slideObjects'
import {
  bringToFront, sendToBack, bringForward, sendBackward,
  groupObjects, ungroupObjects, expandSelectionToGroups, align, distribute,
} from './slideArrange.js'
import { playAnimationsOn } from './slideAnimations.js'
import { TreeSession, getTreeReplicaId, ordKeyBetween } from '../../lib/crdt/tree.js'
import { OpLogSync } from '../../lib/collab/opLogSync.js'
import { updateLogEnabled } from '../../lib/flags.js'
import CommentsPanel from '../../components/CommentsPanel'
import { useLiveCursors } from '../../lib/collab/webrtc/useLiveCursors.js'
import { usePresence } from '../../lib/collab/webrtc/presence.js'
import { getSlideViewers } from '../../components/RemoteCursors.jsx'
import PresenceBar from '../../components/PresenceBar.jsx'
import ConnectionPill from '../../components/ConnectionPill.jsx'
import { useCollabFabric } from '../../lib/collab/useCollabFabric.js'
import { getCollabIdentity, identityColor, deriveStatusPill, countLivePeers } from '../../lib/collab/presenceCommon.js'
import { Button, IconButton, Tooltip, Topbar, Menu, UrlPopover, LoadingState, SaveStatus } from '../../components/ui'
import AccountShareModal from '../../components/AccountShareModal.jsx'
import { useAuthStore } from '../../store/authStore'
import ThemeGallery from './ThemeGallery.jsx'
import MasterSlideEditor from './MasterSlideEditor.jsx'
import TransitionPanel from './TransitionPanel.jsx'
import TemplateGallery from './TemplateGallery.jsx'
import { usePresenterView } from './PresenterView.jsx'
import { getTheme } from './themes.js'

// HTML sanitisation uses the shared config in src/lib/sanitize.js.

// SlideLinkButton — link insert with an inline anchored URL popover (replaces
// the blocking window.prompt). Self-contained open state.
function SlideLinkButton({ editor }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative inline-flex">
      <Tooltip label="Insert link (⌘K)">
        <IconButton
          size="sm"
          active={editor.isActive('link')}
          onClick={() => setOpen((v) => !v)}
          aria-label="Insert link"
        >
          <LinkIcon size={14} />
        </IconButton>
      </Tooltip>
      {open && (
        <UrlPopover
          label="Link URL"
          initialValue={editor.getAttributes('link').href || ''}
          onSubmit={(url) => {
            editor.chain().focus().extendMarkRange('link').setLink({ href: url, target: '_blank' }).run()
            setOpen(false)
          }}
          onRemove={editor.isActive('link')
            ? () => { editor.chain().focus().extendMarkRange('link').unsetLink().run(); setOpen(false) }
            : undefined}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}

// SlideFontFamilySelector — surfaces the already-wired FontFamily extension in
// the Slides toolbar (the wave-19 note flagged that the extension existed but
// had no UI). Mirrors the Docs FontFamilySelector so both editors behave the
// same. Pure textStyle-mark op — writes only into the slide's content HTML, so
// the CRDT slide tree is untouched.
function SlideFontFamilySelector({ editor }) {
  const currentFamily = editor.getAttributes('textStyle').fontFamily || ''
  const currentLabel = SLIDE_FONT_FAMILIES.find((f) => f.value === currentFamily)?.label || 'Font'
  return (
    <Menu
      width="w-40"
      trigger={
        <button
          type="button"
          className="toolbar-btn flex items-center gap-1 px-2 min-w-0 sm:min-w-[76px] text-xs"
          aria-label={`Font family: ${currentLabel}`}
          aria-haspopup="menu"
        >
          <span className="flex-1 text-left truncate" style={{ fontFamily: currentFamily || undefined }}>
            {currentLabel}
          </span>
          <ChevronDownIcon size={10} className="opacity-60" aria-hidden="true" />
        </button>
      }
    >
      {SLIDE_FONT_FAMILIES.map(({ label, value }) => (
        <Menu.Item
          key={label}
          active={currentFamily === value}
          onClick={() => {
            if (!value) editor.chain().focus().setMark('textStyle', { fontFamily: null }).run()
            else editor.chain().focus().setMark('textStyle', { fontFamily: value }).run()
          }}
        >
          <span style={{ fontFamily: value || undefined }}>{label}</span>
        </Menu.Item>
      ))}
    </Menu>
  )
}

// ObjectInsertMenu — insert image / shapes as positioned canvas objects (P4).
function ObjectInsertMenu({ onImage, onShape }) {
  const SHAPES = [
    ['rect', 'Rectangle'], ['roundRect', 'Rounded'], ['oval', 'Oval'],
    ['triangle', 'Triangle'], ['star', 'Star'], ['line', 'Line'],
    ['arrow', 'Arrow'], ['callout', 'Callout'],
  ]
  return (
    <Menu
      width="w-44"
      trigger={
        <button
          type="button"
          className="toolbar-btn flex items-center gap-1 px-2 text-xs"
          aria-label="Insert object"
          aria-haspopup="menu"
        >
          <LayoutGrid size={13} aria-hidden="true" /> Insert
          <ChevronDownIcon size={10} className="opacity-60" aria-hidden="true" />
        </button>
      }
    >
      <Menu.Item onClick={onImage}>
        <ImageIcon size={13} /> Image
      </Menu.Item>
      <Menu.Sep />
      {SHAPES.map(([kind, label]) => (
        <Menu.Item key={kind} onClick={() => onShape(kind)}>
          <Square size={13} /> {label}
        </Menu.Item>
      ))}
    </Menu>
  )
}

// Reveal.js theme names (kept for backward compatibility with legacy decks).
const LEGACY_TRANSITIONS = ['none', 'fade', 'slide', 'convex', 'concave', 'zoom']

function newSlide(master = 'content') {
  return {
    id: crypto.randomUUID(),
    title: '',
    content: '<p></p>',
    notes: '',
    background: '',
    master,
    transition: 'none',
    animations: [],
    // P2: positioned-object model. A fresh slide seeds one empty text object.
    objects: [
      {
        id: newObjectId(), type: 'text',
        x: 0.08, y: 0.10, w: 0.84, h: 0.20, rotation: 0, z: 1,
        html: '<h2></h2>', align: 'left', valign: 'top',
      },
    ],
  }
}

// ── Slide toolbar constants ──────────────────────────────────────────────────
const SLIDE_FONT_SIZES = [14, 18, 24, 32, 40, 56, 72]

// Font stacks offered in the Slides text toolbar. Kept aligned with the Docs
// toolbar (DocsToolbar FONT_FAMILIES) so decks and docs share the same set and
// the sanitiser/exporters treat them identically.
const SLIDE_FONT_FAMILIES = [
  { label: 'Default',         value: '' },
  { label: 'Arial',          value: 'Arial, sans-serif' },
  { label: 'Georgia',        value: 'Georgia, serif' },
  { label: 'Times New Roman', value: '"Times New Roman", serif' },
  { label: 'Courier New',    value: '"Courier New", monospace' },
  { label: 'Verdana',        value: 'Verdana, sans-serif' },
  { label: 'Trebuchet MS',   value: '"Trebuchet MS", sans-serif' },
  { label: 'Impact',         value: 'Impact, sans-serif' },
]

const SLIDE_HEADINGS = [
  { label: 'Normal', value: 0 },
  { label: 'H1',     value: 1 },
  { label: 'H2',     value: 2 },
  { label: 'H3',     value: 3 },
]

// ── Sidebar tabs ────────────────────────────────────────────────────────────
const SIDEBAR_TABS = [
  { id: 'slides', icon: FileText, label: 'Slides' },
  { id: 'transitions', icon: Zap, label: 'Transitions' },
]

export default function SlidesEditor() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { files, updateFile } = useFilesStore()
  const stored = files.find((f) => f.id === id)
  const [file, setFile] = useState(stored)

  const defaultData = file?.content && file.content.slides
    ? file.content
    : { themeId: 'obsidian', theme: 'black', transition: 'slide', slides: [newSlide()], masters: null, customTheme: null }

  const [title, setTitle] = useState(file?.name || 'Untitled Presentation')
  const [slidesData, setSlidesData] = useState(defaultData)
  const [activeIdx, setActiveIdx] = useState(0)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(true)
  const [presenting, setPresenting] = useState(false)
  const [showComments, setShowComments] = useState(false)
  // Import-honesty: the itemised list of native pptx constructs (tables/charts/
  // SmartArt/…) that this deck's import could NOT bring in. Surfaced as a
  // dismissible banner and restated in the export menu so a lossy round-trip is
  // never a silent surprise (see importNotes.js).
  const [importLossDismissed, setImportLossDismissed] = useState(false)
  // Account-based sharing (named users, role-scoped, ACL-enforced).
  const [showShare, setShowShare] = useState(false)
  const myAccountId = useAuthStore((s) => s.accountId)
  const [sidebarTab, setSidebarTab] = useState('slides')

  // Modal states
  const [showThemeGallery,   setShowThemeGallery]   = useState(false)
  const [showMasterEditor,   setShowMasterEditor]   = useState(false)
  const [showTemplateGallery, setShowTemplateGallery] = useState(false)
  const [showGridView,       setShowGridView]       = useState(false)

  // Notes panel height (resizable)
  const [notesHeight, setNotesHeight] = useState(80)
  const notesResizeRef = useRef(null)
  const isResizingNotes = useRef(false)

  const saveTimer = useRef(null)
  const imgInput = useRef(null)
  const treeSessionRef = useRef(null)

  // Drag-drop for slide reorder
  const [dragSlideIdx, setDragSlideIdx] = useState(null)
  const [dragOverIdx, setDragOverIdx] = useState(null)

  // ── P2/P3: positioned-object canvas state ─────────────────────────────────
  const [selectedObjectIds, setSelectedObjectIds] = useState([])
  const [editingObjectId, setEditingObjectId] = useState(null)
  const [objectEditor, setObjectEditor] = useState(null)   // TipTap editor of the object being edited
  const [animPlaying, setAnimPlaying] = useState(false)
  const canvasStageRef = useRef(null)

  const activeSlide = slidesData.slides[activeIdx] ?? slidesData.slides[0]
  // Objects for the active slide. Migration (legacy content → objects[]) is
  // memoized per slide id so a slide without objects[] yields STABLE ids across
  // renders (re-migrating each render would mint new ids → remount nodes → break
  // selection/editing). The effect below persists the migration once.
  const migrationCacheRef = useRef(new Map())
  const activeObjects = useMemo(() => {
    if (!activeSlide) return []
    if (Array.isArray(activeSlide.objects)) return sanitizeObjects(activeSlide.objects)
    const cache = migrationCacheRef.current
    if (!cache.has(activeSlide.id)) cache.set(activeSlide.id, ensureObjects(activeSlide))
    return cache.get(activeSlide.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSlide?.id, activeSlide?.objects, activeSlide?.content, activeSlide?.title])

  // Presenter view hook
  const { openPresenter, syncSlide } = usePresenterView(slidesData)

  // ── Collaboration presence (WAVE-27) ────────────────────────────────────────
  // Stable per-tab replica id doubles as the fabric peerId (shared by CRDT sync
  // and presence/cursor transport).
  const replicaIdRef = useRef(null)
  if (!replicaIdRef.current) replicaIdRef.current = getTreeReplicaId()
  const replicaId = replicaIdRef.current

  const { fabric, peers: collabPeers, joined, configured } =
    useCollabFabric({ sessionId: id, peerId: replicaId })

  const identityRef = useRef(null)
  if (!identityRef.current) identityRef.current = getCollabIdentity(replicaId)
  const localIdentity = identityRef.current

  // Live cursors + presence roster (OFFICE-25 / WAVE-27)
  const { remoteCursors, broadcastSlideCursor } = useLiveCursors({
    fabric, localIdentity, color: identityColor(localIdentity),
  })
  const { roster } = usePresence({ fabric, localIdentity })

  const collabPill = deriveStatusPill({ configured, joined, peers: collabPeers })
  const livePeerCount = countLivePeers(collabPeers)

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Image.configure({ allowBase64: true }),
      Link.configure({ openOnClick: false }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Underline,
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      // Render font size / family on the textStyle mark (base ext is a shell).
      FontSize,
      FontFamily,
      Placeholder.configure({ placeholder: 'Slide content…' }),
    ],
    content: activeSlide?.content || '<p></p>',
    // The object model (objects[]) is now the source of truth for slide body;
    // this flow editor is kept ONLY for undo-history + as a formatting target
    // when no text object is open. It must never write back into slide.content
    // (that would clobber the object-derived content sync in updateObjects).
  })

  // ── Load file ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!file && id) {
      api.getFile(id).then((f) => {
        setFile(f)
        setTitle(f.name)
        if (f.content?.slides) setSlidesData(f.content)
      }).catch(() => navigate('/slides'))
    }
  }, [id])

  // ── CRDT session (OFFICE-23) ──────────────────────────────────────────────
  // WAVE-27: attach the live fabric (when present) so slide-tree ops sync over
  // the same transport as presence; null fabric keeps the local-only behaviour.
  useEffect(() => {
    if (!id) return
    const session = new TreeSession({ sessionId: id, replicaId, fabricClient: fabric || null })
    treeSessionRef.current = session

    const seedTimer = setTimeout(() => {
      setSlidesData((current) => {
        const existing = session.orderedSlides().map((s) => s.nodeId)
        current.slides.forEach((slide, idx) => {
          if (!existing.includes(slide.id)) {
            const ordKey = String(idx).padStart(10, '0')
            session.insertSlide(ordKey, slide)
          }
        })
        return current
      })
    }, 0)

    session.requestSnapshot()

    // CRDT-native persistence (phase 2): mirror slide-tree ops into the server's
    // durable per-file update log (behind the flag), in ADDITION to the whole-doc
    // autosave. Applied log ops re-enter via the SAME 'remoteOp' path, so
    // converged slides render like a peer edit. start() runs only AFTER hydrate,
    // so the deterministic seed above (re-derived from file content on every
    // open, like Docs' SEED_ORIGIN) is not double-logged. Self-disables on 404.
    let opLog = null
    if (updateLogEnabled()) {
      opLog = new OpLogSync({
        fileId: id,
        subscribeLocal: (cb) => {
          const h = (e) => cb(e.detail.op)
          session.addEventListener('localOp', h)
          return () => session.removeEventListener('localOp', h)
        },
        applyOp: (op) => session.applyLogOp(op),
        applySnapshot: (snap) => session.applyLogSnapshot(snap),
        encodeSnapshot: () => session.logSnapshotData(),
      })
      opLog.hydrate().then((ok) => { if (ok) opLog.start() }).catch(() => {})
    }

    const onRemote = () => {
      const crdtSlides = session.orderedSlides()
      if (crdtSlides.length === 0) return
      setSlidesData((prev) => {
        const next = {
          ...prev,
          slides: crdtSlides
            .filter((s) => s.data && typeof s.data === 'object')
            // WAVE-55/56 discipline: a peer-supplied slide's positioned objects
            // are untrusted structured data. Validate/clamp EVERY descriptor at
            // this CRDT ingress boundary (finite geometry, bounded z/count,
            // sanitized text, gated image src) and fail closed — a malformed
            // object is repaired or dropped, never rendered raw.
            .map((s) => {
              const slide = { ...s.data }
              if (Array.isArray(slide.objects)) slide.objects = sanitizeObjects(slide.objects)
              return slide
            }),
        }
        schedule(next)
        return next
      })
    }

    session.addEventListener('remoteOp', onRemote)
    return () => {
      clearTimeout(seedTimer)
      session.removeEventListener('remoteOp', onRemote)
      if (opLog) opLog.stop().catch(() => {})
      session.destroy()
      treeSessionRef.current = null
    }
  }, [id, fabric]) // eslint-disable-line — recreate session when the fabric attaches

  // ── Sync editor when switching slides ─────────────────────────────────────
  useEffect(() => {
    if (editor && activeSlide) {
      editor.commands.setContent(activeSlide.content || '<p></p>', false)
    }
    if (activeSlide?.id) {
      broadcastSlideCursor(activeSlide.id)
      syncSlide(activeIdx)
    }
    // Reset canvas interaction state when switching slides.
    setSelectedObjectIds([])
    setEditingObjectId(null)
  }, [activeIdx]) // eslint-disable-line

  // Persist a legacy slide's migration (content → objects[]) exactly once, so
  // the object ids become stable (no per-render id churn) and future loads skip
  // migration. Uses the memoized activeObjects (stable ids) as the seed.
  useEffect(() => {
    if (!activeSlide || Array.isArray(activeSlide.objects)) return
    if (!activeObjects.length) return
    updateSlideMeta(activeIdx, { objects: activeObjects })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSlide?.id])

  // ── Notes panel resize ────────────────────────────────────────────────────
  useEffect(() => {
    const onMouseMove = (e) => {
      if (!isResizingNotes.current) return
      const container = notesResizeRef.current?.closest('.slides-layout')
      if (!container) return
      const rect = container.getBoundingClientRect()
      const newH = rect.bottom - e.clientY
      setNotesHeight(Math.max(40, Math.min(300, newH)))
    }
    const onMouseUp = () => { isResizingNotes.current = false }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  // ── Global keyboard shortcuts ─────────────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e) => {
      // Only fire when not in an input/textarea/contenteditable.
      const tag = e.target.tagName
      const isEditing = tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable
      const meta = e.metaKey || e.ctrlKey

      if (meta && e.key === 'm' && !isEditing) {
        e.preventDefault()
        addSlide()
      }
      if (meta && e.key === 'd' && !isEditing) {
        e.preventDefault()
        duplicateSlide(activeIdx)
      }
      if (meta && e.shiftKey && e.key === 'Enter') {
        e.preventDefault()
        openPresenter(activeIdx)
      }
      // Object-level shortcuts (only when object(s) are selected + not editing).
      if (selectedObjectIds.length > 0 && !isEditing && !editingObjectId) {
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault(); deleteSelectedObjects(); return
        }
        if (meta && e.key === 'g') {
          e.preventDefault()
          doArrange(e.shiftKey ? 'ungroup' : 'group'); return
        }
        // Arrow nudge is owned by SlideCanvas (capture listener); don't also
        // navigate slides while objects are selected.
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return
      }
      // Arrow key navigation in sidebar
      if (!isEditing) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setActiveIdx((i) => Math.min(i + 1, slidesData.slides.length - 1))
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setActiveIdx((i) => Math.max(i - 1, 0))
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeIdx, slidesData.slides.length, selectedObjectIds, editingObjectId, activeObjects]) // eslint-disable-line

  // ── Autosave ──────────────────────────────────────────────────────────────
  const autosave = useCallback(async (sd) => {
    if (!id) return
    setSaving(true)
    try {
      await updateFile(id, title, sd)
      setSaved(true)
    } finally {
      setSaving(false)
    }
  }, [id, title])

  const schedule = (sd) => {
    setSaved(false)
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => autosave(sd), 2000)
  }

  // Cancel any pending debounced autosave when the editor unmounts, so a save
  // can't fire (and hit the network) against a torn-down component.
  useEffect(() => () => clearTimeout(saveTimer.current), [])

  // ── Slide field update ────────────────────────────────────────────────────
  const updateSlideField = (idx, field, value) => {
    setSlidesData((prev) => {
      const slides = [...prev.slides]
      slides[idx] = { ...slides[idx], [field]: value }
      const next = { ...prev, slides }
      schedule(next)
      const session = treeSessionRef.current
      if (session) {
        const slide = slides[idx]
        session.setSlide(slide.id, slide)
        session.saveLocal()
      }
      return next
    })
  }

  const updateSlideMeta = (idx, updates) => {
    setSlidesData((prev) => {
      const slides = [...prev.slides]
      slides[idx] = { ...slides[idx], ...updates }
      const next = { ...prev, slides }
      schedule(next)
      return next
    })
  }

  // ── P2/P3: object operations ──────────────────────────────────────────────
  // Write the active slide's objects[] through the same field path as content,
  // so the CRDT tree syncs them as part of the slide node. `commit` gates the
  // CRDT/persist write: transient drag frames pass commit:false (local render
  // only), and the pointer-up passes commit:true.
  const updateObjects = useCallback((nextObjects, { commit = true } = {}) => {
    setSlidesData((prev) => {
      const idx = prev.slides.findIndex((s) => s.id === activeSlide?.id)
      if (idx < 0) return prev
      const objects = sanitizeObjects(nextObjects)
      const slide = {
        ...prev.slides[idx],
        objects,
        // Keep a legacy flow `content` in sync so thumbnails / PDF / notes-print
        // (which still read slide.content) stay accurate.
        content: flowContentFromObjects(objects),
      }
      const slides = [...prev.slides]
      slides[idx] = slide
      const next = { ...prev, slides }
      if (commit) {
        schedule(next)
        const session = treeSessionRef.current
        if (session) { session.setSlide(slide.id, slide); session.saveLocal() }
      }
      return next
    })
  }, [activeSlide?.id]) // eslint-disable-line

  // Commit an object text edit back into the object model.
  const commitObjectText = useCallback((html) => {
    if (!editingObjectId) return
    updateObjects(
      activeObjects.map((o) => (o.id === editingObjectId ? { ...o, html } : o)),
      { commit: true },
    )
  }, [editingObjectId, activeObjects, updateObjects])

  // ── P1: play the active slide's animations in the editor preview ──────────
  const playAnimations = useCallback(() => {
    const stage = canvasStageRef.current
    if (!stage || !activeSlide) return
    // Target the animatable objects in z-order (matches present-mode ordering).
    const els = sortByZ(activeObjects)
      .map((o) => stage.querySelector(`[data-object-id="${o.id}"]`))
      .filter(Boolean)
    setAnimPlaying(true)
    const cleanup = playAnimationsOn(els, activeSlide.animations || [])
    // Auto-clear the "playing" flag once the longest animation could have run.
    const t = setTimeout(() => { cleanup(); setAnimPlaying(false) }, 2000)
    return () => { clearTimeout(t); cleanup() }
  }, [activeObjects, activeSlide]) // eslint-disable-line

  const insertObject = (partial) => {
    const maxZ = Math.max(0, ...activeObjects.map((o) => o.z || 0))
    const obj = { id: newObjectId(), rotation: 0, z: maxZ + 1, ...partial }
    updateObjects([...activeObjects, obj], { commit: true })
    setSelectedObjectIds([obj.id])
    if (obj.type === 'text') setEditingObjectId(obj.id)
  }

  const insertTextObject = () => insertObject({
    type: 'text', x: 0.3, y: 0.4, w: 0.4, h: 0.15, html: '<p>Text</p>', align: 'left', valign: 'top',
  })
  const insertShapeObject = (shape = 'rect', fill = '#7c6af7', stroke = '#5b4dd0') => insertObject({
    type: 'shape', shape, x: 0.35, y: 0.35, w: 0.3, h: 0.3, fill, stroke, strokeWidth: 2, opacity: 1,
  })
  const insertImageObject = (src) => insertObject({
    type: 'image', src, x: 0.3, y: 0.3, w: 0.4, h: 0.4,
  })

  const deleteSelectedObjects = () => {
    if (selectedObjectIds.length === 0) return
    updateObjects(activeObjects.filter((o) => !selectedObjectIds.includes(o.id)), { commit: true })
    setSelectedObjectIds([])
    setEditingObjectId(null)
  }

  // Contextual arrange dispatcher (P3).
  const doArrange = (op, arg) => {
    const ids = expandSelectionToGroups(activeObjects, selectedObjectIds)
    let next = activeObjects
    switch (op) {
      case 'bringToFront':  next = bringToFront(activeObjects, ids); break
      case 'sendToBack':    next = sendToBack(activeObjects, ids); break
      case 'bringForward':  next = bringForward(activeObjects, ids); break
      case 'sendBackward':  next = sendBackward(activeObjects, ids); break
      case 'group':         next = groupObjects(activeObjects, selectedObjectIds); break
      case 'ungroup':       next = ungroupObjects(activeObjects, selectedObjectIds); break
      case 'align':         next = align(activeObjects, ids, arg); break
      case 'distribute':    next = distribute(activeObjects, ids, arg); break
      default: return
    }
    updateObjects(next, { commit: true })
  }

  const editingObject = activeObjects.find((o) => o.id === editingObjectId) || null
  // The formatting toolbar acts on the object editor while a text object is open,
  // otherwise on the (hidden) flow editor — which always exists past the loading
  // guard below, so `fmtEditor` is never null when the toolbar renders.
  const fmtEditor = objectEditor || editor

  // ── Slide operations ──────────────────────────────────────────────────────
  const addSlide = (master = 'content') => {
    setSlidesData((prev) => {
      const slide = newSlide(master)
      const slides = [...prev.slides, slide]
      const next = { ...prev, slides }
      schedule(next)
      setActiveIdx(slides.length - 1)
      const session = treeSessionRef.current
      if (session) {
        const prevOrdKey = slides.length >= 2 ? String(slides.length - 2).padStart(10, '0') : ''
        const ordKey = ordKeyBetween(prevOrdKey, '')
        session.insertSlide(ordKey, slide)
        session.saveLocal()
      }
      return next
    })
  }

  const duplicateSlide = (idx) => {
    setSlidesData((prev) => {
      const original = prev.slides[idx]
      const copy = { ...original, id: crypto.randomUUID() }
      const slides = [
        ...prev.slides.slice(0, idx + 1),
        copy,
        ...prev.slides.slice(idx + 1),
      ]
      const next = { ...prev, slides }
      schedule(next)
      setActiveIdx(idx + 1)
      const session = treeSessionRef.current
      if (session) {
        const ordKey = ordKeyBetween(
          String(idx).padStart(10, '0'),
          String(idx + 1).padStart(10, '0')
        )
        session.insertSlide(ordKey, copy)
        session.saveLocal()
      }
      return next
    })
  }

  const deleteSlide = (idx) => {
    setSlidesData((prev) => {
      if (prev.slides.length === 1) return prev
      const slide = prev.slides[idx]
      const slides = prev.slides.filter((_, i) => i !== idx)
      const next = { ...prev, slides }
      schedule(next)
      setActiveIdx(Math.min(idx, slides.length - 1))
      const session = treeSessionRef.current
      if (session) {
        session.deleteSlide(slide.id)
        session.saveLocal()
      }
      return next
    })
  }

  const moveSlide = (idx, dir) => {
    const newIdx = idx + dir
    if (newIdx < 0 || newIdx >= slidesData.slides.length) return
    setSlidesData((prev) => {
      const slides = [...prev.slides];
      [slides[idx], slides[newIdx]] = [slides[newIdx], slides[idx]]
      const next = { ...prev, slides }
      schedule(next)
      setActiveIdx(newIdx)
      const session = treeSessionRef.current
      if (session) {
        const beforeKey = newIdx > 0 ? String(newIdx - 1).padStart(10, '0') : ''
        const afterKey  = newIdx < slides.length - 1 ? String(newIdx + 1).padStart(10, '0') : ''
        const newOrdKey = ordKeyBetween(beforeKey, afterKey)
        session.moveSlide(slides[newIdx].id, newOrdKey)
        session.saveLocal()
      }
      return next
    })
  }

  // Drag-drop reorder
  const handleSlideDropped = () => {
    if (dragSlideIdx === null || dragOverIdx === null || dragSlideIdx === dragOverIdx) {
      setDragSlideIdx(null); setDragOverIdx(null); return
    }
    setSlidesData((prev) => {
      const slides = [...prev.slides]
      const [item] = slides.splice(dragSlideIdx, 1)
      slides.splice(dragOverIdx, 0, item)
      const next = { ...prev, slides }
      schedule(next)
      setActiveIdx(dragOverIdx)
      return next
    })
    setDragSlideIdx(null); setDragOverIdx(null)
  }

  const updateMeta = (key, value) => {
    const next = { ...slidesData, [key]: value }
    setSlidesData(next)
    schedule(next)
  }

  // ── Theme application ─────────────────────────────────────────────────────
  const applyTheme = ({ themeId, customTheme }) => {
    const theme = getTheme(themeId)
    const next = {
      ...slidesData,
      themeId,
      theme: theme.revealTheme,
      customTheme: customTheme || null,
    }
    setSlidesData(next)
    schedule(next)
  }

  // ── Master save ───────────────────────────────────────────────────────────
  const saveMasters = (masters) => {
    const next = { ...slidesData, masters }
    setSlidesData(next)
    schedule(next)
  }

  // ── Export (server PDF or client PPTX) ───────────────────────────────────
  const handleServerPdfExport = async () => {
    if (!id) {
      // Fallback to client-side print PDF if not saved.
      exportSlidesToPdf(title)
      return
    }
    try {
      const res = await fetch(`/api/slides/${id}/export?format=pdf`, { credentials: 'include' })
      if (!res.ok) throw new Error('Server PDF failed')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = `${title}.pdf`; a.click()
      setTimeout(() => URL.revokeObjectURL(url), 5000)
    } catch {
      // Fallback.
      exportSlidesToPdf(title)
    }
  }

  // ── Speaker notes print ───────────────────────────────────────────────────
  const handlePrintNotes = () => {
    const printWindow = window.open('', '_blank', 'width=800,height=600')
    if (!printWindow) return
    // SECURITY: title/notes are untrusted plain-text (a note can come straight
    // from an imported .pptx) written into a new same-origin window — escaped in
    // buildNotesPrintHtml (slide.content is HTML-sanitised there via `sanitize`).
    printWindow.document.write(buildNotesPrintHtml(slidesData, title, sanitize))
    printWindow.document.close()
    printWindow.print()
  }

  if (!editor) {
    return (
      <div className="flex-1 flex items-center justify-center bg-bg">
        <LoadingState label="Opening presentation…" />
      </div>
    )
  }

  const saveStatusKind = saving ? 'saving' : saved ? 'saved' : 'dirty'

  const currentTheme = slidesData.customTheme
    ? { ...getTheme(slidesData.themeId || 'obsidian'), ...slidesData.customTheme }
    : getTheme(slidesData.themeId || 'obsidian')

  const importLoss = slideImportLossItems(slidesData?.importNotes)

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-bg">
      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <Topbar
        leading={
          <Tooltip label="Back to Slides">
            <IconButton size="sm" onClick={() => navigate('/slides')}>
              <ArrowLeft size={15} />
            </IconButton>
          </Tooltip>
        }
        title={
          <input
            value={title}
            onChange={(e) => { setTitle(e.target.value); setSaved(false) }}
            placeholder="Untitled presentation"
            aria-label="Presentation title"
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
            <SaveStatus status={saveStatusKind} />
            {/* WAVE-27: collaboration presence — roster + connection pill */}
            <PresenceBar roster={roster} className="ml-1" />
            <ConnectionPill pill={collabPill} peerCount={livePeerCount} />
          </>
        }
        actions={
          <>
            {/* Share — account-based (named users) + P2P E2E link */}
            <Tooltip label="Share">
              <IconButton size="sm" active={showShare} onClick={() => setShowShare(true)} aria-label="Share">
                <Share2 size={14} />
              </IconButton>
            </Tooltip>
            {/* New from Template */}
            <Tooltip label="New from Template">
              <IconButton size="sm" onClick={() => setShowTemplateGallery(true)} aria-label="New from template">
                <FileText size={14} />
              </IconButton>
            </Tooltip>
            {/* Theme gallery */}
            <Tooltip label="Theme Gallery">
              <IconButton size="sm" onClick={() => setShowThemeGallery(true)} aria-label="Theme gallery">
                <Palette size={14} />
              </IconButton>
            </Tooltip>
            {/* Master slide editor */}
            <Tooltip label="Master Slides (View → Master)">
              <IconButton size="sm" onClick={() => setShowMasterEditor(true)} aria-label="Master slide editor">
                <Layout size={14} />
              </IconButton>
            </Tooltip>
            {/* Grid / overview mode */}
            <Tooltip label="Slide overview">
              <IconButton size="sm" active={showGridView} onClick={() => setShowGridView((v) => !v)} aria-label="Slide overview">
                <LayoutGrid size={14} />
              </IconButton>
            </Tooltip>
            <Tooltip label="Comments">
              <IconButton size="sm" active={showComments} onClick={() => setShowComments((v) => !v)}>
                <MessageSquare size={14} />
              </IconButton>
            </Tooltip>
            {/* Present */}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPresenting(!presenting)}
              aria-pressed={presenting}
            >
              {presenting ? <><EyeOff size={13} /> Edit</> : <><Play size={13} /> Present</>}
            </Button>
            {/* Presenter view */}
            <Tooltip label="Presenter view (⌘⇧↵)">
              <IconButton
                size="sm"
                onClick={() => openPresenter(activeIdx)}
                aria-label="Open presenter view"
              >
                <Monitor size={14} />
              </IconButton>
            </Tooltip>
            {/* Export menu */}
            <Menu
              align="right"
              width="w-52"
              trigger={
                <button
                  type="button"
                  className={[
                    'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md',
                    'bg-paper border border-line text-xs font-medium tracking-tightish',
                    'text-ink-muted hover:border-line-strong hover:text-ink',
                    'transition-colors duration-fast ease-out',
                    'focus-visible:outline-none focus-visible:shadow-focus',
                  ].join(' ')}
                >
                  <Download size={12} /> Export
                  <ChevronDownIcon size={11} className="opacity-60" />
                </button>
              }
            >
              <Menu.Item onClick={handleServerPdfExport}>
                <span className="text-2xs font-bold tracking-eyebrow text-danger w-10">PDF</span>
                Export as PDF
              </Menu.Item>
              <Menu.Item onClick={() => exportSlidesToPptx(slidesData, title)}>
                <span className="text-2xs font-bold tracking-eyebrow text-accent w-10">PPTX</span>
                Export as PowerPoint
              </Menu.Item>
              {/* Restate the import loss right where it matters: before a PPTX
                  export overwrites the user's original and quietly ships a deck
                  missing the tables/charts/etc. that never imported. */}
              {importLoss.length > 0 && (
                <div
                  className="px-3 py-1.5 text-2xs text-warning leading-snug"
                  data-testid="slide-export-loss-note"
                >
                  <AlertCircle size={11} className="inline mr-1 -mt-0.5" />
                  This export will not contain {importLoss.join(', ')} — they never imported.
                </div>
              )}
              <Menu.Sep />
              <Menu.Item onClick={handlePrintNotes}>
                <span className="text-2xs font-bold tracking-eyebrow text-warning w-10">NOTE</span>
                Print speaker notes
              </Menu.Item>
            </Menu>
            <Button
              variant="primary"
              size="sm"
              onClick={() => { clearTimeout(saveTimer.current); autosave(slidesData) }}
              disabled={saving}
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              Save
            </Button>
          </>
        }
      />

      {/* Import-honesty banner — this deck was imported from a .pptx/.odp that
          carried constructs our model can't represent. Say exactly what did not
          come in, and warn that exporting will not restore them. Dismissible,
          but restated in the export menu every time (the moment it matters). */}
      {importLoss.length > 0 && !importLossDismissed && (
        <div
          className="flex items-start gap-3 px-4 py-2 bg-warning-bg border-b border-line text-xs text-warning animate-fade-in"
          role="alert"
          data-testid="slide-import-loss-banner"
        >
          <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
          <span className="flex-1 text-ink-muted">
            This presentation was imported, but {importLoss.join(', ')} could not be
            brought in — our slides can't represent them. They are <strong>not</strong> in
            this deck, and exporting to PowerPoint will not restore them.
          </span>
          <button
            type="button"
            onClick={() => setImportLossDismissed(true)}
            className="flex-shrink-0 text-ink-faint hover:text-ink"
            aria-label="Dismiss import notice"
          >
            <X size={13} />
          </button>
        </div>
      )}

      {/* ── Presentation preview ──────────────────────────────────────────── */}
      {presenting ? (
        <SlidePreview data={slidesData} onClose={() => setPresenting(false)} />
      ) : showGridView ? (
        /* ── Grid / Overview mode ───────────────────────────────────────── */
        <div className="flex-1 flex flex-col overflow-hidden bg-bg">
          {/* Grid header */}
          <div className="flex items-center justify-between px-3 sm:px-6 py-3 bg-paper border-b border-line">
            <h2 className="text-sm font-semibold text-ink">Slide Overview</h2>
            <button
              type="button"
              onClick={() => setShowGridView(false)}
              className={[
                'inline-flex items-center gap-1.5 h-7 px-3 rounded-md text-xs font-medium',
                'bg-paper border border-line text-ink-muted hover:border-line-strong hover:text-ink',
                'transition-colors duration-fast',
              ].join(' ')}
              aria-label="Exit overview"
            >
              <X size={12} />
              Edit
            </button>
          </div>
          {/* Grid of thumbnails */}
          <div className="flex-1 overflow-y-auto p-6">
            <div className="grid grid-cols-4 gap-4">
              {slidesData.slides.map((slide, idx) => {
                const isActive = idx === activeIdx
                return (
                  <div
                    key={slide.id}
                    role="button"
                    tabIndex={0}
                    aria-current={isActive ? 'true' : undefined}
                    aria-label={`Slide ${idx + 1}${slide.title ? `: ${slide.title}` : ''}${isActive ? ' (current)' : ''}`}
                    draggable
                    onDragStart={() => setDragSlideIdx(idx)}
                    onDragOver={(e) => { e.preventDefault(); setDragOverIdx(idx) }}
                    onDragEnd={handleSlideDropped}
                    onClick={() => { setActiveIdx(idx); setShowGridView(false) }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault(); setActiveIdx(idx); setShowGridView(false)
                      }
                    }}
                    className={[
                      'relative rounded-lg overflow-hidden cursor-pointer',
                      'border-2 transition-[box-shadow,border-color] duration-fast',
                      'focus-visible:outline-none focus-visible:shadow-focus',
                      isActive ? 'border-accent shadow-e2' : 'border-line hover:border-line-strong hover:shadow-e1',
                      dragOverIdx === idx && dragSlideIdx !== idx ? 'border-accent' : '',
                    ].join(' ')}
                  >
                    {/* Slide number badge */}
                    <div
                      className="absolute top-2 left-2 z-10 text-[9px] font-semibold tracking-eyebrow uppercase px-1.5 py-0.5 rounded-sm bg-black/40 text-white"
                    >
                      {String(idx + 1).padStart(2, '0')}
                    </div>
                    {/* Active indicator */}
                    {isActive && (
                      <div className="absolute top-2 right-2 z-10 w-2 h-2 rounded-full bg-accent" />
                    )}
                    {/* Thumbnail body */}
                    <div
                      className="flex flex-col items-start justify-start p-4 bg-paper"
                      style={{
                        minHeight: '160px',
                        background: slide.background || undefined,
                      }}
                    >
                      <div
                        className={[
                          'text-sm font-bold truncate w-full mb-2 pl-7',
                          slide.background ? 'text-white' : 'text-ink',
                        ].join(' ')}
                      >
                        {slide.title || `Slide ${idx + 1}`}
                      </div>
                      <div
                        className={[
                          'text-xs w-full overflow-hidden line-clamp-5 leading-snug',
                          slide.background ? 'text-white/80' : 'text-ink-faint',
                        ].join(' ')}
                        dangerouslySetInnerHTML={{ __html: sanitize(slide.content) }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex overflow-hidden slides-layout">
          {/* ── Slide thumbnail sidebar ────────────────────────────────── */}
          <aside className="w-40 sm:w-48 lg:w-56 flex-shrink-0 bg-clay border-r border-line flex flex-col overflow-hidden">
            {/* Sidebar tabs */}
            <div className="flex border-b border-line">
              {SIDEBAR_TABS.map(({ id: tabId, icon: Icon, label }) => (
                <button
                  key={tabId}
                  type="button"
                  aria-pressed={sidebarTab === tabId}
                  onClick={() => setSidebarTab(tabId)}
                  className={[
                    'flex-1 flex items-center justify-center gap-1 px-2 py-2 text-2xs font-semibold transition-colors border-b-2 -mb-px',
                    sidebarTab === tabId
                      ? 'border-accent text-accent'
                      : 'border-transparent text-ink-muted hover:text-ink',
                  ].join(' ')}
                  title={label}
                >
                  <Icon size={11} />
                  <span className="hidden sm:inline">{label}</span>
                </button>
              ))}
            </div>

            {sidebarTab === 'slides' && (
              <>
                <div className="flex items-center justify-between px-3 h-9 border-b border-line">
                  <span className="text-2xs font-semibold text-ink-faint uppercase tracking-eyebrow">
                    Slides · {slidesData.slides.length}
                  </span>
                  <div className="flex items-center gap-0.5">
                    <Tooltip label="Duplicate slide (⌘D)">
                      <IconButton size="sm" onClick={() => duplicateSlide(activeIdx)} aria-label="Duplicate slide">
                        <Copy size={11} />
                      </IconButton>
                    </Tooltip>
                    <Tooltip label="Add slide (⌘M)">
                      <IconButton size="sm" onClick={() => addSlide()} aria-label="Add slide">
                        <Plus size={13} />
                      </IconButton>
                    </Tooltip>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1.5">
                  {slidesData.slides.map((slide, idx) => {
                    const viewers = getSlideViewers(remoteCursors, slide.id)
                    const isActive = idx === activeIdx
                    const isDragTarget = dragOverIdx === idx && dragSlideIdx !== idx
                    return (
                      <div
                        key={slide.id}
                        role="button"
                        tabIndex={0}
                        aria-current={isActive ? 'true' : undefined}
                        aria-label={`Slide ${idx + 1}${slide.title ? `: ${slide.title}` : ''}${isActive ? ' (current)' : ''}`}
                        draggable
                        onDragStart={() => setDragSlideIdx(idx)}
                        onDragOver={(e) => { e.preventDefault(); setDragOverIdx(idx) }}
                        onDragEnd={handleSlideDropped}
                        onClick={() => setActiveIdx(idx)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault(); setActiveIdx(idx)
                          }
                        }}
                        className={[
                          'group relative cursor-pointer rounded-md overflow-hidden',
                          'transition-[box-shadow,background,border] duration-fast ease-out',
                          'focus-visible:outline-none focus-visible:shadow-focus',
                          isDragTarget ? 'border-2 border-accent' : '',
                          isActive ? 'bg-paper shadow-e1' : 'bg-paper/60 hover:bg-paper',
                        ].join(' ')}
                      >
                        {isActive && (
                          <span
                            aria-hidden="true"
                            className="absolute left-0 top-0 bottom-0 w-0.5 bg-accent rounded-r-sm"
                          />
                        )}
                        <div
                          className="h-20 flex flex-col items-start justify-start p-2 text-left border border-line rounded-md"
                          style={{ background: slide.background || undefined }}
                        >
                          <div
                            className={[
                              'text-2xs font-semibold truncate w-full tracking-tightish pl-6',
                              slide.background ? 'text-white' : 'text-ink',
                            ].join(' ')}
                          >
                            {slide.title || `Slide ${idx + 1}`}
                          </div>
                          <div
                            className={[
                              'text-[10px] mt-1 w-full overflow-hidden line-clamp-3 leading-snug',
                              slide.background ? 'text-white/70' : 'text-ink-faint',
                            ].join(' ')}
                            dangerouslySetInnerHTML={{ __html: sanitize(slide.content) }}
                          />
                          {/* Layout badge */}
                          {slide.master && slide.master !== 'content' && (
                            <div className="mt-1">
                              <span className="text-[8px] px-1 rounded-sm bg-accent-tint text-accent font-semibold uppercase">
                                {slide.master}
                              </span>
                            </div>
                          )}
                        </div>
                        <div
                          className={[
                            'absolute top-1 left-1.5 text-[9px] font-semibold tracking-eyebrow uppercase px-1 rounded-sm',
                            slide.background ? 'text-white/80 bg-black/30' : 'text-ink-faint bg-bg-elev2',
                          ].join(' ')}
                        >
                          {String(idx + 1).padStart(2, '0')}
                        </div>
                        {/* Drag handle */}
                        <div className="absolute top-1 right-8 hidden group-hover:flex items-center text-ink-faint">
                          <GripVertical size={9} className="cursor-grab" />
                        </div>
                        {/* Remote viewer badges */}
                        {viewers.length > 0 && (
                          <div className="absolute bottom-1 left-1.5 flex gap-0.5">
                            {viewers.map((v) => (
                              <span
                                key={v.accountId}
                                title={v.displayName}
                                className="flex items-center justify-center rounded-pill text-white font-bold select-none"
                                style={{ background: v.color, width: 14, height: 14, fontSize: 8 }}
                              >
                                {(v.displayName || '?')[0].toUpperCase()}
                              </span>
                            ))}
                          </div>
                        )}
                        {/* Per-slide controls — revealed on hover for mouse,
                            always shown (and ≥44px via the coarse-pointer rule)
                            on touch so they're reachable without hover. */}
                        <div className="absolute top-1 right-1 hidden group-hover:flex [@media(pointer:coarse)]:flex gap-0.5 bg-bg-elev2/80 rounded-md">
                          <IconButton
                            size="sm" title="Move up"
                            disabled={idx === 0}
                            onClick={(e) => { e.stopPropagation(); moveSlide(idx, -1) }}
                          ><ChevronUp size={12} /></IconButton>
                          <IconButton
                            size="sm" title="Move down"
                            disabled={idx === slidesData.slides.length - 1}
                            onClick={(e) => { e.stopPropagation(); moveSlide(idx, 1) }}
                          ><ChevronDown size={12} /></IconButton>
                          <IconButton
                            size="sm" title="Duplicate"
                            onClick={(e) => { e.stopPropagation(); duplicateSlide(idx) }}
                          ><Copy size={12} /></IconButton>
                          <IconButton
                            size="sm" title="Delete slide" className="hover:text-danger"
                            onClick={(e) => { e.stopPropagation(); deleteSlide(idx) }}
                          ><Trash2 size={12} /></IconButton>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </>
            )}

            {sidebarTab === 'transitions' && activeSlide && (
              <div className="flex-1 overflow-y-auto p-3">
                <TransitionPanel
                  slide={activeSlide}
                  onChange={(updated) => {
                    const idx = slidesData.slides.findIndex((s) => s.id === activeSlide.id)
                    if (idx >= 0) updateSlideMeta(idx, { transition: updated.transition, animations: updated.animations })
                  }}
                />
              </div>
            )}

            {/* Meta controls — theme + transition (legacy reveal.js global) */}
            <div className="px-3 py-3 border-t border-line space-y-2.5 bg-clay">
              {/* Current theme badge */}
              <button
                type="button"
                onClick={() => setShowThemeGallery(true)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md border border-line hover:border-line-strong text-xs text-ink-muted hover:text-ink transition-colors"
              >
                <span
                  className="inline-block w-3 h-3 rounded-full flex-shrink-0"
                  style={{ background: currentTheme.primary }}
                />
                <span className="truncate">{currentTheme.label}</span>
                <Palette size={10} className="ml-auto opacity-50" />
              </button>
              <div>
                <label className="text-2xs font-semibold text-ink-faint uppercase tracking-eyebrow block mb-1">
                  Global transition
                </label>
                <select
                  value={slidesData.transition}
                  onChange={(e) => updateMeta('transition', e.target.value)}
                  className={[
                    'w-full bg-paper text-ink text-xs rounded-sm px-2 h-7',
                    'border border-line hover:border-line-strong',
                    'focus-visible:outline-none focus-visible:shadow-focus',
                  ].join(' ')}
                >
                  {LEGACY_TRANSITIONS.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              {/* Master assignment for current slide */}
              <div>
                <label className="text-2xs font-semibold text-ink-faint uppercase tracking-eyebrow block mb-1">
                  Slide layout
                </label>
                <select
                  value={activeSlide?.master || 'content'}
                  onChange={(e) => updateSlideMeta(activeIdx, { master: e.target.value })}
                  className={[
                    'w-full bg-paper text-ink text-xs rounded-sm px-2 h-7',
                    'border border-line hover:border-line-strong',
                    'focus-visible:outline-none focus-visible:shadow-focus',
                  ].join(' ')}
                >
                  <option value="title">Title Master</option>
                  <option value="content">Content Master</option>
                  <option value="section">Section Master</option>
                </select>
              </div>
            </div>
          </aside>

          {/* ── Slide editor ─────────────────────────────────────────────── */}
          {activeSlide && (
            <div className="flex-1 flex flex-col overflow-hidden bg-bg">
              <div className="px-3 sm:px-6 pt-4 pb-2 bg-paper border-b border-line">
                <input
                  value={activeSlide.title}
                  onChange={(e) => updateSlideField(activeIdx, 'title', e.target.value)}
                  className={[
                    'w-full text-2xl font-bold tracking-tightish font-serif',
                    'bg-transparent border-none outline-none',
                    'text-ink placeholder:text-ink-faint',
                  ].join(' ')}
                  placeholder="Slide title…"
                  aria-label="Slide title"
                />
              </div>

              {/* Formatting toolbar — operates on the object being edited when
                  a text object is open, else on the hidden flow editor (kept for
                  back-compat + undo history). When object(s) are selected but not
                  being edited, the contextual Arrange toolbar takes over. */}
              {selectedObjectIds.length > 0 && !editingObjectId ? (
                <ArrangeToolbar
                  count={selectedObjectIds.length}
                  canGroup={selectedObjectIds.length >= 2}
                  canUngroup={activeObjects.some((o) => selectedObjectIds.includes(o.id) && o.group)}
                  onArrange={doArrange}
                  onDelete={deleteSelectedObjects}
                />
              ) : (
              <div
                className="toolbar-surface flex items-center gap-0.5 px-2 sm:px-3 h-auto min-h-10 py-1 flex-wrap"
                role="toolbar"
                aria-label="Slide formatting"
                aria-orientation="horizontal"
              >
                {/* Undo / Redo */}
                <Tooltip label="Undo (⌘Z)">
                  <IconButton size="sm"
                    onClick={() => fmtEditor.chain().focus().undo().run()}
                    disabled={!fmtEditor.can().undo()}
                    aria-label="Undo">
                    <Undo size={14} />
                  </IconButton>
                </Tooltip>
                <Tooltip label="Redo (⌘⇧Z)">
                  <IconButton size="sm"
                    onClick={() => fmtEditor.chain().focus().redo().run()}
                    disabled={!fmtEditor.can().redo()}
                    aria-label="Redo">
                    <Redo size={14} />
                  </IconButton>
                </Tooltip>
                <span className="toolbar-divider" />

                {/* Heading style selector */}
                <Menu
                  width="w-28"
                  trigger={
                    <button
                      type="button"
                      className="toolbar-btn flex items-center gap-1 px-2 min-w-0 sm:min-w-[56px] text-xs"
                      aria-label="Heading style"
                    >
                      <TypeIcon size={12} aria-hidden="true" />
                      {SLIDE_HEADINGS.find((h) =>
                        h.value === 0 ? !fmtEditor.isActive('heading') : fmtEditor.isActive('heading', { level: h.value })
                      )?.label || 'Normal'}
                      <ChevronDownIcon size={10} className="opacity-60" aria-hidden="true" />
                    </button>
                  }
                >
                  {SLIDE_HEADINGS.map(({ label, value }) => (
                    <Menu.Item
                      key={value}
                      active={value === 0 ? !fmtEditor.isActive('heading') : fmtEditor.isActive('heading', { level: value })}
                      onClick={() => {
                        if (value === 0) fmtEditor.chain().focus().setParagraph().run()
                        else fmtEditor.chain().focus().toggleHeading({ level: value }).run()
                      }}
                    >
                      {label}
                    </Menu.Item>
                  ))}
                </Menu>

                {/* Font family */}
                <SlideFontFamilySelector editor={fmtEditor} />

                {/* Font size */}
                <Menu
                  width="w-24"
                  trigger={
                    <button
                      type="button"
                      className="toolbar-btn flex items-center gap-1 px-1 w-12 text-xs"
                      aria-label="Font size"
                    >
                      <span className="flex-1 text-center tabular-nums">
                        {(() => {
                          const fs = fmtEditor.getAttributes('textStyle').fontSize
                          return fs ? parseInt(fs) : '—'
                        })()}
                      </span>
                      <ChevronDownIcon size={10} aria-hidden="true" />
                    </button>
                  }
                >
                  {SLIDE_FONT_SIZES.map((sz) => (
                    <Menu.Item
                      key={sz}
                      onClick={() => fmtEditor.chain().focus().setMark('textStyle', { fontSize: `${sz}pt` }).run()}
                    >
                      {sz}
                    </Menu.Item>
                  ))}
                </Menu>

                <span className="toolbar-divider" />
                <Tooltip label="Bold (⌘B)">
                  <IconButton size="sm" active={fmtEditor.isActive('bold')}
                    onClick={() => fmtEditor.chain().focus().toggleBold().run()} aria-label="Bold">
                    <Bold size={14} />
                  </IconButton>
                </Tooltip>
                <Tooltip label="Italic (⌘I)">
                  <IconButton size="sm" active={fmtEditor.isActive('italic')}
                    onClick={() => fmtEditor.chain().focus().toggleItalic().run()} aria-label="Italic">
                    <Italic size={14} />
                  </IconButton>
                </Tooltip>
                <Tooltip label="Underline (⌘U)">
                  <IconButton size="sm" active={fmtEditor.isActive('underline')}
                    onClick={() => fmtEditor.chain().focus().toggleUnderline().run()} aria-label="Underline">
                    <UnderlineIcon size={14} />
                  </IconButton>
                </Tooltip>
                <Tooltip label="Strikethrough">
                  <IconButton size="sm" active={fmtEditor.isActive('strike')}
                    onClick={() => fmtEditor.chain().focus().toggleStrike().run()} aria-label="Strikethrough">
                    <Strikethrough size={14} />
                  </IconButton>
                </Tooltip>
                <SlideLinkButton editor={fmtEditor} />
                {/* Text color */}
                <label
                  className="toolbar-btn relative cursor-pointer flex items-center gap-1"
                  title="Text color"
                  aria-label="Text color"
                >
                  <Palette size={14} aria-hidden="true" />
                  <input
                    type="color"
                    className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
                    value={fmtEditor.getAttributes('textStyle').color || '#000000'}
                    onChange={(e) => fmtEditor.chain().focus().setColor(e.target.value).run()}
                    aria-label="Choose text color"
                  />
                </label>
                {/* Highlight */}
                <label
                  className={[
                    'toolbar-btn relative cursor-pointer flex items-center',
                    fmtEditor.isActive('highlight') ? 'text-accent' : '',
                  ].join(' ')}
                  title="Highlight"
                  aria-label="Highlight color"
                >
                  <Highlighter size={14} aria-hidden="true" />
                  <input
                    type="color"
                    className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
                    value={fmtEditor.getAttributes('highlight').color || '#fef08a'}
                    onChange={(e) => fmtEditor.chain().focus().toggleHighlight({ color: e.target.value }).run()}
                    aria-label="Choose highlight color"
                  />
                </label>
                <span className="toolbar-divider" />
                <Tooltip label="Align left">
                  <IconButton size="sm" active={fmtEditor.isActive({ textAlign: 'left' })}
                    onClick={() => fmtEditor.chain().focus().setTextAlign('left').run()} aria-label="Align left">
                    <AlignLeft size={14} />
                  </IconButton>
                </Tooltip>
                <Tooltip label="Align center">
                  <IconButton size="sm" active={fmtEditor.isActive({ textAlign: 'center' })}
                    onClick={() => fmtEditor.chain().focus().setTextAlign('center').run()} aria-label="Align center">
                    <AlignCenter size={14} />
                  </IconButton>
                </Tooltip>
                <Tooltip label="Align right">
                  <IconButton size="sm" active={fmtEditor.isActive({ textAlign: 'right' })}
                    onClick={() => fmtEditor.chain().focus().setTextAlign('right').run()} aria-label="Align right">
                    <AlignRight size={14} />
                  </IconButton>
                </Tooltip>
                <span className="toolbar-divider" />
                <Tooltip label="Bullet list">
                  <IconButton size="sm" active={fmtEditor.isActive('bulletList')}
                    onClick={() => fmtEditor.chain().focus().toggleBulletList().run()} aria-label="Bullet list">
                    <List size={14} />
                  </IconButton>
                </Tooltip>
                <Tooltip label="Numbered list">
                  <IconButton size="sm" active={fmtEditor.isActive('orderedList')}
                    onClick={() => fmtEditor.chain().focus().toggleOrderedList().run()} aria-label="Numbered list">
                    <ListOrdered size={14} />
                  </IconButton>
                </Tooltip>
                <Tooltip label="Clear formatting">
                  <IconButton size="sm"
                    onClick={() => fmtEditor.chain().focus().unsetAllMarks().clearNodes().run()}
                    aria-label="Clear formatting">
                    <RemoveFormatting size={14} />
                  </IconButton>
                </Tooltip>
                <span className="toolbar-divider" />
                {/* Insert objects onto the canvas */}
                <Tooltip label="Insert text box">
                  <IconButton size="sm" onClick={insertTextObject} aria-label="Insert text box">
                    <TypeIcon size={14} />
                  </IconButton>
                </Tooltip>
                <ObjectInsertMenu
                  onImage={() => imgInput.current?.click()}
                  onShape={insertShapeObject}
                />
                <input
                  ref={imgInput}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={async (e) => {
                    const f = e.target.files?.[0]; if (!f) return
                    try {
                      const { url } = await api.uploadImage(f)
                      insertImageObject(url)
                    } catch {
                      const reader = new FileReader()
                      reader.onload = (ev) => { if (ev.target?.result) insertImageObject(String(ev.target.result)) }
                      reader.readAsDataURL(f)
                    }
                    e.target.value = ''
                  }}
                />
                <span className="toolbar-divider" />
                {/* P1: preview animations in the editor */}
                <Tooltip label="Play animations">
                  <IconButton
                    size="sm"
                    active={animPlaying}
                    disabled={!(activeSlide.animations && activeSlide.animations.length)}
                    onClick={playAnimations}
                    aria-label="Play animations"
                  >
                    <Play size={14} />
                  </IconButton>
                </Tooltip>
                <span className="toolbar-divider" />
                {/* Slide background */}
                <label
                  className="toolbar-btn flex items-center gap-1.5 cursor-pointer text-xs px-2"
                  title="Slide background"
                >
                  <span className="text-2xs font-semibold tracking-eyebrow uppercase text-ink-faint">BG</span>
                  <span
                    aria-hidden="true"
                    className="inline-block w-4 h-4 rounded-xs border border-line"
                    style={{ background: activeSlide.background || 'var(--paper)' }}
                  />
                  <input
                    type="color"
                    className="sr-only"
                    value={activeSlide.background || '#1a1a2e'}
                    onChange={(e) => updateSlideField(activeIdx, 'background', e.target.value)}
                    aria-label="Slide background colour"
                  />
                </label>
              </div>
              )}

              {/* Slide canvas — free-positioning object stage (P2). */}
              <div className="slide-stage flex-1 overflow-auto px-3 sm:px-6 py-4 sm:py-10 bg-bg">
                <div ref={canvasStageRef} className="mx-auto animate-scale-in" style={{ maxWidth: '900px' }}>
                  <SlideCanvas
                    objects={activeObjects}
                    background={activeSlide.background}
                    selectedIds={selectedObjectIds}
                    onSelect={setSelectedObjectIds}
                    onChange={(next, opts) => updateObjects(next, opts)}
                    onEditText={(id) => { setEditingObjectId(id); setSelectedObjectIds([id]) }}
                    editable
                    overlay={editingObject && (
                      <ObjectTextEditor
                        key={editingObject.id}
                        obj={editingObject}
                        onEditorReady={setObjectEditor}
                        onCommit={commitObjectText}
                        onClose={() => { setEditingObjectId(null); setObjectEditor(null) }}
                      />
                    )}
                  />
                </div>
                {/* Hidden flow editor: keeps TipTap mounted (undo history + the
                    fallback formatting target when no object is being edited). */}
                <div className="sr-only" aria-hidden="true">
                  <EditorContent editor={editor} className="tiptap" />
                </div>
              </div>

              {/* Speaker notes — resizable */}
              <div
                className="bg-warning-bg border-t border-line flex-shrink-0 flex flex-col"
                style={{ height: notesHeight }}
              >
                {/* Resize handle */}
                <div
                  ref={notesResizeRef}
                  onMouseDown={(e) => { e.preventDefault(); isResizingNotes.current = true }}
                  className="h-1 cursor-row-resize bg-transparent hover:bg-warning/30 transition-colors flex-shrink-0"
                  title="Drag to resize notes panel"
                />
                <div className="flex items-center justify-between px-3 sm:px-6 py-1 flex-shrink-0">
                  <label
                    htmlFor="slide-speaker-notes"
                    className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-eyebrow text-warning"
                  >
                    <StickyNote size={11} />
                    Speaker notes
                  </label>
                  <button
                    type="button"
                    onClick={handlePrintNotes}
                    className="text-2xs text-ink-faint hover:text-ink transition-colors"
                    title="Print notes"
                  >
                    Print notes PDF
                  </button>
                </div>
                <textarea
                  id="slide-speaker-notes"
                  value={activeSlide.notes}
                  onChange={(e) => updateSlideField(activeIdx, 'notes', e.target.value)}
                  className={[
                    'flex-1 w-full text-sm bg-transparent border-none outline-none resize-none px-6',
                    'text-ink-muted placeholder:text-ink-faint',
                  ].join(' ')}
                  placeholder="Notes for the presenter…"
                />
              </div>
            </div>
          )}

          {/* Comments panel */}
          {showComments && (
            <CommentsPanel
              fileId={id}
              anchorCtx={activeSlide ? { type: 'slide', slide_id: activeSlide.id, snapshot: activeSlide.title || `Slide ${activeIdx + 1}` } : null}
              onClose={() => setShowComments(false)}
            />
          )}
        </div>
      )}

      {/* ── Modals ──────────────────────────────────────────────────────── */}
      {showThemeGallery && (
        <ThemeGallery
          currentThemeId={slidesData.themeId || 'obsidian'}
          customTheme={slidesData.customTheme}
          onApply={applyTheme}
          onClose={() => setShowThemeGallery(false)}
        />
      )}
      {showMasterEditor && (
        <MasterSlideEditor
          masters={slidesData.masters}
          onSave={saveMasters}
          onClose={() => setShowMasterEditor(false)}
        />
      )}
      {showTemplateGallery && (
        <TemplateGallery
          onApply={(tplData) => {
            setSlidesData((prev) => ({ ...prev, ...tplData }))
            schedule({ ...slidesData, ...tplData })
            setActiveIdx(0)
          }}
          onClose={() => setShowTemplateGallery(false)}
        />
      )}

      {/* Account-based sharing (named users, role-scoped, ACL-enforced) */}
      <AccountShareModal
        open={showShare}
        onClose={() => setShowShare(false)}
        file={{ id, name: title }}
        me={myAccountId}
      />
    </div>
  )
}
