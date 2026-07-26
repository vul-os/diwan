/**
 * Modal — centred dialog with soft scrim and a quiet open animation.
 *
 * Notes
 * -----
 * - Closes on backdrop click (`onClose`) and on Escape (Esc).
 * - Uses our `scale-in` keyframe + ease-spring for a calm appear motion.
 * - No portal — Ofisi is a single-root app and modals are scoped to it.
 * - Focus trap: focuses the first focusable element on open, cycles Tab/Shift-Tab
 *   within the dialog, and restores focus to the trigger element on close.
 *
 * Composition:
 *   <Modal open={…} onClose={…} title="…">
 *     <Modal.Body>…</Modal.Body>
 *     <Modal.Footer>…</Modal.Footer>
 *   </Modal>
 */

import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import IconButton from './IconButton'

// Selectors for all natively focusable elements.
const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),' +
  'select:not([disabled]),[tabindex]:not([tabindex="-1"])'

/**
 * useFocusTrap — keeps keyboard focus inside `containerRef` while `active` is
 * true, and restores focus to `triggerRef` (or the previously-focused element)
 * when the trap is released.
 *
 * Implementation is ~30 lines with no external deps. The approach:
 *  1. On activation: remember the element that currently has focus, then move
 *     focus to the first focusable child.
 *  2. On Tab/Shift-Tab: if focus would leave the container, wrap it.
 *  3. On deactivation: restore focus to the remembered element (or triggerRef).
 */
function useFocusTrap(containerRef, active) {
  const priorFocusRef = useRef(null)

  useEffect(() => {
    if (!active || !containerRef.current) return

    // Save whatever had focus before the modal opened.
    priorFocusRef.current = document.activeElement

    // Move focus to the first focusable element inside the dialog.
    const focusables = () =>
      Array.from(containerRef.current?.querySelectorAll(FOCUSABLE) || [])

    const first = focusables()[0]
    if (first) {
      // Small rAF delay so the modal has fully painted before we move focus
      // (avoids a flicker on some browsers).
      const id = requestAnimationFrame(() => first.focus())
      return () => cancelAnimationFrame(id)
    }
  }, [active, containerRef])

  useEffect(() => {
    if (!active || !containerRef.current) return

    function handleKeyDown(e) {
      if (e.key !== 'Tab') return
      const focusables = Array.from(
        containerRef.current?.querySelectorAll(FOCUSABLE) || []
      )
      if (focusables.length === 0) return
      const first = focusables[0]
      const last  = focusables[focusables.length - 1]

      if (e.shiftKey) {
        // Shift-Tab: if we're at the first element, wrap to last.
        if (document.activeElement === first) {
          e.preventDefault()
          last.focus()
        }
      } else {
        // Tab: if we're at the last element, wrap to first.
        if (document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [active, containerRef])

  // Restore focus on close.
  useEffect(() => {
    if (active) return
    const el = priorFocusRef.current
    if (el && typeof el.focus === 'function') {
      el.focus()
      priorFocusRef.current = null
    }
  }, [active])
}

function Modal({ open, onClose, title, size = 'md', children, className = '' }) {
  const dialogRef = useRef(null)

  // Escape to close.
  useEffect(() => {
    if (!open) return
    function onKey(e) { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Focus trap: activate when open, release when closed (restores prior focus).
  useFocusTrap(dialogRef, open)

  if (!open) return null

  const sizeMap = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
    xl: 'max-w-xl',
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.() }}
      style={{ background: 'rgba(0, 0, 0, 0.62)', backdropFilter: 'blur(3px)' }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`bg-paper text-ink rounded-xl border border-line shadow-e3 w-full ${sizeMap[size] || sizeMap.md} overflow-hidden animate-scale-in ${className}`}
      >
        {title && (
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-line">
            <h3 className="text-md font-semibold tracking-tightish">{title}</h3>
            <IconButton size="sm" title="Close" onClick={onClose}>
              <X size={15} />
            </IconButton>
          </div>
        )}
        {children}
      </div>
    </div>
  )
}

Modal.Body = function ModalBody({ className = '', children }) {
  return <div className={`px-5 py-4 ${className}`}>{children}</div>
}

Modal.Footer = function ModalFooter({ className = '', children }) {
  return (
    <div className={`px-5 py-3 border-t border-line bg-bg-elev2 flex items-center justify-end gap-2 ${className}`}>
      {children}
    </div>
  )
}

export default Modal
