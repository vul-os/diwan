/**
 * useDialogA11y — Escape-to-close + focus-trap + focus-restore for bespoke
 * overlay dialogs that don't use the shared <Modal> shell (e.g. the Slides
 * theme/template galleries, which need their own chrome).
 *
 * Usage:
 *   const ref = useRef(null)
 *   useDialogA11y(ref, onClose)
 *   return <div ref={ref} role="dialog" aria-modal="true">…</div>
 *
 * Mirrors the focus-trap logic baked into <Modal>:
 *   1. Remember the element focused before the dialog opened.
 *   2. Move focus to the first focusable child on open.
 *   3. Wrap Tab / Shift-Tab focus within the dialog.
 *   4. Close on Escape.
 *   5. Restore focus to the trigger element on unmount.
 */

import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),' +
  'select:not([disabled]),[tabindex]:not([tabindex="-1"])'

export function useDialogA11y(containerRef: RefObject<HTMLElement | null>, onClose?: () => void): void {
  const priorFocusRef = useRef<Element | null>(null)

  useEffect(() => {
    priorFocusRef.current = document.activeElement
    const container = containerRef.current

    const focusables = (): HTMLElement[] =>
      Array.from(container?.querySelectorAll<HTMLElement>(FOCUSABLE) || [])

    // Move focus inside the dialog once painted.
    const raf = requestAnimationFrame(() => focusables()[0]?.focus())

    const onKeyDown = (e: KeyboardEvent) => {
      // Stop the Escape from bubbling to a parent dialog / editor handler so
      // one press closes only this dialog, not everything listening for Escape.
      if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); return }
      if (e.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('keydown', onKeyDown)
      const el = priorFocusRef.current
      if (el && typeof (el as HTMLElement).focus === 'function') (el as HTMLElement).focus()
    }
  }, [containerRef, onClose])
}

export default useDialogA11y
