/**
 * MSW integration — Version history snapshot & restore, with WAVE-14 security.
 *
 * Mounts the REAL HistoryPanel against the REAL api client (src/lib/api.js),
 * with `/api` served by MSW. This exercises the whole client stack:
 *   fetch → endpoint resolution → HistoryPanel state → restore confirm modal.
 *
 * The load-bearing assertion is the wave-14 authorization gate: a viewer or
 * commenter that clicks Restore receives a 403 from the (mocked) server and the
 * UI surfaces the failure instead of restoring. Owners/editors succeed.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import HistoryPanel from '../../components/HistoryPanel'
import { server, resetMock, mockState } from './server.js'

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

// Confirm a restore by clicking the "Restore" button inside the confirmation
// dialog specifically (the row also has a "Restore this version" button).
async function confirmRestore() {
  const dialog = await screen.findByRole('dialog')
  const btn = within(dialog).getByRole('button', { name: /^Restore$/i })
  fireEvent.click(btn)
}

describe('Version history (MSW integration)', () => {
  beforeEach(() => resetMock({ role: 'owner' }))

  it('lists snapshots from the server, newest first with a Latest badge', async () => {
    render(<HistoryPanel fileId="doc1" onRestore={() => {}} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('First draft')).toBeInTheDocument())
    // Two versions come back; the newest (v2) carries the "latest" pill.
    expect(screen.getByText('latest')).toBeInTheDocument()
    expect(mockState.calls).toContain('GET /files/doc1/versions')
  })

  it('owner can restore: confirm modal → 200 → onRestore fired', async () => {
    const onRestore = vi.fn()
    render(<HistoryPanel fileId="doc1" onRestore={onRestore} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('First draft')).toBeInTheDocument())

    // The restore button is revealed on hover; it exists in the DOM regardless.
    const restoreButtons = screen.getAllByTitle('Restore this version')
    fireEvent.click(restoreButtons[0])

    await confirmRestore()

    await waitFor(() => expect(onRestore).toHaveBeenCalledTimes(1))
    expect(mockState.calls.some((c) => /POST \/files\/doc1\/versions\/v2\/restore/.test(c))).toBe(true)
    expect(await screen.findByText('Version restored')).toBeInTheDocument()
  })

  it('WAVE-14: a viewer is refused restore (403) — onRestore NOT fired, error shown', async () => {
    resetMock({ role: 'viewer' })
    const onRestore = vi.fn()
    render(<HistoryPanel fileId="doc1" onRestore={onRestore} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('First draft')).toBeInTheDocument())

    fireEvent.click(screen.getAllByTitle('Restore this version')[0])
    await confirmRestore()

    // Server refused → the panel shows the error toast and does NOT call onRestore.
    await waitFor(() =>
      expect(screen.getByText(/forbidden: your role cannot restore/i)).toBeInTheDocument())
    expect(onRestore).not.toHaveBeenCalled()
    // The restore endpoint WAS hit (server-side gate) but returned 403.
    expect(mockState.calls.some((c) => /restore/.test(c))).toBe(true)
  })

  it('WAVE-14: a commenter is likewise refused restore (403)', async () => {
    resetMock({ role: 'commenter' })
    const onRestore = vi.fn()
    render(<HistoryPanel fileId="doc1" onRestore={onRestore} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('First draft')).toBeInTheDocument())

    fireEvent.click(screen.getAllByTitle('Restore this version')[0])
    await confirmRestore()

    await waitFor(() =>
      expect(screen.getByText(/forbidden/i)).toBeInTheDocument())
    expect(onRestore).not.toHaveBeenCalled()
  })

  it('an editor CAN restore (positive control for the role gate)', async () => {
    resetMock({ role: 'editor' })
    const onRestore = vi.fn()
    render(<HistoryPanel fileId="doc1" onRestore={onRestore} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('First draft')).toBeInTheDocument())

    fireEvent.click(screen.getAllByTitle('Restore this version')[0])
    await confirmRestore()

    await waitFor(() => expect(onRestore).toHaveBeenCalledTimes(1))
  })
})
