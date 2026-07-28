/**
 * e2e/fixtures.js — in-browser API mocking for the Playwright E2E layer.
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

import { test as base, expect } from '@playwright/test'

export function makeBackend({ role = 'owner' } = {}) {
  let seq = 1
  const uid = (p) => `${p}_${seq++}`
  const state = {
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
  const CAN_RESTORE = new Set(['owner', 'editor'])
  return { state, uid, CAN_RESTORE }
}

/**
 * Attach the mock backend to a page. Call BEFORE page.goto().
 * Returns the mutable `state` so a test can inspect/seed it.
 */
export async function installBackend(page, opts = {}) {
  const { state, uid, CAN_RESTORE } = makeBackend(opts)

  const json = (route, body, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

  await page.route('**/api/**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const path = url.pathname.replace(/^\/api/, '')
    const method = req.method()
    let body = {}
    try { body = req.postDataJSON() || {} } catch { /* no body */ }

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
      const f = { id, name: body.name || 'Untitled', type: body.type || 'doc', content: body.content }
      state.files[id] = f
      return json(route, f)
    }

    let m
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
      const v = { id: uid('v'), name: state.files[m[1]]?.name, created_at: new Date().toISOString(), label: body.label || '' }
      ;(state.versions[m[1]] ||= []).unshift(v)
      return json(route, v)
    }

    // ── comments ──────────────────────────────────────────────────────────
    if ((m = path.match(/^\/files\/([^/]+)\/comments$/))) {
      const id = m[1]
      if (method === 'GET') return json(route, state.comments[id] || [])
      if (method === 'POST') {
        const c = { id: uid('c'), anchor: body.anchor, author_id: body.author_id, body: body.body, state: 'open', created_at: new Date().toISOString(), replies: [] }
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
      const r = { id: uid('r'), author_id: body.author_id, body: body.body, created_at: new Date().toISOString() }
      const c = (state.comments[id] || []).find((x) => x.id === cid)
      if (c) (c.replies ||= []).push(r)
      return json(route, r)
    }

    // ── suggestions ─────────────────────────────────────────────────────────
    if ((m = path.match(/^\/files\/([^/]+)\/suggestions$/))) {
      const id = m[1]
      if (method === 'GET') return json(route, state.suggestions[id] || [])
      if (method === 'POST') {
        const s = { id: uid('s'), kind: body.kind, author_id: body.author_id, from: body.from, to: body.to, text: body.text, state: 'pending', created_at: new Date().toISOString() }
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

// A test fixture that hands you a page with the backend already installed.
export const test = base.extend({
  officePage: async ({ page }, use) => {
    const state = await installBackend(page)
    page._mockState = state
    await use(page)
  },
})

export { expect }
