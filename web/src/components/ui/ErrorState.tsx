/**
 * ErrorState — the one crafted "this failed to load" surface.
 * ----------------------------------------------------------------------------
 * Unifies the scattered ad-hoc `<AlertCircle /> + <p class="text-danger"> +
 * "Retry" link` blocks (ActivityFeed, HistoryPanel, …) into a consistent,
 * tokenised, accessible panel. Mirrors EmptyState/LoadingState so the three
 * async states of any panel — loading / empty / error — read as one family.
 *
 *   <ErrorState message="Failed to load activity" onRetry={load} />
 *   <ErrorState message={err} size="md" />            // no retry affordance
 *
 * `size` ∈ 'sm' (panels) | 'md' (default) | 'lg' (full surfaces).
 *
 * Accessibility:
 *   - role="alert" so the failure is announced to screen readers.
 *   - the icon is decorative (aria-hidden); the message carries the meaning.
 *   - the Retry control is a real <Button> (keyboard + focus-visible for free).
 */

import { AlertCircle } from 'lucide-react'
import Button from './Button'

type ErrorStateSize = 'sm' | 'md' | 'lg'

const SIZES: Record<ErrorStateSize, { pad: string; icon: number; gap: string }> = {
  sm: { pad: 'py-8',  icon: 18, gap: 'gap-2'   },
  md: { pad: 'py-12', icon: 22, gap: 'gap-2.5' },
  lg: { pad: 'py-16', icon: 26, gap: 'gap-3'   },
}

interface ErrorStateProps {
  message?: string
  onRetry?: () => void
  retryLabel?: string
  size?: ErrorStateSize
  className?: string
}

export default function ErrorState({
  message = 'Something went wrong.',
  onRetry,
  retryLabel = 'Retry',
  size = 'md',
  className = '',
}: ErrorStateProps) {
  const s = SIZES[size] || SIZES.md
  return (
    <div
      role="alert"
      className={`flex flex-col items-center justify-center text-center px-4 ${s.pad} ${s.gap} animate-fade-in ${className}`}
    >
      <div className="w-11 h-11 rounded-full bg-danger-bg flex items-center justify-center">
        <AlertCircle size={s.icon} className="text-danger" aria-hidden strokeWidth={1.8} />
      </div>
      <p className="text-sm text-danger max-w-xs leading-relaxed">{message}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry} className="mt-1">
          {retryLabel}
        </Button>
      )}
    </div>
  )
}
