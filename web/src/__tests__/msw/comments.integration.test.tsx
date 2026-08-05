/**
 * MSW integration — Comments: add, reply, resolve, reopen.
 *
 * Mounts the REAL CommentsPanel (which drives the CRDT CommentStore + the REST
 * api). `/api/files/:id/comments…` is served by MSW, so we exercise the true
 * create → list → resolve → reopen round-trip through fetch.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CommentsPanel from '../../components/CommentsPanel'
import { evictCommentStore } from '../../lib/crdt/comments.js'
import { server, resetMock, mockState } from './server.js'

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const anchorCtx = { type: 'text', from: 1, to: 5, snapshot: 'Hello' }

describe('Comments (MSW integration)', () => {
  beforeEach(() => {
    resetMock({ role: 'owner' })
    // The CRDT CommentStore is a module-level singleton keyed by fileId — evict
    // it so state from a prior test doesn't leak into the next.
    evictCommentStore('doc1')
  })

  it('starts empty, then adds a comment that persists to the server', async () => {
    render(<CommentsPanel fileId="doc1" anchorCtx={anchorCtx} authorId="alice" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('No comments yet.')).toBeInTheDocument())

    const box = screen.getByPlaceholderText('Add a comment…')
    await userEvent.type(box, 'Needs a citation')
    fireEvent.click(screen.getByRole('button', { name: /^Comment$/i }))

    await waitFor(() => expect(screen.getByText('Needs a citation')).toBeInTheDocument())
    // Server received the create.
    expect(mockState.calls).toContain('POST /files/doc1/comments')
    expect(mockState.comments.doc1).toHaveLength(1)
    expect(mockState.comments.doc1[0].body).toBe('Needs a citation')
    expect(mockState.comments.doc1[0].author_id).toBe('alice')
  })

  it('resolves an open comment, then reopens it (state round-trips via PUT)', async () => {
    // Seed a comment on the server first.
    mockState.comments.doc1 = [{
      id: 'c1', anchor: anchorCtx, author_id: 'alice', body: 'Fix wording',
      state: 'open', created_at: new Date().toISOString(), replies: [],
    }]

    render(<CommentsPanel fileId="doc1" anchorCtx={anchorCtx} authorId="alice" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('Fix wording')).toBeInTheDocument())

    // Resolve.
    fireEvent.click(screen.getByRole('button', { name: /Resolve/i }))
    await waitFor(() => expect(screen.getByText('Resolved')).toBeInTheDocument())
    expect(mockState.calls).toContain('PUT /files/doc1/comments/c1')
    expect(mockState.comments.doc1[0].state).toBe('resolved')

    // Reopen.
    fireEvent.click(screen.getByRole('button', { name: /Reopen/i }))
    await waitFor(() => expect(mockState.comments.doc1[0].state).toBe('open'))
  })

  it('adds a threaded reply to an existing comment', async () => {
    mockState.comments.doc1 = [{
      id: 'c1', anchor: anchorCtx, author_id: 'alice', body: 'Top comment',
      state: 'open', created_at: new Date().toISOString(), replies: [],
    }]

    render(<CommentsPanel fileId="doc1" anchorCtx={anchorCtx} authorId="bob" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('Top comment')).toBeInTheDocument())

    const replyBox = screen.getByPlaceholderText('Reply…')
    await userEvent.type(replyBox, 'Agreed')
    fireEvent.click(screen.getByRole('button', { name: /Post reply/i }))

    await waitFor(() => expect(screen.getByText('Agreed')).toBeInTheDocument())
    expect(mockState.calls).toContain('POST /files/doc1/comments/c1/replies')
    expect(mockState.comments.doc1[0].replies).toHaveLength(1)
  })

  it('assigns a comment to a collaborator, then resolve clears the assignment', async () => {
    // Roster: owner + bob (a real collaborator). carol is NOT on the roster.
    mockState.owner = 'alice'
    mockState.collaborators.doc1 = [{ account_id: 'bob', role: 'editor' }]
    mockState.comments.doc1 = [{
      id: 'c1', anchor: anchorCtx, author_id: 'alice', body: 'Do this',
      state: 'open', assignee: '', created_at: new Date().toISOString(), replies: [],
    }]

    render(<CommentsPanel fileId="doc1" anchorCtx={anchorCtx} authorId="alice" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('Do this')).toBeInTheDocument())

    // Open the assign menu and pick bob.
    fireEvent.click(screen.getByRole('button', { name: /^Assign$/i }))
    fireEvent.click(await screen.findByRole('button', { name: /bob/i }))

    await waitFor(() => expect(mockState.comments.doc1[0].assignee).toBe('bob'))
    expect(mockState.calls).toContain('PUT /files/doc1/comments/c1')
    // The assignee badge shows.
    await waitFor(() => expect(screen.getByTitle('Assigned to bob')).toBeInTheDocument())

    // Resolving the thread clears the assignment (server-side + reflected here).
    fireEvent.click(screen.getByRole('button', { name: /Resolve/i }))
    await waitFor(() => expect(mockState.comments.doc1[0].state).toBe('resolved'))
    expect(mockState.comments.doc1[0].assignee).toBe('')
  })

  it('filters comments by Open / Resolved tabs', async () => {
    mockState.comments.doc1 = [
      { id: 'c1', anchor: anchorCtx, author_id: 'a', body: 'Open one', state: 'open', created_at: new Date().toISOString(), replies: [] },
      { id: 'c2', anchor: anchorCtx, author_id: 'a', body: 'Done one', state: 'resolved', created_at: new Date().toISOString(), replies: [] },
    ]
    render(<CommentsPanel fileId="doc1" anchorCtx={anchorCtx} authorId="a" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('Open one')).toBeInTheDocument())

    // Switch to Resolved tab → only the resolved comment shows.
    fireEvent.click(screen.getByRole('tab', { name: /Resolved/i }))
    await waitFor(() => expect(screen.queryByText('Open one')).not.toBeInTheDocument())
    expect(screen.getByText('Done one')).toBeInTheDocument()
  })
})
