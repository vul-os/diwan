/**
 * filesStore.optlock.test.js — P2 optimistic-concurrency client reconcile.
 *
 * The autosave PUT carries the rev the client last read. On a 409 Conflict the
 * store must NOT silently lose the update: it adopts the server's newer file,
 * then retries once against the newer rev, re-applying this caller's content.
 * A normal sequential save still works, and it sends the last-known rev.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the api module BEFORE importing the store (hoisted by vitest).
vi.mock('../../lib/api', () => ({
  api: { updateFile: vi.fn() },
}))
// Draft store is IndexedDB-backed; stub it so saveFileWithDraft doesn't touch it.
vi.mock('../../lib/draftStore', () => ({
  writeDraft: vi.fn().mockResolvedValue(undefined),
  clearDraft: vi.fn().mockResolvedValue(undefined),
}))

import { api } from '../../lib/api'
import { useFilesStore, type DiwanFile } from '../filesStore'

const updateFile = vi.mocked(api.updateFile)

function seed(files: DiwanFile[]) {
  useFilesStore.setState({ files })
}

beforeEach(() => {
  updateFile.mockReset()
  seed([{ id: 'f1', name: 'Doc', type: 'doc', content: 'v1', rev: 1 }])
})

describe('P2: filesStore optimistic-concurrency reconcile', () => {
  it('a normal sequential save sends the last-known rev and stores the result', async () => {
    updateFile.mockResolvedValueOnce({ id: 'f1', name: 'Doc', type: 'doc', content: 'v2', rev: 2 })

    const out = await useFilesStore.getState().updateFile('f1', 'Doc', 'v2')

    // Sent the rev the store held (1).
    expect(api.updateFile).toHaveBeenCalledWith('f1', 'Doc', 'v2', 1)
    expect(out.rev).toBe(2)
    expect(useFilesStore.getState().files.find((f) => f.id === 'f1')?.rev).toBe(2)
  })

  it('a 409 adopts the newer file and retries once against the newer rev', async () => {
    const newer = { id: 'f1', name: 'Doc', type: 'doc', content: 'peerEdit', rev: 5 }
    // First call: stale rev → 409 carrying the current (newer) file.
    updateFile.mockRejectedValueOnce(Object.assign(new Error('revision conflict'), { status: 409, current: newer }))
    // Retry against rev 5 → success, rev advances to 6, our content re-applied.
    updateFile.mockResolvedValueOnce({ id: 'f1', name: 'Doc', type: 'doc', content: 'myEdit', rev: 6 })

    const out = await useFilesStore.getState().updateFile('f1', 'Doc', 'myEdit')

    expect(api.updateFile).toHaveBeenNthCalledWith(1, 'f1', 'Doc', 'myEdit', 1) // stale
    expect(api.updateFile).toHaveBeenNthCalledWith(2, 'f1', 'Doc', 'myEdit', 5) // retry w/ newer rev
    expect(out.content).toBe('myEdit')
    expect(out.rev).toBe(6)
    // No update was lost — this caller's content is what landed.
    expect(useFilesStore.getState().files.find((f) => f.id === 'f1')?.content).toBe('myEdit')
  })

  it('a persistent conflict (retry also 409) surfaces the conflict, no silent loss', async () => {
    const newer = { id: 'f1', name: 'Doc', type: 'doc', content: 'peer', rev: 5 }
    updateFile
      .mockRejectedValueOnce(Object.assign(new Error('conflict'), { status: 409, current: newer }))
      .mockRejectedValueOnce(Object.assign(new Error('conflict'), { status: 409, current: { ...newer, rev: 7 } }))

    await expect(useFilesStore.getState().updateFile('f1', 'Doc', 'myEdit'))
      .rejects.toMatchObject({ status: 409 })
    // Retried exactly once (2 calls total), then gave up rather than looping.
    expect(api.updateFile).toHaveBeenCalledTimes(2)
  })

  it('onConflict lets a caller reconcile non-CRDT structure before the retry', async () => {
    const newer = { id: 'f1', name: 'Doc', type: 'doc', content: 'peer', rev: 5 }
    updateFile.mockRejectedValueOnce(Object.assign(new Error('conflict'), { status: 409, current: newer }))
    updateFile.mockResolvedValueOnce({ id: 'f1', name: 'Doc', type: 'doc', content: 'reconciled', rev: 6 })
    const onConflict = vi.fn()

    await useFilesStore.getState().updateFile('f1', 'Doc', 'reconciled', { onConflict })

    expect(onConflict).toHaveBeenCalledWith(newer, 'reconciled')
  })

  it('a non-409 error propagates untouched (no reconcile attempt)', async () => {
    updateFile.mockRejectedValueOnce(Object.assign(new Error('server error'), { status: 500 }))
    await expect(useFilesStore.getState().updateFile('f1', 'Doc', 'v2'))
      .rejects.toThrow('server error')
    expect(api.updateFile).toHaveBeenCalledTimes(1) // no retry
  })
})
