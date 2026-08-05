/**
 * PresenceBar.test.jsx — guards the collaborator roster strip's accessible
 * contract: the group is labelled with a live count, avatars announce names,
 * and the "+N" overflow chip names the hidden collaborators (polish/office).
 */

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import PresenceBar from '../PresenceBar'

interface RosterPeer {
  accountId: string
  displayName: string
  color: string
  online: boolean
  [key: string]: unknown
}

const peer = (accountId: string, displayName: string, extra: Partial<RosterPeer> = {}): RosterPeer => ({
  accountId, displayName, color: '#0f6a6c', online: true, ...extra,
})

describe('PresenceBar', () => {
  it('renders nothing for an empty roster', () => {
    const { container } = render(<PresenceBar roster={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('labels the strip with a pluralised online count', () => {
    render(<PresenceBar roster={[peer('1', 'Ada Lovelace'), peer('2', 'Alan Turing')]} />)
    expect(screen.getByLabelText('2 collaborators online')).toBeInTheDocument()
  })

  it('uses the singular form for one collaborator', () => {
    render(<PresenceBar roster={[peer('1', 'Ada Lovelace')]} />)
    expect(screen.getByLabelText('1 collaborator online')).toBeInTheDocument()
  })

  it('folds extra collaborators into a "+N" chip that names them', () => {
    const roster = [
      peer('1', 'Ada'), peer('2', 'Alan'), peer('3', 'Grace'),
      peer('4', 'Edsger'), peer('5', 'Barbara'), peer('6', 'Donald'),
    ]
    render(<PresenceBar roster={roster} max={4} />)
    // 4 shown, 2 folded.
    expect(screen.getByText('+2')).toBeInTheDocument()
    const chip = screen.getByText('+2')
    // The overflow tooltip names the hidden collaborators (Barbara, Donald).
    expect(chip.getAttribute('title')).toContain('Barbara')
    expect(chip.getAttribute('title')).toContain('Donald')
    expect(chip.getAttribute('aria-label')).toBe(chip.getAttribute('title'))
  })

  it('caps the names listed in the overflow tooltip', () => {
    const roster = Array.from({ length: 20 }, (_, i) => peer(String(i), `User${i}`))
    render(<PresenceBar roster={roster} max={2} />)
    const chip = screen.getByText('+18')
    // Names are capped at 8 with an ellipsis so the title never runs away.
    expect(chip.getAttribute('title')).toContain('…')
  })
})
