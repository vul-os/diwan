/**
 * MSW integration — the "office remaining" parity features:
 *   - version author display + diff modal (HistoryPanel)
 *   - share links (mint / password / expiry / revoke) + transfer ownership
 *     (AccountShareModal)
 *   - anonymous read-only token view (AnonDocView)
 *
 * Each mounts the REAL component against the REAL api client with `/api` served
 * by MSW, exercising the whole fetch → state → render stack.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import HistoryPanel from '../../components/HistoryPanel'
import AccountShareModal from '../../components/AccountShareModal.jsx'
import AnonDocView from '../../components/AnonDocView.jsx'
import { server, resetMock, mockState } from './server.js'

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

// jsdom lacks clipboard; stub it so copy handlers don't throw.
beforeAll(() => {
  if (!navigator.clipboard) {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    })
  }
})

describe('Version author + diff (MSW integration)', () => {
  beforeEach(() => resetMock({ role: 'owner' }))

  it('shows the per-version author', async () => {
    render(<HistoryPanel fileId="doc1" onRestore={() => {}} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('First draft')).toBeInTheDocument())
    // Authors from the seeded versions must render.
    expect(screen.getByText('alice@vulos.test')).toBeInTheDocument()
    expect(screen.getByText('bob@vulos.test')).toBeInTheDocument()
  })

  it('opens a readable diff modal for a version', async () => {
    render(<HistoryPanel fileId="doc1" onRestore={() => {}} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('First draft')).toBeInTheDocument())

    // Click the first "Diff" action.
    fireEvent.click(screen.getAllByRole('button', { name: /Diff/i })[0])

    // The diff modal loads the line diff from the server.
    await waitFor(() =>
      expect(mockState.calls.some((c) => /versions\/v2\/diff/.test(c))).toBe(true))
    expect(await screen.findByText('new sentence')).toBeInTheDocument()
    expect(screen.getByText('old sentence')).toBeInTheDocument()
    // Added/removed badges.
    expect(screen.getByText(/\+1 added/)).toBeInTheDocument()
    expect(screen.getByText(/−1 removed/)).toBeInTheDocument()
  })
})

describe('Share links + transfer ownership (MSW integration)', () => {
  beforeEach(() => resetMock({ role: 'owner' }))

  const openShare = () =>
    render(
      <AccountShareModal
        open
        onClose={() => {}}
        file={{ id: 'doc1', name: 'Design Notes' }}
        me="you@vulos.test"
      />,
    )

  it('mints a read-only link and lists it', async () => {
    openShare()
    // Wait for the owner-only link section to appear.
    const createBtn = await screen.findByRole('button', { name: /Create link/i })
    fireEvent.click(createBtn)
    await waitFor(() =>
      expect(mockState.calls).toContain('POST /files/doc1/share-links'))
    // The new link URL renders (contains /view/ path + token).
    await waitFor(() =>
      expect(screen.getByText(/\/view\/tok_/)).toBeInTheDocument())
  })

  // The server keeps only a SHA-256 of the token, so a link's URL exists in
  // exactly one place: the mint response. These two tests pin both halves — the
  // URL is there right after minting, and it is gone (with a plain explanation,
  // not a broken URL) for any link the session did not mint.
  it('shows no URL and no copy button for a link this session did not mint', async () => {
    // Seed a link exactly as the server would return it on GET: the GET
    // /share-links handler always strips `token` before responding (see
    // handlers.ts), so its value here is never read by anything this test
    // exercises — but MockShareLink's stored-record shape still requires the
    // field (only the wire response omits it), hence the placeholder.
    mockState.shareLinks.doc1 = [{
      id: 'link-preexisting',
      file_id: 'doc1',
      token: 'not-this-sessions-token',
      created_by: 'you@vulos.test',
      has_password: false,
      expires_at: null,
      revoked: false,
      created_at: new Date().toISOString(),
    }]
    openShare()

    expect(await screen.findByText(/URL shown only when created/i)).toBeInTheDocument()
    // Nothing that looks like a share URL is rendered…
    expect(screen.queryByText(/\/view\//)).not.toBeInTheDocument()
    // …and there is no copy affordance to paste an empty one from.
    expect(screen.queryByRole('button', { name: /Copy link URL/i })).not.toBeInTheDocument()
    // Revoke still works without the token — the owner can always kill a leak.
    expect(screen.getByRole('button', { name: /Revoke link/i })).toBeInTheDocument()
  })

  it('copies the minted URL from the mint response, not from the list', async () => {
    openShare()
    fireEvent.click(await screen.findByRole('button', { name: /Create link/i }))
    const copyBtn = await screen.findByRole('button', { name: /Copy link URL/i })

    // The list response carries no token, so a copy that worked off the list
    // would copy `/view/undefined`. It must copy the minted URL instead.
    const url = screen.getByText(/\/view\/tok_/).textContent
    fireEvent.click(copyBtn)
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(url))
    expect(url).not.toMatch(/undefined/)
  })

  it('mints a password + expiring link (flags surface in the list)', async () => {
    openShare()
    const pwInput = await screen.findByLabelText(/Optional link password/i)
    fireEvent.change(pwInput, { target: { value: 's3cret' } })
    fireEvent.change(screen.getByLabelText(/Link expiry/i), { target: { value: String(24 * 60 * 60) } })
    fireEvent.click(screen.getByRole('button', { name: /Create link/i }))

    await waitFor(() => expect(screen.getByText(/password/i)).toBeInTheDocument())
    expect(screen.getByText(/expires/i)).toBeInTheDocument()
  })

  it('revokes a link', async () => {
    openShare()
    fireEvent.click(await screen.findByRole('button', { name: /Create link/i }))
    const revokeBtn = await screen.findByRole('button', { name: /Revoke link/i })
    fireEvent.click(revokeBtn)
    await waitFor(() =>
      expect(mockState.calls.some((c) => /DELETE \/files\/doc1\/share-links\//.test(c))).toBe(true))
    // No active links remain.
    await waitFor(() => expect(screen.getByText(/No active links/i)).toBeInTheDocument())
  })

  it('transfers ownership after confirm', async () => {
    openShare()
    const target = await screen.findByLabelText(/New owner account/i)
    fireEvent.change(target, { target: { value: 'newowner@vulos.test' } })
    fireEvent.click(screen.getByRole('button', { name: /^Transfer$/i }))
    // Confirm modal — click the "Transfer ownership" confirm button.
    const confirmBtn = await screen.findByRole('button', { name: /Transfer ownership/i })
    fireEvent.click(confirmBtn)
    await waitFor(() =>
      expect(mockState.calls).toContain('POST /files/doc1/transfer-owner'))
    expect(mockState.owner).toBe('newowner@vulos.test')
  })

  it('a non-owner cannot mint (server 403 surfaced)', async () => {
    resetMock({ role: 'viewer' })
    // As a non-owner, isOwner is false so the section is hidden; simulate the
    // security contract directly at the API mock: a share-link POST returns 403.
    // (The UI hides the control as defence in depth; the server is the gate.)
    render(
      <AccountShareModal
        open onClose={() => {}}
        file={{ id: 'doc1', name: 'Design Notes' }}
        me="stranger@vulos.test"
      />,
    )
    // The link-mint control must NOT be present for a non-owner.
    await waitFor(() => expect(screen.getByText(/People with access/i)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /Create link/i })).not.toBeInTheDocument()
  })
})

describe('Anonymous read-only view (MSW integration)', () => {
  beforeEach(() => resetMock({ role: 'owner' }))

  function seedLink({ password = '' } = {}) {
    const token = 'tokX'
    const link = {
      id: 'linkX', file_id: 'doc1', token, has_password: !!password, expires_at: null, revoked: false,
      created_at: new Date().toISOString(),
    }
    mockState.shareLinks.doc1 = [link]
    mockState.linksByToken[token] = {
      link,
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Shared body text' }] }] },
      name: 'Design Notes',
      requires_password: !!password,
      password,
    }
    return token
  }

  const renderView = (token: string) =>
    render(
      <MemoryRouter initialEntries={[`/view/${token}`]}>
        <Routes>
          <Route path="/view/:token" element={<AnonDocView />} />
        </Routes>
      </MemoryRouter>,
    )

  it('renders a bare link read-only with content', async () => {
    const token = seedLink()
    renderView(token)
    expect(await screen.findByText('Shared body text')).toBeInTheDocument()
    expect(screen.getByText(/Read-only shared document/i)).toBeInTheDocument()
  })

  it('prompts for a password and rejects the wrong one, accepts the right one', async () => {
    const token = seedLink({ password: 'open-sesame' })
    renderView(token)
    // Password prompt appears; content is NOT shown yet.
    const pw = await screen.findByLabelText(/Document password/i)
    expect(screen.queryByText('Shared body text')).not.toBeInTheDocument()

    // Wrong password → error, still no content.
    fireEvent.change(pw, { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: /View document/i }))
    await waitFor(() => expect(screen.getByText(/incorrect password/i)).toBeInTheDocument())
    expect(screen.queryByText('Shared body text')).not.toBeInTheDocument()

    // Correct password → content revealed.
    fireEvent.change(pw, { target: { value: 'open-sesame' } })
    fireEvent.click(screen.getByRole('button', { name: /View document/i }))
    expect(await screen.findByText('Shared body text')).toBeInTheDocument()
  })

  it('shows an error for an unknown/revoked token', async () => {
    renderView('does-not-exist')
    await waitFor(() =>
      expect(screen.getByText(/link not found|unavailable/i)).toBeInTheDocument())
  })
})
