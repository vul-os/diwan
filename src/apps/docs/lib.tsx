/**
 * src/apps/docs/lib.jsx — @vulos/office-client docs library entry
 *
 * Exports <DocsApp /> — the Docs editor as a single embeddable React component.
 *
 * Props:
 *   apiBase        {string}    — base URL for API (default '' = same-origin)
 *   theme          {string}    — 'light' | 'dark' | 'auto' (default 'auto')
 *   onSignOut      {function}  — callback when user hits sign-out
 *   onNotification {function}  — optional (title, body, priority) => void
 *   initialDocID   {string}    — pre-open a specific document on mount
 */

import { Suspense, lazy } from 'react'
import type { ComponentType } from 'react'
import { MemoryRouter, Routes, Route, Navigate } from 'react-router-dom'

// DocsEditor.jsx does not yet declare props (untyped, pending conversion); this
// cast documents the props DocsApp forwards to it without widening to `any`.
export interface DocsEditorProps {
  apiBase?: string
  onNotification?: (title: string, body: string, priority?: string) => void
  onSignOut?: () => void
}

const DocsEditor = lazy(() =>
  import('./DocsEditor.jsx').then((mod) => ({ default: mod.default as ComponentType<DocsEditorProps> }))
)

export interface DocsAppProps {
  /** base URL for API (default '' = same-origin) */
  apiBase?: string
  theme?: 'light' | 'dark' | 'auto'
  /** callback when user hits sign-out */
  onSignOut?: () => void
  onNotification?: (title: string, body: string, priority?: string) => void
  /** pre-open a specific document on mount */
  initialDocID?: string
}

export function DocsApp({
  apiBase = '',
  theme = 'auto',
  onSignOut,
  onNotification,
  initialDocID,
}: DocsAppProps) {
  const initialPath = initialDocID ? `/docs/${initialDocID}` : '/docs'
  return (
    <div data-theme={theme} style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Suspense fallback={<div style={{ flex: 1 }} />}>
          <Routes>
            <Route path="/docs/:id" element={<DocsEditor apiBase={apiBase} onNotification={onNotification} onSignOut={onSignOut} />} />
            <Route path="/docs" element={<DocsEditor apiBase={apiBase} onNotification={onNotification} onSignOut={onSignOut} />} />
            <Route path="*" element={<Navigate to="/docs" replace />} />
          </Routes>
        </Suspense>
      </MemoryRouter>
    </div>
  )
}

export default DocsApp
