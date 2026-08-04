/**
 * MSW integration — Suggestions (track-changes): create, accept, reject.
 *
 * SuggestionPanel is a controlled component; DocsEditor owns the accept/reject
 * wiring (getSuggestionStore + api.updateSuggestion). We reproduce that exact
 * wiring in a small harness so the test drives the REAL panel, the REAL CRDT
 * suggestion store, and the REAL api client against MSW — the same code path
 * the editor uses, minus TipTap's document mutation.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { useState } from 'react'
import SuggestionPanel from '../../components/SuggestionPanel.jsx'
import type { Suggestion } from '../../components/SuggestionPanel.jsx'
import { getSuggestionStore, evictSuggestionStore } from '../../lib/crdt/suggestions.js'
import { api } from '../../lib/api.js'
import { server, resetMock, mockState } from './server'

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

// Harness mirroring DocsEditor's suggestion accept/reject handlers.
function Harness({ fileId }: { fileId: string }) {
  const store = getSuggestionStore(fileId)
  const [suggestions, setSuggestions] = useState(store.list())

  const onAccept = async (sg: Suggestion) => {
    store.accept(sg.id, 'reviewer')
    setSuggestions(store.list())
    await api.updateSuggestion(fileId, sg.id, 'accepted', 'reviewer')
  }
  const onReject = async (sg: Suggestion) => {
    store.reject(sg.id, 'reviewer')
    setSuggestions(store.list())
    await api.updateSuggestion(fileId, sg.id, 'rejected', 'reviewer')
  }

  return (
    <SuggestionPanel
      fileId={fileId} authorId="author"
      suggestions={suggestions} onAccept={onAccept} onReject={onReject}
      onClose={() => {}}
    />
  )
}

describe('Suggestions (MSW integration)', () => {
  beforeEach(() => {
    resetMock({ role: 'owner' })
    evictSuggestionStore('doc1')
  })

  function seedInsert() {
    const store = getSuggestionStore('doc1')
    return store.addInsert(3, 3, 'inserted text', 'author')
  }

  it('shows a pending insert suggestion with its change preview', async () => {
    seedInsert()
    render(<Harness fileId="doc1" />)
    expect(screen.getByText('inserted text')).toBeInTheDocument()
    // "Pending" appears both as a tab label and the suggestion's state pill.
    expect(screen.getAllByText('Pending').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByRole('button', { name: /Accept/i })).toBeInTheDocument()
  })

  it('accepting a suggestion marks it accepted and PUTs state to the server', async () => {
    seedInsert()
    render(<Harness fileId="doc1" />)

    fireEvent.click(screen.getByRole('button', { name: /Accept/i }))

    await waitFor(() =>
      expect(mockState.calls.some((c) => /PUT \/files\/doc1\/suggestions\//.test(c))).toBe(true))
    const store = getSuggestionStore('doc1')
    expect(store.list()[0].state).toBe('accepted')
  })

  it('rejecting a suggestion marks it rejected and PUTs state to the server', async () => {
    seedInsert()
    render(<Harness fileId="doc1" />)

    fireEvent.click(screen.getByRole('button', { name: /Reject/i }))

    await waitFor(() => {
      const store = getSuggestionStore('doc1')
      expect(store.list()[0].state).toBe('rejected')
    })
    expect(mockState.calls.some((c) => /PUT \/files\/doc1\/suggestions\//.test(c))).toBe(true)
  })

  it('accepted suggestions drop out of the default Pending filter', async () => {
    seedInsert()
    render(<Harness fileId="doc1" />)
    fireEvent.click(screen.getByRole('button', { name: /Accept/i }))
    // Default tab is Pending; once accepted, the empty-state copy shows.
    await waitFor(() =>
      expect(screen.getByText('No pending suggestions.')).toBeInTheDocument())
  })
})
