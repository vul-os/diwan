/**
 * Sidebar primitives — Diwan's warm vertical app rail (sand chrome on ivory).
 *
 * Pieces:
 *   - <Sidebar>             root container; manages width (collapsed/expanded)
 *   - <Sidebar.Brand>       Diwan mark + serif wordmark (fades collapsed)
 *   - <Sidebar.Section>     labelled group; mono uppercase label, hides collapsed
 *   - <Sidebar.Item>        nav row; ember left-rail + calm tint when active,
 *                           optional per-app icon tint at rest
 *   - <Sidebar.Footer>      sticky bottom region (settings, collapse toggle…)
 *
 * Design DNA:
 *   - Surface is warm sand, one step off the ivory canvas, with a hairline edge.
 *   - Active = a 2.5px ember left-rail + a calm accent-tint bg (no coloured
 *     border) + the icon brightening to ember. The rail marks, it doesn't box.
 *   - At rest, app icons carry one calm tint each (iconAccent) so
 *     Docs/Sheets/Slides/Board/PDF are findable at a glance.
 *   - Mono uppercase section labels; width transitions 200ms so it feels considered.
 */

import { createContext, useContext } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { PanelLeftClose, PanelLeftOpen, ChevronsLeft } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export type SidebarMode = 'expanded' | 'mini' | 'hidden'

const SidebarCtx = createContext<{ collapsed: boolean }>({ collapsed: false })

/**
 * DiwanMark — the brand glyph: an **iwan**, the vaulted portal at the heart of
 * Persian and Ottoman architecture — the opening onto the room where the
 * registers were kept.  Turned a quarter turn clockwise the arch's two legs
 * become the bars of a D and the teal threshold becomes its stem.
 *
 * A flat two-colour glyph on transparency (ember arch, teal threshold) — it
 * carries no tile of its own, so callers must NOT give it a rounded background
 * or a drop shadow.
 * Self-contained inline SVG (no asset request), so it's crisp at any size.
 * Reused by the rail brand + the mobile header + the login screen.
 */
interface DiwanMarkProps {
  size?: number
  className?: string
}

export function DiwanMark({ size = 32, className = '' }: DiwanMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M12 55 L12 31 A22.1 22.1 0 0 1 32 9 A22.1 22.1 0 0 1 52 31 L52 55 L44 55 L44 31 A14.17 14.17 0 0 0 32 17 A14.17 14.17 0 0 0 20 31 L20 55 Z"
        fill="#D0471F"
      />
      <rect x="20" y="47" width="24" height="8" fill="#0E8B86" />
    </svg>
  )
}

/**
 * <Sidebar mode> — three desktop states:
 *   'expanded' (244px, icons + labels + doc list)
 *   'mini'     (60px icon-only rail, native tooltips)
 *   'hidden'   (0px, collapsed off; content goes full-width)
 * `collapsed` is still accepted as a legacy alias for the mini state.
 */
interface SidebarProps {
  mode?: SidebarMode
  collapsed?: boolean
  children?: ReactNode
  className?: string
}

function Sidebar({ mode, collapsed: collapsedProp, children, className = '' }: SidebarProps) {
  const resolved: SidebarMode = mode || (collapsedProp ? 'mini' : 'expanded')
  const collapsed = resolved === 'mini'
  const hidden = resolved === 'hidden'
  return (
    <SidebarCtx.Provider value={{ collapsed }}>
      <aside
        className={[
          'relative flex flex-col flex-shrink-0',
          'bg-bg-elev2 text-ink-muted',
          hidden ? 'border-r-0 overflow-hidden' : 'border-r border-line',
          'transition-[width,opacity] duration-base ease-out motion-reduce:transition-none',
          hidden ? 'w-0 opacity-0 pointer-events-none' : collapsed ? 'w-[60px]' : 'w-[244px]',
          className,
        ].join(' ')}
        aria-hidden={hidden || undefined}
      >
        {children}
      </aside>
    </SidebarCtx.Provider>
  )
}

/**
 * Sidebar.Brand — mark + wordmark, plus the sidebar collapse control at the top.
 * When `onSetMode` is provided (desktop rail) it renders the state control:
 *   expanded → a "minimise" button (to the mini rail)
 *   mini     → stacked "expand" + "hide" buttons
 * The mobile drawer omits `onSetMode` (it closes via its own backdrop/Esc).
 */
interface SidebarBrandProps {
  name?: string
  onSetMode?: ((mode: SidebarMode) => void) | undefined
}

function SidebarBrand({ name = 'Diwan', onSetMode }: SidebarBrandProps) {
  const { collapsed } = useContext(SidebarCtx)

  const ctrlBtn =
    'flex items-center justify-center rounded-md text-ink-faint hover:text-ink ' +
    'hover:bg-bg-hover transition-colors duration-fast ease-out ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40'

  if (collapsed) {
    // Mini rail: mark on top, then two stacked controls (expand / hide).
    return (
      <div className="flex flex-col items-center gap-1.5 pt-2.5 pb-2 border-b border-line flex-shrink-0">
        <DiwanMark size={28} className="flex-shrink-0" />
        {onSetMode && (
          <div className="flex flex-col items-center gap-0.5">
            <button type="button" title="Expand sidebar" aria-label="Expand sidebar"
              onClick={() => onSetMode('expanded')} className={`${ctrlBtn} w-7 h-6`}>
              <PanelLeftOpen size={15} />
            </button>
            <button type="button" title="Hide sidebar" aria-label="Hide sidebar"
              onClick={() => onSetMode('hidden')} className={`${ctrlBtn} w-7 h-6`}>
              <ChevronsLeft size={15} />
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2.5 h-14 px-4 border-b border-line flex-shrink-0">
      <DiwanMark size={30} className="flex-shrink-0" />
      <div className="flex flex-col min-w-0">
        <span className="font-display text-[20px] font-bold tracking-display text-ink truncate leading-none">
          {name}
        </span>
        <span className="font-mono text-[8.5px] font-medium uppercase tracking-[0.22em] text-ink-faint leading-none mt-[5px]">
          Office Suite
        </span>
      </div>
      {onSetMode && (
        <button type="button" title="Minimise sidebar" aria-label="Minimise sidebar"
          onClick={() => onSetMode('mini')} className={`${ctrlBtn} ml-auto -mr-1 w-7 h-7`}>
          <PanelLeftClose size={17} />
        </button>
      )}
    </div>
  )
}

interface SidebarSectionProps {
  label?: ReactNode
  children?: ReactNode
  className?: string
}

function SidebarSection({ label, children, className = '' }: SidebarSectionProps) {
  const { collapsed } = useContext(SidebarCtx)
  return (
    <div className={`px-2 ${className}`}>
      {!collapsed && label && (
        <p className="px-2 pt-3.5 pb-1.5 font-mono text-[10px] font-medium text-ink-faint uppercase tracking-wider select-none">
          {label}
        </p>
      )}
      {collapsed && label && <div className="border-t border-line mx-2 my-2" />}
      <div className="flex flex-col gap-px">{children}</div>
    </div>
  )
}

/**
 * Sidebar.Item — accepts either `to` (renders NavLink) or `onClick` (button).
 * Active = teal left-rail + selected tint + hairline teal border + teal icon.
 */
interface SidebarItemProps {
  to?: string
  end?: boolean
  onClick?: ((e: MouseEvent) => void) | undefined
  icon?: LucideIcon
  iconAccent?: string    // optional category tint for the icon when not active
  dense?: boolean         // tighter row height + smaller glyph (Recent files)
  title?: string
  children?: ReactNode
  variant?: 'nav' | 'danger'
}

function SidebarItem({
  to,
  end,
  onClick,
  icon: Icon,
  iconAccent,    // optional category tint for the icon when not active
  dense,         // tighter row height + smaller glyph (Recent files)
  title,
  children,
  variant = 'nav',
}: SidebarItemProps) {
  const { collapsed } = useContext(SidebarCtx)
  const glyph = dense ? 14 : 16

  const renderInner = (isActive: boolean) => (
    <>
      {/* Accent left-rail — the active marker. A calm bar that "gets out of the
          way" instead of boxing the whole row. */}
      <span
        aria-hidden
        className={[
          'absolute left-0 top-1 bottom-1 w-[2.5px] rounded-r-full bg-accent',
          'transition-opacity duration-fast ease-out',
          isActive ? 'opacity-100' : 'opacity-0',
        ].join(' ')}
      />
      {Icon && (
        <Icon
          size={glyph}
          strokeWidth={isActive ? 2.1 : 1.8}
          className={[
            'flex-shrink-0 transition-colors duration-fast ease-out',
            isActive ? 'text-accent-press' : iconAccent || 'text-ink-faint group-hover:text-ink-muted',
          ].join(' ')}
        />
      )}
      {!collapsed && (
        <span className="flex-1 min-w-0 flex items-center gap-1.5">
          <span className="truncate text-[13px] tracking-tightish">{children}</span>
        </span>
      )}
    </>
  )

  const cn = (isActive: boolean) =>
    [
      'group relative flex items-center gap-2.5 px-2.5 rounded-md',
      dense ? 'h-7' : 'h-8',
      'transition-colors duration-fast ease-out',
      collapsed ? 'justify-center' : '',
      // Active = subtle accent tint + rail (above) + brightened icon. No
      // coloured border, so the row reads calm rather than filled/boxed.
      isActive
        ? 'bg-accent-tint text-ink border border-transparent'
        : 'text-ink-muted border border-transparent hover:bg-bg-hover hover:text-ink',
      variant === 'danger' ? 'hover:bg-danger-bg hover:text-danger hover:border-transparent' : '',
    ].join(' ')

  if (to) {
    return (
      <NavLink to={to} end={!!end} title={title} onClick={onClick} className={({ isActive }) => cn(isActive)}>
        {({ isActive }) => renderInner(isActive)}
      </NavLink>
    )
  }
  return (
    <button type="button" onClick={onClick} title={title} className={cn(false)}>
      {renderInner(false)}
    </button>
  )
}

function SidebarFooter({ children }: { children?: ReactNode }) {
  return (
    <div className="mt-auto border-t border-line pt-2 pb-1 px-2 flex flex-col gap-px">
      {children}
    </div>
  )
}

const SidebarWithSlots = Object.assign(Sidebar, {
  Brand: SidebarBrand,
  Section: SidebarSection,
  Item: SidebarItem,
  Footer: SidebarFooter,
})

export { SidebarWithSlots as Sidebar }
export default SidebarWithSlots
