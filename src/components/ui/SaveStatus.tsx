/**
 * SaveStatus — the one shared save/sync indicator for every editor.
 * ----------------------------------------------------------------------------
 * Docs, Sheets and Slides each hand-rolled a near-identical meta-line (an icon
 * + word: Saving / Saved / Unsaved / Save failed). This unifies them into a
 * single crafted control so the suite reads as one product.
 *
 * It renders a small "breathing" dot (the `.save-dot` state ladder in
 * index.css — saved / saving / error / offline) followed by a quiet label.
 * The dot pulse honours prefers-reduced-motion via the CSS. It is deliberately
 * calm: a green dot at rest, never a banner.
 *
 *   <SaveStatus status="saving" />
 *   <SaveStatus status="error" text="Retrying 2/3" title={err} />
 *   <SaveStatus status="dirty" />           // → "Unsaved"
 *
 * `status` ∈ 'saved' | 'saving' | 'dirty' | 'error' | 'offline'
 *
 * The component is purely presentational + accessible (role=status,
 * aria-live=polite) so screen readers announce the transition. Callers keep
 * their own save state machine; this only renders it.
 */

type SaveStatusKind = 'saved' | 'saving' | 'dirty' | 'error' | 'offline'

const MAP: Record<SaveStatusKind, { dot: string; text: string; tone: string }> = {
  saving:  { dot: 'save-dot--saving',  text: 'Saving',   tone: 'text-ink-faint' },
  saved:   { dot: 'save-dot--saved',   text: 'Saved',    tone: 'text-ink-faint' },
  dirty:   { dot: '',                  text: 'Unsaved',  tone: 'text-ink-faint' },
  error:   { dot: 'save-dot--error',   text: 'Save failed', tone: 'text-danger' },
  offline: { dot: 'save-dot--offline', text: 'Offline',  tone: 'text-warning' },
}

interface SaveStatusProps {
  status?: SaveStatusKind | undefined
  text?: string | undefined
  title?: string | undefined
  className?: string
}

export default function SaveStatus({ status = 'saved', text, title, className = '' }: SaveStatusProps) {
  const info = MAP[status] || MAP.saved
  return (
    <span
      role="status"
      aria-live="polite"
      title={title || undefined}
      className={[
        'inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded-sm select-none',
        'text-2xs font-medium tracking-tightish',
        info.tone,
        className,
      ].join(' ')}
    >
      <span aria-hidden className={`save-dot ${info.dot}`.trim()} />
      {text || info.text}
    </span>
  )
}
