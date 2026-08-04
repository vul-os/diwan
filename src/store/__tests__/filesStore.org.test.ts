/**
 * filesStore.org.test.js — folder / star / trash client actions (parity).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/api', () => ({
  api: {
    listFolders: vi.fn(),
    createFolder: vi.fn(),
    updateFolder: vi.fn(),
    trashFolder: vi.fn(),
    deleteFolder: vi.fn(),
    moveFile: vi.fn(),
    createFile: vi.fn(),
    listFiles: vi.fn(),
    listSharedWithMe: vi.fn(),
  },
}))
vi.mock('../../lib/draftStore', () => ({
  writeDraft: vi.fn().mockResolvedValue(undefined),
  clearDraft: vi.fn().mockResolvedValue(undefined),
}))

import { api } from '../../lib/api'
import { useFilesStore } from '../filesStore'

const listFolders = vi.mocked(api.listFolders)
const createFolder = vi.mocked(api.createFolder)
const deleteFolder = vi.mocked(api.deleteFolder)
const listFiles = vi.mocked(api.listFiles)
const listSharedWithMe = vi.mocked(api.listSharedWithMe)
const moveFile = vi.mocked(api.moveFile)
const createFile = vi.mocked(api.createFile)

beforeEach(() => {
  Object.values(api).forEach((fn) => vi.mocked(fn).mockReset?.())
  useFilesStore.setState({
    files: [{ id: 'f1', name: 'Doc', type: 'doc', content: 'v1', rev: 1, starred: false, trashed: false, parent_id: '' }],
    folders: [],
  })
})

describe('folders', () => {
  it('createFolder appends the new folder', async () => {
    createFolder.mockResolvedValueOnce({ id: 'fold1', name: 'Work', parent_id: '' })
    const f = await useFilesStore.getState().createFolder('Work', '')
    expect(api.createFolder).toHaveBeenCalledWith('Work', '')
    expect(f.id).toBe('fold1')
    expect(useFilesStore.getState().folders).toHaveLength(1)
  })

  it('fetchFolders populates state', async () => {
    listFolders.mockResolvedValueOnce([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }])
    await useFilesStore.getState().fetchFolders()
    expect(useFilesStore.getState().folders).toHaveLength(2)
  })

  it('deleteFolder removes it and refreshes files', async () => {
    useFilesStore.setState({ folders: [{ id: 'fold1', name: 'Work' }] })
    deleteFolder.mockResolvedValueOnce({})
    listFiles.mockResolvedValueOnce([])
    await useFilesStore.getState().deleteFolder('fold1')
    expect(api.deleteFolder).toHaveBeenCalledWith('fold1')
    expect(useFilesStore.getState().folders).toHaveLength(0)
  })
})

// Regression guard: a malformed (non-array) list response from the backend must
// coerce to [], never poison store state. A poisoned `files`/`folders` would
// crash every consumer that does .filter/.map/.slice — including the app-shell
// rail, which took down the WHOLE UI (all routes) when /notifications answered a
// non-array. These stores must be robust to that at the seam.
describe('non-array list responses coerce to [] (shell-crash regression)', () => {
  it('fetchFiles: an object response yields an empty array, not the object', async () => {
    listFiles.mockResolvedValueOnce({})
    await useFilesStore.getState().fetchFiles()
    const { files } = useFilesStore.getState()
    expect(Array.isArray(files)).toBe(true)
    expect(files).toHaveLength(0)
  })

  it('fetchFolders: a null response yields an empty array', async () => {
    listFolders.mockResolvedValueOnce(null)
    await useFilesStore.getState().fetchFolders()
    const { folders } = useFilesStore.getState()
    expect(Array.isArray(folders)).toBe(true)
    expect(folders).toHaveLength(0)
  })

  it('fetchSharedWithMe: a non-array files field yields an empty array', async () => {
    listSharedWithMe.mockResolvedValueOnce({ files: { nope: true } })
    await useFilesStore.getState().fetchSharedWithMe()
    const { sharedWithMe } = useFilesStore.getState()
    expect(Array.isArray(sharedWithMe)).toBe(true)
    expect(sharedWithMe).toHaveLength(0)
  })
})

describe('star / trash / move', () => {
  it('toggleStar flips the star and applies the server result', async () => {
    moveFile.mockResolvedValueOnce({ id: 'f1', name: 'Doc', type: 'doc', rev: 1, starred: true, trashed: false, parent_id: '' })
    await useFilesStore.getState().toggleStar('f1')
    expect(api.moveFile).toHaveBeenCalledWith('f1', { starred: true })
    expect(useFilesStore.getState().files[0].starred).toBe(true)
  })

  it('trashFile sets trashed via move', async () => {
    moveFile.mockResolvedValueOnce({ id: 'f1', name: 'Doc', type: 'doc', rev: 1, trashed: true, parent_id: '' })
    await useFilesStore.getState().trashFile('f1')
    expect(api.moveFile).toHaveBeenCalledWith('f1', { trashed: true })
    expect(useFilesStore.getState().files[0].trashed).toBe(true)
  })

  it('restoreFile clears trashed via move', async () => {
    useFilesStore.setState({ files: [{ id: 'f1', name: 'Doc', type: 'doc', rev: 1, trashed: true, parent_id: '' }] })
    moveFile.mockResolvedValueOnce({ id: 'f1', name: 'Doc', type: 'doc', rev: 1, trashed: false, parent_id: '' })
    await useFilesStore.getState().restoreFile('f1')
    expect(api.moveFile).toHaveBeenCalledWith('f1', { trashed: false })
    expect(useFilesStore.getState().files[0].trashed).toBe(false)
  })

  it('moveFile reparents into a folder', async () => {
    moveFile.mockResolvedValueOnce({ id: 'f1', name: 'Doc', type: 'doc', rev: 1, parent_id: 'fold1' })
    await useFilesStore.getState().moveFile('f1', { parentId: 'fold1' })
    expect(api.moveFile).toHaveBeenCalledWith('f1', { parentId: 'fold1' })
    expect(useFilesStore.getState().files[0].parent_id).toBe('fold1')
  })
})

describe('createFile with template + folder', () => {
  it('seeds template content and files into a folder', async () => {
    createFile.mockResolvedValueOnce({ id: 'new1', name: 'Résumé', type: 'doc', rev: 1, parent_id: '' })
    moveFile.mockResolvedValueOnce({ id: 'new1', name: 'Résumé', type: 'doc', rev: 1, parent_id: 'fold1' })
    const tpl = { type: 'doc', content: [{ type: 'paragraph' }] }
    const f = await useFilesStore.getState().createFile('Résumé', 'doc', { content: tpl, parentId: 'fold1' })
    expect(api.createFile).toHaveBeenCalledWith('Résumé', 'doc', tpl)
    expect(api.moveFile).toHaveBeenCalledWith('new1', { parentId: 'fold1' })
    expect(f.parent_id).toBe('fold1')
  })

  it('uses default content when no template given', async () => {
    createFile.mockResolvedValueOnce({ id: 'new2', name: 'Blank', type: 'doc', rev: 1 })
    await useFilesStore.getState().createFile('Blank', 'doc')
    // Third arg is the blank default doc shape, not undefined.
    const [, , content] = createFile.mock.calls[0]
    expect(content).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] })
  })
})
