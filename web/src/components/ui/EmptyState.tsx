/**
 * EmptyState — the one crafted "there's nothing here yet" surface.
 * ----------------------------------------------------------------------------
 * Unifies the scattered `<p className="… font-serif italic">No X yet.</p>`
 * one-liners into a consistent, on-brand block: a haloed icon, a serif
 * headline, an optional muted hint, and an optional action slot. Reads as
 * intentional and calm rather than blank.
 *
 *   <EmptyState icon={MessageSquare} title="No comments yet"
 *               hint="Select text and add the first note." />
 *   <EmptyState icon={FileText} title="Nothing here" size="lg"
 *               action={<Button>New file</Button>} />
 *
 * `size` ∈ 'sm' (panels) | 'md' (default) | 'lg' (full surfaces).
 * Decorative only — the icon is aria-hidden; the title carries the meaning.
 */

import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

type EmptyStateSize = 'sm' | 'md' | 'lg'

const SIZES: Record<EmptyStateSize, { pad: string; halo: string; icon: number; title: string; gap: string }> = {
  sm: { pad: 'py-8',  halo: 'w-11 h-11', icon: 18, title: 'text-sm',  gap: 'gap-2'   },
  md: { pad: 'py-12', halo: 'w-14 h-14', icon: 24, title: 'text-lg',  gap: 'gap-2.5' },
  lg: { pad: 'py-16', halo: 'w-16 h-16', icon: 28, title: 'text-xl',  gap: 'gap-3'   },
}

interface EmptyStateProps {
  icon?: LucideIcon
  title?: ReactNode
  hint?: ReactNode
  action?: ReactNode
  size?: EmptyStateSize
  className?: string
}

export default function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
  size = 'md',
  className = '',
}: EmptyStateProps) {
  const s = SIZES[size] || SIZES.md
  return (
    <div
      className={`flex flex-col items-center justify-center text-center ${s.pad} ${s.gap} animate-fade-in ${className}`}
    >
      {Icon && (
        <div className={`${s.halo} rounded-full bg-accent-tint flex items-center justify-center`}>
          <Icon size={s.icon} className="text-accent opacity-70" aria-hidden strokeWidth={1.8} />
        </div>
      )}
      {title && (
        <p className={`font-serif ${s.title} text-ink leading-snug`}>{title}</p>
      )}
      {hint && (
        <p className="text-sm text-ink-muted max-w-xs leading-relaxed">{hint}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
