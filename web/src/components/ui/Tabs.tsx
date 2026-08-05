/**
 * Tabs — restrained, underline-only.  No chunky pill backgrounds.
 *
 * Usage:
 *   <Tabs value={state} onChange={setState} items={[
 *     { value: 'all', label: 'All' },
 *     { value: 'open', label: 'Open', count: 3 },
 *   ]} />
 *
 * Accessibility: implements the WAI-ARIA tabs pattern — role=tablist/tab,
 * aria-selected, roving tabindex (only the selected tab is in the tab order),
 * and ←/→/Home/End arrow-key navigation between tabs.
 */

import { useRef } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'

export interface TabItem {
  value: string
  label: ReactNode
  count?: number
}

interface TabsProps {
  value: string
  onChange?: (value: string) => void
  items: TabItem[]
  className?: string
}

export default function Tabs({ value, onChange, items, className = '' }: TabsProps) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, idx: number) => {
    const last = items.length - 1
    let next: number | null = null
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = idx >= last ? 0 : idx + 1
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = idx <= 0 ? last : idx - 1
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = last
    if (next === null) return
    e.preventDefault()
    onChange?.(items[next].value)
    tabRefs.current[next]?.focus()
  }

  return (
    <div
      role="tablist"
      className={`flex items-stretch border-b border-line ${className}`}
    >
      {items.map(({ value: v, label, count }, idx) => {
        const selected = v === value
        return (
          <button
            key={v}
            ref={(el) => { tabRefs.current[idx] = el }}
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onKeyDown={(e) => onKeyDown(e, idx)}
            onClick={() => onChange?.(v)}
            className={[
              'group relative inline-flex items-center gap-1.5 px-3 py-2 text-xs',
              'font-medium tracking-tightish transition-colors duration-fast ease-out',
              selected
                ? 'text-ink'
                : 'text-ink-faint hover:text-ink-muted',
            ].join(' ')}
          >
            {label}
            {typeof count === 'number' && (
              <span
                className={`text-2xs px-1 rounded-xs ${
                  selected
                    ? 'bg-accent-tint-2 text-accent-press'
                    : 'bg-bg-elev2 text-ink-faint'
                }`}
              >
                {count}
              </span>
            )}
            {/* underline indicator */}
            <span
              className={[
                'absolute left-2 right-2 -bottom-px h-px transition-colors duration-base ease-out',
                selected ? 'bg-accent' : 'bg-transparent',
              ].join(' ')}
            />
          </button>
        )
      })}
    </div>
  )
}
