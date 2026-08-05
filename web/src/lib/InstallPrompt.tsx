/**
 * src/lib/InstallPrompt.jsx — subtle, dismissible "install Office" affordance
 * and an offline indicator. Both are progressive enhancements:
 *
 *   - Install: listens for the `beforeinstallprompt` event (Chromium), stashes
 *     it, and shows a low-key banner with Install / Not now. Dismissal (or a
 *     completed install) is remembered in localStorage so it never nags again.
 *     Never rendered when Office is embedded in the OS hub — the host owns that.
 *
 *   - Offline: a small pill appears when the browser goes offline, so a user on
 *     the cached app shell knows why live document sync has stopped.
 *
 * Nothing here blocks the app; if the event never fires (already installed,
 * unsupported browser, iOS) the banner simply never shows.
 */

import { useEffect, useState } from 'react'
import { Download, X, WifiOff } from 'lucide-react'
import { isEmbedded } from './pwa.js'

const DISMISS_KEY = 'vulos.office.pwa.install-dismissed.v1'

// Chromium-only, not part of the standard DOM lib types.
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

function alreadyHandled(): boolean {
  try {
    if (localStorage.getItem(DISMISS_KEY) === '1') return true
  } catch {
    /* private mode / storage disabled — treat as not-dismissed */
  }
  // Running as an installed PWA already ⇒ never prompt.
  try {
    if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true
    if (window.navigator && (window.navigator as Navigator & { standalone?: boolean }).standalone) return true
  } catch {
    /* noop */
  }
  return false
}

export default function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null)
  const [visible, setVisible] = useState(false)
  const [offline, setOffline] = useState(
    typeof navigator !== 'undefined' && navigator.onLine === false
  )

  useEffect(() => {
    if (isEmbedded()) return // OS-hosted embed: host owns install/offline UX.

    const onBeforeInstall = (e: Event) => {
      // Suppress the browser's default mini-infobar; drive our own affordance.
      e.preventDefault()
      if (alreadyHandled()) return
      setDeferred(e as BeforeInstallPromptEvent)
      setVisible(true)
    }
    const onInstalled = () => {
      setVisible(false)
      setDeferred(null)
      try { localStorage.setItem(DISMISS_KEY, '1') } catch { /* noop */ }
    }
    const onOnline = () => setOffline(false)
    const onOffline = () => setOffline(true)

    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    window.addEventListener('appinstalled', onInstalled)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      window.removeEventListener('appinstalled', onInstalled)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [])

  const install = async () => {
    if (!deferred) return
    setVisible(false)
    try {
      deferred.prompt()
      await deferred.userChoice
    } catch {
      /* user dismissed the native dialog — nothing to do */
    }
    setDeferred(null)
    try { localStorage.setItem(DISMISS_KEY, '1') } catch { /* noop */ }
  }

  const dismiss = () => {
    setVisible(false)
    setDeferred(null)
    try { localStorage.setItem(DISMISS_KEY, '1') } catch { /* noop */ }
  }

  return (
    <>
      {offline && (
        <div
          role="status"
          aria-live="polite"
          data-testid="offline-indicator"
          style={{
            position: 'fixed',
            top: '10px',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 2147483000,
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '5px 12px',
            fontFamily: 'var(--font-sans)',
            fontSize: 'var(--text-xs, 0.75rem)',
            color: 'var(--ink, #1a1a1a)',
            background: 'var(--bg-elev-2, #fff)',
            border: '1px solid var(--line-strong, #ddd)',
            borderRadius: '999px',
            boxShadow: '0 2px 10px rgba(0,0,0,0.14)',
          }}
        >
          <WifiOff size={13} aria-hidden="true" />
          <span>You’re offline — showing cached view</span>
        </div>
      )}

      {visible && (
        <div
          role="dialog"
          aria-label="Install Diwan"
          data-testid="install-prompt"
          style={{
            position: 'fixed',
            bottom: '16px',
            right: '16px',
            zIndex: 2147483000,
            maxWidth: '340px',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            padding: '12px 14px',
            fontFamily: 'var(--font-sans)',
            color: 'var(--ink, #1a1a1a)',
            background: 'var(--bg-elev-2, #fff)',
            border: '1px solid var(--line-strong, #ddd)',
            borderRadius: 'var(--radius-lg, 10px)',
            boxShadow: '0 8px 28px rgba(0,0,0,0.18)',
          }}
        >
          <Download size={18} aria-hidden="true" style={{ color: 'var(--accent, #0f6a6c)', flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 'var(--text-sm, 0.8125rem)', fontWeight: 600 }}>Install Office</div>
            <div style={{ fontSize: 'var(--text-xs, 0.75rem)', color: 'var(--ink-muted, #666)', marginTop: '1px' }}>
              Add it to your device for a faster, app-like experience.
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
            <button
              type="button"
              onClick={install}
              style={{
                fontSize: 'var(--text-sm, 0.8125rem)',
                fontWeight: 600,
                padding: '6px 12px',
                color: 'var(--ink-on-accent, #fff)',
                background: 'var(--accent, #0f6a6c)',
                border: 'none',
                borderRadius: 'var(--radius-md, 8px)',
                cursor: 'pointer',
              }}
            >
              Install
            </button>
            <button
              type="button"
              onClick={dismiss}
              aria-label="Dismiss install prompt"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '6px',
                color: 'var(--ink-faint, #999)',
                background: 'transparent',
                border: 'none',
                borderRadius: 'var(--radius-md, 8px)',
                cursor: 'pointer',
              }}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
    </>
  )
}
