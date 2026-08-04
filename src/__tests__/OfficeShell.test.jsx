/**
 * OfficeShell tests
 * 1. Renders the shell (after auth mock)
 * 2. Deep-link routes to the right pane
 *
 * The auth boundary itself is covered against the REAL component in
 * RequireAuth.test.jsx.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Mock lazy-loaded app components so they render immediately
vi.mock('../apps/docs/DocsEditor.jsx', () => ({
  default: () => <div data-testid="docs-editor">DocsEditor</div>,
}))
vi.mock('../apps/sheets/SheetsEditor.jsx', () => ({
  default: () => <div data-testid="sheets-editor">SheetsEditor</div>,
}))
vi.mock('../apps/slides/SlidesEditor.jsx', () => ({
  default: () => <div data-testid="slides-editor">SlidesEditor</div>,
}))
vi.mock('../apps/pdf/PDFEditor.jsx', () => ({
  default: () => <div data-testid="pdf-editor">PDFEditor</div>,
}))

// Mock RequireAuth to pass through children (auth tested separately)
vi.mock('../shells/RequireAuth', () => ({
  default: ({ children }) => <>{children}</>,
}))

import OfficeShell from '../shells/OfficeShell.jsx'

describe('OfficeShell', () => {
  it('renders the canonical left-rail Sidebar with all four app links', async () => {
    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/sheets/abc123']}>
          <OfficeShell />
        </MemoryRouter>
      )
    })
    // Canonical Layout/Sidebar nav — not the old divergent top-nav.
    expect(screen.getByText('Docs')).toBeTruthy()
    expect(screen.getByText('Sheets')).toBeTruthy()
    expect(screen.getByText('Slides')).toBeTruthy()
    expect(screen.getByText('PDF')).toBeTruthy()
  })

  it('deep-link /sheets/:id routes to SheetsEditor', async () => {
    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/sheets/abc123']}>
          <OfficeShell />
        </MemoryRouter>
      )
    })
    await waitFor(() => {
      expect(screen.getByTestId('sheets-editor')).toBeTruthy()
    })
  })

  it('deep-link /pdf/:id routes to PDFEditor', async () => {
    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/pdf/doc42']}>
          <OfficeShell />
        </MemoryRouter>
      )
    })
    await waitFor(() => {
      expect(screen.getByTestId('pdf-editor')).toBeTruthy()
    })
  })
})
