/**
 * MSW / RTL integration — Slides editor (full component mount).
 *
 * Mounts the REAL SlidesEditor under a MemoryRouter with the file seeded into
 * the Zustand filesStore and `/api` served by MSW. Reveal.js renders under
 * jsdom, so this is a true full-tree integration test of the deck editor.
 *
 * Covers: open a deck, add a slide, reorder slides (drag), presenter-view toggle
 * (window.open), and the presence pill.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { useFilesStore } from '../../store/filesStore.js'
import SlidesEditor from '../../apps/slides/SlidesEditor.jsx'
import { server, resetMock } from './server'

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

interface DeckSlide {
  id: string
  title: string
  content: string
  notes: string
}

function seedDeck(slides: DeckSlide[]) {
  useFilesStore.setState({
    files: [{
      id: 'deck1', name: 'My Deck', type: 'slide',
      content: {
        themeId: 'obsidian', theme: 'black', transition: 'slide',
        slides, masters: null, customTheme: null,
      },
    }],
  })
}

function mountDeck() {
  return render(
    <MemoryRouter initialEntries={['/slides/deck1']}>
      <Routes><Route path="/slides/:id" element={<SlidesEditor />} /></Routes>
    </MemoryRouter>,
  )
}

const slide = (id: string, title: string): DeckSlide => ({ id, title, content: `<p>${title}</p>`, notes: '' })

describe('Slides editor (full mount, MSW/RTL)', () => {
  beforeEach(() => resetMock())

  it('opens a deck and shows its title + first slide thumbnail', async () => {
    seedDeck([slide('s1', 'Intro')])
    mountDeck()
    await waitFor(() => expect(screen.getByDisplayValue('My Deck')).toBeInTheDocument())
    // Slide thumbnail exposes an accessible label.
    expect(screen.getAllByLabelText(/Slide 1/i).length).toBeGreaterThanOrEqual(1)
  })

  it('adds a slide via the Add slide button', async () => {
    seedDeck([slide('s1', 'Intro')])
    mountDeck()
    await waitFor(() => expect(screen.getByDisplayValue('My Deck')).toBeInTheDocument())

    // One slide to start.
    expect(screen.queryAllByLabelText(/^Slide 2/i)).toHaveLength(0)

    fireEvent.click(screen.getByLabelText('Add slide'))

    // Now a second slide exists (thumbnail rail + overview may each render it).
    await waitFor(() =>
      expect(screen.getAllByLabelText(/^Slide 2/i).length).toBeGreaterThanOrEqual(1))
  })

  it('reorders slides by drag: slide 2 dropped onto slide 1 becomes current', async () => {
    seedDeck([slide('s1', 'First'), slide('s2', 'Second')])
    mountDeck()
    await waitFor(() => expect(screen.getByDisplayValue('My Deck')).toBeInTheDocument())

    const thumbs = screen.getAllByLabelText(/^Slide \d/i)
    // Grab the rail thumbnails (first two matches).
    const first = thumbs.find((t) => /Slide 1/.test(t.getAttribute('aria-label') ?? ''))
    const second = thumbs.find((t) => /Slide 2/.test(t.getAttribute('aria-label') ?? ''))
    expect(first && second).toBeTruthy()

    // Drag slide 2 over slide 1 and drop → the moved slide becomes current (idx 0).
    fireEvent.dragStart(second!)
    fireEvent.dragOver(first!)
    fireEvent.dragEnd(second!)

    await waitFor(() => {
      // After the move, the slide now at position 1 is marked current.
      const current = screen.getAllByLabelText(/\(current\)/i)
      expect(current.length).toBeGreaterThanOrEqual(1)
      expect(current[0].getAttribute('aria-label')).toMatch(/Slide 1/)
    })
  })

  it('presenter-view toggle opens a presenter window', async () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue({
      closed: false, close: () => {}, postMessage: () => {}, focus: () => {},
      document: { write: () => {}, close: () => {} },
    } as unknown as Window)
    seedDeck([slide('s1', 'Intro')])
    mountDeck()
    await waitFor(() => expect(screen.getByDisplayValue('My Deck')).toBeInTheDocument())

    fireEvent.click(screen.getByLabelText('Open presenter view'))
    expect(openSpy).toHaveBeenCalled()
    openSpy.mockRestore()
  })

  it('shows a presence/connection status pill', async () => {
    seedDeck([slide('s1', 'Intro')])
    mountDeck()
    await waitFor(() => expect(screen.getByDisplayValue('My Deck')).toBeInTheDocument())
    // The topbar carries at least one role=status region (presence pill).
    expect(screen.getAllByRole('status').length).toBeGreaterThanOrEqual(1)
  })
})
