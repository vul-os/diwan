import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { NavigateFunction } from 'react-router-dom'
import {
  FileText, Table2, Presentation, FileSearch, PenTool, Clock,
  ArrowUpRight, FolderSearch, HardDrive, RefreshCw, Loader2, Plus,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useFilesStore } from '../store/filesStore'
import { useLocalFilesStore } from '../store/localFilesStore'
import type { LocalFileEntry } from '../store/localFilesStore'
import { importFromUrl } from '../lib/importFile'
import { timeAgo, formatBytes } from '../lib/format'
import NewFileModal from './NewFileModal'
import { Card, Button, Tooltip, useToast, Skeleton, DocThumb } from './ui'

// A local-scan file as this page actually reads it: `ext`/`appType`/`modified`
// are always present on real scan results, but LocalFileEntry keeps them
// optional/untyped (index signature) since other consumers read fewer fields.
type HomeLocalFile = LocalFileEntry & { ext: string; appType: string; modified: string }

interface TypeInfoEntry {
  icon: LucideIcon
  iconCn: string
  bgCn: string
  route: string
}

interface LocalTypeInfoEntry {
  icon: LucideIcon
  iconCn: string
  bgCn: string
  label: string
}

// ─── Per-app tint map — shares the rail's tokens so content ↔ sidebar agree ──
const typeInfo: Record<string, TypeInfoEntry> = {
  doc:   { icon: FileText,     iconCn: 'text-app-docs',   bgCn: 'bg-app-docs-bg',   route: 'docs'   },
  sheet: { icon: Table2,       iconCn: 'text-app-sheets', bgCn: 'bg-app-sheets-bg', route: 'sheets' },
  slide: { icon: Presentation, iconCn: 'text-app-slides', bgCn: 'bg-app-slides-bg', route: 'slides' },
  whiteboard: { icon: PenTool, iconCn: 'text-app-board',  bgCn: 'bg-app-board-bg',  route: 'whiteboards' },
}

const localTypeInfo: Record<string, LocalTypeInfoEntry> = {
  doc:   { icon: FileText,     iconCn: 'text-app-docs',   bgCn: 'bg-app-docs-bg',   label: 'Document'     },
  sheet: { icon: Table2,       iconCn: 'text-app-sheets', bgCn: 'bg-app-sheets-bg', label: 'Spreadsheet'  },
  slide: { icon: Presentation, iconCn: 'text-app-slides', bgCn: 'bg-app-slides-bg', label: 'Presentation' },
  pdf:   { icon: FileSearch,   iconCn: 'text-app-pdf',    bgCn: 'bg-app-pdf-bg',    label: 'PDF'          },
}

async function openLocalFile(
  file: HomeLocalFile,
  navigate: NavigateFunction,
  setImporting: (path: string | null) => void,
  showToast: (msg: string, tone?: 'info' | 'success' | 'error') => void,
) {
  setImporting(file.path)
  try {
    await importFromUrl(file, navigate)
  } catch (e) {
    console.error(e)
    showToast(`Could not open ${file.name}: ${e instanceof Error ? e.message : String(e)}`, 'error')
  } finally {
    setImporting(null)
  }
}

// ─── Quick-start cluster ─────────────────────────────────────────────────────
interface QuickStart {
  label: string
  shortLabel: string
  icon: LucideIcon
  type: string
}

const quickStarts: QuickStart[] = [
  { label: 'New Document',     shortLabel: 'Document',     icon: FileText,     type: 'doc'   },
  { label: 'New Spreadsheet',  shortLabel: 'Spreadsheet',  icon: Table2,       type: 'sheet' },
  { label: 'New Presentation', shortLabel: 'Presentation', icon: Presentation, type: 'slide' },
  { label: 'New Whiteboard',   shortLabel: 'Whiteboard',   icon: PenTool,      type: 'whiteboard' },
]

export default function Home() {
  const navigate = useNavigate()
  const { showToast, toast } = useToast()
  const { files, loading: filesLoading, fetchFiles } = useFilesStore()
  const { files: localFiles, loading: localLoading, scanned, scan } = useLocalFilesStore()
  const [showLocalAll, setShowLocalAll] = useState(false)
  const [importing, setImporting] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [newType, setNewType] = useState<string | null>(null)

  useEffect(() => { void fetchFiles() }, [])
  useEffect(() => { if (!scanned) void scan() }, [scanned])

  const recentFiles = files.filter(f => typeInfo[f.type]).slice(0, 12)
  const visibleLocal = (showLocalAll ? localFiles : localFiles.slice(0, 8)) as HomeLocalFile[]

  const openNew = (type: string) => { setNewType(type); setShowNew(true) }

  return (
    <div className="flex-1 overflow-auto bg-bg">
      <div className="max-w-4xl mx-auto px-8 py-12 space-y-12">

        {/* ── Hero ── */}
        <header>
          <p className="mono-label mb-3">Workspace</p>
          <h1 className="font-display text-3xl font-semibold text-ink tracking-display leading-[1.05]">
            Welcome back
          </h1>
          <p className="text-md text-ink-muted mt-3 leading-relaxed max-w-md">
            Create something new, or pick up where you left off.
          </p>
        </header>

        {/* ── Quick-start cluster ── */}
        <section>
          <p className="mono-label mb-3.5">Start something new</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {quickStarts.map(({ label: _label, shortLabel, icon: Icon, type }) => {
              const info = typeInfo[type]
              return (
                <button
                  key={type}
                  onClick={() => openNew(type)}
                  className={[
                    'group relative flex flex-col gap-4 p-5 rounded-lg border border-line',
                    'bg-paper hover:bg-bg-elev2 hover:border-line-strong',
                    'transition-colors duration-fast ease-out',
                    'text-left cursor-pointer overflow-hidden',
                    'focus-visible:outline-none focus-visible:shadow-focus focus-visible:border-accent',
                  ].join(' ')}
                >
                  <div className={`w-10 h-10 rounded-lg ${info.bgCn} border border-line flex items-center justify-center flex-shrink-0`}>
                    <Icon size={20} className={info.iconCn} strokeWidth={1.9} />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-ink tracking-tightish leading-snug">{shortLabel}</p>
                    <p className="text-2xs text-ink-faint mt-0.5 tracking-tightish">Blank · ready to edit</p>
                  </div>
                  <div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity duration-fast">
                    <div className="w-6 h-6 rounded-md bg-accent flex items-center justify-center">
                      <Plus size={13} className="text-white" strokeWidth={2.4} />
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </section>

        {/* ── Recent documents ── */}
        {filesLoading && (
          <section aria-label="Loading recent documents" role="status">
            <p className="mono-label mb-3.5">Recent</p>
            <Card>
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className={`flex items-center gap-3 px-4 py-2.5 ${i < 3 ? 'border-b border-line' : ''}`}>
                  <Skeleton className="w-8 h-8" />
                  <Skeleton className="h-3 flex-1 max-w-[45%]" />
                  <Skeleton className="h-2.5 w-14 ml-auto" />
                </div>
              ))}
            </Card>
          </section>
        )}

        {!filesLoading && recentFiles.length > 0 && (
          <section>
            <p className="mono-label mb-3.5">Recent</p>
            <Card>
              {recentFiles.map((file, i) => {
                const info = typeInfo[file.type]
                const Icon = info.icon
                return (
                  <button
                    key={file.id}
                    onClick={() => void navigate(`/${info.route}/${file.id}`)}
                    className={[
                      'w-full flex items-center gap-3 px-4 py-2.5 text-left group',
                      'hover:bg-bg-hover transition-colors duration-fast ease-out',
                      'focus:outline-none focus-visible:shadow-focus focus-visible:bg-bg-hover',
                      i < recentFiles.length - 1 ? 'border-b border-line' : '',
                    ].join(' ')}
                  >
                    <div className={`w-8 h-8 ${info.bgCn} border border-line rounded-md flex items-center justify-center flex-shrink-0`}>
                      <Icon size={14} className={info.iconCn} />
                    </div>
                    <span className="text-sm font-medium text-ink flex-1 truncate tracking-tightish">{file.name}</span>
                    <span className="font-mono text-2xs text-ink-faint flex items-center gap-1.5 flex-shrink-0">
                      <Clock size={10} />
                      {timeAgo(file.updated_at)}
                    </span>
                    <ArrowUpRight
                      size={14}
                      className="text-accent opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                    />
                  </button>
                )
              })}
            </Card>
          </section>
        )}

        {/* ── Empty state — gentle serif tagline over a crafted preview trio ── */}
        {!filesLoading && recentFiles.length === 0 && (
          <section className="flex flex-col items-center justify-center py-14 text-center">
            <div className="relative h-24 w-48 mb-6" aria-hidden>
              <div className="absolute left-1/2 top-1 -translate-x-1/2 -rotate-6 w-20 h-24 rounded-lg border border-line overflow-hidden shadow-e1 opacity-70">
                <DocThumb type="sheet" className="h-full" />
              </div>
              <div className="absolute left-1/2 top-0 -translate-x-1/2 rotate-6 translate-x-8 w-20 h-24 rounded-lg border border-line overflow-hidden shadow-e1 opacity-70">
                <DocThumb type="slide" className="h-full" />
              </div>
              <div className="absolute left-1/2 top-0 -translate-x-1/2 w-20 h-24 rounded-lg border border-line overflow-hidden shadow-e2">
                <DocThumb type="doc" className="h-full" />
              </div>
            </div>
            <p className="font-serif text-xl text-ink leading-snug mb-2">
              Your workspace awaits.
            </p>
            <p className="text-sm text-ink-muted max-w-xs leading-relaxed mb-6">
              Start with a blank document, spreadsheet, or presentation — or open a file from your computer.
            </p>
            <Button variant="primary" size="md" onClick={() => setShowNew(true)}>
              <Plus size={14} /> New file
            </Button>
          </section>
        )}

        {/* ── Local files from disk ── */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <HardDrive size={12} className="text-ink-faint" />
              <p className="mono-label">On your computer</p>
              {localFiles.length > 0 && (
                <span className="font-mono text-2xs text-ink-faint bg-bg-elev2 border border-line rounded-pill px-2 py-0.5">
                  {localFiles.length}
                </span>
              )}
            </div>
            <Tooltip label={localLoading ? 'Scanning…' : 'Rescan files'} side="left">
              <button
                onClick={() => void scan()}
                className="flex items-center gap-1.5 font-mono text-2xs uppercase tracking-wide text-ink-faint hover:text-ink-muted transition-colors rounded-sm px-1 -mx-1 focus:outline-none focus-visible:shadow-focus focus-visible:text-ink-muted"
              >
                <RefreshCw size={12} className={localLoading ? 'animate-spin' : ''} />
                {localLoading ? 'Scanning…' : 'Rescan'}
              </button>
            </Tooltip>
          </div>

          {localLoading && !scanned && (
            <Card className="p-6 flex items-center gap-3 text-sm text-ink-muted">
              <FolderSearch size={16} className="text-ink-faint animate-pulse flex-shrink-0" />
              Scanning Documents, Downloads &amp; Desktop…
            </Card>
          )}

          {scanned && localFiles.length === 0 && (
            <Card className="p-8 text-center">
              <FolderSearch size={26} className="text-ink-faint mx-auto mb-2" />
              <p className="text-sm text-ink-muted">No supported files found in Documents, Downloads or Desktop</p>
            </Card>
          )}

          {localFiles.length > 0 && (
            <>
              <Card>
                {visibleLocal.map((file, i) => {
                  const info = localTypeInfo[file.appType]
                  if (!info) return null
                  const Icon = info.icon
                  return (
                    <button
                      key={file.path}
                      onClick={() => void openLocalFile(file, navigate, setImporting, showToast)}
                      disabled={importing === file.path}
                      className={[
                        'w-full flex items-center gap-3 px-4 py-2.5 text-left group',
                        'hover:bg-bg-hover transition-colors duration-fast ease-out',
                        'focus:outline-none focus-visible:shadow-focus focus-visible:bg-bg-hover',
                        'disabled:opacity-60',
                        i < visibleLocal.length - 1 ? 'border-b border-line' : '',
                      ].join(' ')}
                    >
                      <div className={`w-7 h-7 ${info.bgCn} border border-line rounded-md flex items-center justify-center flex-shrink-0`}>
                        <Icon size={13} className={info.iconCn} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-ink truncate tracking-tightish">{file.name}</p>
                        <p className="font-mono text-2xs text-ink-faint truncate">
                          {file.path.replace(/\/Users\/[^/]+/, '~')}
                        </p>
                      </div>
                      <div className="flex items-center gap-3 flex-shrink-0 font-mono text-2xs text-ink-faint">
                        <span>{formatBytes(file.size)}</span>
                        <span>{timeAgo(file.modified)}</span>
                        <span className={`px-1.5 py-0.5 rounded-sm ${info.bgCn} ${info.iconCn} border border-line font-semibold uppercase text-[9px]`}>
                          {file.ext.slice(1)}
                        </span>
                        {importing === file.path
                          ? <Loader2 size={12} className="animate-spin text-accent" />
                          : <ArrowUpRight size={12} className="text-accent opacity-0 group-hover:opacity-100 transition-opacity" />
                        }
                      </div>
                    </button>
                  )
                })}
              </Card>

              {localFiles.length > 8 && (
                <button
                  onClick={() => setShowLocalAll(v => !v)}
                  className="mt-3 w-full py-2 text-2xs text-ink-faint hover:text-ink-muted bg-paper border border-line rounded-md hover:bg-bg-elev2 transition-colors tracking-tightish focus:outline-none focus-visible:shadow-focus focus-visible:border-accent"
                >
                  {showLocalAll ? 'Show less' : `Show all ${localFiles.length} files`}
                </button>
              )}
            </>
          )}
        </section>
      </div>

      {showNew && (
        <NewFileModal
          defaultType={(newType || 'doc') as 'doc' | 'sheet' | 'slide' | 'whiteboard'}
          onClose={() => { setShowNew(false); setNewType(null) }}
        />
      )}
      {toast}
    </div>
  )
}
