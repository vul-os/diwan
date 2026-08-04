import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Plus, Search, LayoutGrid, List, MoreVertical, Clock,
  Trash2, Pencil, ArrowUpRight, FileText, Table2, Presentation, PenTool,
  HardDrive, Loader2, RefreshCw, FileSearch, Upload,
  Star, Folder, FolderPlus, RotateCcw, ChevronRight, Home, FolderInput,
  Share2, Users,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useFilesStore } from '../store/filesStore'
import type { DiwanFile, DiwanFolder } from '../store/filesStore'
import { useLocalFilesStore } from '../store/localFilesStore'
import type { LocalFileEntry } from '../store/localFilesStore'
import { useAuthStore } from '../store/authStore'
import NewFileModal from './NewFileModal'
import AccountShareModal from './AccountShareModal'
import { importFromUrl, importFile, detectType } from '../lib/importFile'
import { api } from '../lib/api'
import { timeAgo, formatBytes } from '../lib/format'
import { Button, IconButton, Input, Card, Tooltip, useToast, DocThumb, Skeleton, Avatar, hueFor, ThemeSwitch } from './ui'

// ─── Local shapes — `api.searchDocs` returns `unknown` by design; this
// documents just what this panel reads (see lib/api.ts searchDocs comment). ──
interface SearchResult {
  id: string
  name?: string
  type?: string
  snippet?: string
  owner?: string
  shared?: boolean
}
interface SearchDocsResponse {
  query?: string
  results?: SearchResult[]
}

// ─── Token-aligned config ─────────────────────────────────────────────────────
interface AppConfig {
  label: string
  singularLabel: string
  icon: LucideIcon
  iconCn: string
  bgCn: string
  route: string
  emptyMsg: string
  localExts: string[]
  extLabel: string
  importExts: string
  canCreate: boolean
}

const CONFIG: Record<'doc' | 'sheet' | 'slide' | 'whiteboard' | 'pdf', AppConfig> = {
  doc: {
    label: 'Documents', singularLabel: 'Document',
    icon: FileText,
    iconCn: 'text-accent',       bgCn: 'bg-accent-tint',
    route: 'docs', emptyMsg: 'No documents yet',
    localExts: ['.doc', '.docx', '.txt', '.md', '.rtf', '.odt'],
    extLabel: 'docx, odt, txt, md, html',
    importExts: '.docx,.txt,.md,.rtf,.html,.htm,.odt',
    canCreate: true,
  },
  sheet: {
    label: 'Spreadsheets', singularLabel: 'Spreadsheet',
    icon: Table2,
    iconCn: 'text-success',      bgCn: 'bg-success-bg',
    route: 'sheets', emptyMsg: 'No spreadsheets yet',
    localExts: ['.xls', '.xlsx', '.csv', '.ods'],
    extLabel: 'xlsx, xls, ods, csv',
    importExts: '.xlsx,.xls,.csv,.tsv,.ods',
    canCreate: true,
  },
  slide: {
    label: 'Presentations', singularLabel: 'Presentation',
    icon: Presentation,
    iconCn: 'text-warning',      bgCn: 'bg-warning-bg',
    route: 'slides', emptyMsg: 'No presentations yet',
    localExts: ['.ppt', '.pptx', '.odp'],
    extLabel: 'pptx, odp',
    importExts: '.pptx,.odp',
    canCreate: true,
  },
  whiteboard: {
    label: 'Whiteboards', singularLabel: 'Whiteboard',
    icon: PenTool,
    iconCn: 'text-app-board',    bgCn: 'bg-app-board-bg',
    route: 'whiteboards', emptyMsg: 'No whiteboards yet',
    localExts: ['.excalidraw'],
    extLabel: 'excalidraw',
    importExts: '.excalidraw',
    canCreate: true,
  },
  pdf: {
    label: 'PDFs', singularLabel: 'PDF',
    icon: FileSearch,
    iconCn: 'text-danger',       bgCn: 'bg-danger-bg',
    route: 'pdf', emptyMsg: 'No PDFs yet',
    localExts: ['.pdf'],
    extLabel: 'pdf',
    importExts: '.pdf',
    canCreate: false,
  },
}

type AppType = keyof typeof CONFIG

interface AppHomeProps {
  type: AppType
}

export default function AppHome({ type }: AppHomeProps) {
  const cfg = CONFIG[type]
  const Icon = cfg.icon
  const navigate = useNavigate()
  const { showToast, toast } = useToast()
  const {
    files, folders, loading, fetchFiles, fetchFolders, deleteFile, renameFile,
    toggleStar, trashFile, restoreFile, moveFile, createFolder, renameFolder,
    trashFolder, deleteFolder, sharedWithMe, fetchSharedWithMe,
  } = useFilesStore()
  const { files: localFiles, loading: localLoading, scanned, scan } = useLocalFilesStore()
  const myAccountId = useAuthStore((s) => s.accountId)
  const [showNew, setShowNew] = useState(false)
  // The file currently open in the account-share dialog (or null).
  const [sharing, setSharing] = useState<DiwanFile | null>(null)
  const [search, setSearch] = useState('')
  // Global full-text search across the caller's ACL-scoped documents (owned +
  // shared). Fires against the backend, debounced, when the query is >= 2 chars.
  // Results carry per-file snippets; ACL is enforced server-side at query time.
  const [contentResults, setContentResults] = useState<SearchResult[] | null>(null) // null = idle, [] = no matches
  const [contentSearching, setContentSearching] = useState(false)
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
  const [menuOpen, setMenuOpen] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [importing, setImporting] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Parity: file organization.
  //   view    — 'browse' | 'starred' | 'trash'
  //   folderId— current folder in the tree ('' = root); only meaningful in browse
  //   moving  — the file being placed via the "Move to…" picker (or null)
  const [view, setView] = useState<'browse' | 'starred' | 'trash'>('browse')
  const [folderId, setFolderId] = useState('')
  const [moving, setMoving] = useState<DiwanFile | null>(null)

  const openImportedFile = async (file: File | null | undefined) => {
    if (!file) return
    setImporting('__file__')
    try {
      if (!detectType(file.name)) {
        throw new Error(`Cannot open .${(file.name.split('.').pop() || '').toLowerCase()} files.`)
      }
      await importFile(file, navigate)
    } catch (err) {
      showToast(`Could not open ${file.name}: ${err instanceof Error ? err.message : String(err)}`, 'error')
    } finally {
      setImporting(null)
    }
  }

  const handleImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    await openImportedFile(file)
  }

  const onDragOver = (e: DragEvent<HTMLDivElement>) => { e.preventDefault(); if (!dragActive) setDragActive(true) }
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setDragActive(false)
  }
  const onDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragActive(false)
    const file = e.dataTransfer?.files?.[0]
    if (file) await openImportedFile(file)
  }

  useEffect(() => { fetchFiles(); fetchFolders(); fetchSharedWithMe() }, [])
  useEffect(() => { if (!scanned) scan() }, [scanned])

  // Debounced backend full-text search (content, not just names). Scoped to this
  // app's type so a Docs search doesn't surface Sheets. The server enforces ACL
  // at query time, so results only ever include the caller's own + shared files.
  useEffect(() => {
    const q = search.trim()
    if (q.length < 2) { setContentResults(null); setContentSearching(false); return }
    setContentSearching(true)
    let live = true
    const t = setTimeout(async () => {
      try {
        const res = await api.searchDocs(q, type) as SearchDocsResponse
        if (live) setContentResults(res?.results || [])
      } catch {
        if (live) setContentResults([])
      } finally {
        if (live) setContentSearching(false)
      }
    }, 250)
    return () => { live = false; clearTimeout(t) }
  }, [search, type])

  const searchLc = search.toLowerCase()

  // Folders scoped to the current view. Trash view lists trashed folders at any
  // depth; browse lists non-trashed folders whose parent is the current folder.
  const visibleFolders = useMemo(() => {
    const list = (folders || []).filter(f => f.name.toLowerCase().includes(searchLc))
    if (view === 'trash') return list.filter(f => f.trashed)
    if (view === 'starred') return list.filter(f => f.starred && !f.trashed)
    return list.filter(f => !f.trashed && (f.parent_id || '') === folderId)
  }, [folders, view, folderId, searchLc])

  // Files scoped to the current view. A file is hidden from browse/starred while
  // trashed; the Trash view shows only trashed files.
  const myFiles = useMemo(() => {
    const list = files
      .filter(f => f.type === type)
      .filter(f => f.name.toLowerCase().includes(searchLc))
    if (view === 'trash') return list.filter(f => f.trashed)
    if (view === 'starred') return list.filter(f => f.starred && !f.trashed)
    return list.filter(f => !f.trashed && (f.parent_id || '') === folderId)
  }, [files, type, view, folderId, searchLc])

  const myLocalFiles = localFiles
    .filter(f => f.ext && cfg.localExts.includes(f.ext))
    .filter(f => f.name.toLowerCase().includes(searchLc)) as (LocalFileEntry & { ext: string; appType: string })[]

  // Files shared TO the user by others, scoped to this app's type + search.
  const sharedFiles = useMemo(() => (
    (sharedWithMe || [])
      .filter(f => f.type === type)
      .filter(f => (f.name || '').toLowerCase().includes(searchLc))
  ), [sharedWithMe, type, searchLc])

  // Breadcrumb path from root → current folder.
  const crumbs = useMemo(() => {
    if (view !== 'browse' || !folderId) return []
    const byId = new Map((folders || []).map(f => [f.id, f]))
    const out: DiwanFolder[] = []
    let cur = byId.get(folderId)
    let guard = 0
    while (cur && guard++ < 64) {
      out.unshift(cur)
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined
    }
    return out
  }, [folders, folderId, view])

  const openFile = (f: { id: string }) => navigate(`/${cfg.route}/${f.id}`)
  const startRename = (f: DiwanFile) => { setRenaming(f.id); setRenameValue(f.name); setMenuOpen(null) }
  const commitRename = async (id: string) => { if (renameValue.trim()) await renameFile(id, renameValue.trim()); setRenaming(null) }
  const startRenameFolder = (f: DiwanFolder) => { setRenaming('folder:' + f.id); setRenameValue(f.name); setMenuOpen(null) }
  const commitRenameFolder = async (id: string) => { if (renameValue.trim()) await renameFolder(id, renameValue.trim()); setRenaming(null) }

  const handleNewFolder = async () => {
    const name = window.prompt('New folder name')
    if (name && name.trim()) {
      try { await createFolder(name.trim(), view === 'browse' ? folderId : '') }
      catch (e) { showToast(`Could not create folder: ${e instanceof Error ? e.message : String(e)}`, 'error') }
    }
  }

  const wrap = <A extends unknown[]>(label: string, fn: (...a: A) => Promise<unknown>) => async (...a: A) => {
    try { await fn(...a) } catch (e) { showToast(`${label}: ${e instanceof Error ? e.message : String(e)}`, 'error') }
    setMenuOpen(null)
  }

  const openLocalFile = async (file: LocalFileEntry & { appType: string }) => {
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

  const trashCount = files.filter(f => f.type === type && f.trashed).length +
    (folders || []).filter(f => f.trashed).length
  const starredCount = files.filter(f => f.type === type && f.starred && !f.trashed).length

  const isEmpty = myFiles.length === 0 && visibleFolders.length === 0

  return (
    <div
      className="flex-1 overflow-auto bg-bg relative"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragActive && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-accent-tint/80 backdrop-blur-sm border-2 border-dashed border-accent m-3 rounded-xl pointer-events-none">
          <div className="text-center">
            <Upload size={32} className="text-accent mx-auto mb-2" />
            <p className="font-serif text-lg text-ink">Drop to open</p>
            <p className="text-sm text-ink-muted">docx, xlsx, pptx, odt, ods, odp, pdf and more</p>
          </div>
        </div>
      )}
      {/* ── Topbar ── */}
      <div className="sticky top-0 z-10 flex items-center gap-3 px-5 h-11 bg-paper border-b border-line">
        <div className={`w-7 h-7 rounded-md ${cfg.bgCn} flex items-center justify-center flex-shrink-0`}>
          <Icon size={15} className={cfg.iconCn} />
        </div>
        <h1 className="font-display text-lg font-semibold text-ink tracking-tight leading-none">{cfg.label}</h1>

        <div className="flex-1 max-w-xs mx-2">
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search…"
            size="sm"
            leading={<Search size={13} />}
          />
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <ThemeSwitch collapsed />
          <div className="flex items-center gap-0.5 p-0.5 bg-bg-elev2 border border-line rounded-md mr-1">
            <Tooltip label="Grid view" side="bottom">
              <IconButton size="sm" active={viewMode === 'grid'} onClick={() => setViewMode('grid')}>
                <LayoutGrid size={13} />
              </IconButton>
            </Tooltip>
            <Tooltip label="List view" side="bottom">
              <IconButton size="sm" active={viewMode === 'list'} onClick={() => setViewMode('list')}>
                <List size={13} />
              </IconButton>
            </Tooltip>
          </div>

          <input ref={fileInputRef} type="file" accept={cfg.importExts} className="hidden" onChange={handleImportFile} />
          <Button
            variant="secondary" size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={importing === '__file__'}
          >
            {importing === '__file__' ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
            Open file
          </Button>
          {cfg.canCreate && (
            <>
              <Tooltip label="New folder" side="bottom">
                <IconButton size="sm" onClick={handleNewFolder} aria-label="New folder">
                  <FolderPlus size={14} />
                </IconButton>
              </Tooltip>
              <Button variant="primary" size="sm" onClick={() => setShowNew(true)}>
                <Plus size={13} /> New {cfg.singularLabel}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* ── View tabs (All / Starred / Trash) + breadcrumb ── */}
      <div className="max-w-6xl mx-auto px-6 pt-4 flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1 p-0.5 bg-bg-elev2 border border-line rounded-md">
          <ViewTab active={view === 'browse'} onClick={() => { setView('browse'); setFolderId('') }}>
            <Home size={12} /> All
          </ViewTab>
          <ViewTab active={view === 'starred'} onClick={() => setView('starred')}>
            <Star size={12} /> Starred{starredCount > 0 ? ` (${starredCount})` : ''}
          </ViewTab>
          <ViewTab active={view === 'trash'} onClick={() => setView('trash')}>
            <Trash2 size={12} /> Trash{trashCount > 0 ? ` (${trashCount})` : ''}
          </ViewTab>
        </div>

        {view === 'browse' && folderId && (
          <nav className="flex items-center gap-1 text-2xs text-ink-faint ml-1" aria-label="Folder path">
            <button className="hover:text-ink-muted flex items-center gap-1 rounded-sm px-1 -mx-1 focus:outline-none focus-visible:shadow-focus focus-visible:text-ink-muted" onClick={() => setFolderId('')}>
              <Home size={11} /> Home
            </button>
            {crumbs.map((c) => (
              <span key={c.id} className="flex items-center gap-1">
                <ChevronRight size={11} />
                <button className="hover:text-ink-muted truncate max-w-[10rem] rounded-sm px-1 -mx-1 focus:outline-none focus-visible:shadow-focus focus-visible:text-ink-muted" onClick={() => setFolderId(c.id)}>
                  {c.name}
                </button>
              </span>
            ))}
          </nav>
        )}
      </div>

      <div className="max-w-6xl mx-auto px-6 py-6 space-y-8">
        {/* ── Full-text content matches (backend search) ── */}
        {search.trim().length >= 2 && (
          <ContentSearchResults
            results={contentResults}
            searching={contentSearching}
            query={search.trim()}
            onOpen={openFile}
          />
        )}

        <section>
          {loading && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4" role="status" aria-label={`Loading ${cfg.label.toLowerCase()}`}>
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="rounded-lg border border-line overflow-hidden bg-paper">
                  <Skeleton className="h-28" rounded="rounded-none" />
                  <div className="p-3 space-y-2">
                    <Skeleton className="h-3 w-3/4" />
                    <Skeleton className="h-2.5 w-1/3" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {!loading && isEmpty && (
            <div className="flex flex-col items-center justify-center py-20 text-center animate-fade-in">
              <div className={`w-16 h-16 ${cfg.bgCn} rounded-xl flex items-center justify-center mb-4`}>
                <Icon size={28} className={`${cfg.iconCn} opacity-40`} />
              </div>
              <p className="font-serif text-lg text-ink mb-1">
                {search ? 'No results' : view === 'trash' ? 'Trash is empty' : view === 'starred' ? 'No starred items' : cfg.emptyMsg}
              </p>
              <p className="text-sm text-ink-muted mb-6">
                {search ? 'Try a different search term'
                  : view === 'trash' ? 'Deleted items appear here and can be restored'
                  : view === 'starred' ? 'Star items to find them quickly'
                  : `Start fresh with a blank ${cfg.singularLabel.toLowerCase()}`}
              </p>
              {!search && view === 'browse' && (
                <div className="flex items-center gap-2">
                  <Button variant="secondary" size="md" onClick={() => fileInputRef.current?.click()}>
                    <Upload size={14} /> Open File
                  </Button>
                  {cfg.canCreate && (
                    <Button variant="primary" size="md" onClick={() => setShowNew(true)}>
                      <Plus size={14} /> New {cfg.singularLabel}
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Folders (browse/starred/trash) ── */}
          {!loading && visibleFolders.length > 0 && (
            <div className="mb-6">
              <p className="text-2xs font-semibold text-ink-faint tracking-eyebrow uppercase mb-3">Folders</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                {visibleFolders.map(folder => (
                  <FolderCard
                    key={folder.id}
                    folder={folder}
                    view={view}
                    renaming={renaming}
                    renameValue={renameValue}
                    setRenameValue={setRenameValue}
                    setRenaming={setRenaming}
                    menuOpen={menuOpen}
                    setMenuOpen={setMenuOpen}
                    onOpen={() => { setView('browse'); setFolderId(folder.id) }}
                    onRename={() => startRenameFolder(folder)}
                    onRenameCommit={() => commitRenameFolder(folder.id)}
                    onTrash={wrap('Trash folder', () => trashFolder(folder.id, true))}
                    onRestore={wrap('Restore folder', () => trashFolder(folder.id, false))}
                    onDelete={wrap('Delete folder', () => deleteFolder(folder.id))}
                  />
                ))}
              </div>
            </div>
          )}

          {!loading && myFiles.length > 0 && (
            <>
              {visibleFolders.length > 0 && (
                <p className="text-2xs font-semibold text-ink-faint tracking-eyebrow uppercase mb-3">Files</p>
              )}
              {viewMode === 'grid' ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                  {myFiles.map(file => (
                    <FileCard
                      key={file.id}
                      file={file}
                      Icon={Icon}
                      type={type}
                      view={view}
                      renaming={renaming}
                      renameValue={renameValue}
                      setRenaming={setRenaming}
                      setRenameValue={setRenameValue}
                      menuOpen={menuOpen}
                      setMenuOpen={setMenuOpen}
                      onOpen={() => openFile(file)}
                      onRename={() => startRename(file)}
                      onRenameCommit={() => commitRename(file.id)}
                      onStar={wrap('Star', () => toggleStar(file.id))}
                      onMove={() => { setMoving(file); setMenuOpen(null) }}
                      onShare={() => { setSharing(file); setMenuOpen(null) }}
                      onTrash={wrap('Trash', () => trashFile(file.id))}
                      onRestore={wrap('Restore', () => restoreFile(file.id))}
                      onDelete={wrap('Delete', () => deleteFile(file.id))}
                    />
                  ))}
                </div>
              ) : (
                <FileListTable
                  files={myFiles}
                  cfg={cfg}
                  Icon={Icon}
                  view={view}
                  renaming={renaming}
                  renameValue={renameValue}
                  setRenaming={setRenaming}
                  setRenameValue={setRenameValue}
                  menuOpen={menuOpen}
                  setMenuOpen={setMenuOpen}
                  onOpen={openFile}
                  onRename={startRename}
                  onRenameCommit={commitRename}
                  onStar={(id) => wrap('Star', () => toggleStar(id))()}
                  onMove={(file) => { setMoving(file); setMenuOpen(null) }}
                  onShare={(file) => { setSharing(file); setMenuOpen(null) }}
                  onTrash={(id) => wrap('Trash', () => trashFile(id))()}
                  onRestore={(id) => wrap('Restore', () => restoreFile(id))()}
                  onDelete={(id) => wrap('Delete', () => deleteFile(id))()}
                />
              )}
            </>
          )}
        </section>

        {/* ── Shared with me (browse root only) ── */}
        {view === 'browse' && !folderId && sharedFiles.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-3">
              <Users size={13} className="text-ink-faint" />
              <p className="text-2xs font-semibold text-ink-faint tracking-eyebrow uppercase">Shared with me</p>
              <span className="text-2xs text-ink-faint bg-bg-elev2 border border-line rounded-pill px-2 py-0.5">
                {sharedFiles.length}
              </span>
            </div>
            <Card>
              {sharedFiles.map((file, i) => (
                <button
                  key={file.id}
                  onClick={() => openFile(file)}
                  className={[
                    'w-full flex items-center gap-3 px-4 py-2.5 text-left group',
                    'hover:bg-accent-tint transition-colors duration-fast ease-out',
                    'focus:outline-none focus-visible:shadow-focus focus-visible:bg-accent-tint',
                    i < sharedFiles.length - 1 ? 'border-b border-line' : '',
                  ].join(' ')}
                >
                  <div className={`w-7 h-7 ${cfg.bgCn} rounded-md flex items-center justify-center flex-shrink-0`}>
                    <Icon size={13} className={cfg.iconCn} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-ink truncate tracking-tightish">{file.name}</p>
                    <p className="text-2xs text-ink-faint truncate flex items-center gap-1">
                      <Avatar name={file.owner} size={13} color={hueFor(file.owner)} />
                      Shared by {file.owner}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0 text-2xs text-ink-faint tracking-tightish">
                    <span className="px-1.5 py-0.5 rounded-xs bg-bg-elev2 border border-line font-semibold uppercase text-[9px] capitalize">
                      {(file.role as string | undefined) || 'shared'}
                    </span>
                    <span>{timeAgo(file.updated_at)}</span>
                    <ArrowUpRight size={12} className="opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                </button>
              ))}
            </Card>
          </section>
        )}

        {/* ── On Your Computer (browse root only) ── */}
        {view === 'browse' && !folderId && myLocalFiles.length > 0 && (
          <section>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <HardDrive size={13} className="text-ink-faint" />
                <p className="text-2xs font-semibold text-ink-faint tracking-eyebrow uppercase">On Your Computer</p>
                <span className="text-2xs text-ink-faint bg-bg-elev2 border border-line rounded-pill px-2 py-0.5">
                  {myLocalFiles.length}
                </span>
              </div>
              <button onClick={() => scan()} className="flex items-center gap-1.5 text-2xs text-ink-faint hover:text-ink-muted transition-colors rounded-sm px-1 -mx-1 focus:outline-none focus-visible:shadow-focus focus-visible:text-ink-muted">
                <RefreshCw size={11} className={localLoading ? 'animate-spin' : ''} />
                Rescan
              </button>
            </div>
            <Card>
              {myLocalFiles.map((file, i) => (
                <button
                  key={file.path}
                  onClick={() => openLocalFile(file)}
                  disabled={importing === file.path}
                  className={[
                    'w-full flex items-center gap-3 px-4 py-2.5 text-left group',
                    'hover:bg-accent-tint transition-colors duration-fast ease-out',
                    'focus:outline-none focus-visible:shadow-focus focus-visible:bg-accent-tint',
                    'disabled:opacity-60',
                    i < myLocalFiles.length - 1 ? 'border-b border-line' : '',
                  ].join(' ')}
                >
                  <div className={`w-7 h-7 ${cfg.bgCn} rounded-md flex items-center justify-center flex-shrink-0`}>
                    <Icon size={13} className={cfg.iconCn} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-ink truncate tracking-tightish">{file.name}</p>
                    <p className="text-2xs text-ink-faint truncate">{file.path.replace(/\/Users\/[^/]+/, '~')}</p>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0 text-2xs text-ink-faint tracking-tightish">
                    <span>{formatBytes(file.size || 0)}</span>
                    <span className={`px-1.5 py-0.5 rounded-xs ${cfg.bgCn} ${cfg.iconCn} font-semibold uppercase text-[9px]`}>
                      {file.ext.slice(1)}
                    </span>
                    {importing === file.path
                      ? <Loader2 size={12} className="animate-spin text-accent" />
                      : <ArrowUpRight size={12} className="opacity-0 group-hover:opacity-100 transition-opacity" />}
                  </div>
                </button>
              ))}
            </Card>
          </section>
        )}
      </div>

      {/* `showNew` is only ever set true from behind a `cfg.canCreate` guard, so
          `type` here is never 'pdf' (the one non-creatable app) even though the
          broader AppType union includes it. */}
      {showNew && <NewFileModal onClose={() => setShowNew(false)} lockType={type as 'doc' | 'sheet' | 'slide' | 'whiteboard'} parentId={view === 'browse' ? folderId : ''} />}
      {moving && (
        <MoveToFolderModal
          file={moving}
          folders={(folders || []).filter(f => !f.trashed)}
          onClose={() => setMoving(null)}
          onMove={async (targetId) => {
            try { await moveFile(moving.id, { parentId: targetId }) }
            catch (e) { showToast(`Move failed: ${e instanceof Error ? e.message : String(e)}`, 'error') }
            setMoving(null)
          }}
        />
      )}
      {sharing && (
        <AccountShareModal
          open
          file={sharing}
          me={myAccountId ?? undefined}
          onClose={() => { setSharing(null); fetchSharedWithMe() }}
        />
      )}
      {menuOpen && <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(null)} />}
      {toast}
    </div>
  )
}

function ViewTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={[
        'flex items-center gap-1.5 px-2.5 py-1 rounded-sm text-2xs font-semibold tracking-tightish transition-colors',
        'focus:outline-none focus-visible:shadow-focus',
        active ? 'bg-paper text-ink shadow-e1' : 'text-ink-faint hover:text-ink-muted',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

// ─── ContentSearchResults ─────────────────────────────────────────────────────
// Renders backend full-text search hits (matches inside document content, not
// just names) with a highlighted snippet. The server returns only files the
// caller may read (ACL enforced at query time), so nothing here can leak another
// account's content.
interface ContentSearchResultsProps {
  results: SearchResult[] | null
  searching: boolean
  query: string
  onOpen: (r: SearchResult) => void
}

export function ContentSearchResults({ results, searching, query, onOpen }: ContentSearchResultsProps) {
  // Idle (results === null) with no in-flight request → render nothing.
  if (results === null && !searching) return null

  return (
    <section aria-label="Content search results">
      <h2 className="text-2xs font-semibold text-ink-faint tracking-eyebrow uppercase mb-2 flex items-center gap-1.5">
        <Search size={11} /> Matches in content
        {searching && <Loader2 size={11} className="animate-spin" />}
      </h2>
      {!searching && results && results.length === 0 && (
        <p className="text-2xs text-ink-faint">No content matches for “{query}”.</p>
      )}
      {results && results.length > 0 && (
        <ul className="rounded-lg border border-line divide-y divide-line overflow-hidden bg-paper">
          {results.map((r) => (
            <li key={r.id}>
              <button
                onClick={() => onOpen(r)}
                className="w-full text-left px-3.5 py-2.5 hover:bg-accent-tint transition-colors focus:outline-none focus-visible:shadow-focus"
              >
                <div className="flex items-center gap-2">
                  <p className="text-xs font-medium text-ink truncate tracking-tightish">{r.name || 'Untitled'}</p>
                  {r.shared && (
                    <span className="text-2xs text-ink-faint flex items-center gap-0.5">
                      <Users size={9} /> shared{r.owner ? ` by ${r.owner}` : ''}
                    </span>
                  )}
                </div>
                <SnippetText snippet={r.snippet} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// SnippetText renders a server snippet, highlighting the «matched» span the
// backend delimits with « » guillemets. Rendered as plain text nodes (no HTML
// injection) so document content can never inject markup.
export function SnippetText({ snippet }: { snippet?: string }) {
  if (!snippet) return null
  const parts: React.ReactNode[] = []
  let rest = snippet
  let k = 0
  while (true) {
    const open = rest.indexOf('«')
    if (open < 0) { parts.push(<span key={k++}>{rest}</span>); break }
    const close = rest.indexOf('»', open)
    if (close < 0) { parts.push(<span key={k++}>{rest}</span>); break }
    if (open > 0) parts.push(<span key={k++}>{rest.slice(0, open)}</span>)
    parts.push(<mark key={k++} className="bg-warning/25 text-ink rounded-xs px-0.5">{rest.slice(open + 1, close)}</mark>)
    rest = rest.slice(close + 1)
  }
  return <p className="text-2xs text-ink-muted mt-0.5 leading-relaxed line-clamp-2">{parts}</p>
}

// ─── FolderCard ───────────────────────────────────────────────────────────────
interface FolderCardProps {
  folder: DiwanFolder
  view: 'browse' | 'starred' | 'trash'
  renaming: string | null
  renameValue: string
  setRenameValue: (v: string) => void
  setRenaming: (v: string | null) => void
  menuOpen: string | null
  setMenuOpen: (v: string | null) => void
  onOpen: () => void
  onRename: () => void
  onRenameCommit: () => void
  onTrash: () => void
  onRestore: () => void
  onDelete: () => void
}

function FolderCard({
  folder, view, renaming, renameValue, setRenameValue, setRenaming,
  menuOpen, setMenuOpen, onOpen, onRename, onRenameCommit, onTrash, onRestore, onDelete,
}: FolderCardProps) {
  const key = 'folder:' + folder.id
  const menuKey = 'foldermenu:' + folder.id
  return (
    <div className="group bg-paper rounded-lg border border-line hover:border-line-strong hover:shadow-e2 transition-[box-shadow,border-color] duration-base ease-out overflow-hidden">
      <div className="flex items-center gap-2.5 p-3">
        <button
          className="flex items-center gap-2.5 flex-1 min-w-0 text-left"
          onClick={view === 'trash' ? undefined : onOpen}
          disabled={view === 'trash'}
        >
          <div className="w-8 h-8 rounded-md bg-accent-tint flex items-center justify-center flex-shrink-0">
            <Folder size={16} className="text-accent" />
          </div>
          {renaming === key ? (
            <input
              autoFocus
              value={renameValue}
              onChange={e => setRenameValue(e.target.value)}
              onBlur={onRenameCommit}
              onKeyDown={e => { if (e.key === 'Enter') onRenameCommit(); if (e.key === 'Escape') setRenaming(null) }}
              className="flex-1 min-w-0 text-xs font-semibold border border-accent rounded-sm px-1 focus:outline-none bg-paper text-ink"
              onClick={e => e.stopPropagation()}
            />
          ) : (
            <p className="text-xs font-semibold text-ink truncate tracking-tightish">{folder.name}</p>
          )}
        </button>
        <div className="relative flex-shrink-0" onClick={e => e.stopPropagation()}>
          <button
            onClick={() => setMenuOpen(menuOpen === menuKey ? null : menuKey)}
            className="p-0.5 rounded-sm hover:bg-accent-tint text-ink-faint opacity-0 group-hover:opacity-100 transition-[opacity,background] duration-fast"
            aria-label="Folder actions"
          >
            <MoreVertical size={12} />
          </button>
          {menuOpen === menuKey && (
            <div className="absolute right-0 top-full mt-1 w-36 bg-paper border border-line rounded-lg shadow-e2 z-20 py-1 text-xs overflow-hidden animate-scale-in">
              {view === 'trash' ? (
                <>
                  <MenuItem onClick={onRestore}><RotateCcw size={12} className="text-ink-faint" /> Restore</MenuItem>
                  <MenuItem danger onClick={onDelete}><Trash2 size={12} /> Delete forever</MenuItem>
                </>
              ) : (
                <>
                  <MenuItem onClick={onRename}><Pencil size={12} className="text-ink-faint" /> Rename</MenuItem>
                  <MenuItem danger onClick={onTrash}><Trash2 size={12} /> Move to trash</MenuItem>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function MenuItem({ danger, onClick, children }: { danger?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className={[
        'w-full flex items-center gap-2 px-3 py-1.5 transition-colors',
        danger ? 'hover:bg-danger-bg text-danger' : 'hover:bg-accent-tint text-ink',
      ].join(' ')}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

// ─── FileCard ─────────────────────────────────────────────────────────────────
interface FileCardProps {
  file: DiwanFile
  Icon: LucideIcon
  type: AppType
  view: 'browse' | 'starred' | 'trash'
  renaming: string | null
  renameValue: string
  setRenaming: (v: string | null) => void
  setRenameValue: (v: string) => void
  menuOpen: string | null
  setMenuOpen: (v: string | null) => void
  onOpen: () => void
  onRename: () => void
  onRenameCommit: () => void
  onStar: () => void
  onMove: () => void
  onShare: () => void
  onTrash: () => void
  onRestore: () => void
  onDelete: () => void
}

function FileCard({
  file, Icon, type, view, renaming, renameValue, setRenaming, setRenameValue,
  menuOpen, setMenuOpen, onOpen, onRename, onRenameCommit,
  onStar, onMove, onShare, onTrash, onRestore, onDelete,
}: FileCardProps) {
  const inTrash = view === 'trash'
  return (
    <div className="group bg-paper rounded-lg border border-line hover:border-line-strong hover:shadow-e2 hover:-translate-y-0.5 transition-[transform,box-shadow,border-color] duration-base ease-out cursor-pointer overflow-hidden">
      <div
        className="h-28 relative border-b border-line cursor-pointer rounded-t-lg focus-visible:outline-none focus-visible:shadow-focus focus-visible:z-10"
        onClick={inTrash ? undefined : onOpen}
        role="button"
        tabIndex={inTrash ? -1 : 0}
        aria-label={`Open ${file.name}`}
        onKeyDown={(e) => { if (!inTrash && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen() } }}
      >
        <DocThumb type={type} className="h-full" />
        {/* Star badge (top-left) — always visible when starred, hover otherwise. */}
        {!inTrash && (
          <button
            className={[
              'absolute top-2 left-2 w-6 h-6 rounded-md flex items-center justify-center transition-[opacity,transform,color]',
              file.starred
                ? 'opacity-100 text-warning'
                : 'opacity-0 group-hover:opacity-100 text-ink-faint hover:text-warning',
              'bg-bg-elevated/80 backdrop-blur-sm border border-line',
            ].join(' ')}
            onClick={(e) => { e.stopPropagation(); onStar() }}
            aria-label={file.starred ? 'Unstar' : 'Star'}
            aria-pressed={!!file.starred}
          >
            <Star size={13} fill={file.starred ? 'currentColor' : 'none'} />
          </button>
        )}
        <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 translate-y-0.5 group-hover:translate-y-0 transition-[opacity,transform] duration-fast">
          <span className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-bg-elevated/80 backdrop-blur-sm border border-line">
            <ArrowUpRight size={13} className="text-ink-muted" />
          </span>
        </div>
      </div>
      <div className="p-3" onClick={inTrash ? undefined : onOpen}>
        {renaming === file.id ? (
          <input
            autoFocus
            value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onBlur={onRenameCommit}
            onKeyDown={e => { if (e.key === 'Enter') onRenameCommit(); if (e.key === 'Escape') setRenaming(null) }}
            className="w-full text-xs font-semibold border border-accent rounded-sm px-1 focus:outline-none bg-paper text-ink"
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <p className="text-xs font-semibold text-ink truncate tracking-tightish">{file.name}</p>
        )}
        <div className="flex items-center justify-between mt-1.5">
          <span className="text-2xs text-ink-faint flex items-center gap-1 tracking-tightish">
            <Clock size={9} />{timeAgo(file.updated_at)}
          </span>
          <div className="relative" onClick={e => e.stopPropagation()}>
            <button
              onClick={() => setMenuOpen(menuOpen === file.id ? null : file.id)}
              className="p-0.5 rounded-sm hover:bg-accent-tint text-ink-faint opacity-0 group-hover:opacity-100 transition-[opacity,background] duration-fast"
              aria-label="File actions"
            >
              <MoreVertical size={12} />
            </button>
            {menuOpen === file.id && (
              <div className="absolute right-0 bottom-full mb-1 w-36 bg-paper border border-line rounded-lg shadow-e2 z-20 py-1 text-xs overflow-hidden animate-scale-in">
                {inTrash ? (
                  <>
                    <MenuItem onClick={onRestore}><RotateCcw size={12} className="text-ink-faint" /> Restore</MenuItem>
                    <MenuItem danger onClick={onDelete}><Trash2 size={12} /> Delete forever</MenuItem>
                  </>
                ) : (
                  <>
                    <MenuItem onClick={onShare}><Share2 size={12} className="text-ink-faint" /> Share</MenuItem>
                    <MenuItem onClick={onStar}>
                      <Star size={12} className="text-ink-faint" /> {file.starred ? 'Unstar' : 'Star'}
                    </MenuItem>
                    <MenuItem onClick={onMove}><FolderInput size={12} className="text-ink-faint" /> Move to…</MenuItem>
                    <MenuItem onClick={onRename}><Pencil size={12} className="text-ink-faint" /> Rename</MenuItem>
                    <MenuItem danger onClick={onTrash}><Trash2 size={12} /> Move to trash</MenuItem>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── FileListTable ────────────────────────────────────────────────────────────
interface FileListTableProps {
  files: DiwanFile[]
  cfg: AppConfig
  Icon: LucideIcon
  view: 'browse' | 'starred' | 'trash'
  renaming: string | null
  renameValue: string
  setRenaming: (v: string | null) => void
  setRenameValue: (v: string) => void
  menuOpen: string | null
  setMenuOpen: (v: string | null) => void
  onOpen: (file: DiwanFile) => void
  onRename: (file: DiwanFile) => void
  onRenameCommit: (id: string) => void
  onStar: (id: string) => void
  onMove: (file: DiwanFile) => void
  onShare: (file: DiwanFile) => void
  onTrash: (id: string) => void
  onRestore: (id: string) => void
  onDelete: (id: string) => void
}

function FileListTable({
  files, cfg, Icon, view, renaming, renameValue, setRenaming, setRenameValue,
  menuOpen, setMenuOpen, onOpen, onRename, onRenameCommit,
  onStar, onMove, onShare, onTrash, onRestore, onDelete,
}: FileListTableProps) {
  const inTrash = view === 'trash'
  return (
    <Card>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line bg-bg-elev2">
            <th className="text-left px-4 py-2.5 text-2xs font-semibold text-ink-faint tracking-eyebrow uppercase">Name</th>
            <th className="text-left px-4 py-2.5 text-2xs font-semibold text-ink-faint tracking-eyebrow uppercase">Modified</th>
            <th className="w-10" />
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {files.map(file => (
            <tr
              key={file.id}
              className="group hover:bg-accent-tint cursor-pointer transition-colors duration-fast"
              onClick={inTrash ? undefined : () => onOpen(file)}
            >
              <td className="px-4 py-3">
                <div className="flex items-center gap-3">
                  <div className={`w-8 h-8 ${cfg.bgCn} rounded-md flex items-center justify-center flex-shrink-0`}>
                    <Icon size={14} className={cfg.iconCn} />
                  </div>
                  {renaming === file.id ? (
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={e => setRenameValue(e.target.value)}
                      onBlur={() => onRenameCommit(file.id)}
                      onKeyDown={e => { if (e.key === 'Enter') onRenameCommit(file.id); if (e.key === 'Escape') setRenaming(null) }}
                      className="font-medium border border-accent rounded-sm px-1 text-sm focus:outline-none bg-paper text-ink"
                      onClick={e => e.stopPropagation()}
                    />
                  ) : (
                    <span className="font-medium text-ink tracking-tightish flex items-center gap-1.5">
                      {file.name}
                      {file.starred && !inTrash && <Star size={11} className="text-warning" fill="currentColor" />}
                    </span>
                  )}
                </div>
              </td>
              <td className="px-4 py-3 text-2xs text-ink-faint tracking-tightish">{timeAgo(file.updated_at)}</td>
              <td className="px-2 py-3" onClick={e => e.stopPropagation()}>
                <div className="relative">
                  <button
                    onClick={() => setMenuOpen(menuOpen === file.id ? null : file.id)}
                    className="p-1 rounded-sm hover:bg-accent-tint text-ink-faint opacity-0 group-hover:opacity-100 transition-[opacity,background] duration-fast"
                    aria-label="File actions"
                  >
                    <MoreVertical size={14} />
                  </button>
                  {menuOpen === file.id && (
                    <div className="absolute right-0 top-full mt-1 w-36 bg-paper border border-line rounded-lg shadow-e2 z-20 py-1 text-xs overflow-hidden animate-scale-in">
                      {inTrash ? (
                        <>
                          <MenuItem onClick={() => onRestore(file.id)}><RotateCcw size={12} className="text-ink-faint" /> Restore</MenuItem>
                          <MenuItem danger onClick={() => onDelete(file.id)}><Trash2 size={12} /> Delete forever</MenuItem>
                        </>
                      ) : (
                        <>
                          <MenuItem onClick={() => onShare(file)}><Share2 size={12} className="text-ink-faint" /> Share</MenuItem>
                          <MenuItem onClick={() => onStar(file.id)}>
                            <Star size={12} className="text-ink-faint" /> {file.starred ? 'Unstar' : 'Star'}
                          </MenuItem>
                          <MenuItem onClick={() => onMove(file)}><FolderInput size={12} className="text-ink-faint" /> Move to…</MenuItem>
                          <MenuItem onClick={() => onRename(file)}><Pencil size={12} className="text-ink-faint" /> Rename</MenuItem>
                          <MenuItem danger onClick={() => onTrash(file.id)}><Trash2 size={12} /> Move to trash</MenuItem>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

// ─── MoveToFolderModal ────────────────────────────────────────────────────────
interface MoveToFolderModalProps {
  file: DiwanFile
  folders: DiwanFolder[]
  onClose: () => void
  onMove: (targetId: string) => void
}

function MoveToFolderModal({ file, folders, onClose, onMove }: MoveToFolderModalProps) {
  const byParent = useMemo(() => {
    const m = new Map<string, DiwanFolder[]>()
    for (const f of folders) {
      const p = f.parent_id || ''
      if (!m.has(p)) m.set(p, [])
      m.get(p)!.push(f)
    }
    return m
  }, [folders])

  const renderTree = (parent: string, depth: number): React.ReactNode => (byParent.get(parent) || []).map(f => (
    <div key={f.id}>
      <button
        className={[
          'w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left rounded-sm hover:bg-accent-tint transition-colors',
          (file.parent_id || '') === f.id ? 'text-ink-faint' : 'text-ink',
        ].join(' ')}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
        onClick={() => onMove(f.id)}
        disabled={(file.parent_id || '') === f.id}
      >
        <Folder size={13} className="text-accent flex-shrink-0" />
        <span className="truncate">{f.name}</span>
        {(file.parent_id || '') === f.id && <span className="ml-auto text-2xs text-ink-faint">current</span>}
      </button>
      {renderTree(f.id, depth + 1)}
    </div>
  ))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-paper border border-line rounded-xl shadow-e3 w-full max-w-sm mx-4 animate-scale-in" onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-line">
          <p className="text-sm font-semibold text-ink tracking-tightish">Move “{file.name}”</p>
          <p className="text-2xs text-ink-faint mt-0.5">Choose a destination folder</p>
        </div>
        <div className="max-h-72 overflow-auto py-1">
          <button
            className={[
              'w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left rounded-sm hover:bg-accent-tint transition-colors',
              (file.parent_id || '') === '' ? 'text-ink-faint' : 'text-ink',
            ].join(' ')}
            onClick={() => onMove('')}
            disabled={(file.parent_id || '') === ''}
          >
            <Home size={13} className="text-ink-faint flex-shrink-0" />
            <span>Home (root)</span>
            {(file.parent_id || '') === '' && <span className="ml-auto text-2xs text-ink-faint">current</span>}
          </button>
          {renderTree('', 0)}
          {folders.length === 0 && (
            <p className="px-3 py-4 text-2xs text-ink-faint text-center">No folders yet — create one first.</p>
          )}
        </div>
        <div className="px-4 py-3 border-t border-line flex justify-end">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </div>
  )
}
