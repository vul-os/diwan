/**
 * "New → Whiteboard" — NewFileModal offers Whiteboard as a first-class document
 * type alongside doc/sheet/slide, and creating one routes to /whiteboards/:id
 * with type 'whiteboard'.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const createFile = vi.fn().mockResolvedValue({ id: 'wb-new', type: 'whiteboard' })
const navigate = vi.fn()

vi.mock('../../../store/filesStore', () => ({
  useFilesStore: () => ({ createFile }),
}))
vi.mock('react-router-dom', async (importOriginal: () => Promise<Record<string, unknown>>) => {
  const actual = await importOriginal()
  return { ...actual, useNavigate: () => navigate }
})

import NewFileModal from '../../../components/NewFileModal.jsx'

describe('New → Whiteboard', () => {
  it('offers Whiteboard as a type and creates one routed to /whiteboards/:id', async () => {
    createFile.mockClear(); navigate.mockClear()
    render(<NewFileModal onClose={() => {}} />)

    const wbType = await screen.findByRole('button', { name: /Whiteboard/i })
    await userEvent.click(wbType)
    await userEvent.type(screen.getByLabelText(/Name/i), 'My Board')
    await userEvent.click(screen.getByRole('button', { name: /^Create$/i }))

    await waitFor(() => expect(createFile).toHaveBeenCalled())
    expect(createFile).toHaveBeenCalledWith('My Board', 'whiteboard', expect.anything())
    expect(navigate).toHaveBeenCalledWith('/whiteboards/wb-new')
  })
})
