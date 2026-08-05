/**
 * Menu — shared, keyboard- and touch-accessible dropdown menu.
 * ----------------------------------------------------------------------------
 * Promoted from the working `Dropdown` pattern in DocsToolbar so all four
 * editors (Docs / Sheets / Slides / PDF) share ONE menu implementation instead
 * of each re-rolling a hover-only `hidden group-hover:block` panel.
 *
 * Behaviour:
 *   - explicit open state (click / Enter / Space / ArrowDown to open)
 *   - Escape closes and returns focus to the trigger
 *   - outside-click (mousedown) closes
 *   - focus moves into the panel on open; ArrowUp/Down/Home/End roam items
 *   - selecting an item closes the menu
 *
 * Usage (drop-in for the old Dropdown):
 *   <Menu trigger={<button className="toolbar-btn">…</button>} align="right" width="w-52">
 *     <Menu.Item onClick={…}>Export…</Menu.Item>
 *   </Menu>
 *
 * The `trigger` is a single React element; Menu clones it to wire up the
 * open/close handlers + aria-haspopup / aria-expanded, so call sites keep
 * their own trigger styling.
 */

import { cloneElement, useCallback, useEffect, useRef, useState } from 'react'
import type { ButtonHTMLAttributes, MouseEvent as ReactMouseEvent, KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode, Ref } from 'react'

const FOCUSABLE = 'input:not([disabled]), [role="menuitem"]:not([disabled])'
const ITEM_SEL = '[role="menuitem"]:not([disabled])'

interface TriggerProps {
  onClick?: (e: ReactMouseEvent) => void
  onKeyDown?: (e: ReactKeyboardEvent) => void
}

// React elements carry a legacy top-level `ref` alongside `props` (outside the
// public ReactElement<P> type surface) — this mirrors that at the type level
// so we can read/merge the caller's own ref, same as the original JS did.
interface ElementWithRef {
  ref?: Ref<HTMLElement> | null
}

interface MenuProps {
  trigger: ReactElement<TriggerProps>
  children?: ReactNode
  align?: 'left' | 'right'
  width?: string
  className?: string
}

function MenuBase({ trigger, children, align = 'left', width = 'w-44', className = '' }: MenuProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLElement | null>(null)

  const close = useCallback((restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus?.()
  }, [])

  // Outside-click + Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(true) } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close])

  // Move focus into the panel on open.
  useEffect(() => {
    if (open) (menuRef.current?.querySelector(FOCUSABLE) as HTMLElement | null)?.focus()
  }, [open])

  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    if (!menuRef.current) return
    const items = [...menuRef.current.querySelectorAll<HTMLElement>(ITEM_SEL)]
    if (!items.length) return
    e.preventDefault()
    const i = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown') items[(i + 1) % items.length].focus()
    else if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length].focus()
    else if (e.key === 'Home') items[0].focus()
    else items[items.length - 1].focus()
  }

  const triggerEl = cloneElement(trigger, {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node
      const r = (trigger as unknown as ElementWithRef).ref
      if (typeof r === 'function') r(node)
      else if (r) (r as { current: HTMLElement | null }).current = node
    },
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    onClick: (e: ReactMouseEvent) => { trigger.props.onClick?.(e); setOpen((v) => !v) },
    onKeyDown: (e: ReactKeyboardEvent) => {
      trigger.props.onKeyDown?.(e)
      if (e.key === 'ArrowDown' || ((e.key === 'Enter' || e.key === ' ') && !open)) {
        e.preventDefault()
        setOpen(true)
      }
    },
  } as Partial<TriggerProps> & { ref: Ref<HTMLElement>; 'aria-haspopup': string; 'aria-expanded': boolean })

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      {triggerEl}
      {open && (
        <div
          ref={menuRef}
          role="menu"
          onKeyDown={onMenuKeyDown}
          onClick={() => setOpen(false)}
          className={[
            'absolute top-full mt-0.5 py-1 z-50',
            'bg-paper border border-line rounded-md shadow-e2 animate-scale-in',
            align === 'right' ? 'right-0' : 'left-0',
            width,
          ].join(' ')}
        >
          {children}
        </div>
      )}
    </div>
  )
}

interface MenuItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children?: ReactNode
  active?: boolean | undefined
}

function MenuItem({ children, onClick, active, disabled, className = '', ...rest }: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={[
        'w-full text-left px-3 py-1.5 text-sm flex items-center gap-2',
        'transition-colors hover:bg-accent-tint focus:bg-accent-tint focus:outline-none',
        'disabled:opacity-40 disabled:cursor-not-allowed',
        active ? 'text-accent font-medium' : 'text-ink-muted',
        className,
      ].join(' ')}
      {...rest}
    >
      {children}
    </button>
  )
}

// Non-interactive section label for grouping items.
function MenuLabel({ children }: { children?: ReactNode }) {
  return (
    <p className="px-3 py-1 text-2xs font-semibold text-ink-faint tracking-eyebrow uppercase select-none">
      {children}
    </p>
  )
}

function MenuSep() {
  return <div className="my-1 border-t border-line" aria-hidden="true" />
}

const Menu = Object.assign(MenuBase, { Item: MenuItem, Label: MenuLabel, Sep: MenuSep })

export default Menu
