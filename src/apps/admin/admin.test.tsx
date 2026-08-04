/**
 * admin.test.jsx — AdminApp invites + audit panels.
 * Mocks the api client and asserts the UI mints/lists/revokes invites and
 * renders the append-only audit log. Also asserts audit detail values render as
 * text (no HTML injection).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const mock = vi.hoisted(() => ({
  adminListInvites: vi.fn(),
  adminMintInvite: vi.fn(),
  adminRevokeInvite: vi.fn(),
  adminListAudit: vi.fn(),
}))
vi.mock('../../lib/api', () => ({ api: mock }))

import AdminApp from './AdminApp.jsx'

beforeEach(() => {
  Object.values(mock).forEach((fn) => fn.mockReset())
  mock.adminListInvites.mockResolvedValue([])
  mock.adminListAudit.mockResolvedValue([])
})

describe('AdminApp invites', () => {
  it('mints an invite and shows the raw token once', async () => {
    mock.adminMintInvite.mockResolvedValue({
      token: 'RAW-SECRET-TOKEN',
      invite: { id: 'h1', note: 'alice@vulos.org', max_uses: 1, used_count: 0, expires_at: 0, revoked: false },
    })
    mock.adminListInvites
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ id: 'h1', note: 'alice@vulos.org', max_uses: 1, used_count: 0, expires_at: 0, revoked: false }])

    render(<AdminApp />)
    await waitFor(() => expect(mock.adminListInvites).toHaveBeenCalled())

    fireEvent.click(screen.getByText('Mint invite'))

    await waitFor(() => expect(mock.adminMintInvite).toHaveBeenCalled())
    expect(await screen.findByText('RAW-SECRET-TOKEN')).toBeInTheDocument()
    // The invite row appears in the table.
    expect(await screen.findByText('alice@vulos.org')).toBeInTheDocument()
  })

  it('revokes an invite', async () => {
    mock.adminListInvites.mockResolvedValue([
      { id: 'h2', note: 'bob', max_uses: 5, used_count: 1, expires_at: 0, revoked: false },
    ])
    mock.adminRevokeInvite.mockResolvedValue({ ok: true })

    render(<AdminApp />)
    const revokeBtn = await screen.findByText('Revoke')
    fireEvent.click(revokeBtn)
    await waitFor(() => expect(mock.adminRevokeInvite).toHaveBeenCalledWith('h2'))
  })

  it('surfaces a 403 from a non-admin as an inline error', async () => {
    mock.adminListInvites.mockRejectedValue(new Error('admin privileges required'))
    render(<AdminApp />)
    expect(await screen.findByText('admin privileges required')).toBeInTheDocument()
  })
})

describe('AdminApp audit', () => {
  it('renders audit entries and treats detail as plain text', async () => {
    mock.adminListAudit.mockResolvedValue([
      {
        id: 'a1',
        at: Date.now() * 1e6,
        actor: 'root@vulos.org',
        action: 'acl.grant',
        target: 'file-123',
        detail: 'grantee=<img src=x onerror=alert(1)>',
      },
    ])
    render(<AdminApp />)
    fireEvent.click(screen.getByText('Audit log'))
    await waitFor(() => expect(mock.adminListAudit).toHaveBeenCalled())

    expect(await screen.findByText('ACL granted')).toBeInTheDocument()
    expect(screen.getByText('file-123')).toBeInTheDocument()
    // The malicious detail is rendered verbatim as text (not parsed as HTML),
    // so no <img> element is created.
    expect(screen.getByText('grantee=<img src=x onerror=alert(1)>')).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
  })
})
