/**
 * Tooltip accessible-name fallback (wave-23 polish).
 *
 * The visual tooltip bubble is pointer-events:none and portalled, so it does NOT
 * provide an accessible name to assistive tech. Tooltip therefore borrows its
 * `label` as the wrapped control's `aria-label` when the control has none of its
 * own — otherwise an icon-only button reads as an anonymous "button". These tests
 * guard that fallback and, crucially, that it does NOT clobber an existing name.
 */

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import Tooltip from './Tooltip'

describe('Tooltip accessible-name fallback', () => {
  it('borrows the label as aria-label when the child has no name', () => {
    render(
      <Tooltip label="Comments">
        <button type="button"><svg aria-hidden /></button>
      </Tooltip>,
    )
    // The button is reachable by the tooltip label as its accessible name.
    expect(screen.getByRole('button', { name: 'Comments' })).toBeInTheDocument()
  })

  it('does not override an existing aria-label on the child', () => {
    render(
      <Tooltip label="Tooltip text">
        <button type="button" aria-label="Real name"><svg aria-hidden /></button>
      </Tooltip>,
    )
    expect(screen.getByRole('button', { name: 'Real name' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Tooltip text' })).toBeNull()
  })

  it('does not override an existing title on the child', () => {
    render(
      <Tooltip label="Tooltip text">
        <button type="button" title="Title name"><svg aria-hidden /></button>
      </Tooltip>,
    )
    // title supplies the accessible name; the tooltip label must not replace it.
    expect(screen.getByRole('button', { name: 'Title name' })).toBeInTheDocument()
  })

  it('does not override a child that already has visible text', () => {
    render(
      <Tooltip label="Export document">
        <button type="button">Export</button>
      </Tooltip>,
    )
    // Visible text is the accessible name; the differing tooltip label must not
    // clobber it (WCAG 2.5.3 "Label in Name").
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Export document' })).toBeNull()
  })

  it('renders children unchanged when no label is given', () => {
    render(
      <Tooltip>
        <button type="button">Plain</button>
      </Tooltip>,
    )
    expect(screen.getByRole('button', { name: 'Plain' })).toBeInTheDocument()
  })
})
