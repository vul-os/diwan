/**
 * e2e/fixtures.ts — in-browser API mocking for the Playwright E2E layer.
 *
 * Installs a `page.route('**\/api/**')` handler that serves a small, stateful
 * mock of the Diwan backend so the browser app runs with no Go server.
 * The mock mirrors src/__tests__/msw/handlers.js: auth, files, versions (with a
 * role-gated restore — wave-14), comments and suggestions.
 *
 * Usage:
 *   import { test, expect } from './fixtures.js'
 *   test('…', async ({ officePage }) => { … })   // officePage = mocked page
 */

import { test as base, expect, type Page, type Route } from '@playwright/test'

export type Role = 'owner' | 'editor' | 'viewer'

// The mock never inspects a file's `content` internally (it only stores and
// echoes back whatever the app POSTs/PUTs) — each document type (doc/slide/
// sheet/whiteboard) shapes it differently, so `unknown` is the honest type,
// not a stand-in for `any`.
export interface FileRecord {
  id: string
  name: string
  type: string
  content: unknown
  _restoredFrom?: string
}

export interface VersionRecord {
  id: string
  name?: string
  created_at: string
  label: string
}

export interface CommentReply {
  id: string
  author_id?: string | undefined
  body?: string | undefined
  created_at: string
}

export interface CommentRecord {
  id: string
  anchor?: unknown
  author_id?: string | undefined
  body?: string | undefined
  state: string
  created_at: string
  replies: CommentReply[]
}

export interface SuggestionRecord {
  id: string
  kind?: string | undefined
  author_id?: string | undefined
  from?: unknown
  to?: unknown
  text?: string | undefined
  state: string
  created_at: string
  reviewer_id?: string
}

export interface BackendState {
  role: Role
  files: Record<string, FileRecord>
  versions: Record<string, VersionRecord[]>
  comments: Record<string, CommentRecord[]>
  suggestions: Record<string, SuggestionRecord[]>
}

export interface MakeBackendOptions {
  role?: Role
}

interface MockBackend {
  state: BackendState
  uid: (prefix: string) => string
  CAN_RESTORE: Set<Role>
}

export function makeBackend({ role = 'owner' }: MakeBackendOptions = {}): MockBackend {
  let seq = 1
  const uid = (p: string) => `${p}_${seq++}`
  const state: BackendState = {
    role,
    files: {
      doc1: { id: 'doc1', name: 'Design Notes', type: 'doc', content: { _html: '<p>Hello world</p>' } },
      // A deck imported from a lossy .pptx: importNotes on the content drives the
      // import-honesty banner + export-menu restatement (see slides/importNotes.js).
      deck1: {
        id: 'deck1', name: 'Imported Deck', type: 'slide',
        content: {
          themeId: 'obsidian', theme: 'black', transition: 'slide', masters: null, customTheme: null,
          importNotes: { tables: 2, charts: 1, filename: 'quarterly.pptx' },
          slides: [{ id: 's1', title: '', content: '<p></p>', notes: '', background: '', master: 'content', transition: 'none', animations: [], objects: [] }],
        },
      },
    },
    versions: {
      doc1: [
        { id: 'v2', name: 'Design Notes', created_at: new Date(Date.now() - 60_000).toISOString(), label: '' },
        { id: 'v1', name: 'Design Notes', created_at: new Date(Date.now() - 3_600_000).toISOString(), label: 'First draft' },
      ],
    },
    comments: { doc1: [] },
    suggestions: { doc1: [] },
  }
  const CAN_RESTORE = new Set<Role>(['owner', 'editor'])
  return { state, uid, CAN_RESTORE }
}

// The shape of every JSON body this mock ever receives, flattened into one
// interface — each route handler below reads only the subset relevant to its
// own request. postDataJSON() itself types as `any` (it decodes an arbitrary
// wire payload); this is the one assertion that gives it a concrete shape.
interface RequestBody {
  name?: string
  type?: string
  content?: unknown
  label?: string
  anchor?: unknown
  author_id?: string
  body?: string
  from?: unknown
  to?: unknown
  text?: string
  kind?: string
  state?: string
  reviewer_id?: string
}

/**
 * Attach the mock backend to a page. Call BEFORE page.goto().
 * Returns the mutable `state` so a test can inspect/seed it.
 */
export async function installBackend(page: Page, opts: MakeBackendOptions = {}): Promise<BackendState> {
  const { state, uid, CAN_RESTORE } = makeBackend(opts)

  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

  await page.route('**/api/**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const path = url.pathname.replace(/^\/api/, '')
    const method = req.method()
    let body: RequestBody = {}
    try { body = (req.postDataJSON() as RequestBody) ?? {} } catch { /* no body */ }

    // ── auth ────────────────────────────────────────────────────────────────
    if (path === '/auth/status' || path === '/auth/me')
      return json(route, { enabled: false, authenticated: true, account_id: 'you@vulos.test' })

    // ── @-mention notifications — the app-shell rail polls this on every route
    // (SidebarContent). It calls .filter() on the result, so it MUST be an
    // array; model it explicitly rather than let it fall through to the {}
    // catch-all below (which would poison the rail and crash the whole shell). ─
    if (path === '/notifications' && method === 'GET')
      return json(route, [])

    // ── local files (self-host disk scan) — the AppHome home lists these; the
    // store calls .filter() on the result, so it MUST be an array. ────────────
    if (path === '/local-files' && method === 'GET')
      return json(route, [])

    // ── files ───────────────────────────────────────────────────────────────
    if (path === '/files' && method === 'GET')
      return json(route, Object.values(state.files))

    // createFile — the unified Open/Import flow POSTs {name,type,content} here,
    // then navigates to /:route/:id (which GETs /files/:id). Store the imported
    // content so the destination editor loads exactly what the importer produced.
    if (path === '/files' && method === 'POST') {
      const id = uid('file')
      const f: FileRecord = { id, name: body.name || 'Untitled', type: body.type || 'doc', content: body.content }
      state.files[id] = f
      return json(route, f)
    }

    let m: RegExpMatchArray | null
    if ((m = path.match(/^\/files\/([^/]+)$/))) {
      const id = m[1]
      if (method === 'GET') return json(route, state.files[id] || { error: 'nf' }, state.files[id] ? 200 : 404)
      if (method === 'PUT') {
        const f = state.files[id]
        if (f) Object.assign(f, { name: body.name ?? f.name, content: body.content ?? f.content })
        return json(route, f || { id, ...body })
      }
    }

    // ── versions ──────────────────────────────────────────────────────────
    if ((m = path.match(/^\/files\/([^/]+)\/versions$/)) && method === 'GET')
      return json(route, state.versions[m[1]] || [])

    if ((m = path.match(/^\/files\/([^/]+)\/versions\/([^/]+)\/restore$/)) && method === 'POST') {
      if (!CAN_RESTORE.has(state.role))
        return json(route, { error: 'forbidden: your role cannot restore versions' }, 403)
      return json(route, { ...state.files[m[1]], _restoredFrom: m[2] })
    }

    if ((m = path.match(/^\/files\/([^/]+)\/versions$/)) && method === 'POST') {
      const v: VersionRecord = { id: uid('v'), name: state.files[m[1]]?.name, created_at: new Date().toISOString(), label: body.label || '' }
      ;(state.versions[m[1]] ||= []).unshift(v)
      return json(route, v)
    }

    // ── comments ──────────────────────────────────────────────────────────
    if ((m = path.match(/^\/files\/([^/]+)\/comments$/))) {
      const id = m[1]
      if (method === 'GET') return json(route, state.comments[id] || [])
      if (method === 'POST') {
        const c: CommentRecord = { id: uid('c'), anchor: body.anchor, author_id: body.author_id, body: body.body, state: 'open', created_at: new Date().toISOString(), replies: [] }
        ;(state.comments[id] ||= []).push(c)
        return json(route, c)
      }
    }
    if ((m = path.match(/^\/files\/([^/]+)\/comments\/([^/]+)$/))) {
      const [, id, cid] = m
      const c = (state.comments[id] || []).find((x) => x.id === cid)
      if (method === 'PUT') { if (c) Object.assign(c, body); return json(route, c || { id: cid, ...body }) }
      if (method === 'DELETE') { state.comments[id] = (state.comments[id] || []).filter((x) => x.id !== cid); return json(route, { ok: true }) }
    }
    if ((m = path.match(/^\/files\/([^/]+)\/comments\/([^/]+)\/replies$/)) && method === 'POST') {
      const [, id, cid] = m
      const r: CommentReply = { id: uid('r'), author_id: body.author_id, body: body.body, created_at: new Date().toISOString() }
      const c = (state.comments[id] || []).find((x) => x.id === cid)
      if (c) (c.replies ||= []).push(r)
      return json(route, r)
    }

    // ── suggestions ─────────────────────────────────────────────────────────
    if ((m = path.match(/^\/files\/([^/]+)\/suggestions$/))) {
      const id = m[1]
      if (method === 'GET') return json(route, state.suggestions[id] || [])
      if (method === 'POST') {
        const s: SuggestionRecord = { id: uid('s'), kind: body.kind, author_id: body.author_id, from: body.from, to: body.to, text: body.text, state: 'pending', created_at: new Date().toISOString() }
        ;(state.suggestions[id] ||= []).push(s)
        return json(route, s)
      }
    }
    if ((m = path.match(/^\/files\/([^/]+)\/suggestions\/([^/]+)$/)) && method === 'PUT') {
      const [, id, sid] = m
      const s = (state.suggestions[id] || []).find((x) => x.id === sid)
      if (s) Object.assign(s, { state: body.state, reviewer_id: body.reviewer_id })
      return json(route, s || { id: sid, ...body })
    }

    if (path === '/upload') return json(route, { url: '/uploaded.png' })

    // Anything else we didn't model → empty 200 so the app degrades gracefully.
    return json(route, {})
  })

  return state
}

// officePage's extra property is only ever set by the fixture below — typing
// it on the fixture itself (rather than augmenting Playwright's own `Page`
// globally) keeps the guarantee scoped to tests that actually opted into it.
export type OfficePage = Page & { _mockState: BackendState }

// A test fixture that hands you a page with the backend already installed.
export const test = base.extend<{ officePage: OfficePage }>({
  officePage: async ({ page }, use) => {
    const state = await installBackend(page)
    const officePage = page as OfficePage
    officePage._mockState = state
    await use(officePage)
  },
})

export { expect }
