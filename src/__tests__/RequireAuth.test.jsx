/**
 * RequireAuth — the shells' client-side auth boundary.
 *
 * The contract it must never break: ONLY an explicit `200 {authenticated:true}`
 * renders the app. A 5xx (the auth middleware answers 503 when the JWT secret is
 * missing or the session introspector is unreachable), a network failure, or a
 * non-JSON 200 (a proxy/SPA page in front of the API) must NOT resolve to
 * "authed" — that is a fail-open that fakes a session the user does not have.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import RequireAuth from '../shells/RequireAuth'

const origFetch = global.fetch
const origLocation = window.location

function stubLocation(href = 'https://office.vulos.org/docs/abc') {
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { href },
  })
}

const jsonRes = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
})

async function renderBoundary() {
  await act(async () => {
    render(<RequireAuth><div data-testid="app">protected</div></RequireAuth>)
  })
}

describe('RequireAuth', () => {
  beforeEach(() => stubLocation())

  afterEach(() => {
    global.fetch = origFetch
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: origLocation,
    })
  })

  it('renders the app on an explicit authenticated 200', async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonRes(200, { authenticated: true, user_id: 'u1' }))

    await renderBoundary()

    await waitFor(() => expect(screen.getByTestId('app')).toBeTruthy())
    expect(global.fetch).toHaveBeenCalledWith('/api/auth/me', { credentials: 'include' })
  })

  it('redirects to the central login on 401', async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonRes(401, { error: 'authentication required' }))

    await renderBoundary()

    await waitFor(() => {
      expect(window.location.href).toContain('app.vulos.org/login?next=')
    })
    expect(screen.queryByTestId('app')).toBeNull()
  })

  it('redirects to the central login on 403', async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonRes(403, { error: 'forbidden' }))

    await renderBoundary()

    await waitFor(() => {
      expect(window.location.href).toContain('app.vulos.org/login?next=')
    })
    expect(screen.queryByTestId('app')).toBeNull()
  })

  it('shows an error — NOT the app — when the server cannot answer (503)', async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonRes(503, { error: 'server auth not configured' }))

    await renderBoundary()

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.queryByTestId('app')).toBeNull()
    expect(window.location.href).not.toContain('login')
  })

  it('shows an error — NOT the app — when the request fails (network/CORS/DNS)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))

    await renderBoundary()

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.queryByTestId('app')).toBeNull()
  })

  it('shows an error — NOT the app — when a 200 is not an authenticated body', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => { throw new SyntaxError('Unexpected token < in JSON') }, // an HTML page
    })

    await renderBoundary()

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.queryByTestId('app')).toBeNull()
  })

  it('retry re-checks the session and lets a recovered server through', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(jsonRes(503, { error: 'server auth not configured' }))
      .mockResolvedValueOnce(jsonRes(200, { authenticated: true, user_id: 'u1' }))

    await renderBoundary()
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())

    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: /retry/i }))
    })

    await waitFor(() => expect(screen.getByTestId('app')).toBeTruthy())
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })
})
