/**
 * useTheme — tiny hook for explicit light/dark/system theme toggling.
 *
 * Storage:
 *   localStorage 'diwan.theme' = 'light' | 'dark' | 'system'
 *   DEFAULT is 'light' — Diwan ships light out of the box (a workspace should
 *   feel like daylight). System/Dark are opt-in via the selector.
 *
 * Side-effects:
 *   Always resolves to a concrete [data-theme="light"|"dark"] on <html> — in
 *   'system' mode it reads prefers-color-scheme and follows OS changes live.
 */

import { useEffect, useState, useCallback } from 'react'

const STORE_KEY = 'diwan.theme'
// Back-compat: honour a previously-persisted key from the old brand.
const LEGACY_KEY = 'vulos.theme'

function osPrefersDark() {
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches } catch { return false }
}

export function resolveTheme(theme) {
  if (theme === 'light' || theme === 'dark') return theme
  return osPrefersDark() ? 'dark' : 'light'
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', resolveTheme(theme))
}

export function useTheme() {
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem(STORE_KEY) || localStorage.getItem(LEGACY_KEY) || 'light' } catch { return 'light' }
  })

  useEffect(() => {
    applyTheme(theme)
    try { localStorage.setItem(STORE_KEY, theme) } catch {}
    // In 'system' mode, follow live OS theme changes.
    if (theme !== 'system') return
    let mq
    try { mq = window.matchMedia('(prefers-color-scheme: dark)') } catch { return }
    const onChange = () => applyTheme('system')
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [theme])

  const cycle = useCallback(() => {
    setTheme((t) => (t === 'light' ? 'dark' : t === 'dark' ? 'system' : 'light'))
  }, [])

  return { theme, setTheme, cycle }
}

/**
 * useResolvedTheme — the concrete 'light' | 'dark' currently in effect, tracked
 * live from the <html data-theme> attribute (which useTheme keeps authoritative,
 * including 'system' → OS resolution). Sub-app canvases that own their own
 * theming (Excalidraw, chart overlays, …) subscribe here so they flip in lock-
 * step with the shared tokens instead of guessing from the raw preference.
 */
export function useResolvedTheme() {
  const read = () =>
    (typeof document !== 'undefined' &&
      document.documentElement.getAttribute('data-theme')) === 'dark'
      ? 'dark'
      : 'light'
  const [resolved, setResolved] = useState(read)
  useEffect(() => {
    const el = document.documentElement
    const obs = new MutationObserver(() => setResolved(read()))
    obs.observe(el, { attributes: true, attributeFilter: ['data-theme'] })
    setResolved(read())
    return () => obs.disconnect()
  }, [])
  return resolved
}
