/**
 * src/apps/sheets/lib.tsx — @vulos/office-client sheets library entry
 *
 * Exports <SheetsApp /> — the Sheets editor as a single embeddable React component.
 *
 * Props:
 *   apiBase        {string}    — base URL for API (default '' = same-origin)
 *   theme          {string}    — 'light' | 'dark' | 'auto' (default 'auto')
 *   onSignOut      {function}  — callback when user hits sign-out
 *   onNotification {function}  — optional (title, body, priority) => void
 *   initialDocID   {string}    — pre-open a specific sheet on mount
 */

import { Suspense, lazy, type ComponentType, type LazyExoticComponent } from 'react'
import { MemoryRouter, Routes, Route, Navigate } from 'react-router-dom'

export interface SheetsAppProps {
  apiBase?: string
  theme?: string
  onSignOut?: () => void
  onNotification?: (title: string, body: string, priority?: unknown) => void
  initialDocID?: string
}

/** SheetsEditor.jsx is not yet converted and (per its own signature) currently
 * takes no props at all — apiBase/onNotification/onSignOut below are passed but
 * silently ignored by it today, same as before this file was converted. This
 * local cast documents the prop contract lib.tsx wants without changing that
 * runtime behavior; it should be dropped once SheetsEditor is converted and
 * actually reads these. */
interface SheetsEditorProps {
  apiBase?: string
  onNotification?: (title: string, body: string, priority?: unknown) => void
  onSignOut?: () => void
}
const SheetsEditor = lazy(() => import('./SheetsEditor.jsx')) as unknown as LazyExoticComponent<ComponentType<SheetsEditorProps>>

export function SheetsApp({
  apiBase = '',
  theme = 'auto',
  onSignOut,
  onNotification,
  initialDocID,
}: SheetsAppProps) {
  const initialPath = initialDocID ? `/sheets/${initialDocID}` : '/sheets'
  return (
    <div data-theme={theme} style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Suspense fallback={<div style={{ flex: 1 }} />}>
          <Routes>
            <Route path="/sheets/:id" element={<SheetsEditor apiBase={apiBase} onNotification={onNotification} onSignOut={onSignOut} />} />
            <Route path="/sheets" element={<SheetsEditor apiBase={apiBase} onNotification={onNotification} onSignOut={onSignOut} />} />
            <Route path="*" element={<Navigate to="/sheets" replace />} />
          </Routes>
        </Suspense>
      </MemoryRouter>
    </div>
  )
}

export default SheetsApp
