/**
 * Tooltip — hover/focus label rendered in a portal.
 *
 *   <Tooltip label="Bold (⌘B)"><IconButton>…</IconButton></Tooltip>
 *
 * The bubble is portalled to <body> and positioned from the trigger's bounding
 * rect, so it no longer clips inside `overflow-x-auto` / `overflow-hidden`
 * toolbars (the old absolute-in-flow approach did). Appears after a short delay
 * so sweeping the cursor across a toolbar doesn't flicker.
 */

import { cloneElement, isValidElement, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode, ReactElement } from 'react'
import { createPortal } from 'react-dom'

const GAP = 6

type TooltipSide = 'top' | 'bottom' | 'left' | 'right'

interface TooltipProps {
  label?: ReactNode
  children: ReactNode
  side?: TooltipSide
  className?: string
}

export default function Tooltip({ label, children, side = 'bottom', className = '' }: TooltipProps) {
  const wrapRef = useRef<HTMLSpanElement>(null)
  const bubbleRef = useRef<HTMLSpanElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })

  useEffect(() => () => clearTimeout(timer.current), [])

  if (!label) return children

  // The bubble is visual-only (pointer-events:none, portalled). It does NOT
  // provide an accessible name. So if the wrapped control has no name of its
  // own, borrow the tooltip label as its aria-label — otherwise an icon-only
  // button reads as an anonymous "button" to assistive tech. We deliberately
  // do NOT touch a child that already has a name via aria-label/-labelledby,
  // a title, or visible text content (overriding visible text would violate
  // WCAG 2.5.3 "Label in Name").
  // React.ReactElement's `props` is typed `any` upstream — narrow to just
  // the fields this accessibility check reads.
  type ChildProps = {
    children?: unknown
    'aria-label'?: unknown
    'aria-labelledby'?: unknown
    title?: unknown
  }
  const childProps = isValidElement(children) ? (children.props as ChildProps) : null
  const hasTextContent =
    childProps !== null &&
    ['string', 'number'].includes(typeof childProps.children)
  const labelledChildren =
    childProps !== null &&
    !childProps['aria-label'] &&
    !childProps['aria-labelledby'] &&
    !childProps.title &&
    !hasTextContent
      ? cloneElement(children as ReactElement, { 'aria-label': label })
      : children

  const show = () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setOpen(true), 300)
  }
  const hide = () => {
    clearTimeout(timer.current)
    setOpen(false)
  }

  // Position relative to the trigger once visible.
  useLayoutEffect(() => {
    if (!open || !wrapRef.current) return
    const r = wrapRef.current.getBoundingClientRect()
    const b = bubbleRef.current?.getBoundingClientRect() || { width: 0, height: 0 }
    let top = 0, left = 0
    if (side === 'bottom') { top = r.bottom + GAP; left = r.left + r.width / 2 - b.width / 2 }
    else if (side === 'top') { top = r.top - GAP - b.height; left = r.left + r.width / 2 - b.width / 2 }
    else if (side === 'right') { top = r.top + r.height / 2 - b.height / 2; left = r.right + GAP }
    else { top = r.top + r.height / 2 - b.height / 2; left = r.left - GAP - b.width }
    // Keep inside the viewport horizontally.
    left = Math.max(4, Math.min(left, window.innerWidth - b.width - 4))
    setPos({ top, left })
  }, [open, side, label])

  return (
    <span
      ref={wrapRef}
      className={`inline-flex ${className}`}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocusCapture={show}
      onBlurCapture={hide}
    >
      {labelledChildren}
      {open && createPortal(
        <span
          ref={bubbleRef}
          role="tooltip"
          style={{ top: pos.top, left: pos.left }}
          className={[
            'pointer-events-none fixed z-[200] whitespace-nowrap',
            'px-2 py-1 rounded-sm text-2xs font-medium tracking-tightish',
            'bg-ink text-paper shadow-e2 animate-fade-in',
          ].join(' ')}
        >
          {label}
        </span>,
        document.body,
      )}
    </span>
  )
}
