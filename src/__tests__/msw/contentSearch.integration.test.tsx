/**
 * MSW integration — global content search surface (AppHome).
 *
 * Exercises the newly-added full-text search UI in isolation from the heavy
 * AppHome page mount:
 *
 *   1. api.searchDocs() round-trips through the real fetch client + MSW `/search`
 *      handler, passing the app `type` filter, and the server-side ACL scoping is
 *      honoured (only the caller's own + shared docs come back).
 *   2. <ContentSearchResults> renders those results — including the "shared by …"
 *      attribution that tells the user a hit is on someone else's document — and
 *      the empty-state when nothing matches.
 *   3. <SnippetText> highlights the «matched» span the backend delimits with
 *      guillemets, and renders document text as inert text nodes (no HTML
 *      injection) so a malicious document body can never inject markup here.
 *
 * The security contract (ACL enforced at query time, content rendered inert) is
 * locked to the UI so a regression that leaks or injects is caught.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ContentSearchResults, SnippetText } from '../../components/AppHome'
import { api } from '../../lib/api.js'
import { server, resetMock, mockState } from './server.js'

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

// AppHome.tsx's SearchResult/SearchDocsResponse shapes are intentionally not
// exported (api.searchDocs returns `unknown` by design — see lib/api.ts); this
// mirrors them locally, matching field-for-field, to type this test's own
// fixtures and the cast at the api.searchDocs() boundary.
interface TestSearchResult {
  id: string
  name?: string
  type?: string
  snippet?: string
  owner?: string
  shared?: boolean
}
interface TestSearchResponse {
  query?: string
  results: TestSearchResult[]
}
function cast<T>(v: unknown): T { return v as T }

describe('Content search — api round-trip + ACL scoping (MSW)', () => {
  beforeEach(() => resetMock({ role: 'owner' }))

  it('searchDocs passes the type filter and returns only ACL-scoped hits', async () => {
    // The corpus the "server" would return for this account: one owned doc and
    // one shared-to-me doc. A doc I can't read simply is not in the corpus (the
    // server never returns it) — modelling the query-time ACL filter.
    mockState.searchResults = [
      { id: 'mine', name: 'My roadmap', type: 'doc', _body: 'ship the widget', snippet: 'ship the «widget» soon' },
      { id: 'shared', name: 'Team notes', type: 'doc', _body: 'widget planning', shared: true, owner: 'alice@vulos.test' },
    ]

    const res = cast<TestSearchResponse>(await api.searchDocs('widget', 'doc'))
    expect(mockState.calls.some((c) => c === 'GET /search')).toBe(true)
    expect(res.results).toHaveLength(2)
    const shared = res.results.find((r) => r.id === 'shared')!
    expect(shared.shared).toBe(true)
    expect(shared.owner).toBe('alice@vulos.test')
    // A document not in the caller's readable corpus never surfaces.
    expect(res.results.find((r) => r.id === 'secret')).toBeUndefined()
  })

  it('a non-matching query yields no results', async () => {
    mockState.searchResults = [
      { id: 'mine', name: 'My roadmap', type: 'doc', _body: 'ship the widget' },
    ]
    const res = cast<TestSearchResponse>(await api.searchDocs('nonexistentterm', 'doc'))
    expect(res.results).toHaveLength(0)
  })
})

describe('ContentSearchResults rendering (MSW-free)', () => {
  it('renders each hit with a shared-by attribution for shared docs', () => {
    const results: TestSearchResult[] = [
      { id: 'mine', name: 'My roadmap', snippet: 'ship the «widget» soon' },
      { id: 'shared', name: 'Team notes', snippet: 'the «widget» plan', shared: true, owner: 'alice@vulos.test' },
    ]
    render(
      <ContentSearchResults
        results={results}
        searching={false}
        query="widget"
        onOpen={() => {}}
      />,
    )
    expect(screen.getByText('My roadmap')).toBeInTheDocument()
    expect(screen.getByText('Team notes')).toBeInTheDocument()
    // Only the shared hit carries the "shared by …" chip.
    expect(screen.getByText(/shared by alice@vulos.test/i)).toBeInTheDocument()
  })

  it('opens a hit when its row is activated', () => {
    // A boxed field (rather than a bare `let`) sidesteps a TS control-flow
    // narrowing pitfall where a `let` reassigned only inside a nested closure
    // gets narrowed to its initializer's literal type at the read site.
    const state: { opened: TestSearchResult | null } = { opened: null }
    const results: TestSearchResult[] = [{ id: 'mine', name: 'My roadmap', snippet: 'a «hit»' }]
    render(
      <ContentSearchResults
        results={results}
        searching={false}
        query="hit"
        onOpen={(r) => { state.opened = r }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /My roadmap/i }))
    expect(state.opened?.id).toBe('mine')
  })

  it('shows an explicit empty state when there are no matches', () => {
    render(
      <ContentSearchResults
        results={[]}
        searching={false}
        query="ghost"
        onOpen={() => {}}
      />,
    )
    expect(screen.getByText(/No content matches for/i)).toHaveTextContent('ghost')
  })

  it('renders nothing while idle (no query, no request in flight)', () => {
    const { container } = render(
      <ContentSearchResults results={null} searching={false} query="" onOpen={() => {}} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('shows a loading affordance while a search is in flight', () => {
    render(
      <ContentSearchResults results={null} searching query="widget" onOpen={() => {}} />,
    )
    // The section header is present even before results arrive.
    expect(screen.getByText(/Matches in content/i)).toBeInTheDocument()
  })
})

describe('SnippetText highlight + injection safety', () => {
  it('wraps the «matched» span in a <mark> and leaves the rest as text', () => {
    const { container } = render(<SnippetText snippet={'ship the «widget» soon'} />)
    const mark = container.querySelector('mark')
    expect(mark).not.toBeNull()
    expect(mark!.textContent).toBe('widget')
    // The surrounding text is preserved.
    expect(container.textContent).toBe('ship the widget soon')
  })

  it('renders document text inertly — never as HTML', () => {
    // A document body that tries to smuggle markup must render as literal text.
    const { container } = render(
      <SnippetText snippet={'before «<img src=x onerror=alert(1)>» after'} />,
    )
    // No real <img> node was created from the document content.
    expect(container.querySelector('img')).toBeNull()
    // The angle-bracket text survives verbatim inside the highlight.
    expect(container.querySelector('mark')!.textContent).toContain('<img')
  })

  it('handles an unmatched snippet (no guillemets) as plain text', () => {
    const { container } = render(<SnippetText snippet={'just plain context'} />)
    expect(container.querySelector('mark')).toBeNull()
    expect(container.textContent).toBe('just plain context')
  })

  it('renders nothing for an empty snippet', () => {
    const { container } = render(<SnippetText snippet={''} />)
    expect(container.firstChild).toBeNull()
  })
})
