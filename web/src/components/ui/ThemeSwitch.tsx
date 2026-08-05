/**
 * ThemeSwitch — the explicit light / system / dark control.
 *
 * Two presentations, both driven by the shared `useTheme` hook (we never
 * re-implement persistence here — it stays in useTheme / localStorage):
 *
 *   - Expanded  → a labelled segmented toggle (Sun · Monitor · Moon). The
 *     active segment is filled with the teal accent so the current mode reads
 *     at a glance. Each segment is a real <button role="radio">, so it's
 *     keyboard-navigable and announced.
 *   - Collapsed → a single icon button showing the active mode's glyph that
 *     cycles light → system → dark on click (with a tooltip naming the next).
 *
 * Visuals follow the system: hairline border, 6px radius, mono micro-label,
 * 150ms transitions, and states that read correctly in BOTH themes.
 */

import { Sun, Moon, Monitor } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import IconButton from './IconButton'
import Tooltip from './Tooltip'
import { useTheme } from './useTheme'

const OPTIONS: { value: string; Icon: LucideIcon; label: string }[] = [
  { value: 'light',  Icon: Sun,     label: 'Light'  },
  { value: 'system', Icon: Monitor, label: 'System' },
  { value: 'dark',   Icon: Moon,    label: 'Dark'   },
]

interface ThemeSwitchProps {
  collapsed?: boolean
}

export default function ThemeSwitch({ collapsed = false }: ThemeSwitchProps) {
  const { theme, setTheme, cycle } = useTheme()

  // ── Collapsed rail → single cycling icon button ──────────────────────────
  if (collapsed) {
    const active = OPTIONS.find((o) => o.value === theme) ?? OPTIONS[1]
    const Icon = active.Icon
    const next =
      theme === 'light' ? 'system' : theme === 'system' ? 'dark' : 'light'
    return (
      <Tooltip label={`Theme: ${active.label} · switch to ${next}`} side="right">
        <IconButton
          size="sm"
          onClick={cycle}
          active
          aria-label={`Theme: ${active.label}. Activate to switch to ${next}.`}
        >
          <Icon size={14} />
        </IconButton>
      </Tooltip>
    )
  }

  // ── Expanded rail → labelled segmented control ───────────────────────────
  return (
    <div>
      <p className="px-1 pb-1.5 font-mono text-[10px] font-medium uppercase tracking-wider text-ink-faint select-none">
        Appearance
      </p>
      <div
        role="radiogroup"
        aria-label="Color theme"
        className="grid grid-cols-3 gap-0.5 p-0.5 rounded-md bg-bg-sunk border border-line"
      >
        {OPTIONS.map(({ value, Icon, label }) => {
          const isActive = theme === value
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={isActive}
              title={`${label} theme`}
              onClick={() => setTheme(value)}
              className={[
                'group relative flex items-center justify-center gap-1.5 h-7 rounded-[5px]',
                'text-[11px] font-medium tracking-tightish',
                'transition-[background,color,box-shadow] duration-fast ease-out',
                'focus-visible:outline-none focus-visible:shadow-focus',
                isActive
                  ? 'bg-accent text-[var(--ink-on-accent)] shadow-e1'
                  : 'text-ink-faint hover:text-ink hover:bg-bg-hover',
              ].join(' ')}
            >
              <Icon
                size={13}
                strokeWidth={isActive ? 2.2 : 1.9}
                className="flex-shrink-0"
              />
              <span>{label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
