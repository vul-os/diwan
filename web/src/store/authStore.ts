import { create } from 'zustand'
import { api } from '../lib/api'

// Session tokens are stored exclusively in httpOnly cookies managed by the
// backend. No token is ever written to localStorage — only an opaque
// loggedIn flag is kept in memory for UX purposes.

export interface AuthStatus {
  enabled: boolean
  authenticated: boolean
}

interface SystemInfo {
  account_id?: string
  is_admin?: boolean
  [key: string]: unknown
}

/** Errors thrown by lib/api's `request()` for a failed /auth/login — the
 *  server's JSON error body is spread onto the Error (see api.ts `request`). */
interface LoginError extends Error {
  error?: string
  remaining_attempts?: number
}

interface AuthState {
  status: AuthStatus | null
  loading: boolean
  error: string | null
  remainingAttempts: number | null
  accountId: string | null
  isAdmin: boolean
  fetchStatus: () => Promise<void>
  fetchIdentity: () => Promise<void>
  login: (password: string) => Promise<void>
  logout: () => Promise<void>
}

export const useAuthStore = create<AuthState>((set) => ({
  status: null,
  loading: true,
  error: null,
  remainingAttempts: null,
  // The caller's own account id + admin flag, resolved from /system/info. Used
  // by the account-share dialog (owner detection, self-share guard) and any
  // surface that needs "who am I". null until fetched (or in local single-user
  // mode where it resolves to the shared 'self' identity).
  accountId: null,
  isAdmin: false,

  fetchStatus: async () => {
    try {
      const status = await api.authStatus() as AuthStatus
      set({ status, loading: false })
    } catch {
      set({ status: { enabled: false, authenticated: true }, loading: false })
    }
  },

  // Resolve the caller's identity from the server. Best-effort: a failure leaves
  // accountId null, which the share UI treats conservatively (local/owner mode).
  fetchIdentity: async () => {
    try {
      const info = await api.systemInfo() as SystemInfo
      set({ accountId: info?.account_id || null, isAdmin: !!info?.is_admin })
    } catch {
      /* identity is optional UX; leave null */
    }
  },

  login: async (password) => {
    set({ error: null, remainingAttempts: null })
    try {
      await api.login(password)
      // The backend sets an httpOnly session cookie on success.
      // We never touch localStorage for tokens.
      set({ status: { enabled: true, authenticated: true }, error: null })
    } catch (err) {
      const loginErr = err as LoginError
      set({ error: loginErr.error || 'Login failed', remainingAttempts: loginErr.remaining_attempts ?? null })
      throw err
    }
  },

  logout: async () => {
    try { await api.logout() } catch { /* ignore */ }
    // Backend clears the httpOnly cookie. No localStorage cleanup needed.
    set({ status: { enabled: true, authenticated: false }, error: null })
  },
}))
