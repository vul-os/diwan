/**
 * format — shared date/size formatting helpers.
 *
 * These were previously copy-pasted (character-for-character in several cases)
 * across AppHome, Home, CommentsPanel, SuggestionPanel, ActivityFeed and
 * HistoryPanel. Consolidating them here removes the drift risk (one panel's
 * "5m ago" reading differently from another's) and gives the formatters a single
 * tested home.
 *
 * All functions are null-safe: an empty / invalid input yields '' (or a sensible
 * fallback) rather than "Invalid Date".
 */

export type DateInput = Date | string | number | null | undefined

// Coerce a Date | ISO-string | epoch-ms into a Date, or null if unparseable.
function toDate(input: DateInput): Date | null {
  if (input == null || input === '') return null
  const d = input instanceof Date ? input : new Date(input)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * timeAgo — coarse relative time: "just now", "5m ago", "3h ago", "2d ago",
 * then a short calendar date ("Mar 4") once older than a week.
 *
 * Accepts a Date, an ISO string, or epoch milliseconds so every call site's
 * existing contract keeps working.
 */
export function timeAgo(input: DateInput): string {
  const d = toDate(input)
  if (!d) return ''
  const diff = Date.now() - d.getTime()
  if (diff < 60_000)     return 'just now'
  if (diff < 3_600_000)  return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/**
 * timeAgoLong — like timeAgo but keeps counting in days (up to 30) before
 * falling back to a full locale date. Matches the older HistoryPanel/ActivityFeed
 * treatment where the timeline wants day granularity for up to a month.
 */
export function timeAgoLong(input: DateInput): string {
  const d = toDate(input)
  if (!d) return ''
  const diffSec = Math.floor((Date.now() - d.getTime()) / 1000)
  if (diffSec < 60) return 'just now'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 30) return `${diffDay}d ago`
  return d.toLocaleDateString()
}

/**
 * formatTs — absolute short date + time, e.g. "Mar 4, 09:30". Used by the
 * comment / suggestion panels for exact edit timestamps.
 */
export function formatTs(input: DateInput): string {
  const d = toDate(input)
  if (!d) return ''
  return (
    d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  )
}

/**
 * formatBytes — compact human-readable file size: "820 B", "12 KB", "3.4 MB".
 */
export function formatBytes(b: number | string | null | undefined): string {
  const n = Number(b) || 0
  if (n < 1024)          return `${n} B`
  if (n < 1024 * 1024)   return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
