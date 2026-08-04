/**
 * WhiteboardEditor — the editor mounts the Excalidraw canvas (stubbed for jsdom)
 * and, exactly like Docs, makes ZERO central-collab-server calls. Collaboration
 * is peer-to-peer over /api/peering/* (never mounted in this host), so on a plain
 * open nothing leaves the tab. This pins the "no central whiteboard/collab
 * server" guarantee at the component boundary; the multipeer CRDT proof lives in
 * lib/crdt/__tests__/boardYP2P.multipeer.test.js.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import type { ExcalidrawProps, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { server, resetMock, mockState } from '../../../__tests__/msw/server.js'

interface FakeBoardElement { id: string; [k: string]: unknown }
interface FakeBoardFile { id: string; [k: string]: unknown }

// Stub the Excalidraw canvas: jsdom cannot run its canvas engine. The stub hands
// the editor a REAL imperative scene API (so the ExcalidrawYBinding runs for
// real) and renders a testid we can assert mounted.
vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: (props: ExcalidrawProps) => {
    const give = (node: (HTMLDivElement & { __gaveApi?: boolean }) | null) => {
      if (node && !node.__gaveApi) {
        node.__gaveApi = true
        let scene: FakeBoardElement[] = []
        const files: Record<string, FakeBoardFile> = {}
        props.excalidrawAPI?.({
          updateScene(s: { elements?: FakeBoardElement[] }) { if (s.elements) scene = [...s.elements] },
          getSceneElementsIncludingDeleted() { return scene },
          addFiles(fs: FakeBoardFile[]) { for (const f of fs) files[f.id] = f },
          getFiles() { return files },
        } as unknown as ExcalidrawImperativeAPI)
      }
    }
    return <div data-testid="excalidraw" data-view-mode={props.viewModeEnabled ? 'true' : 'false'} ref={give} />
  },
}))

import WhiteboardEditor from '../WhiteboardEditor'

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks() })
afterAll(() => server.close())

function collabCalls() {
  return mockState.calls.filter((c) => c.includes('/collab/'))
}

function mount() {
  return render(
    <MemoryRouter initialEntries={['/whiteboards/wb1']}>
      <Routes>
        <Route path="/whiteboards/:id" element={<WhiteboardEditor />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('WhiteboardEditor', () => {
  beforeEach(() => {
    resetMock({ role: 'owner' })
    mockState.files.wb1 = { id: 'wb1', name: 'System Diagram', type: 'whiteboard', content: { elements: [], files: {} } }
  })

  it('mounts the Excalidraw canvas and makes ZERO central-collab-server calls', async () => {
    mount()
    await waitFor(() => expect(screen.getByTestId('excalidraw')).toBeTruthy())
    await new Promise((r) => setTimeout(r, 200)) // let any deferred join/bootstrap fire
    expect(collabCalls()).toEqual([])
  })

  it('shows the title from the file and credits the MIT Excalidraw editor', async () => {
    mount()
    await waitFor(() => expect(screen.getByTestId('whiteboard-editor')).toBeTruthy())
    await waitFor(() => expect(screen.getByLabelText('Whiteboard title')).toHaveValue('System Diagram'))
    expect(document.body.textContent).toMatch(/excalidraw/i)
  })
})
