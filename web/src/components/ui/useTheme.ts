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

import { useEffect, useState, useCallback, type Dispatch, type SetStateAction } from 'react'

const STORE_KEY = 'diwan.theme'
// Back-compat: honour a previously-persisted key from the old brand.
const LEGACY_KEY = 'vulos.theme'

function osPrefersDark(): boolean {
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches } catch { return false }
}

/** The persisted theme setting is 'light' | 'dark' | 'system' in practice, but
 *  this also tolerates a stray legacy value read back from localStorage. */
export function resolveTheme(theme: string): 'light' | 'dark' {
  if (theme === 'light' || theme === 'dark') return theme
  return osPrefersDark() ? 'dark' : 'light'
}

function applyTheme(theme: string): void {
  document.documentElement.setAttribute('data-theme', resolveTheme(theme))
}

export function useTheme(): { theme: string, setTheme: Dispatch<SetStateAction<string>>, cycle: () => void } {
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem(STORE_KEY) || localStorage.getItem(LEGACY_KEY) || 'light' } catch { return 'light' }
  })

  useEffect(() => {
    applyTheme(theme)
    try { localStorage.setItem(STORE_KEY, theme) } catch {}
    // In 'system' mode, follow live OS theme changes.
    if (theme !== 'system') return
    let mq: MediaQueryList
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
export function useResolvedTheme(): 'light' | 'dark' {
  const read = (): 'light' | 'dark' =>
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
