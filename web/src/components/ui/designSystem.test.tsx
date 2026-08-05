/**
 * Tests for the design-system primitives introduced in the UI/UX elevation pass:
 * SaveStatus, Avatar/AvatarStack (+ hueFor), EmptyState, DocThumb.
 *
 * These guard the accessible + behavioural contracts callers depend on (status
 * text, aria-live announcement, initials/hue derivation, overflow chip, empty
 * titles) so a future refactor can't silently break the suite's shared chrome.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FileText } from 'lucide-react'
import SaveStatus from './SaveStatus'
import Avatar, { AvatarStack, hueFor } from './Avatar'
import EmptyState from './EmptyState'
import ErrorState from './ErrorState'
import DocThumb from './DocThumb'
import type { DocThumbType } from './DocThumb'
import ToolbarButton from './ToolbarButton'

describe('ToolbarButton (shared toolbar toggle primitive)', () => {
  it('announces the toggle state via aria-pressed only when active', () => {
    // Inactive → the attribute is omitted (reads as a plain action button).
    const { rerender } = render(<ToolbarButton title="Bold">B</ToolbarButton>)
    let btn = screen.getByRole('button', { name: 'Bold' })
    expect(btn.hasAttribute('aria-pressed')).toBe(false)
    expect(btn.className).toContain('toolbar-btn')

    // Active → aria-pressed="true" + the .active state class.
    rerender(<ToolbarButton title="Bold" active>B</ToolbarButton>)
    btn = screen.getByRole('button', { name: 'Bold' })
    expect(btn.getAttribute('aria-pressed')).toBe('true')
    expect(btn.className).toContain('active')
  })

  it('mirrors the title into an accessible name and disables cleanly', () => {
    render(<ToolbarButton title="Italic (⌘I)" disabled>I</ToolbarButton>)
    const btn = screen.getByRole('button', { name: 'Italic (⌘I)' })
    expect(btn).toBeDisabled()
  })
})

describe('SaveStatus', () => {
  it('announces via role=status and renders the mapped label per state', () => {
    const { rerender } = render(<SaveStatus status="saving" />)
    const region = screen.getByRole('status')
    expect(region).toHaveTextContent('Saving')

    rerender(<SaveStatus status="saved" />)
    expect(screen.getByRole('status')).toHaveTextContent('Saved')

    rerender(<SaveStatus status="dirty" />)
    expect(screen.getByRole('status')).toHaveTextContent('Unsaved')

    rerender(<SaveStatus status="error" />)
    expect(screen.getByRole('status')).toHaveTextContent('Save failed')
  })

  it('honours an explicit text override (e.g. retry counter)', () => {
    render(<SaveStatus status="error" text="Retrying 2/3" />)
    expect(screen.getByRole('status')).toHaveTextContent('Retrying 2/3')
  })

  it('falls back to the saved state for an unknown status', () => {
    // Deliberately an invalid status — guards the runtime fallback for a value
    // that couldn't happen under the type system (e.g. from untyped JS callers).
    render(<SaveStatus status={'???' as unknown as 'saved'} />)
    expect(screen.getByRole('status')).toHaveTextContent('Saved')
  })
})

describe('Avatar', () => {
  it('renders one- and two-word initials', () => {
    const { rerender } = render(<Avatar name="Ada Lovelace" />)
    expect(screen.getByText('AL')).toBeInTheDocument()
    rerender(<Avatar name="cher" />)
    expect(screen.getByText('CH')).toBeInTheDocument()
  })

  it('shows a placeholder glyph when nameless', () => {
    render(<Avatar name="" />)
    expect(screen.getByText('?')).toBeInTheDocument()
  })

  it('hueFor is deterministic for the same seed', () => {
    expect(hueFor('Ada')).toBe(hueFor('Ada'))
    expect(hueFor('Ada')).toMatch(/^#/)
  })

  it('prefers an explicit colour over the derived hue', () => {
    render(<Avatar name="Ada Lovelace" color="#123456" />)
    const chip = screen.getByText('AL')
    expect(chip.style.getPropertyValue('--avatar-bg')).toBe('#123456')
  })
})

describe('AvatarStack', () => {
  it('renders up to max chips and a +N overflow chip', () => {
    const people = [
      { id: 1, name: 'A B' }, { id: 2, name: 'C D' }, { id: 3, name: 'E F' },
      { id: 4, name: 'G H' }, { id: 5, name: 'I J' }, { id: 6, name: 'K L' },
    ]
    render(<AvatarStack people={people} max={4} />)
    // 4 shown initials + overflow "+2"
    expect(screen.getByText('AB')).toBeInTheDocument()
    expect(screen.getByText('GH')).toBeInTheDocument()
    expect(screen.getByText('+2')).toBeInTheDocument()
    // 5th/6th are folded into the overflow chip, not rendered as initials
    expect(screen.queryByText('IJ')).not.toBeInTheDocument()
  })

  it('renders nothing when there are no people', () => {
    const { container } = render(<AvatarStack people={[]} />)
    expect(container.firstChild).toBeNull()
  })
})

describe('EmptyState', () => {
  it('renders the title, hint and an icon', () => {
    render(<EmptyState icon={FileText} title="No comments yet" hint="Add the first note." />)
    expect(screen.getByText('No comments yet')).toBeInTheDocument()
    expect(screen.getByText('Add the first note.')).toBeInTheDocument()
  })
})

describe('ErrorState', () => {
  it('announces the failure (role=alert) and shows the message', () => {
    render(<ErrorState message="Failed to load activity" />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Failed to load activity')
  })

  it('renders a Retry control that fires onRetry', async () => {
    const onRetry = vi.fn()
    render(<ErrorState message="boom" onRetry={onRetry} />)
    const btn = screen.getByRole('button', { name: /retry/i })
    btn.click()
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('omits the Retry control when no onRetry is given', () => {
    render(<ErrorState message="boom" />)
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull()
  })
})

describe('DocThumb', () => {
  it('renders a decorative (aria-hidden) preview for each type', () => {
    for (const type of ['doc', 'sheet', 'slide', 'pdf'] as DocThumbType[]) {
      const { container, unmount } = render(<DocThumb type={type} />)
      expect(container.querySelector('svg')).toBeInTheDocument()
      expect(container.querySelector('[aria-hidden="true"]')).toBeInTheDocument()
      unmount()
    }
  })
})
