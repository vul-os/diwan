/**
 * Layout — app shell.
 *
 * Composed against src/components/ui (Sidebar primitives, Topbar primitives).
 *
 * Aesthetic notes:
 *   - Sidebar uses an accent-rail to mark the active app instead of filling
 *     the row, so the rail "gets out of the way" of the work surface.
 *   - App icons keep one warm tint each (so users can find Sheets / Slides /
 *     PDF at a glance) but those tints sit at low saturation and only show
 *     on the icon itself, never on a row background.
 *   - The bottom-right "theme cycler" gives users explicit control over the
 *     warm-dark mode — calmer than slamming the inversion on every load.
 *
 * Responsive:
 *   - ≥lg: the rail is a persistent column, collapsible to an icon strip.
 *   - <lg: the rail collapses off-canvas. A slim mobile header (hamburger +
 *     brand) sits above the work surface; tapping the hamburger slides the rail
 *     in over a scrim. Selecting any destination closes the drawer.
 *
 * Routes / props: unchanged — it still wraps `children` and reads from
 * `useAuthStore` + `useFilesStore`.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Home as HomeIcon, FileText, Table2, Presentation, FileSearch, PenTool,
  LogOut, PanelLeftOpen, Settings as SettingsIcon, Plus,
  Menu, Bell,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useAuthStore } from '../store/authStore'
import { useFilesStore } from '../store/filesStore'
import type { DiwanFile } from '../store/filesStore'
import { useNotificationsStore } from '../store/notificationsStore'
import NewFileModal from './NewFileModal'
import NotificationsPanel from './NotificationsPanel'
import { Sidebar, IconButton, Tooltip, ThemeSwitch, DiwanMark } from './ui'
import type { SidebarMode } from './ui/Sidebar'

interface NavApp {
  label: string
  icon: LucideIcon
  route: string
  tint: string
  beta?: boolean
}

// Each app icon carries one low-saturation tint at rest (so users find
// Sheets/Slides/PDF at a glance); it brightens to accent only when its app is
// active — the cloud "restrained accent" trait. Tints live on the icon glyph
// only (never a row bg) and match the Home page cards so rail ↔ content agree.
// Office is documents-only: chat/video and calendar/contacts are third-party and
// are NOT launched from here.
const NAV_APPS: NavApp[] = [
  { label: 'Docs',        icon: FileText,      route: '/docs',        tint: 'text-app-docs'   },
  { label: 'Sheets',      icon: Table2,        route: '/sheets',      tint: 'text-app-sheets' },
  { label: 'Slides',      icon: Presentation,  route: '/slides',      tint: 'text-app-slides' },
  { label: 'Whiteboards', icon: PenTool,       route: '/whiteboards', tint: 'text-app-board'  },
  { label: 'PDF',         icon: FileSearch,    route: '/pdf',         tint: 'text-app-pdf'    },
]

// Recent-file rows mirror the app tints so a recent doc/sheet/slide/whiteboard
// reads the same hue as its app in the rail above.
const RECENT_ICON: Record<string, LucideIcon> = { doc: FileText, sheet: Table2, slide: Presentation, whiteboard: PenTool }
const RECENT_TINT: Record<string, string> = { doc: 'text-app-docs', sheet: 'text-app-sheets', slide: 'text-app-slides', whiteboard: 'text-app-board' }

/**
 * SidebarContent — the rail body, shared between the persistent (≥lg) column
 * and the mobile drawer. `collapsed` only applies to the desktop column;
 * `onNavigate` is fired on any destination tap so the drawer can close itself.
 */
interface SidebarContentProps {
  collapsed: boolean
  onNavigate?: () => void
  onNewFile: () => void
  onSetMode?: (mode: SidebarMode) => void
}

function SidebarContent({ collapsed, onNavigate, onNewFile, onSetMode }: SidebarContentProps) {
  const { status, logout } = useAuthStore()
  const { files } = useFilesStore()
  const navigate = useNavigate()
  const { items: notifs, fetch: fetchNotifs } = useNotificationsStore()
  const [notifOpen, setNotifOpen] = useState(false)

  // Poll for @-mention notifications so the badge stays fresh.
  useEffect(() => {
    void fetchNotifs()
    const t = setInterval(() => { void fetchNotifs() }, 60000)
    return () => clearInterval(t)
  }, [fetchNotifs])
  const unread = notifs.filter((n) => !n.read).length
  const fileTypeOf = (id: string) => files.find((f) => f.id === id)?.type

  const recentFiles = files.slice(0, 5)
  const TYPE_ROUTE: Record<string, string> = { doc: 'docs', sheet: 'sheets', slide: 'slides', whiteboard: 'whiteboards' }
  const typeRoute = (f: DiwanFile) => `/${TYPE_ROUTE[f.type] || 'docs'}/${f.id}`

  return (
    <>
      <Sidebar.Brand name="Diwan" onSetMode={onSetMode} />

      <Sidebar.Section>
        {/* "New" is the only emphatic button in the rail — primary accent. */}
        <button
          onClick={() => { onNewFile(); onNavigate?.() }}
          title="New file"
          className={[
            'relative flex items-center gap-2 h-9 mt-2 rounded-lg',
            'bg-accent text-white border border-accent shadow-e1',
            'hover:bg-accent-hover active:translate-y-px',
            'transition-[background,transform] duration-fast ease-out',
            'text-[13px] font-semibold tracking-tightish',
            collapsed ? 'justify-center px-0' : 'px-3',
          ].join(' ')}
        >
          <Plus size={16} strokeWidth={2.2} className="flex-shrink-0" />
          {!collapsed && <span>New file</span>}
        </button>
        <div className="mt-1.5">
          <Sidebar.Item to="/" end icon={HomeIcon} title="Home" onClick={onNavigate}>Home</Sidebar.Item>
        </div>
      </Sidebar.Section>

      <Sidebar.Section label="Apps">
        {NAV_APPS.map(({ label, icon, route, beta, tint }) => (
          <Sidebar.Item
            key={route}
            to={route}
            icon={icon}
            iconAccent={tint}
            title={beta ? `${label} (beta)` : label}
            onClick={onNavigate}
          >
            {label}
            {beta && !collapsed && (
              <span className="font-mono text-[8.5px] px-1 py-px rounded-sm bg-brand-purple-subtle text-brand-purple font-medium leading-none uppercase tracking-wide">
                beta
              </span>
            )}
          </Sidebar.Item>
        ))}
      </Sidebar.Section>

      {recentFiles.length > 0 && !collapsed && (
        <Sidebar.Section label="Recent">
          {recentFiles.map((f) => (
            <Sidebar.Item
              key={f.id}
              dense
              icon={RECENT_ICON[f.type] || FileText}
              iconAccent={RECENT_TINT[f.type] || 'text-ink-faint'}
              onClick={() => { void navigate(typeRoute(f)); onNavigate?.() }}
              title={f.name}
            >
              {f.name}
            </Sidebar.Item>
          ))}
        </Sidebar.Section>
      )}

      <Sidebar.Footer>
        {/* @-mention notifications — a bell with an unread badge + popover. */}
        <div className="relative">
          <button
            onClick={() => setNotifOpen((v) => !v)}
            title="Notifications"
            className={[
              'relative w-full flex items-center gap-2 h-8 rounded-lg text-[13px] tracking-tightish transition-colors',
              collapsed ? 'justify-center px-0' : 'px-2.5',
              notifOpen ? 'bg-accent-tint text-ink' : 'text-ink-muted hover:bg-bg-elev2 hover:text-ink',
            ].join(' ')}
          >
            <span className="relative flex-shrink-0">
              <Bell size={15} />
              {unread > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[13px] h-[13px] px-0.5 rounded-full bg-accent text-white text-[8px] font-bold flex items-center justify-center leading-none">
                  {unread > 9 ? '9+' : unread}
                </span>
              )}
            </span>
            {!collapsed && <span>Notifications</span>}
          </button>
          {notifOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setNotifOpen(false)} />
              <div className="absolute bottom-full left-0 mb-2 z-50">
                <NotificationsPanel onClose={() => setNotifOpen(false)} fileTypeOf={fileTypeOf} />
              </div>
            </>
          )}
        </div>
        <Sidebar.Item to="/settings" icon={SettingsIcon} title="Settings" onClick={onNavigate}>
          Settings
        </Sidebar.Item>
        {status?.enabled && (
          <Sidebar.Item
            onClick={() => { void logout(); onNavigate?.() }}
            icon={LogOut}
            title="Sign out"
            variant="danger"
          >
            Sign out
          </Sidebar.Item>
        )}
      </Sidebar.Footer>
    </>
  )
}

const SIDEBAR_KEY = 'diwan.sidebar'
const SIDEBAR_MODES: SidebarMode[] = ['expanded', 'mini', 'hidden']

function Shell({ children }: { children?: ReactNode }) {
  // Desktop rail state — persisted across sessions. 'expanded' | 'mini' | 'hidden'.
  const [mode, setMode] = useState<SidebarMode>(() => {
    try {
      const m = localStorage.getItem(SIDEBAR_KEY)
      return SIDEBAR_MODES.includes(m as SidebarMode) ? (m as SidebarMode) : 'expanded'
    } catch { return 'expanded' }
  })
  const [mobileOpen, setMobileOpen] = useState(false)
  const [showNew, setShowNew] = useState(false)

  const openNew = () => setShowNew(true)
  const closeMobile = () => setMobileOpen(false)
  const collapsed = mode === 'mini'

  const applyMode = (m: SidebarMode) => {
    setMode(m)
    try { localStorage.setItem(SIDEBAR_KEY, m) } catch { /* private mode */ }
  }

  // Esc closes the mobile drawer.
  useEffect(() => {
    if (!mobileOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMobile() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mobileOpen])

  return (
    <div className="flex h-screen overflow-hidden bg-bg text-ink">
      {/* Persistent rail — ≥lg only. The <Sidebar> animates its own width and
          collapses to 0 when hidden, so the work surface reflows full-width. */}
      <div className="hidden lg:flex">
        <Sidebar mode={mode}>
          <SidebarContent collapsed={collapsed} onSetMode={applyMode} onNewFile={openNew} />
          {/* Appearance control lives at the foot; the collapse control now sits
              at the top of the rail (Sidebar.Brand). */}
          <div className={collapsed ? 'flex flex-col items-center px-2 pb-2' : 'px-3 pb-3 pt-1'}>
            <ThemeSwitch collapsed={collapsed} />
          </div>
        </Sidebar>
      </div>

      {/* When fully hidden (≥lg), a slim floating control brings the rail back. */}
      {mode === 'hidden' && (
        <div className="hidden lg:block absolute left-3 top-3 z-30">
          <Tooltip label="Show sidebar" side="right">
            <IconButton size="md" onClick={() => applyMode('expanded')} title="Show sidebar"
              className="bg-bg-elev1 border border-line shadow-e2">
              <PanelLeftOpen size={17} />
            </IconButton>
          </Tooltip>
        </div>
      )}

      {/* Mobile drawer — <lg: off-canvas overlay with scrim (backdrop + Esc close) */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div
            className="absolute inset-0 bg-black/40 animate-fade-in"
            onClick={closeMobile}
            aria-hidden
          />
          <div className="absolute left-0 top-0 bottom-0 animate-drawer-in">
            <Sidebar mode="expanded" className="h-full shadow-e3">
              <SidebarContent collapsed={false} onNavigate={closeMobile} onNewFile={openNew} />
              <div className="px-3 pb-3 pt-1">
                <ThemeSwitch />
              </div>
            </Sidebar>
          </div>
        </div>
      )}

      <main className="relative flex-1 flex flex-col min-w-0 overflow-hidden bg-bg">
        {/* Mobile header — only below lg, where the rail is off-canvas */}
        <header className="lg:hidden flex items-center gap-2.5 h-12 px-2 border-b border-line bg-bg-elev2 flex-shrink-0">
          <IconButton size="md" onClick={() => setMobileOpen(true)} title="Open navigation">
            <Menu size={18} />
          </IconButton>
          <DiwanMark size={26} />
          <span className="font-display text-[18px] font-bold tracking-display text-ink leading-none">Diwan</span>
        </header>
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">{children}</div>
      </main>

      {showNew && <NewFileModal onClose={() => setShowNew(false)} />}
    </div>
  )
}

export default function Layout({ children }: { children?: ReactNode }) {
  return <Shell>{children}</Shell>
}
