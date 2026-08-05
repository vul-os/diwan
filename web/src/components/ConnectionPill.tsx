/**
 * ConnectionPill.jsx — collaboration connection status pill (WAVE-27).
 *
 * A small, quiet status pill that reflects the collab fabric / signaling state,
 * matching the restraint of Docs' save-status meta-line: informative, never
 * alarming. Shown in the topbar meta area of Sheets & Slides.
 *
 * Status vocabulary (from deriveStatusPill in lib/collab/presenceCommon.js):
 *   live / solo   → "Live"          (success tone, calm)
 *   connecting    → "Connecting…"   (muted)
 *   reconnecting  → "Reconnecting…" (warning tone, gentle pulse)
 *   offline       → "Offline"       (muted — local editing still works)
 *   readonly      → "View only"     (muted — permission clarity)
 *   mismatch      → "Not syncing"   (DANGER — a peer runs a different CRDT
 *                                    engine, so this session stopped
 *                                    replicating; see lib/crdt/gridEngine.js)
 *
 * `mismatch` is the one status here that breaks the "informative, never
 * alarming" rule, deliberately. Every other state resolves itself; this one
 * means the document will not converge and the connection looks fine, so a calm
 * muted treatment would be a lie the user has no other way to catch.
 *
 * Design-system compliance:
 *   - Warm signal tokens (success / warning / muted) — no generic Tailwind reds.
 *   - Reduced-motion: the reconnecting pulse is gated on motion preference.
 *   - aria-live="polite" + role="status" so screen readers announce transitions
 *     without stealing focus.
 */

import { Wifi, WifiOff, Loader2, Eye, AlertTriangle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { StatusPill, StatusPillStatus, StatusPillTone } from '../lib/collab/presenceCommon.js'

const TONE_CLASS: Record<StatusPillTone, string> = {
  success: 'text-success',
  warning: 'text-warning',
  danger:  'text-danger',
  muted:   'text-ink-muted',
}

const STATUS_META: Record<StatusPillStatus, { Icon: LucideIcon; spin: boolean; pulse: boolean }> = {
  live:         { Icon: Wifi,          spin: false, pulse: false },
  solo:         { Icon: Wifi,          spin: false, pulse: false },
  connecting:   { Icon: Loader2,       spin: true,  pulse: false },
  reconnecting: { Icon: Loader2,       spin: true,  pulse: true  },
  offline:      { Icon: WifiOff,       spin: false, pulse: false },
  readonly:     { Icon: Eye,           spin: false, pulse: false },
  mismatch:     { Icon: AlertTriangle, spin: false, pulse: false },
}

interface ConnectionPillProps {
  pill: StatusPill | null | undefined
  peerCount?: number
}

export default function ConnectionPill({ pill, peerCount = 0 }: ConnectionPillProps) {
  if (!pill) return null
  const meta = STATUS_META[pill.status] || STATUS_META.offline
  const { Icon } = meta
  const toneClass = TONE_CLASS[pill.tone] || TONE_CLASS.muted

  // Screen-reader phrasing: fold peer count into the announcement when live.
  const srText = (pill.status === 'live' && peerCount > 0)
    ? `${pill.label} — ${peerCount} collaborator${peerCount === 1 ? '' : 's'} connected`
    : pill.label

  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={srText}
      title={srText}
      className={[
        'inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded-sm',
        'text-2xs font-medium tracking-tightish select-none',
        // Gentle pulse only while reconnecting, and only if motion is allowed.
        meta.pulse ? 'motion-safe:animate-pulse' : '',
        toneClass,
      ].join(' ')}
    >
      <Icon
        size={11}
        className={meta.spin ? 'motion-safe:animate-spin' : ''}
        aria-hidden="true"
      />
      <span>{pill.label}</span>
      {pill.status === 'live' && peerCount > 0 && (
        <span aria-hidden="true" className="opacity-70">· {peerCount}</span>
      )}
    </span>
  )
}
