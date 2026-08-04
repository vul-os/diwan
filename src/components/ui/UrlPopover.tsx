/**
 * UrlPopover — inline, anchored URL entry (replaces native window.prompt()).
 * ----------------------------------------------------------------------------
 * Used for inserting links and image-by-URL in the Docs and Slides editors.
 * The caller wraps the trigger button in a `relative` element and renders this
 * conditionally; it positions itself below the trigger.
 *
 * Pasted/typed values are validated on submit: dangerous schemes
 * (javascript:/data:/vbscript:) are rejected, and scheme-less domains are
 * normalised to https://.
 */

import { useEffect, useRef, useState } from 'react'

export function isSafeUrl(raw?: string): boolean {
  const v = (raw || '').trim()
  if (!v) return false
  return !/^\s*(javascript|data|vbscript):/i.test(v)
}

export function normalizeUrl(raw?: string): string {
  const v = (raw || '').trim()
  return /^(https?:|mailto:|\/|#)/i.test(v) ? v : `https://${v}`
}

interface UrlPopoverProps {
  initialValue?: string
  placeholder?: string
  label?: string
  submitLabel?: string
  onSubmit?: (url: string) => void
  onRemove?: () => void
  onClose?: () => void
  align?: 'left' | 'right'
  className?: string
}

export default function UrlPopover({
  initialValue = '',
  placeholder = 'https://…',
  label = 'Link URL',
  submitLabel = 'Apply',
  onSubmit,
  onRemove,
  onClose,
  align = 'left',
  className = '',
}: UrlPopoverProps) {
  const [val, setVal] = useState(initialValue)
  const [err, setErr] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select() }, [])

  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) onClose?.() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.() } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const submit = () => {
    const v = val.trim()
    if (!v) { onRemove ? onRemove() : onClose?.(); return }
    if (!isSafeUrl(v)) { setErr('That doesn’t look like a safe URL.'); return }
    onSubmit?.(normalizeUrl(v))
  }

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={label}
      className={[
        'absolute top-full mt-1 z-50 w-72 p-3',
        'bg-paper border border-line rounded-lg shadow-e3 animate-scale-in',
        align === 'right' ? 'right-0' : 'left-0',
        className,
      ].join(' ')}
    >
      <label className="block text-2xs font-semibold text-ink-faint tracking-eyebrow uppercase mb-1.5">
        {label}
      </label>
      <input
        ref={inputRef}
        type="url"
        value={val}
        placeholder={placeholder}
        onChange={(e) => { setVal(e.target.value); setErr('') }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } }}
        className="w-full text-sm px-2.5 py-1.5 rounded-md border border-line bg-bg text-ink placeholder:text-ink-faint focus:outline-none focus:border-accent"
      />
      {err && <p className="mt-1 text-2xs text-danger">{err}</p>}
      <div className="flex items-center justify-end gap-2 mt-2.5">
        {onRemove && (
          <button type="button" onClick={onRemove} className="mr-auto text-xs text-danger hover:underline">
            Remove
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="h-7 px-2.5 rounded-md border border-line text-xs text-ink-muted hover:border-line-strong transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          className="h-7 px-2.5 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent-hover transition-colors"
        >
          {submitLabel}
        </button>
      </div>
    </div>
  )
}
