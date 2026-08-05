/**
 * src/apps/whiteboard/lib.tsx — @vulos/office-client whiteboard library entry
 *
 * Exports <WhiteboardApp /> — the Excalidraw-based whiteboard editor as a single
 * embeddable React component, mounted on Office's distributed P2P collab engine
 * (see WhiteboardEditor.jsx). Built on the MIT-licensed Excalidraw editor
 * (https://github.com/excalidraw/excalidraw).
 *
 * Props:
 *   theme                {string}    — 'light' | 'dark' | 'auto' (default 'auto')
 *   initialWhiteboardID  {string}    — pre-open a specific whiteboard on mount
 */

import { Suspense, lazy } from 'react'
import { MemoryRouter, Routes, Route, Navigate } from 'react-router-dom'

const WhiteboardEditor = lazy(() => import('./WhiteboardEditor.jsx'))

interface WhiteboardAppProps {
  theme?: 'light' | 'dark' | 'auto'
  initialWhiteboardID?: string
}

export function WhiteboardApp({ theme = 'auto', initialWhiteboardID }: WhiteboardAppProps) {
  const initialPath = initialWhiteboardID ? `/whiteboards/${initialWhiteboardID}` : '/whiteboards'
  return (
    <div data-theme={theme} style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Suspense fallback={<div style={{ flex: 1 }} />}>
          <Routes>
            <Route path="/whiteboards/:id" element={<WhiteboardEditor />} />
            <Route path="*" element={<Navigate to="/whiteboards" replace />} />
          </Routes>
        </Suspense>
      </MemoryRouter>
    </div>
  )
}

export default WhiteboardApp
