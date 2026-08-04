/**
 * ThemeGallery — a11y + interaction test.
 *
 * Locks the WAI-ARIA tabs contract added in the finalize pass: the tablist and
 * its tabs carry the right roles/state, arrow keys roam + activate tabs, the
 * form controls are label-associated, and Apply reports the chosen theme.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ThemeGallery from './ThemeGallery.jsx'
import { PRESET_THEMES } from './themes'

function open(props = {}) {
  return render(
    <ThemeGallery
      currentThemeId={PRESET_THEMES[0].id}
      customTheme={null}
      onApply={props.onApply || (() => {})}
      onClose={props.onClose || (() => {})}
    />,
  )
}

describe('ThemeGallery tabs a11y', () => {
  it('exposes a labelled tablist with two tabs and one selected', () => {
    open()
    const tablist = screen.getByRole('tablist', { name: /theme source/i })
    expect(tablist).toBeInTheDocument()
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(2)
    // Presets is selected by default; Custom is not.
    const presets = screen.getByRole('tab', { name: 'Presets' })
    const custom = screen.getByRole('tab', { name: 'Custom' })
    expect(presets).toHaveAttribute('aria-selected', 'true')
    expect(custom).toHaveAttribute('aria-selected', 'false')
    // Roving tabindex: only the active tab is in the tab order.
    expect(presets).toHaveAttribute('tabindex', '0')
    expect(custom).toHaveAttribute('tabindex', '-1')
  })

  it('each tab controls a labelled tabpanel', () => {
    open()
    const presets = screen.getByRole('tab', { name: 'Presets' })
    expect(presets).toHaveAttribute('aria-controls', 'themepanel-gallery')
    const panel = screen.getByRole('tabpanel')
    expect(panel).toHaveAttribute('aria-labelledby', 'themetab-gallery')
  })

  it('ArrowRight moves selection to the next tab and activates it', () => {
    open()
    const presets = screen.getByRole('tab', { name: 'Presets' })
    fireEvent.keyDown(presets, { key: 'ArrowRight' })
    const custom = screen.getByRole('tab', { name: 'Custom' })
    expect(custom).toHaveAttribute('aria-selected', 'true')
    // The custom panel is now shown (base-preset select is a tell).
    expect(screen.getByLabelText('Base Preset')).toBeInTheDocument()
  })

  it('ArrowLeft wraps from the first tab to the last', () => {
    open()
    const presets = screen.getByRole('tab', { name: 'Presets' })
    fireEvent.keyDown(presets, { key: 'ArrowLeft' })
    expect(screen.getByRole('tab', { name: 'Custom' })).toHaveAttribute('aria-selected', 'true')
  })
})

describe('ThemeGallery custom form + apply', () => {
  it('custom-tab form controls are associated with their labels', () => {
    open()
    fireEvent.click(screen.getByRole('tab', { name: 'Custom' }))
    // getByLabelText only resolves when htmlFor/id are wired correctly.
    expect(screen.getByLabelText('Base Preset')).toBeInTheDocument()
    expect(screen.getByLabelText('Heading Font')).toBeInTheDocument()
    expect(screen.getByLabelText('Body Font')).toBeInTheDocument()
    expect(screen.getByLabelText('Primary')).toBeInTheDocument()
    expect(screen.getByLabelText('Background')).toBeInTheDocument()
  })

  it('Apply reports the selected theme id', () => {
    const onApply = vi.fn()
    open({ onApply })
    // Pick the second preset tile, then apply.
    const tile = screen.getByRole('button', { name: new RegExp(PRESET_THEMES[1].label, 'i') })
    fireEvent.click(tile)
    fireEvent.click(screen.getByRole('button', { name: /^Apply/i }))
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ themeId: PRESET_THEMES[1].id }),
    )
  })

  it('Escape closes the dialog', () => {
    const onClose = vi.fn()
    open({ onClose })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
