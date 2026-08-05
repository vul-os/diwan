import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, AtSign, CheckCheck, X } from 'lucide-react'
import { useNotificationsStore } from '../store/notificationsStore'

function timeAgo(s: string) {
  const diff = Date.now() - new Date(s).getTime()
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return `${Math.floor(diff / 86400000)}d ago`
}

const ROUTE: Record<string, string> = { doc: 'docs', sheet: 'sheets', slide: 'slides' }

/**
 * NotificationsPanel — a dropdown surfacing @-mention notifications.
 * All text (actor, snippet, file name) is rendered as plain React text nodes,
 * so a crafted mention/comment body can carry no markup.
 */
interface NotificationsPanelProps {
  onClose?: () => void
  fileTypeOf?: (fileId: string) => string | undefined
}

export default function NotificationsPanel({ onClose, fileTypeOf }: NotificationsPanelProps) {
  const { items, fetch, markRead, markAllRead } = useNotificationsStore()
  const navigate = useNavigate()

  useEffect(() => { void fetch() }, [fetch])

  const open = (n: { id: string; file_id?: string }) => {
    void markRead(n.id)
    if (n.file_id) {
      const t = fileTypeOf?.(n.file_id)
      const route = (t && ROUTE[t]) || 'docs'
      void navigate(`/${route}/${n.file_id}`)
    }
    onClose?.()
  }

  return (
    <div className="w-80 max-w-[90vw] bg-paper border border-line rounded-xl shadow-e3 overflow-hidden animate-scale-in">
      <div className="flex items-center justify-between px-3 h-10 border-b border-line">
        <div className="flex items-center gap-2">
          <Bell size={14} className="text-ink-muted" />
          <span className="text-sm font-semibold text-ink tracking-tightish">Notifications</span>
        </div>
        <div className="flex items-center gap-1">
          {items.some((n) => !n.read) && (
            <button
              onClick={() => void markAllRead()}
              className="flex items-center gap-1 text-2xs text-ink-faint hover:text-ink-muted transition-colors px-1.5 py-1 rounded-sm"
              title="Mark all read"
            >
              <CheckCheck size={12} /> Mark all read
            </button>
          )}
          <button onClick={onClose} className="p-1 rounded-sm hover:bg-accent-tint text-ink-faint" aria-label="Close">
            <X size={13} />
          </button>
        </div>
      </div>
      <div className="max-h-96 overflow-y-auto">
        {items.length === 0 && (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <Bell size={22} className="text-ink-faint/40 mb-2" />
            <p className="text-xs text-ink-faint">You’re all caught up</p>
          </div>
        )}
        {items.map((n) => (
          <button
            key={n.id}
            onClick={() => open(n)}
            className={[
              'w-full flex items-start gap-2.5 px-3 py-2.5 text-left border-b border-line last:border-b-0 transition-colors',
              n.read ? 'hover:bg-bg-elev2' : 'bg-accent-tint/40 hover:bg-accent-tint',
            ].join(' ')}
          >
            <span className="w-6 h-6 rounded-full bg-accent-tint text-accent flex items-center justify-center flex-shrink-0 mt-0.5">
              <AtSign size={13} />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-xs text-ink leading-snug">
                <span className="font-semibold">{n.actor || 'Someone'}</span>
                {' mentioned you'}
                {n.file_name ? <> in <span className="font-medium">{n.file_name}</span></> : null}
              </span>
              {n.snippet && (
                <span className="block text-2xs text-ink-muted truncate mt-0.5">“{n.snippet}”</span>
              )}
              <span className="block text-2xs text-ink-faint mt-0.5">{timeAgo(n.created_at)}</span>
            </span>
            {!n.read && <span className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0 mt-1.5" />}
          </button>
        ))}
      </div>
    </div>
  )
}
