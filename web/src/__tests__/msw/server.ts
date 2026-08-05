/**
 * MSW node server for the vitest integration layer (WAVE-28).
 *
 * Import { server } into a test and drive it with resetMock() in beforeEach.
 * The lifecycle (listen / resetHandlers / close) is wired once here and the
 * consuming test file hooks it. onUnhandledRequest is 'bypass' so unrelated
 * asset/probe requests don't fail the run — we only assert on the endpoints we
 * explicitly model.
 */

import { setupServer } from 'msw/node'
import { handlers } from './handlers.js'

export const server = setupServer(...handlers)
export { mockState, resetMock } from './handlers.js'
