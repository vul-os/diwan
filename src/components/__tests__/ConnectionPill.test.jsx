/**
 * ConnectionPill.test.jsx — WAVE-27 status-pill rendering.
 *
 * Confirms the pill maps each derived status to the right label, tone class,
 * accessibility affordances (role=status, aria-live), and reduced-motion-safe
 * animation gating.
 */

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import ConnectionPill from '../ConnectionPill.jsx'

function pill(status, label, tone) {
  return { status, label, tone }
}

describe('ConnectionPill', () => {
  it('renders nothing when pill is null', () => {
    const { container } = render(<ConnectionPill pill={null} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders Live with success tone and peer count', () => {
    render(<ConnectionPill pill={pill('live', 'Live', 'success')} peerCount={3} />)
    const el = screen.getByRole('status')
    expect(el).toHaveTextContent('Live')
    expect(el.className).toMatch(/text-success/)
    // Folds peer count into the accessible label.
    expect(el).toHaveAttribute('aria-label', expect.stringContaining('3 collaborators'))
  })

  it('singularises the collaborator count', () => {
    render(<ConnectionPill pill={pill('live', 'Live', 'success')} peerCount={1} />)
    expect(screen.getByRole('status')).toHaveAttribute(
      'aria-label', expect.stringContaining('1 collaborator connected'),
    )
  })

  it('renders Reconnecting with warning tone and a motion-safe pulse', () => {
    render(<ConnectionPill pill={pill('reconnecting', 'Reconnecting…', 'warning')} />)
    const el = screen.getByRole('status')
    expect(el).toHaveTextContent('Reconnecting…')
    expect(el.className).toMatch(/text-warning/)
    // Pulse is gated behind motion-safe (reduced-motion respect).
    expect(el.className).toMatch(/motion-safe:animate-pulse/)
  })

  it('renders Offline with muted tone and no pulse', () => {
    render(<ConnectionPill pill={pill('offline', 'Offline', 'muted')} />)
    const el = screen.getByRole('status')
    expect(el).toHaveTextContent('Offline')
    expect(el.className).toMatch(/text-ink-muted/)
    expect(el.className).not.toMatch(/animate-pulse/)
  })

  it('renders the engine mismatch with a danger tone', () => {
    // Deliberately louder than every other state in this component: it is the
    // only one that means "this will not fix itself".
    render(<ConnectionPill pill={pill('mismatch', 'Not syncing', 'danger')} />)
    const el = screen.getByRole('status')
    expect(el).toHaveTextContent('Not syncing')
    expect(el.className).toMatch(/text-danger/)
    expect(el.className).not.toMatch(/animate-pulse/)
  })

  it('is announced politely to assistive tech', () => {
    render(<ConnectionPill pill={pill('connecting', 'Connecting…', 'muted')} />)
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite')
  })
})
