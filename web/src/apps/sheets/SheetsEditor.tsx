import { useEffect, useRef, useState, useCallback, useMemo, lazy, Suspense, type ChangeEvent, type ComponentPropsWithRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Workbook } from '@fortune-sheet/react'
import type { WorkbookInstance } from '@fortune-sheet/react/dist/components/Workbook'
import type { Sheet as FSSheet, Selection as FSSelection } from '@fortune-sheet/core'
import '@fortune-sheet/react/dist/index.css'
import {
  ArrowLeft, Save, Loader2, Download, Upload, AlertCircle, MessageSquare,
  ChevronDown, BarChart2, Filter, Table2, Tag, Sliders, Keyboard, Search,
  Lock, MessageSquarePlus, X, MoreHorizontal, ListChecks, Share2, Shield,
} from 'lucide-react'
import { useFilesStore, getSaveState, onSaveStateChange, type DiwanFile } from '../../store/filesStore'
import { api } from '../../lib/api'
import { readDraft, clearDraft, type Draft } from '../../lib/draftStore'
import { exportSheetsToXlsx, exportSheetsToCsv, exportSheetsToOds, exportNeedsConfirm, type ExportSheet } from './sheetsExport'
import { importCSVFile } from './csvImport'
import { importWorkbook } from './sheetsImport'
// importNotes: what an import could NOT bring in (foreign pivot tables, charts our
// model can't express). Kept on the workbook so the export dialog can warn before
// the user writes a file back over the original that still has them.
import {
  makeImportNotes, combineImportNotes, getImportNotes, setImportNotes,
  mergeImportNotes, importLossSummary, type ImportNotes, type INSheet,
} from './importNotes.js'
import {
  clampProtectedRanges, getProtectedRanges, mergeProtectedRanges, type PRSheet,
} from './protectedRanges.js'
import {
  GridSession, getGridReplicaId,
  type GridSessionOptions, type ChartDescriptor as CrdtChartDescriptor,
  type GridRemoteOpDetail,
} from '../../lib/crdt/grid.js'
import { GRID_ENGINE_MISMATCH_NOTICE } from '../../lib/crdt/gridEngine.js'
import { OpLogSync } from '../../lib/collab/opLogSync.js'
import { updateLogEnabled, substrateSyncEnabled } from '../../lib/flags.js'
import CommentsPanel from '../../components/CommentsPanel'
import { useLiveCursors, type FabricLike } from '../../lib/collab/webrtc/useLiveCursors.js'
import { usePresence, type PresenceFabric } from '../../lib/collab/webrtc/presence.js'
import { SheetsCursorLayer } from '../../components/RemoteCursors.jsx'
import PresenceBar from '../../components/PresenceBar.jsx'
import ConnectionPill from '../../components/ConnectionPill.jsx'
import { useCollabFabric } from '../../lib/collab/useCollabFabric.js'
import { getCollabIdentity, identityColor, deriveStatusPill, countLivePeers } from '../../lib/collab/presenceCommon.js'
import { Button, IconButton, Tooltip, Topbar, Menu, useToast, useDialogA11y, SaveStatus } from '../../components/ui'
import AccountShareModal from '../../components/AccountShareModal.jsx'
import { useAuthStore } from '../../store/authStore'
import { useSheetKeyboardShortcuts, KeyboardShortcutsHelp, useShortcutsHelp, type KSSheet } from './KeyboardShortcuts.jsx'
import SheetsFindReplace from './SheetsFindReplace.jsx'
import NumberFormatMenu from './NumberFormatMenu.jsx'
// makeChart is a tiny pure validator/clamp — imported eagerly so the CRDT
// ingress path can sanitise a peer-supplied chart descriptor fail-closed
// (WAVE-55: a hostile peer must not be able to inject a non-string title or
// non-finite geometry that would crash/escape the renderer).
import { makeChart, chartsBySheetId, mergeCharts, clampCharts, type Chart, type ChartSheet } from './charts.js'
// WAVE-63: register the high-value formulas Fortune-Sheet lacks (XLOOKUP,
// TEXTJOIN, IFS, SWITCH, LET, XMATCH, FILTER/SORT/UNIQUE) into the shared
// formula-parser Parser prototype so they evaluate live + recalc on dependency
// change, exactly like a native function. Idempotent + install-guarded; done at
// module load (before any Workbook mounts its parser). Pure data transforms —
// no eval/DOM/fetch (see formulaFunctions.js SECURITY note).
import { Parser as FormulaParser } from '@fortune-sheet/formula-parser'
import { installCustomFormulas, type FormulaParserClass } from './formulaFunctions.js'
installCustomFormulas(FormulaParser as unknown as FormulaParserClass)
// WAVE-63: reactive pivots — makePivot is the fail-closed ingress clamp for a
// peer-supplied pivot descriptor (allow-listed agg, coerced/capped strings,
// normalised range) exactly like makeChart. clampPivots re-clamps on load.
import { makePivot, getPivots, clampPivots, pivotsBySheetId, mergePivots, type Pivot, type PivotSheet } from './pivot.js'
// WAVE-63: CF color scales + data bars — makeColorScale is the fail-closed
// ingress clamp (allow-listed kind, hex-validated colours) for a peer-supplied
// rule; clampColorScales re-clamps on load; merge preserves the overlay.
import {
  makeColorScale, clampColorScales, colorScalesBySheetId, mergeColorScales, buildNativeConditionFormat,
  type ColorScaleRule, type CSSheet, type NativeConditionFormat,
} from './colorScales.js'
// WAVE-64: data-validation rules (sheet.dataVerification) get the same treatment
// — clampDataValidation rebuilds every stored regulation through the fail-closed
// builder on load, so an unknown type / junk condition / unbounded hint from a
// corrupt or hostile file is dropped before Fortune-Sheet's validator sees it.
import { clampDataValidation, type DVSheet } from './dataValidation.js'
import { parseRange as parseRangeFS } from './ConditionalFormatPanel.jsx'

// Side panels — lazily loaded so they don't bloat the initial bundle.
const PivotPanel              = lazy(() => import('./PivotPanel.jsx'))
const FilterPanel             = lazy(() => import('./FilterPanel.jsx'))
const ConditionalFormatPanel  = lazy(() => import('./ConditionalFormatPanel.jsx'))
const ChartWizard             = lazy(() => import('./ChartWizard.jsx'))
const ChartLayer              = lazy(() => import('./ChartLayer.jsx'))
const PivotLayer              = lazy(() => import('./PivotLayer.jsx'))
const ColorScaleLayer         = lazy(() => import('./ColorScaleLayer.jsx'))
const NamedRangesPanel        = lazy(() => import('./NamedRangesPanel.jsx'))
const ProtectedRangesPanel    = lazy(() => import('./ProtectedRangesPanel.jsx'))
const DataValidationPanel     = lazy(() => import('./DataValidationPanel.jsx'))
const ExportDialog            = lazy(() => import('./ExportDialog.jsx'))

const RETRY_DELAY_MS  = 4000
const AUTOSAVE_DELAY_MS = 3000

/**
 * Sheet — the on-disk / in-memory workbook sheet shape SheetsEditor works with.
 * Every overlay module (charts.ts, pivot.ts, colorScales.ts, dataValidation.ts,
 * protectedRanges.ts, importNotes.ts) declares its OWN narrower view behind a
 * `[key: string]: unknown` catch-all; this is the union of all of them. Handing
 * `Sheet[]` to one of those modules' functions, or taking their narrower return
 * type back, crosses a structural-typing boundary an index signature's `unknown`
 * can't bridge on its own — `cast<T>()` below is the local, explicit adapter
 * (same pattern as sheetsImport.ts's INSheet/ImportSheet boundary).
 */
export interface Sheet {
  id?: string
  name?: string
  celldata?: SheetCellEntry[]
  config?: Record<string, unknown>
  order?: number
  status?: number
  row?: number
  column?: number
  luckysheet_select_save?: unknown[]
  luckysheet_conditionformat_save?: NativeConditionFormat[]
  charts?: Chart[]
  pivots?: Pivot[]
  colorScales?: ColorScaleRule[]
  dataVerification?: Record<string, unknown>
  namedRanges?: unknown[]
  protectedRanges?: unknown[]
  importNotes?: ImportNotes
  [key: string]: unknown
}

export interface SheetCellValue {
  v?: string | number | boolean | undefined
  m?: string | number
  f?: string
  ct?: { fa?: string; t?: string }
  ps?: { value: string; isShow: boolean }
  [key: string]: unknown
}
export interface SheetCellEntry {
  r: number
  c: number
  v?: SheetCellValue | string | number | boolean | null
}

/** Local, explicit cast between this file's `Sheet` and a narrower overlay-module
 * view of the same runtime object — see the `Sheet` doc comment above. */
function cast<T>(v: unknown): T { return v as T }

/** Mirrors the shared <SaveStatus> component's own kind list (components/ui/SaveStatus.tsx),
 * which omits filesStore's 'idle' — see the cast site below for why that's safe. */
type UISaveStatusKind = 'saved' | 'saving' | 'dirty' | 'error' | 'offline'

type AnyGridSession = GridSession

interface ActiveCell { row: number; col: number }
interface SelectionRect { r0: number; r1: number; c0: number; c1: number }

/**
 * normalizeSheets — give every sheet the dimensions/identity fields Fortune
 * Sheet needs. Without explicit `row`/`column` (and `id`/`order`/`status`) the
 * library computes its default selection against undefined bounds, which is why
 * the name box rendered "A1:NaN" on a fresh/empty sheet. Providing them yields a
 * valid A1 selection and a stable grid.
 */
function normalizeSheets(sheets: unknown): Sheet[] {
  // `sheets` is untrusted, freshly-loaded document content — Array.isArray
  // narrows it to `any[]`, not `Sheet[]`, so the per-element cast below is
  // where the boundary is actually crossed (same pattern as the file's own
  // `cast<T>()` helper above).
  const arr: unknown[] = Array.isArray(sheets) && sheets.length
    ? sheets
    : [{ name: 'Sheet1', celldata: [], config: {} }]
  return arr.map((raw, i) => {
    const sh = raw as Sheet
    return {
    ...sh,
    name: sh.name || `Sheet${i + 1}`,
    celldata: sh.celldata || [],
    config: sh.config || {},
    id: sh.id || `sheet_${i + 1}`,
    order: typeof sh.order === 'number' ? sh.order : i,
    status: typeof sh.status === 'number' ? sh.status : (i === 0 ? 1 : 0),
    row: sh.row || 100,
    column: sh.column || 26,
    // A well-formed A1 selection. FortuneSheet builds the name-box label from
    // the last saved selection, and its label builder does
    // `columnChar(column[1]) + (row[1] + 1)` with no guard — so a selection that
    // lacks its END indices renders the literal "A1:NaN" in the name box (the
    // string users have been seeing on every sheet). Both ends, explicitly.
    luckysheet_select_save: Array.isArray(sh.luckysheet_select_save) && sh.luckysheet_select_save.length
      ? sh.luckysheet_select_save
      : [{ row: [0, 0], column: [0, 0], row_focus: 0, column_focus: 0 }],
    }
  })
}

// loadContent — the single UNTRUSTED-ORIGIN normalise+clamp used by every load
// path (initial state, api.getFile, XLSX import, draft restore). Runs charts AND
// pivots through their fail-closed clamps so a corrupt/legacy/poisoned record
// can never reach render with an unsafe descriptor (WAVE-61/63 defence-in-depth).
function loadContent(content: unknown): Sheet[] {
  const normalized = normalizeSheets(content)
  const charts = clampCharts(cast<ChartSheet[]>(normalized))
  const pivots = clampPivots(cast<PivotSheet[]>(charts))
  const scales = clampColorScales(cast<CSSheet[]>(pivots))
  const validated = clampDataValidation(cast<DVSheet[]>(scales))
  const protectedR = clampProtectedRanges(cast<PRSheet[]>(validated))
  return cast<Sheet[]>(protectedR)
}

// Shared trigger styling for the Import / Export menus.
const MENU_TRIGGER_CN = [
  'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md',
  'bg-paper border border-line text-xs font-medium tracking-tightish',
  'text-ink-muted hover:border-line-strong hover:text-ink',
  'transition-colors duration-fast ease-out',
  'focus-visible:outline-none focus-visible:shadow-focus',
].join(' ')

// ── FreezePanel ─────────────────────────────────────────────────────────────
function FreezePanel({ workbookRef }: { workbookRef: React.RefObject<WorkbookInstance | null> }) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'rows' | 'cols' | null>(null)
  const [count, setCount] = useState(1)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); setMode(null) }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const freeze = (type: 'row' | 'column' | 'both', row: number, column: number) => {
    workbookRef.current?.freeze(type, { row, column })
    setOpen(false)
    setMode(null)
  }

  return (
    <div ref={panelRef} className="relative">
      <Tooltip label="Freeze rows / columns">
        <IconButton size="sm" active={open} onClick={() => { setOpen((v) => !v); setMode(null) }}>
          <Lock size={14} />
        </IconButton>
      </Tooltip>
      {open && (
        <div
          role="menu"
          className={[
            'absolute left-0 top-full mt-0.5 w-52 py-1',
            'bg-paper border border-line rounded-md shadow-e2 z-40 text-sm',
            'animate-scale-in',
          ].join(' ')}
        >
          {mode === null ? (
            <>
              <button
                role="menuitem"
                onClick={() => freeze('row', 1, 0)}
                className="w-full text-left px-3 py-2 hover:bg-accent-tint text-ink-muted"
              >
                Freeze top row
              </button>
              <button
                role="menuitem"
                onClick={() => freeze('column', 0, 1)}
                className="w-full text-left px-3 py-2 hover:bg-accent-tint text-ink-muted"
              >
                Freeze first column
              </button>
              <hr className="border-line my-1" />
              <button
                role="menuitem"
                onClick={() => { setMode('rows'); setCount(2) }}
                className="w-full text-left px-3 py-2 hover:bg-accent-tint text-ink-muted"
              >
                Freeze rows…
              </button>
              <button
                role="menuitem"
                onClick={() => { setMode('cols'); setCount(2) }}
                className="w-full text-left px-3 py-2 hover:bg-accent-tint text-ink-muted"
              >
                Freeze columns…
              </button>
              <hr className="border-line my-1" />
              <button
                role="menuitem"
                onClick={() => freeze('both', 0, 0)}
                className="w-full text-left px-3 py-2 hover:bg-accent-tint text-ink-muted"
              >
                Unfreeze
              </button>
            </>
          ) : (
            <div className="px-3 py-2 flex flex-col gap-2">
              <label className="text-2xs font-semibold uppercase tracking-eyebrow text-ink-faint">
                {mode === 'rows' ? 'Rows to freeze' : 'Columns to freeze'}
              </label>
              <input
                type="number"
                min={1}
                max={50}
                value={count}
                onChange={(e) => setCount(Math.max(1, parseInt(e.target.value) || 1))}
                className={[
                  'w-full h-7 px-2 text-sm rounded-sm',
                  'bg-paper border border-line focus:border-line-strong',
                  'focus-visible:outline-none focus-visible:shadow-focus',
                ].join(' ')}
                autoFocus
              />
              <div className="flex gap-1.5">
                <button
                  onClick={() => freeze(mode === 'rows' ? 'row' : 'column', mode === 'rows' ? count : 0, mode === 'cols' ? count : 0)}
                  className="flex-1 h-7 rounded-sm bg-accent text-white text-xs font-medium hover:bg-accent-hover transition-colors focus-visible:outline-none focus-visible:shadow-focus"
                >
                  Apply
                </button>
                <button
                  onClick={() => setMode(null)}
                  className="h-7 px-2 rounded-sm border border-line text-xs text-ink-muted hover:border-line-strong transition-colors"
                >
                  Back
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── CellCommentPanel ─────────────────────────────────────────────────────────
interface CellCommentPanelProps {
  data: Sheet[]
  activeCell: ActiveCell
  onChange: (updater: (prev: Sheet[]) => Sheet[]) => void
  onClose: () => void
}
function CellCommentPanel({ data, activeCell, onChange, onClose }: CellCommentPanelProps) {
  const sheet = data?.[0]
  const existing = sheet?.celldata?.find(
    (c) => c.r === activeCell.row && c.c === activeCell.col
  )
  const existingV = existing?.v
  const currentComment = (typeof existingV === 'object' && existingV?.ps?.value) || ''
  const [text, setText] = useState(currentComment)

  // Reset when active cell changes
  useEffect(() => {
    const cell = data?.[0]?.celldata?.find(
      (c) => c.r === activeCell.row && c.c === activeCell.col
    )
    const v = cell?.v
    setText((typeof v === 'object' && v?.ps?.value) || '')
  }, [activeCell.row, activeCell.col]) // eslint-disable-line

  const handleSave = () => {
    onChange((prev) => {
      const sheets = prev.map((sh, idx) => {
        if (idx !== 0) return sh
        const celldata = [...(sh.celldata || [])]
        const cellIdx = celldata.findIndex((c) => c.r === activeCell.row && c.c === activeCell.col)
        if (cellIdx >= 0) {
          const cell = { ...celldata[cellIdx] }
          const v: SheetCellValue = typeof cell.v === 'object' && cell.v !== null
            ? { ...cell.v }
            : { v: cell.v ?? undefined, m: String(cell.v ?? '') }
          if (text.trim()) {
            v.ps = { value: text.trim(), isShow: false }
          } else {
            delete v.ps
          }
          celldata[cellIdx] = { ...cell, v }
        } else if (text.trim()) {
          celldata.push({
            r: activeCell.row,
            c: activeCell.col,
            v: { v: '', m: '', ct: { fa: 'General', t: 'n' }, ps: { value: text.trim(), isShow: false } },
          })
        }
        return { ...sh, celldata }
      })
      return sheets
    })
    onClose()
  }

  const cellLabel = `${String.fromCharCode(65 + activeCell.col)}${activeCell.row + 1}`
  const panelRef = useRef<HTMLDivElement>(null)
  // Trap focus, close on Esc, restore focus to the triggering control on close.
  useDialogA11y(panelRef, onClose)

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Comment on cell ${cellLabel}`}
      className={[
        'absolute right-4 left-4 sm:left-auto top-4 z-40 w-auto sm:w-72 bg-paper border border-line rounded-lg shadow-e3',
        'flex flex-col animate-scale-in',
      ].join(' ')}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-line">
        <span className="text-xs font-semibold text-ink">
          Comment · <span className="text-ink-faint font-mono">{cellLabel}</span>
        </span>
        <button
          onClick={onClose}
          className="text-ink-faint hover:text-ink transition-colors rounded-sm focus-visible:outline-none focus-visible:shadow-focus"
          aria-label="Close comment panel"
        >
          <X size={13} />
        </button>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Add a comment…"
        rows={4}
        className={[
          'flex-1 w-full p-3 text-sm bg-transparent border-none outline-none resize-none',
          'text-ink placeholder:text-ink-faint',
        ].join(' ')}
      />
      <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-line">
        {currentComment && (
          <button
            onClick={() => { setText(''); handleSave() }}
            className="text-xs text-danger hover:underline rounded-sm focus-visible:outline-none focus-visible:shadow-focus"
          >
            Delete
          </button>
        )}
        <button
          onClick={onClose}
          className="h-7 px-3 rounded-sm border border-line text-xs text-ink-muted hover:border-line-strong transition-colors focus-visible:outline-none focus-visible:shadow-focus"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          className="h-7 px-3 rounded-sm bg-accent text-white text-xs font-medium hover:bg-accent-hover transition-colors focus-visible:outline-none focus-visible:shadow-focus"
        >
          Save
        </button>
      </div>
    </div>
  )
}

interface HandleChangeOpts {
  chartsAuthoritative?: boolean
  overlaysAuthoritative?: boolean
}

export default function SheetsEditor() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { files, saveFileWithDraft, markDirty } = useFilesStore()
  const [file, setFile] = useState<DiwanFile | undefined>(files.find((f) => f.id === id))
  const [title, setTitle] = useState(file?.name || 'Untitled Sheet')
  // Account-based sharing (named users, role-scoped, ACL-enforced).
  const [showShare, setShowShare] = useState(false)
  const myAccountId = useAuthStore((s) => s.accountId)
  // clampCharts re-clamps any persisted chart geometry through makeChart so a
  // corrupt/legacy local descriptor can never reach render with NaN layout
  // (WAVE-61 defence-in-depth; the wave-55 peer-ingress clamp is separate).
  const [data, setData] = useState<Sheet[]>(() => loadContent(file?.content))
  const [saveStatus, setSaveStatus] = useState(getSaveState(id ?? ''))
  const [draft, setDraft] = useState<Draft | null>(null)
  const [retryCount, setRetryCount] = useState(0)
  const { showToast, toast } = useToast()

  // FortuneSheet's <Workbook> is UNCONTROLLED: it reads `data` once, at mount,
  // and ignores every later change to the prop. Cell edits are fine (they
  // originate inside the grid), but replacing the WHOLE document from outside it
  // — the deep-link/refresh fetch below, and restoring a local draft — silently
  // never reached the grid: the workbook had already mounted on the empty
  // fallback sheet, so opening a bookmarked spreadsheet or simply reloading the
  // page showed an empty grid, as though the data were gone.
  //
  // loadDocument is the single seam for those wholesale loads: it swaps the data
  // AND bumps loadKey, which is part of the Workbook's React key, forcing a
  // remount on the new document. It must NOT be used for cell edits — remounting
  // on every keystroke would throw away the grid's own state.
  const [loadKey, setLoadKey] = useState(0)
  const loadDocument = useCallback((next: Sheet[]) => {
    setData(next)
    setLoadKey((k) => k + 1)
  }, [])

  // Panel visibility state
  const [showComments,      setShowComments]      = useState(false)
  const [showPivot,         setShowPivot]         = useState(false)
  const [showFilter,        setShowFilter]        = useState(false)
  const [showCondFormat,    setShowCondFormat]    = useState(false)
  const [showNamedRanges,   setShowNamedRanges]   = useState(false)
  const [showProtectedRanges, setShowProtectedRanges] = useState(false)
  const [showChartWizard,   setShowChartWizard]   = useState(false)
  const [editingChartId,    setEditingChartId]    = useState<string | null>(null)   // WAVE-54: chart being edited (null = insert)
  const [selectedChartId,   setSelectedChartId]   = useState<string | null>(null)   // WAVE-54: floating chart selection
  const [showFindReplace,   setShowFindReplace]   = useState(false)
  const [showDataValidation, setShowDataValidation] = useState(false)
  const [editingPivotId,    setEditingPivotId]    = useState<string | null>(null)   // WAVE-63: pivot being edited (null = insert)
  const [exportFormat,      setExportFormat]      = useState<string | null>(null)   // WAVE-64: format awaiting export confirmation

  const [activeCell,      setActiveCell]      = useState<ActiveCell>({ row: 0, col: 0 })
  const [selectionRect,   setSelectionRect]   = useState<SelectionRect | null>(null) // {r0,r1,c0,c1} 0-indexed inclusive
  const [showCellComment, setShowCellComment] = useState(false)

  const saveTimer   = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const retryTimer  = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const titleRef    = useRef(title)
  titleRef.current  = title
  const dataRef     = useRef(data)
  dataRef.current   = data
  const gridSessionRef  = useRef<AnyGridSession | null>(null)
  const workbookWrapRef = useRef<HTMLDivElement>(null)
  const workbookRef     = useRef<WorkbookInstance | null>(null)
  const importInputRef  = useRef<HTMLInputElement>(null)

  // ── Collaboration presence (WAVE-27) ────────────────────────────────────────
  // Stable per-tab replica id doubles as the fabric peerId, so the CRDT sync and
  // the presence/cursor transport share one identity.
  const replicaIdRef = useRef<string | null>(null)
  if (!replicaIdRef.current) replicaIdRef.current = getGridReplicaId()
  const replicaId = replicaIdRef.current

  // Owns + joins the same relay-client FabricClient Docs uses; degrades to
  // local-only (fabric stays null-ish, offline pill) when no peering backend.
  const { fabric, peers: collabPeers, joined, configured } =
    useCollabFabric({ sessionId: id ?? '', peerId: replicaId })

  // True once the grid session has proved a peer runs a different CRDT engine
  // and has therefore STOPPED replicating (lib/crdt/gridEngine.js). Latched for
  // the life of the session, like the guard itself: a mismatched peer leaving
  // does not make the two documents agree again.
  const [engineMismatch, setEngineMismatch] = useState(false)

  // Stable local identity (signed-in account or per-tab guest) + its colour.
  const identityRef = useRef<ReturnType<typeof getCollabIdentity> | null>(null)
  if (!identityRef.current) identityRef.current = getCollabIdentity(replicaId)
  const localIdentity = identityRef.current

  // ── Keyboard shortcuts ──────────────────────────────────────────────────────
  const { show: showShortcutsHelp, openHelp, closeHelp } = useShortcutsHelp()
  useSheetKeyboardShortcuts({
    containerRef: workbookWrapRef,
    data: cast<KSSheet[]>(data),
    onChange:    (next) => setData(cast<Sheet[]>(next)),
    onShowHelp:  openHelp,
  })

  // Ctrl+F / Ctrl+H: open find/replace overlay for sheets
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault()
        setShowFindReplace((v) => !v)
      }
      if (e.key === 'h' || e.key === 'H') {
        e.preventDefault()
        setShowFindReplace(true)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // ── CRDT collaboration (OFFICE-23) ──────────────────────────────────────────
  // WAVE-27: pass the live fabric (when available) so grid ops sync over the
  // same transport that carries presence. When `fabric` is null (no peering
  // backend) this is exactly the previous local-only path.
  useEffect(() => {
    if (!id) return
    let cancelled = false
    let session: AnyGridSession | null = null
    let opLog: OpLogSync | null = null
    // A new session means a new handshake; clear any latch from the old one.
    setEngineMismatch(false)

    // Open a grid session and wire everything that hangs off it. Called once,
    // either synchronously (the default grid.js path) or after the substrate
    // engine's WASM has loaded — hence the `cancelled` guard: the effect can be
    // torn down while that load is still in flight.
    const open = (s: AnyGridSession, onRemote: (ev: Event) => void) => {
      if (cancelled) { s.destroy(); return }
      session = s
      gridSessionRef.current = s

      // ENGINE-ADVERTISEMENT HANDSHAKE (lib/crdt/gridEngine.js). The session
      // refuses to keep replicating the moment it can prove a peer folds ops
      // with a DIFFERENT merge function — because the two grid engines share
      // wire types but not op payloads, so a mixed room exchanges nothing while
      // the presence pill still says "Live". Surface it: flip the pill to a
      // danger "Not syncing", show the notice, and stop mirroring into the
      // durable update log so the two op families never interleave there.
      const onEngineMismatch = () => {
        setEngineMismatch(true)
        if (opLog) { opLog.stop().catch(() => {}); opLog = null }
      }
      s.addEventListener('engineMismatch', onEngineMismatch)

      s.requestSnapshot()

      // CRDT-native persistence (phase 2): when the server exposes the per-file
      // update log AND the client flag is on, mirror grid cell ops into that
      // durable append-only log IN ADDITION to the whole-doc autosave. Applied log
      // ops re-enter through the SAME 'remoteOp' path as fabric ops (onRemote), so
      // hydrated/converged cells render exactly like a peer edit. Self-disables on
      // 404, so this never changes behaviour on a deployment without the flag.
      //
      // Both session classes implement the SAME four-callback adapter, so the
      // persistence layer is identical on either path — the point of keeping the
      // storage seam untouched by the substrate adoption.
      if (updateLogEnabled()) {
        opLog = new OpLogSync({
          fileId: id,
          subscribeLocal: (cb) => {
            const h = (e: Event) => cb((e as CustomEvent<GridRemoteOpDetail>).detail.op)
            s.addEventListener('localOp', h)
            return () => s.removeEventListener('localOp', h)
          },
          applyOp: (op) => s.applyLogOp(op),
          applySnapshot: (snap) => s.applyLogSnapshot(snap),
          encodeSnapshot: () => s.logSnapshotData(),
        })
        opLog.hydrate().then((ok) => { if (ok) opLog?.start() }).catch(() => {})
      }

      // Read the latch directly, AFTER the op log exists, in case the session
      // already latched before we could subscribe. It cannot today — the session
      // defers the event by a microtask precisely so a caller can subscribe
      // first — but the correctness of this screen should not rest on that
      // staying true, and the handler is idempotent.
      if (s.engineMismatch) onEngineMismatch()

      s.addEventListener('remoteOp', onRemote)
    }

    const onRemote = (ev: Event) => {
      // WAVE-54: a chart op carries a chart payload; merge it into sheet.charts
      // (LWW-by-id: last upsert wins, delete removes). Cell ops fall through.
      const detail = (ev as CustomEvent<GridRemoteOpDetail>)?.detail
      if (detail && (detail.chart || detail.chartId)) {
        // WAVE-55 SECURITY: the descriptor arrives from an untrusted peer over
        // the CRDT fabric. NEVER merge it raw — run it through makeChart so the
        // type is allow-listed, geometry is finite/clamped, and title/labels are
        // coerced to plain strings. A hostile peer therefore cannot inject a
        // non-string title (→ "Objects are not valid as a React child" crash),
        // non-finite x/y/w/h (→ NaN layout / render escape), or an absurd size
        // (→ DoS). Fail-closed: a chart with no usable string id is dropped.
        const safeChart = detail.chart ? makeChart(detail.chart) : null
        if (detail.chart && (typeof detail.chart.id !== 'string' || !detail.chart.id)) {
          // No stable id ⇒ cannot LWW-merge deterministically; ignore.
          return
        }
        setData((prev) => (prev || []).map((sheet, idx) => {
          if (idx !== 0) return sheet
          const charts = Array.isArray(sheet.charts) ? sheet.charts : []
          if (detail.action === 'delete') {
            return { ...sheet, charts: charts.filter((c) => c.id !== detail.chartId) }
          }
          if (safeChart) {
            const exists = charts.some((c) => c.id === safeChart.id)
            const next = exists
              ? charts.map((c) => (c.id === safeChart.id ? safeChart : c))
              : [...charts, safeChart]
            return { ...sheet, charts: next }
          }
          return sheet
        }))
        markDirty(id)
        return
      }
      // WAVE-63: a pivot op carries a pivot descriptor; merge into sheet.pivots
      // (LWW-by-id). SAME WAVE-55 posture as charts: the descriptor arrives from
      // an UNTRUSTED peer, so NEVER merge it raw — run it through makePivot so the
      // aggregation is allow-listed, strings are coerced/capped, and the range is
      // normalised (blocks a non-string field → React-child crash, and a
      // pathological range that computePivot would otherwise iterate → DoS).
      // Fail-closed: a pivot with no usable string id is dropped.
      if (detail && (detail.pivot || detail.pivotId)) {
        const safePivot = detail.pivot ? makePivot(detail.pivot) : null
        if (detail.pivot && (typeof detail.pivot.id !== 'string' || !detail.pivot.id)) {
          return // no stable id ⇒ cannot LWW-merge deterministically
        }
        setData((prev) => (prev || []).map((sheet, idx) => {
          if (idx !== 0) return sheet
          const pivots = Array.isArray(sheet.pivots) ? sheet.pivots : []
          if (detail.pivotAction === 'delete') {
            return { ...sheet, pivots: pivots.filter((p) => p.id !== detail.pivotId) }
          }
          if (safePivot) {
            const exists = pivots.some((p) => p.id === safePivot.id)
            const next = exists
              ? pivots.map((p) => (p.id === safePivot.id ? safePivot : p))
              : [...pivots, safePivot]
            return { ...sheet, pivots: next }
          }
          return sheet
        }))
        markDirty(id)
        return
      }
      // WAVE-63: a cs_op carries a colour-scale/data-bar rule; merge into
      // sheet.colorScales (LWW-by-id). SAME WAVE-55 posture: run the untrusted
      // peer rule through makeColorScale (allow-listed kind, hex-validated
      // colours) so a hostile rule can't inject a url()/expression() colour or a
      // non-string field. Fail-closed: a rule with no usable string id is dropped.
      if (detail && (detail.colorScale || detail.colorScaleId)) {
        const safeRule = detail.colorScale ? makeColorScale(detail.colorScale) : null
        if (detail.colorScale && (typeof detail.colorScale.id !== 'string' || !detail.colorScale.id)) {
          return
        }
        setData((prev) => (prev || []).map((sheet, idx) => {
          if (idx !== 0) return sheet
          const rules = Array.isArray(sheet.colorScales) ? sheet.colorScales : []
          if (detail.colorScaleAction === 'delete') {
            return { ...sheet, colorScales: rules.filter((r) => r.id !== detail.colorScaleId) }
          }
          if (safeRule) {
            const exists = rules.some((r) => r.id === safeRule.id)
            const next = exists
              ? rules.map((r) => (r.id === safeRule.id ? safeRule : r))
              : [...rules, safeRule]
            return { ...sheet, colorScales: next }
          }
          return sheet
        }))
        markDirty(id)
        return
      }
      const crdtCells = session ? session.cells() : []
      if (crdtCells.length === 0) return
      setData((prev) => {
        const sheets = prev.map((sheet, idx) => {
          if (idx !== 0) return sheet
          const existing = new Map((sheet.celldata || []).map((c) => [`${c.r}_${c.c}`, c]))
          for (const { r, c, v } of crdtCells) {
            const key = `${r}_${c}`
            const ex = existing.get(key)
            const exVal = ex ? (typeof ex.v === 'object' && ex.v !== null ? ex.v?.v : ex.v) : undefined
            if (!ex || exVal !== v) {
              existing.set(key, { r, c, v: { v, m: v, ct: { fa: 'General', t: 'n' } } })
            }
          }
          return { ...sheet, celldata: [...existing.values()] }
        })
        return sheets
      })
      markDirty(id)
    }

    const opts: GridSessionOptions = { sessionId: id, replicaId, fabricClient: fabric || null }
    if (substrateSyncEnabled()) {
      // The SHARED KOTVA Sync engine (src/lib/crdt/substrateGrid.js) — the
      // default. It is WASM, so it must finish loading before a session exists:
      // the grid renders from a live CRDT and cannot be handed a half-initialised
      // one. Imported dynamically so a flag-OFF build pays nothing.
      //
      // ── IF THE LOAD FAILS ────────────────────────────────────────────────
      //
      // This used to fall straight back to the hand-rolled grid.js engine. That
      // was wrong whenever the session could REPLICATE, and quietly so. The two
      // engines are each internally convergent but they do not share a total
      // order: grid.js resolves a conflicting write by (lamport, replicaId) and
      // ignores wall-clock time, while the substrate resolves by a full HLC. Two
      // peers on different engines can therefore pick DIFFERENT winners for the
      // same pair of concurrent writes — permanent divergence, with both users
      // seeing a plausible spreadsheet and no error anywhere.
      //
      // So the fallback is now conditional on there being nothing to diverge
      // FROM: with no fabric attached and no update log, this client is the only
      // writer and the engine choice cannot be observed by anyone. Then grid.js is
      // strictly better than no session at all.
      //
      // Otherwise we FAIL CLOSED: no session, so no ops in and no ops out. The
      // editor still opens, still edits, and still autosaves the whole document
      // (every session call site is guarded) — the user loses live collaboration,
      // which is visible, instead of silently diverging, which is not.
      const canReplicate = !!fabric || updateLogEnabled()
      import('../../lib/crdt/substrateGrid.js')
        .then(async (m) => {
          await m.initSubstrateSync()
          if (!cancelled) open(new m.SubstrateGridSession(opts) as unknown as AnyGridSession, onRemote)
        })
        .catch((err) => {
          if (cancelled) return
          if (canReplicate) {
            console.error(
              '[sheets] the shared KOTVA Sync engine failed to load and this session can ' +
              'replicate, so falling back to the local engine would risk diverging from ' +
              'peers that loaded it. Staying local-only for this session (edits still save). ' +
              'Cause:', err instanceof Error ? err.message : err,
            )
            return
          }
          console.warn(
            '[sheets] the shared KOTVA Sync engine failed to load; nothing can replicate ' +
            'in this session (no peers, no update log), so using the local engine. Cause:',
            err instanceof Error ? err.message : err,
          )
          open(new GridSession(opts), onRemote)
        })
    } else {
      open(new GridSession(opts), onRemote)
    }

    return () => {
      cancelled = true
      if (opLog) opLog.stop().catch(() => {})
      if (session) {
        session.removeEventListener('remoteOp', onRemote)
        session.destroy()
      }
      gridSessionRef.current = null
    }
  }, [id, fabric]) // recreate session when the fabric attaches

  useEffect(() => {
    if (!id) return
    const unsub = onSaveStateChange(id, (state) => setSaveStatus({ ...state }))
    return unsub
  }, [id])

  useEffect(() => {
    if (!file && id) {
      api.getFile(id).then((f) => {
        const df = f as DiwanFile
        setFile(df)
        setTitle(df.name)
        loadDocument(loadContent(df.content))
      }).catch(() => {
        showToast('Could not open this spreadsheet.', 'error')
        // BrowserRouter (declarative) mode, per main.tsx — navigate() is
        // always synchronous void here, never returns a Promise. void just
        // makes that explicit against NavigateFunction's wider (data-router)
        // type.
        void navigate('/sheets')
      })
    }
  }, [id])

  useEffect(() => {
    if (!id) return
    // readDraft catches its own IndexedDB failures internally (see
    // draftStore.ts) and resolves null rather than rejecting.
    void readDraft(id).then((d) => { if (d && d.ts) setDraft(d) })
  }, [id])

  // ── Live cursors + presence roster (OFFICE-25 / WAVE-27) ────────────────────
  // FabricClient (lib/collab/webrtc/fabric.ts) extends EventTarget and so
  // types addEventListener with the generic DOM signature, which does not
  // structurally satisfy the narrower per-event-name overloads FabricLike /
  // PresenceFabric declare — a pre-existing type-only mismatch between those
  // independently-typed modules (not a runtime one: FabricClient's listeners
  // are called with the same CustomEvent shape at runtime either way).
  const { remoteCursors, broadcastSheetCursor } = useLiveCursors({
    fabric: fabric as unknown as FabricLike | null, localIdentity, color: identityColor(localIdentity),
  })
  const { roster } = usePresence({ fabric: fabric as unknown as PresenceFabric | null, localIdentity })

  // Status pill: Live / Connecting / Reconnecting / Offline from fabric state.
  const collabPill = deriveStatusPill({ configured, joined, peers: collabPeers, engineMismatch })
  const livePeerCount = countLivePeers(collabPeers)

  const getCellRect = useCallback((row: number, col: number) => {
    const container = workbookWrapRef.current
    if (!container) return null
    try {
      const tbody = container.querySelector('.luckysheet-cell-main tbody')
      if (!tbody) return null
      const tr = tbody.querySelectorAll('tr')[row]
      if (!tr) return null
      const td = tr.querySelectorAll('td')[col + 1]
      if (!td) return null
      const containerRect = container.getBoundingClientRect()
      const tdRect = td.getBoundingClientRect()
      return {
        top:    tdRect.top    - containerRect.top,
        left:   tdRect.left   - containerRect.left,
        width:  tdRect.width,
        height: tdRect.height,
      }
    } catch { return null }
  }, [])

  // WAVE-63: a monotonic tick that bumps whenever the grid scrolls or the window
  // resizes, so the DOM-measured overlays (color scales / data bars) re-measure
  // their cell rects and stay aligned. Throttled to animation frames.
  const [scrollTick, setScrollTick] = useState(0)
  useEffect(() => {
    const container = workbookWrapRef.current
    if (!container) return
    let raf = 0
    const bump = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => setScrollTick((t) => t + 1)) }
    // Scroll events inside the grid bubble to the container (capture=true).
    container.addEventListener('scroll', bump, true)
    window.addEventListener('resize', bump)
    return () => {
      cancelAnimationFrame(raf)
      container.removeEventListener('scroll', bump, true)
      window.removeEventListener('resize', bump)
    }
  }, [])

  // ── Save / autosave ─────────────────────────────────────────────────────────
  const doSave = useCallback(async (contentOverride?: Sheet[], retryNum = 0) => {
    if (!id) return
    const content = contentOverride !== undefined ? contentOverride : dataRef.current
    try {
      await saveFileWithDraft(id, titleRef.current, content)
      setRetryCount(0)
    } catch (err: unknown) {
      // A 403 is the SERVER refusing an edit to a PROTECTED RANGE (or a role that
      // may not write). Retrying cannot succeed and would silently spin, so we
      // surface the server's own message and stop — the write is genuinely denied.
      const e = err as { status?: number; error?: string; message?: string } | null
      if (e?.status === 403) {
        setRetryCount(0)
        showToast(e?.error || e?.message || 'This range is protected — your change was not saved.', 'error')
        return
      }
      if (retryNum < 3) {
        const delay = RETRY_DELAY_MS * (retryNum + 1)
        retryTimer.current = setTimeout(() => {
          setRetryCount(retryNum + 1)
          // doSave catches its own errors (see its try/catch below) and never
          // rejects — this is its own retry loop re-entering itself.
          void doSave(undefined, retryNum + 1)
        }, delay)
      }
    }
  }, [id, saveFileWithDraft, showToast])

  const handleChange = useCallback((newDataRaw: unknown, opts: HandleChangeOpts = {}) => {
    // WAVE-63: the Workbook is fed `renderData`, which injects derived
    // __fromColorScale band rules into luckysheet_conditionformat_save for the
    // canvas to paint. Those are RENDER-ONLY — strip them here so they never
    // enter the authoritative model / save payload (else they'd accumulate and
    // round-trip). The user's own CF rules (no marker) are kept.
    // `unknown` already subsumes `Sheet[]` here — this stays genuinely unknown
    // until the Array.isArray narrow below, then gets an explicit per-branch cast.
    let newData: unknown = newDataRaw
    if (Array.isArray(newData)) {
      newData = (newData as Sheet[]).map((sheet) => {
        const cf = sheet?.luckysheet_conditionformat_save
        if (!Array.isArray(cf) || !cf.some((r) => r?.__fromColorScale)) return sheet
        return { ...sheet, luckysheet_conditionformat_save: cf.filter((r) => !r?.__fromColorScale) }
      })
    }
    // WAVE-61 DATA-LOSS FIX ─────────────────────────────────────────────────
    // FortuneSheet's <Workbook onChange> re-emits its INTERNAL, normalised
    // `luckysheetfile` array (see @fortune-sheet/react → onChange(context
    // .luckysheetfile)). That normalised object DROPS the app-owned `sheet
    // .charts` overlay field. So a bare `setData(newData)` clobbered every
    // locally-inserted chart on grid init and on every cell edit — the only
    // path that re-added a chart was a remote-peer chart_op, which never fires
    // solo (0 [data-chart-id] cards, 0 charts in the save PUT).
    //
    // The charts array is the app's LOCALLY-AUTHORITATIVE source of truth, so
    // we merge it back onto the normalised payload here (unless this update
    // already carries authoritative charts, e.g. a chart insert/edit — flagged
    // via opts.chartsAuthoritative). Functional setData so we always merge
    // against the CURRENT charts, never a stale closure. This makes charts
    // survive grid init, cell edits, and round-trips.
    // WAVE-63: pivots are a second app-owned overlay (sheet.pivots) that
    // FortuneSheet's onChange also drops — merge them back the same way charts
    // are, so a plain cell edit never clobbers a live pivot. An authoritative
    // overlay update (chart OR pivot insert/edit) already carries its own array.
    setData((prev) => {
      if (!Array.isArray(newData)) return newData as Sheet[]
      if (opts.overlaysAuthoritative) return newData as Sheet[]
      const withCharts = opts.chartsAuthoritative
        ? cast<ChartSheet[]>(newData)
        : mergeCharts(cast<ChartSheet[]>(newData), chartsBySheetId(cast<ChartSheet[]>(prev)))
      const withPivots = mergePivots(cast<PivotSheet[]>(withCharts), pivotsBySheetId(cast<PivotSheet[]>(prev)))
      const withScales = mergeColorScales(cast<CSSheet[]>(withPivots), colorScalesBySheetId(cast<CSSheet[]>(prev)))
      // importNotes is a fourth app-owned overlay FortuneSheet's onChange drops.
      // Without this merge it would evaporate on the first keystroke — i.e. on
      // exactly the import → EDIT → export path it exists to warn about.
      const withNotes = mergeImportNotes(cast<INSheet[]>(withScales), getImportNotes(cast<INSheet[]>(prev)))
      // protectedRanges is a fifth app-owned overlay onChange drops — re-attach it
      // so a plain cell edit never silently clears a range's protection (which the
      // server would then no longer see either).
      return cast<Sheet[]>(mergeProtectedRanges(cast<PRSheet[]>(withNotes), getProtectedRanges(cast<PRSheet[]>(prev))))
    })
    markDirty(id ?? '')
    clearTimeout(saveTimer.current)
    clearTimeout(retryTimer.current)
    setRetryCount(0)
    if (Array.isArray(newData) && (newData as Sheet[])[0]?.celldata?.length) {
      const cells = (newData as Sheet[])[0].celldata as SheetCellEntry[]
      const last = cells[cells.length - 1]
      if (last) broadcastSheetCursor(last.r, last.c)
    }
    // CRDT ops
    const session = gridSessionRef.current
    if (session && Array.isArray(newData) && (newData as Sheet[])[0]?.celldata) {
      for (const cell of (newData as Sheet[])[0].celldata as SheetCellEntry[]) {
        const row = cell.r
        const col = cell.c
        const val = typeof cell.v === 'object' && cell.v !== null
          ? (cell.v?.v ?? cell.v?.m ?? '')
          : (cell.v ?? '')
        const existing = session.cells().find((c) => c.r === row && c.c === col)
        if (!existing || existing.v !== String(val)) {
          if (val === '' || val === null || val === undefined) {
            session.clearCell(row, col)
          } else {
            session.setCell(row, col, String(val))
          }
        }
      }
      session.saveLocal()
    }
    // Persist the MERGED content (charts + pivots included). newData from a
    // plain grid edit lacks both overlays; merge them in for the save PUT too so
    // they reload with the sheet. An authoritative update already carries them.
    let toSave: unknown = newData
    if (Array.isArray(newData) && !opts.overlaysAuthoritative) {
      toSave = opts.chartsAuthoritative
        ? newData
        : mergeCharts(cast<ChartSheet[]>(newData), chartsBySheetId(cast<ChartSheet[]>(dataRef.current)))
      toSave = mergePivots(cast<PivotSheet[]>(toSave), pivotsBySheetId(cast<PivotSheet[]>(dataRef.current)))
      toSave = mergeColorScales(cast<CSSheet[]>(toSave), colorScalesBySheetId(cast<CSSheet[]>(dataRef.current)))
      toSave = mergeImportNotes(cast<INSheet[]>(toSave), getImportNotes(cast<INSheet[]>(dataRef.current)))
      toSave = mergeProtectedRanges(cast<PRSheet[]>(toSave), getProtectedRanges(cast<PRSheet[]>(dataRef.current)))
    }
    // doSave catches its own errors internally and never rejects.
    saveTimer.current = setTimeout(() => { void doSave(cast<Sheet[]>(toSave)) }, AUTOSAVE_DELAY_MS)
  }, [id, markDirty, broadcastSheetCursor, doSave])

  const handleSave = () => {
    clearTimeout(saveTimer.current)
    clearTimeout(retryTimer.current)
    setRetryCount(0)
    void doSave(dataRef.current)
  }

  // ── Export (WAVE-64) ──────────────────────────────────────────────────────
  // Charts/pivots do not survive every format identically, and losing them
  // SILENTLY is a data-loss bug. So an export that would lose or degrade content
  // goes through ExportDialog first (it names exactly what is at stake and can be
  // cancelled); a plain workbook downloads immediately, with no extra click.
  const runExport = useCallback(async (fmt: string) => {
    setExportFormat(null)
    try {
      if (fmt === 'xlsx') {
        const { skipped } = await exportSheetsToXlsx(cast<ExportSheet[]>(data), title)
        // The writer is the authority on what actually made it into the file: if
        // it had to skip a chart the dialog didn't predict, say so now.
        if (skipped?.length) {
          showToast(`Exported. ${skipped.length} chart${skipped.length === 1 ? '' : 's'} could not be embedded and ` +
            'ride only in the “Vulos Charts” sheet.', 'error')
        }
      } else if (fmt === 'ods') {
        exportSheetsToOds(cast<ExportSheet[]>(data), title)
      } else if (fmt === 'csv') {
        exportSheetsToCsv(cast<ExportSheet[]>(data), title)
      } else if (fmt === 'xlsx-server') {
        // Server-rendered download (last saved version; cells only — see
        // exportFidelity('xlsx-server'), which warns before we get here).
        const a = document.createElement('a')
        a.href = `/api/sheets/${id}/export?format=xlsx`
        a.download = ''
        document.body.appendChild(a)
        a.click()
        a.remove()
      }
    } catch (e: unknown) {
      showToast(`Export failed: ${e instanceof Error ? e.message : 'unknown error'}`, 'error')
    }
  }, [data, title, id, showToast])

  const requestExport = useCallback((fmt: string) => {
    if (exportNeedsConfirm(cast<ExportSheet[]>(data), fmt)) setExportFormat(fmt)
    else void runExport(fmt) // runExport catches its own errors (toast on failure)
  }, [data, runExport])

  // ── Charts (WAVE-54) ──────────────────────────────────────────────────────
  // A chart edit already produced the new workbook data (charts.js op). We save
  // it via the normal path AND broadcast a chart_op so live collaborators merge
  // the same descriptor without waiting for a full re-save round-trip. We diff
  // the charts array to know which chart to upsert/remove on the fabric.
  const handleChartChange = useCallback((nextData: Sheet[]) => {
    const prevCharts = Array.isArray(dataRef.current?.[0]?.charts) ? dataRef.current[0].charts : []
    const nextCharts = Array.isArray(nextData?.[0]?.charts) ? nextData[0].charts : []
    // chartsAuthoritative: nextData already holds the definitive charts array
    // (an insert/edit/move/delete from the wizard or ChartLayer) — do NOT let
    // handleChange's merge re-attach the PREVIOUS charts over this one.
    handleChange(nextData, { chartsAuthoritative: true })
    const session = gridSessionRef.current
    if (session) {
      const prevIds = new Set(prevCharts.map((c) => c.id))
      const nextIds = new Set(nextCharts.map((c) => c.id))
      for (const c of nextCharts) {
        const before = prevCharts.find((p) => p.id === c.id)
        if (!before || JSON.stringify(before) !== JSON.stringify(c)) session.upsertChart(c as unknown as CrdtChartDescriptor)
      }
      for (const cid of prevIds) if (!nextIds.has(cid)) session.removeChart(cid)
    }
  }, [handleChange])

  const handleEditChart = useCallback((chartId: string) => {
    setEditingChartId(chartId)
    setShowChartWizard(true)
  }, [])

  // ── Pivots (WAVE-63) ──────────────────────────────────────────────────────
  // A pivot insert/edit/delete already produced the new workbook data (pivot.js
  // op over the FULL data, so charts are preserved). Save it via the normal path
  // AND broadcast a pivot_op so live collaborators merge the same descriptor. We
  // diff the pivots array to know which pivot to upsert/remove on the fabric.
  const handlePivotChange = useCallback((nextData: Sheet[]) => {
    const prevPivots = Array.isArray(dataRef.current?.[0]?.pivots) ? dataRef.current[0].pivots : []
    const nextPivots = Array.isArray(nextData?.[0]?.pivots) ? nextData[0].pivots : []
    // overlaysAuthoritative: nextData was derived from the full current data via
    // a pivot.js op, so it already carries the definitive charts AND pivots — do
    // NOT let handleChange re-merge stale overlays over it.
    handleChange(nextData, { overlaysAuthoritative: true })
    const session = gridSessionRef.current
    if (session) {
      const prevIds = new Set(prevPivots.map((p) => p.id))
      const nextIds = new Set(nextPivots.map((p) => p.id))
      for (const p of nextPivots) {
        const before = prevPivots.find((x) => x.id === p.id)
        if (!before || JSON.stringify(before) !== JSON.stringify(p)) session.upsertPivot(p as unknown as CrdtChartDescriptor)
      }
      for (const pid of prevIds) if (!nextIds.has(pid)) session.removePivot(pid)
    }
  }, [handleChange])

  const handleEditPivot = useCallback((pivotId: string) => {
    setEditingPivotId(pivotId)
    setShowPivot(true)
  }, [])

  // ── CF color scales / data bars (WAVE-63) ─────────────────────────────────
  // The CF panel produces the new workbook data (colorScales.js op over the FULL
  // data, charts/pivots preserved). Save it authoritatively (do NOT let the
  // merge resurrect a just-deleted rule) AND broadcast cs_ops so collaborators
  // converge. We diff the rules to know which to upsert/remove on the fabric.
  const handleColorScaleChange = useCallback((nextData: Sheet[]) => {
    const prevRules = Array.isArray(dataRef.current?.[0]?.colorScales) ? dataRef.current[0].colorScales : []
    const nextRules = Array.isArray(nextData?.[0]?.colorScales) ? nextData[0].colorScales : []
    handleChange(nextData, { overlaysAuthoritative: true })
    const session = gridSessionRef.current
    if (session) {
      const prevIds = new Set(prevRules.map((r) => r.id))
      const nextIds = new Set(nextRules.map((r) => r.id))
      for (const r of nextRules) {
        const before = prevRules.find((x) => x.id === r.id)
        if (!before || JSON.stringify(before) !== JSON.stringify(r)) session.upsertColorScale(r as unknown as CrdtChartDescriptor)
      }
      for (const rid of prevIds) if (!nextIds.has(rid)) session.removeColorScale(rid)
    }
  }, [handleChange])

  const handleTitleChange = (newTitle: string) => {
    setTitle(newTitle)
    markDirty(id ?? '')
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => { void doSave(dataRef.current) }, 1500)
  }

  // WAVE-62 SECURITY: a draft is client-side persisted content (IndexedDB) and
  // is an UNTRUSTED-ORIGIN load path exactly like the server file — a poisoned
  // draft (prior XSS, corrupted/legacy record, another tab) could hold a chart
  // descriptor with a non-string title (→ "Objects are not valid as a React
  // child" crash) or non-finite geometry (→ NaN SVG layout). Every other load
  // path (initial useState, api.getFile, XLSX import) runs clampCharts →
  // makeChart; the restore path must too, or it reopens the wave-55 render-DoS
  // through the load door. Normalise + clamp fail-closed before it reaches data.
  const handleRestoreDraft  = () => { if (!draft) return; loadDocument(loadContent(draft.content)); if (draft.name) setTitle(draft.name); setDraft(null); markDirty(id ?? '') }
  const handleDiscardDraft  = () => { if (id) void clearDraft(id); setDraft(null) } // clearDraft catches its own errors (draftStore.ts)

  // ── Import CSV ──────────────────────────────────────────────────────────────
  const handleImportCSV = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const sheet = await importCSVFile(file)
      // Append as a new sheet.
      setData((prev) => {
        const next = [...prev, cast<Sheet>(sheet)]
        markDirty(id ?? '')
        clearTimeout(saveTimer.current)
        saveTimer.current = setTimeout(() => { void doSave(next) }, AUTOSAVE_DELAY_MS)
        return next
      })
      showToast(`Imported “${file.name}”`, 'success')
    } catch (err) {
      console.error('CSV import failed:', err)
      showToast('Could not import CSV — check the file and try again.', 'error')
    }
    e.target.value = ''
  }

  // ── Import XLSX / XLS / ODS (client-side, bounded) ─────────────────────────
  // Parsed via the shared bounded importer (importWorkbook → workbookToSheets):
  // size cap + cell/sheet caps + zip-bomb bounds (via SheetJS's own hardened
  // parser), preserving values, formulas (as inert data), number formats, merges,
  // and column widths — plus the real OOXML charts SheetJS cannot see.
  // Imported sheets are APPENDED (never destroy the open workbook); a name clash
  // is de-duplicated so Fortune-Sheet keeps distinct sheet ids.
  const handleImportXLSX = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const buf = await file.arrayBuffer()
      // importWorkbook also reads the real OOXML charts SheetJS cannot see, and
      // reports what it could not bring in (see sheetsImport.importWorkbook).
      const { sheets: imported, notes } = await importWorkbook(buf, file.name)

      // A chart belongs to the FIRST sheet and reads its cells (charts.js
      // getCharts). Sheets imported HERE are appended after the open workbook's
      // own, so a chart that came with them has no sheet it can legally attach to
      // — and silently carrying it as dead data (invisible, and dropped again on
      // export) is exactly the failure this whole change is about. So we say it:
      // the charts did not come in, and opening the file on its own is how to
      // keep them.
      const orphaned = (imported[0]?.charts || []).map((c) => ({
        title: c.title,
        reason: 'a chart must sit on the first sheet — open this file on its own (Open, from the file list) to keep its charts',
      }))
      const lost = combineImportNotes(notes, makeImportNotes({ charts: orphaned, filename: file.name }))

      setData((prev) => {
        const used = new Set(prev.map((s) => s.name))
        const appended = cast<Sheet[]>(imported).map((s) => {
          let name = s.name || 'Sheet'
          let n = 1
          while (used.has(name)) name = `${s.name} (${++n})`
          used.add(name)
          // Strip the overlays that are only meaningful on sheet 0 — they would be
          // invisible here and would quietly vanish on the next save.
          const { charts: _c, importNotes: _n, ...sheet } = s
          return { ...sheet, name }
        })
        let next: Sheet[] = [...prev, ...appended]
        const merged = combineImportNotes(getImportNotes(cast<INSheet[]>(prev)), lost)
        if (merged) next = cast<Sheet[]>(setImportNotes(cast<INSheet[]>(next), merged))
        markDirty(id ?? '')
        clearTimeout(saveTimer.current)
        saveTimer.current = setTimeout(() => { void doSave(next) }, AUTOSAVE_DELAY_MS)
        return next
      })
      const summary = importLossSummary(lost)
      if (summary) showToast(`Imported “${file.name}” — ${summary}`, 'info')
      else showToast(`Imported “${file.name}”`, 'success')
    } catch (err: unknown) {
      console.error('Spreadsheet import failed:', err)
      const msg = err instanceof Error ? err.message : String(err)
      showToast(`Could not import “${file.name}” — ${msg}`, 'error')
    }
    e.target.value = ''
  }

  // ── Filter view apply ───────────────────────────────────────────────────────
  const handleFilterApply = useCallback((hiddenRows: number[]) => {
    setData((prev) => prev.map((sheet, idx) => {
      if (idx !== 0) return sheet
      const rowhidden: Record<number, number> = {}
      for (const r of hiddenRows) rowhidden[r] = 1
      return { ...sheet, config: { ...sheet.config, rowhidden } }
    }))
  }, [])

  // ── Save status display ─── rendered via the shared <SaveStatus> below.
  const saveStatusText =
    saveStatus.status === 'error' && retryCount > 0 ? `Retrying ${retryCount}/3` : undefined

  // Only one side panel open at a time (except comments). Close the OTHER
  // panels — never the one being toggled: closing self inside this setter's own
  // functional update raced the `return !v` and left the panel stuck closed
  // after the Fortune-Sheet grid re-initialized (data-validation wouldn't open).
  // WAVE-63: render-time data for the Workbook. FortuneSheet renders on a CANVAS
  // (no DOM cells to overlay), and its native colorGradation/dataBar compute is
  // buggy — so we paint color scales / data bars by expanding each rule into
  // FortuneSheet-native `between` BAND rules (buildNativeConditionFormat) and
  // injecting them into luckysheet_conditionformat_save AT RENDER TIME ONLY. The
  // saved model (`data`) keeps just the clean colorScales + user rules; the
  // derived bands are marked __fromColorScale and are recomputed reactively from
  // the current cell values, so the gradient re-buckets live as data changes.
  const renderData = useMemo(() => {
    const scales = data?.[0]?.colorScales
    // Fast path: no colour scales ⇒ return `data` unchanged (zero cost on the
    // vast majority of workbooks that use no gradients/bars).
    if (!Array.isArray(scales) || scales.length === 0) return data
    // With rules, rebuild the derived bands. This must re-run whenever a source
    // cell in ANY rule's range changes (to re-bucket the gradient) — detecting
    // that requires a scan anyway, so we rebuild on any data-identity change.
    // Cost is O(scanned rule cells + NATIVE_BANDS×ruleCount) per edit, bounded
    // by buildNativeConditionFormat's own caps; negligible for typical use.
    return data.map((sheet, idx) => {
      if (idx !== 0) return sheet
      return { ...sheet, luckysheet_conditionformat_save: buildNativeConditionFormat(cast<CSSheet>(sheet), parseRangeFS) }
    })
  }, [data])

  const panelSetters = [setShowPivot, setShowFilter, setShowCondFormat, setShowNamedRanges, setShowProtectedRanges, setShowDataValidation]
  const togglePanel = (setter: (v: boolean | ((prev: boolean) => boolean)) => void) => () => {
    setter((v: boolean) => {
      if (!v) { for (const s of panelSetters) if (s !== setter) s(false) }
      return !v
    })
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-bg">
      {/* Hidden file inputs for import */}
      <input ref={importInputRef} type="file" className="hidden" accept=".csv,.tsv,.xlsx,.xls,.ods" onChange={(e) => {
        const name = (e.target.files?.[0]?.name || '').toLowerCase()
        // Both handlers catch their own errors internally (toast on failure).
        if (/\.(xlsx|xls|ods)$/.test(name)) void handleImportXLSX(e)
        else void handleImportCSV(e)
      }} />

      {/* Engine-mismatch banner. The connection pill alone is not enough here:
          the transport is HEALTHY, so everything else on screen looks normal
          while nothing is actually merging. role="alert" because this is the
          one collaboration state the user must act on (reload / get everyone
          onto the same build) rather than wait out. */}
      {engineMismatch && (
        <div
          role="alert"
          className="flex items-start gap-3 px-3 sm:px-4 py-2 bg-danger-bg border-b border-line text-xs text-danger animate-fade-in"
        >
          <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
          <span className="flex-1 text-ink-muted">{GRID_ENGINE_MISMATCH_NOTICE}</span>
        </div>
      )}

      {/* Draft-restore banner */}
      {draft && (
        <div className="flex items-center gap-3 px-3 sm:px-4 py-2 bg-warning-bg border-b border-line text-xs text-warning animate-fade-in">
          <AlertCircle size={14} className="flex-shrink-0" />
          <span className="flex-1 text-ink-muted">Unsaved changes from a previous session were found.</span>
          <Button variant="primary"   size="sm" onClick={handleRestoreDraft}>Restore</Button>
          <Button variant="secondary" size="sm" onClick={handleDiscardDraft}>Discard</Button>
        </div>
      )}

      {/* Top bar */}
      <Topbar
        leading={
          <Tooltip label="Back to Sheets">
            <IconButton size="sm" onClick={() => void navigate('/sheets')}><ArrowLeft size={15} /></IconButton>
          </Tooltip>
        }
        title={
          <input
            value={title}
            onChange={(e) => handleTitleChange(e.target.value)}
            placeholder="Untitled sheet"
            aria-label="Sheet title"
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
                // filesStore's SaveStatus union includes 'idle', which the shared
                // <SaveStatus> component doesn't list among its own kinds — it
                // already falls back to its 'saved' rendering for any status it
                // doesn't recognise (MAP[status] || MAP.saved), so this cast
                // preserves that exact pre-existing behavior across the boundary.
                status={saveStatus.status as UISaveStatusKind}
                text={saveStatusText}
                title={saveStatus.error || undefined}
              />
            )}
            {/* WAVE-27: collaboration presence — roster + connection pill */}
            <PresenceBar roster={roster} className="ml-1" />
            <ConnectionPill pill={collabPill} peerCount={livePeerCount} />
          </>
        }
        actions={
          <>
            {/* Share — account-based (named users) + P2P E2E link */}
            <Tooltip label="Share">
              <IconButton size="sm" active={showShare} onClick={() => setShowShare(true)}>
                <Share2 size={14} />
              </IconButton>
            </Tooltip>
            {/* Find/Replace stays primary (always visible) */}
            <Tooltip label="Find / Replace (Ctrl+F)">
              <IconButton size="sm" active={showFindReplace} onClick={() => setShowFindReplace((v) => !v)}>
                <Search size={14} />
              </IconButton>
            </Tooltip>

            {/* Secondary tools — inline on ≥lg, collapsed into "More" below lg */}
            <div
              className="hidden lg:flex items-center gap-1"
              role="toolbar"
              aria-label="Sheet tools"
              aria-orientation="horizontal"
            >
              <NumberFormatMenu
                selection={selectionRect}
                activeCell={activeCell}
                data={cast<import('./numberFormats.js').SheetData[]>(data)}
                onChange={(next) => handleChange(next)}
              />
              <FreezePanel workbookRef={workbookRef} />
              <Tooltip label="Data validation (Data → Data validation)">
                <IconButton size="sm" active={showDataValidation} onClick={togglePanel(setShowDataValidation)}>
                  <ListChecks size={14} />
                </IconButton>
              </Tooltip>
              <Tooltip label="Cell comment">
                <IconButton size="sm" active={showCellComment} onClick={() => setShowCellComment((v) => !v)}>
                  <MessageSquarePlus size={14} />
                </IconButton>
              </Tooltip>
              <Tooltip label="Pivot table (Insert → Pivot table)">
                <IconButton size="sm" active={showPivot} onClick={() => { setEditingPivotId(null); togglePanel(setShowPivot)() }}>
                  <Table2 size={14} />
                </IconButton>
              </Tooltip>
              <Tooltip label="Filter views (Data → Filter views)">
                <IconButton size="sm" active={showFilter} onClick={togglePanel(setShowFilter)}>
                  <Filter size={14} />
                </IconButton>
              </Tooltip>
              <Tooltip label="Conditional formatting (Format → Conditional formatting)">
                <IconButton size="sm" active={showCondFormat} onClick={togglePanel(setShowCondFormat)}>
                  <Sliders size={14} />
                </IconButton>
              </Tooltip>
              <Tooltip label="Named ranges (Data → Named ranges)">
                <IconButton size="sm" active={showNamedRanges} onClick={togglePanel(setShowNamedRanges)}>
                  <Tag size={14} />
                </IconButton>
              </Tooltip>
              <Tooltip label="Protected ranges (Data → Protect range)">
                <IconButton size="sm" active={showProtectedRanges} onClick={togglePanel(setShowProtectedRanges)}>
                  <Shield size={14} />
                </IconButton>
              </Tooltip>
              <Tooltip label="Insert chart">
                <IconButton size="sm" onClick={() => { setEditingChartId(null); setShowChartWizard(true) }}>
                  <BarChart2 size={14} />
                </IconButton>
              </Tooltip>
              <Tooltip label="Keyboard shortcuts (⌘/)">
                <IconButton size="sm" onClick={openHelp}>
                  <Keyboard size={14} />
                </IconButton>
              </Tooltip>
              <Tooltip label="Comments">
                <IconButton size="sm" active={showComments} onClick={() => setShowComments((v) => !v)}>
                  <MessageSquare size={14} />
                </IconButton>
              </Tooltip>
            </div>

            {/* Overflow "More" — below lg only */}
            <div className="lg:hidden">
              <Menu
                align="right"
                width="w-56"
                trigger={
                  <IconButton size="sm" title="More tools">
                    <MoreHorizontal size={16} />
                  </IconButton>
                }
              >
                <Menu.Item active={showDataValidation} onClick={togglePanel(setShowDataValidation)}>
                  <ListChecks size={14} /> Data validation
                </Menu.Item>
                <Menu.Item active={showCellComment} onClick={() => setShowCellComment((v) => !v)}>
                  <MessageSquarePlus size={14} /> Cell comment
                </Menu.Item>
                <Menu.Item active={showPivot} onClick={() => { setEditingPivotId(null); togglePanel(setShowPivot)() }}>
                  <Table2 size={14} /> Pivot table
                </Menu.Item>
                <Menu.Item active={showFilter} onClick={togglePanel(setShowFilter)}>
                  <Filter size={14} /> Filter views
                </Menu.Item>
                <Menu.Item active={showCondFormat} onClick={togglePanel(setShowCondFormat)}>
                  <Sliders size={14} /> Conditional formatting
                </Menu.Item>
                <Menu.Item active={showNamedRanges} onClick={togglePanel(setShowNamedRanges)}>
                  <Tag size={14} /> Named ranges
                </Menu.Item>
                <Menu.Item active={showProtectedRanges} onClick={togglePanel(setShowProtectedRanges)}>
                  <Shield size={14} /> Protected ranges
                </Menu.Item>
                <Menu.Item onClick={() => { setEditingChartId(null); setShowChartWizard(true) }}>
                  <BarChart2 size={14} /> Insert chart
                </Menu.Item>
                <Menu.Item onClick={openHelp}>
                  <Keyboard size={14} /> Keyboard shortcuts
                </Menu.Item>
                <Menu.Item active={showComments} onClick={() => setShowComments((v) => !v)}>
                  <MessageSquare size={14} /> Comments
                </Menu.Item>
              </Menu>
            </div>

            {/* Import menu */}
            <Menu
              align="right"
              trigger={
                <button type="button" className={MENU_TRIGGER_CN}>
                  <Upload size={12} /> Import
                  <ChevronDown size={11} className="opacity-60" />
                </button>
              }
            >
              <Menu.Item onClick={() => { if (importInputRef.current) { importInputRef.current.accept = '.csv'; importInputRef.current.click() } }}>
                <span className="text-2xs font-bold tracking-eyebrow text-ink-faint w-10">CSV</span>
                CSV file
              </Menu.Item>
              <Menu.Item onClick={() => { if (importInputRef.current) { importInputRef.current.accept = '.xlsx,.xls'; importInputRef.current.click() } }}>
                <span className="text-2xs font-bold tracking-eyebrow text-accent w-10">XLSX</span>
                Excel workbook
              </Menu.Item>
              <Menu.Item onClick={() => { if (importInputRef.current) { importInputRef.current.accept = '.ods'; importInputRef.current.click() } }}>
                <span className="text-2xs font-bold tracking-eyebrow text-success w-10">ODS</span>
                OpenDocument sheet
              </Menu.Item>
            </Menu>

            {/* Export menu */}
            <Menu
              align="right"
              trigger={
                <button type="button" className={MENU_TRIGGER_CN}>
                  <Download size={12} /> Export
                  <ChevronDown size={11} className="opacity-60" />
                </button>
              }
            >
              <Menu.Item onClick={() => requestExport('xlsx')}>
                <span className="text-2xs font-bold tracking-eyebrow text-accent w-10">XLSX</span>
                Excel workbook
              </Menu.Item>
              <Menu.Item onClick={() => requestExport('ods')}>
                <span className="text-2xs font-bold tracking-eyebrow text-success w-10">ODS</span>
                OpenDocument sheet
              </Menu.Item>
              <Menu.Item onClick={() => requestExport('csv')}>
                <span className="text-2xs font-bold tracking-eyebrow text-ink-faint w-10">CSV</span>
                Current sheet (CSV)
              </Menu.Item>
              {id && (
                <Menu.Item onClick={() => requestExport('xlsx-server')}>
                  <span className="text-2xs font-bold tracking-eyebrow text-accent w-10">SRV</span>
                  Server XLSX
                </Menu.Item>
              )}
            </Menu>

            <Button
              variant="primary"
              size="sm"
              onClick={handleSave}
              disabled={saveStatus.status === 'saving'}
            >
              {saveStatus.status === 'saving' ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              Save
            </Button>
          </>
        }
      />

      {/* Main content area: workbook + side panels */}
      <div className="flex-1 flex overflow-hidden bg-bg">
        <div
          className="flex-1 overflow-hidden relative bg-paper sheets-themed"
          ref={workbookWrapRef}
        >
          <Workbook
            // Remount on a wholesale document load (see loadDocument): the grid
            // is uncontrolled and would otherwise keep showing the sheet it
            // first mounted with.
            key={`${id}:${loadKey}`}
            // @fortune-sheet/react's own WorkbookInstance type re-evaluates its
            // getCellValue() options union slightly differently across two
            // structural positions under exactOptionalPropertyTypes (both sides
            // are the SAME library type; this is a library type-identity quirk,
            // not a real mismatch) — cast through unknown to the ref prop's own
            // type (as this JSX site itself derives it) rather than widen a
            // 3rd-party type we don't own.
            ref={workbookRef as unknown as ComponentPropsWithRef<typeof Workbook>['ref']}
            data={cast<FSSheet[]>(renderData)}
            onChange={handleChange}
            showFormulaBar={true}
            defaultFontSize={11}
            hooks={{
              afterSelectionChange: (_sheetId: string, selection: FSSelection) => {
                if (selection?.row_focus !== undefined && selection.column_focus !== undefined) {
                  setActiveCell({ row: selection.row_focus, col: selection.column_focus })
                }
                // Record the full selection rectangle so number-format /
                // validation can act on multi-cell ranges. Fortune Sheet gives
                // `row`/`column` as [start, end] pairs on the selection.
                if (Array.isArray(selection?.row) && Array.isArray(selection?.column)) {
                  setSelectionRect({
                    r0: selection.row[0], r1: selection.row[1],
                    c0: selection.column[0], c1: selection.column[1],
                  })
                }
              },
            }}
          />
          {/* WAVE-63: CF color scales + data bars are painted on the FS canvas
              via native band rules (see renderData / buildNativeConditionFormat).
              The DOM-overlay ColorScaleLayer is kept for environments/exports
              where cell rects ARE measurable (getCellRect resolves); on the
              canvas grid it self-disables (no rects) rather than mis-aligning. */}
          <Suspense fallback={null}>
            <ColorScaleLayer data={cast<CSSheet[]>(data)} getCellRect={getCellRect} scrollTick={scrollTick} />
          </Suspense>
          <SheetsCursorLayer remoteCursors={remoteCursors} getCellRect={getCellRect} />
          {/* WAVE-54: floating live charts over the grid */}
          <Suspense fallback={null}>
            <ChartLayer
              data={cast<ChartSheet[]>(data)}
              onChange={(next) => handleChartChange(cast<Sheet[]>(next))}
              selectedId={selectedChartId}
              onSelect={setSelectedChartId}
              onEdit={handleEditChart}
            />
          </Suspense>
          {/* WAVE-63: floating live pivot tables over the grid */}
          <Suspense fallback={null}>
            <PivotLayer
              data={cast<PivotSheet[]>(data)}
              onChange={(next) => handlePivotChange(cast<Sheet[]>(next))}
              onEdit={handleEditPivot}
            />
          </Suspense>
          {showCellComment && (
            <CellCommentPanel
              data={data}
              activeCell={activeCell}
              onChange={(updater) => {
                const next = typeof updater === 'function' ? updater(data) : updater
                handleChange(next)
              }}
              onClose={() => setShowCellComment(false)}
            />
          )}
          {showFindReplace && (
            <SheetsFindReplace
              data={cast<import('./SheetsFindReplace.js').FRSheet[]>(data)}
              onChange={(newData) => handleChange(newData)}
              onClose={() => setShowFindReplace(false)}
            />
          )}
        </div>

        {/* Side panels — one open at a time */}
        <Suspense fallback={null}>
          {showPivot && (
            <PivotPanel
              data={cast<PivotSheet[]>(data)}
              pivot={editingPivotId ? getPivots(cast<PivotSheet[]>(data)).find((p) => p.id === editingPivotId) || null : null}
              selectionRect={selectionRect}
              onClose={() => { setShowPivot(false); setEditingPivotId(null) }}
              onInsert={(next) => { handlePivotChange(cast<Sheet[]>(next)) }}
              onInsertStatic={(next) => { handleChange(next) }}
            />
          )}
          {showFilter && (
            <FilterPanel
              data={cast<import('./FilterPanel.js').FPSheet[]>(data)}
              onClose={() => setShowFilter(false)}
              onApply={handleFilterApply}
            />
          )}
          {showCondFormat && (
            <ConditionalFormatPanel
              data={cast<CSSheet[]>(data)}
              onClose={() => setShowCondFormat(false)}
              onChange={(next) => { handleChange(next) }}
              onColorScaleChange={(next) => { handleColorScaleChange(cast<Sheet[]>(next)) }}
            />
          )}
          {showNamedRanges && (
            <NamedRangesPanel
              data={cast<import('./NamedRangesPanel.js').NRSheet[]>(data)}
              onClose={() => setShowNamedRanges(false)}
              onChange={(next) => { handleChange(next) }}
            />
          )}
          {showProtectedRanges && (
            <ProtectedRangesPanel
              data={cast<PRSheet[]>(data)}
              fileId={id}
              me={myAccountId}
              selectionRect={selectionRect}
              onClose={() => setShowProtectedRanges(false)}
              onChange={(next) => { handleChange(next, { overlaysAuthoritative: true }) }}
            />
          )}
          {showDataValidation && (
            <DataValidationPanel
              data={cast<DVSheet[]>(data)}
              activeCell={activeCell}
              onClose={() => setShowDataValidation(false)}
              onChange={(next) => { handleChange(next) }}
            />
          )}
        </Suspense>

        {/* Comments panel */}
        {showComments && (
          <CommentsPanel
            fileId={id ?? ''}
            anchorCtx={{ type: 'cell', sheet: 'Sheet1', row: 0, col: 0, snapshot: '' }}
            onClose={() => setShowComments(false)}
          />
        )}
      </div>

      {/* Modals */}
      <Suspense fallback={null}>
        {showChartWizard && (
          <ChartWizard
            data={cast<ChartSheet[]>(data)}
            chart={editingChartId ? (data?.[0]?.charts || []).find((c) => c.id === editingChartId) || null : null}
            selectionRect={selectionRect}
            onClose={() => { setShowChartWizard(false); setEditingChartId(null) }}
            onChange={(next) => { handleChartChange(cast<Sheet[]>(next)); setShowChartWizard(false); setEditingChartId(null) }}
          />
        )}
        {/* Export fidelity confirmation (WAVE-64) — see runExport. */}
        {exportFormat && (
          <ExportDialog
            data={cast<ExportSheet[]>(data)}
            format={exportFormat}
            onCancel={() => setExportFormat(null)}
            onConfirm={(fmt) => void runExport(fmt)}
          />
        )}
      </Suspense>

      {/* Keyboard shortcuts help */}
      {showShortcutsHelp && <KeyboardShortcutsHelp onClose={closeHelp} />}

      {/* Account-based sharing (named users, role-scoped, ACL-enforced) */}
      <AccountShareModal
        open={showShare}
        onClose={() => setShowShare(false)}
        file={{ id, name: title }}
        me={myAccountId ?? ''}
      />

      {/* Transient notifier (import success / failure, …) */}
      {toast}
    </div>
  )
}
