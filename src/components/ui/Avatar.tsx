/**
 * Avatar + AvatarStack — collaborator presence chips.
 * ----------------------------------------------------------------------------
 * A crafted round initial-chip with a deterministic hue derived from the
 * collaborator's name/id (so the same person keeps the same colour across the
 * session) OR an explicit `color` when the collab layer already assigns one
 * (Slides/PresenceBar pass a per-peer colour). Renders on the shared
 * `.avatar-chip` shape from index.css (ring against the chrome, sans initials).
 *
 *   <Avatar name="Ada Lovelace" size={22} />
 *   <Avatar name="Ada" color="#6f9fd8" size={18} />
 *   <AvatarStack people={[{name,color}, …]} max={4} size={22} />
 *
 * The stack overlaps chips and shows a "+N" overflow chip past `max`.
 * Names feed the accessible label; the chip itself is aria-hidden decoration
 * when wrapped by a titled control.
 */

import type { CSSProperties, HTMLAttributes } from 'react'

// Style objects here set a `--avatar-bg` custom property that index.css reads;
// CSSProperties has no index signature for custom props, so widen locally.
type AvatarStyle = CSSProperties & { '--avatar-bg': string }

// A small, calm palette tuned for the near-black chrome — legible, no glow.
// Mirrors the per-app tints so presence colours feel part of the same system.
const HUES = [
  '#6f9fd8', // blue
  '#5cc08a', // green
  '#e2a93f', // amber
  '#e0726a', // red
  '#3fc1b0', // teal
  '#C96AFF', // brand purple
  '#b08cff', // violet
  '#e08fc0', // pink
]

export function hueFor(seed = '') {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return HUES[h % HUES.length]
}

function initials(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

interface AvatarProps extends HTMLAttributes<HTMLSpanElement> {
  name?: string
  color?: string
  size?: number
  title?: string
  className?: string
}

export default function Avatar({
  name = '',
  color,
  size = 22,
  title,
  className = '',
  'aria-hidden': ariaHidden,
  ...rest
}: AvatarProps) {
  const bg = color || hueFor(name || title || '')
  const fontSize = Math.max(8, Math.round(size * 0.42))
  return (
    <span
      className={`avatar-chip ${className}`.trim()}
      style={{ width: size, height: size, fontSize, '--avatar-bg': bg } as AvatarStyle}
      title={title || name || undefined}
      aria-hidden={ariaHidden}
      {...rest}
    >
      {initials(name)}
    </span>
  )
}

export interface AvatarStackPerson {
  id?: string | number
  accountId?: string
  name?: string
  displayName?: string
  color?: string
}

interface AvatarStackProps {
  people?: AvatarStackPerson[]
  max?: number
  size?: number
  className?: string
}

export function AvatarStack({ people = [], max = 4, size = 22, className = '' }: AvatarStackProps) {
  if (!people.length) return null
  const shown = people.slice(0, max)
  const overflow = people.length - shown.length
  const names = people.map((p) => p.name || p.displayName).filter(Boolean).join(', ')
  return (
    <span
      className={`avatar-stack inline-flex items-center ${className}`.trim()}
      aria-label={names ? `Collaborators: ${names}` : undefined}
    >
      {shown.map((p, i) => (
        <Avatar
          key={p.id || p.accountId || p.name || i}
          name={p.name || p.displayName}
          color={p.color}
          size={size}
          aria-hidden
        />
      ))}
      {overflow > 0 && (
        <span
          className="avatar-chip"
          aria-hidden
          style={{
            width: size,
            height: size,
            fontSize: Math.max(8, Math.round(size * 0.4)),
            '--avatar-bg': 'var(--bg-elevated)',
            color: 'var(--ink-muted)',
          } as AvatarStyle}
        >
          +{overflow}
        </span>
      )}
    </span>
  )
}
