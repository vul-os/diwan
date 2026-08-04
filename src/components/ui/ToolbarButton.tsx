/**
 * ToolbarButton — the one shared toolbar button primitive.
 * ----------------------------------------------------------------------------
 * Consolidates the three drifting toolbar buttons (Docs' raw `.toolbar-btn`,
 * Slides' mixed inline buttons, PDF's IconButton) onto a single component so
 * the editors stop diverging. It renders the tokenised `.toolbar-btn` class
 * (see index.css — which also raises the hit area to ≥44px on coarse pointers).
 *
 * Accessibility:
 *   - `active` maps to `aria-pressed` so toggle buttons (Bold/Italic/Align…)
 *     announce their state instead of reading as plain buttons.
 *
 * Usage:
 *   <ToolbarButton title="Bold (⌘B)" active={isBold} onClick={…}><Bold/></ToolbarButton>
 */

import { forwardRef } from 'react'
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'

interface ToolbarButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean
  disabled?: boolean
  title?: string
  className?: string
  children?: ReactNode
}

const ToolbarButton = forwardRef(function ToolbarButton(
  { active = false, disabled = false, title, className = '', children, ...rest }: ToolbarButtonProps,
  ref: Ref<HTMLButtonElement>,
) {
  return (
    <button
      ref={ref}
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active || undefined}
      disabled={!!disabled}
      className={`toolbar-btn ${active ? 'active' : ''} ${className}`.trim()}
      {...rest}
    >
      {children}
    </button>
  )
})

export default ToolbarButton
