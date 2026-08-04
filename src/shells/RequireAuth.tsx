/**
 * src/shells/RequireAuth.tsx — auth boundary shared by all subdomain shells.
 *
 * Calls GET /api/auth/me on mount and believes ONLY an explicit
 * `200 {"authenticated": true}`. Anything else is not a session:
 *
 *   401 / 403         → redirect to https://app.vulos.org/login?next=<current-url>
 *   5xx / network / … → an honest error surface. The server could not tell us
 *                       who we are (the auth middleware answers 503 when the JWT
 *                       secret is missing or the introspector is unreachable),
 *                       and "I could not ask" is not "you're in".
 *
 * Rendering the app around a session that does not exist only makes the failure
 * arrive later, one 401 at a time, on every call the shell makes.
 *
 * The shared vc_session cookie (Domain=vulos.org) is automatically sent by
 * the browser, so a user already logged in at app.vulos.org will pass this
 * check transparently.
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { ErrorState, LoadingState } from '../components/ui'

type AuthState = 'loading' | 'error' | 'authed'

interface RequireAuthProps {
  children?: ReactNode
  apiBase?: string
}

export default function RequireAuth({ children, apiBase = '' }: RequireAuthProps) {
  const [state, setState] = useState<AuthState>('loading')
  const [attempt, setAttempt] = useState(0)

  const retry = useCallback(() => {
    setState('loading')
    setAttempt(n => n + 1)
  }, [])

  useEffect(() => {
    let cancelled = false
    const base = apiBase ? apiBase.replace(/\/$/, '') : ''

    fetch(`${base}/api/auth/me`, { credentials: 'include' })
      .then(async r => {
        if (cancelled) return
        if (r.status === 401 || r.status === 403) {
          const next = encodeURIComponent(window.location.href)
          window.location.href = `https://app.vulos.org/login?next=${next}`
          return
        }
        if (!r.ok) {
          setState('error')
          return
        }
        const body = await r.json().catch(() => null) as { authenticated?: boolean } | null
        if (!cancelled) setState(body?.authenticated === true ? 'authed' : 'error')
      })
      .catch(() => {
        if (!cancelled) setState('error')
      })

    return () => { cancelled = true }
  }, [apiBase, attempt])

  if (state === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg">
        <LoadingState label="Checking your session…" />
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg">
        <ErrorState
          size="lg"
          message="We couldn't verify your session — the server didn't answer. Check your connection and try again."
          onRetry={retry}
        />
      </div>
    )
  }

  return children
}
