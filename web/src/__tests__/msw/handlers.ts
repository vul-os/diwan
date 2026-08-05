/**
 * MSW request handlers — an in-memory mock of the Diwan `/api` doc
 * backend, used by the RTL + MSW integration layer (WAVE-28).
 *
 * These model the real endpoints exercised by HistoryPanel / CommentsPanel /
 * SuggestionPanel / DocsEditor (see src/lib/api.js). The store is intentionally
 * small but *stateful* so a test can add a comment and then read it back, or
 * assert that a viewer/commenter role is refused a restore (wave-14 security).
 *
 * The role of the mock "current user" is controlled via `mockState.role`
 * ('owner' | 'editor' | 'commenter' | 'viewer'); a test flips it to prove the
 * server-side restore gate at the API-mock level.
 */

import { http, HttpResponse } from 'msw'

// ─── In-memory backend record shapes — a loose mirror of the real API's JSON,
// pinned just to the fields these mock handlers themselves read/write. ───────

interface MockFile {
  id: string
  name: string
  type: string
  content?: unknown
  [key: string]: unknown
}
interface MockVersion {
  id: string
  name?: string
  author?: string
  created_at: string
  label?: string
  _restoredFrom?: string
}
interface MockReply {
  id: string
  author_id?: string | undefined
  body?: string | undefined
  mentions?: string[]
  created_at: string
}
interface MockComment {
  id: string
  anchor?: unknown
  author_id?: string | undefined
  body?: string | undefined
  mentions?: string[]
  assignee?: string
  state: string
  created_at: string
  replies: MockReply[]
}
interface MockCollaborator {
  account_id: string
  role: string
}
interface MockSuggestion {
  id: string
  kind?: string | undefined
  author_id?: string | undefined
  from?: unknown
  to?: unknown
  text?: string | undefined
  state: string
  reviewer_id?: string
  created_at: string
}
interface MockShareLink {
  id: string
  file_id: string
  token: string
  created_by?: string
  has_password: boolean
  expires_at: string | null
  revoked: boolean
  created_at: string
}
interface LinkByTokenEntry {
  link: MockShareLink
  content: unknown
  name?: string
  requires_password: boolean
  password: string
}
interface SearchSeedEntry {
  id: string
  name: string
  type?: string
  snippet?: string
  owner?: string
  shared?: boolean
  _body?: string
}
interface SharedWithMeEntry {
  id: string
  name?: string
  type?: string
  owner?: string
  role?: string
  updated_at?: string
  [key: string]: unknown
}

interface MockStateShape {
  role: string // 'owner' | 'editor' | 'commenter' | 'viewer'
  files: Record<string, MockFile>
  versions: Record<string, MockVersion[]>
  comments: Record<string, MockComment[]>
  collaborators: Record<string, MockCollaborator[]>
  suggestions: Record<string, MockSuggestion[]>
  // WAVE37 server-collab authoritative op log: fileId → { seq, ops:[{seq,origin,op}] }.
  collab: Record<string, unknown>
  // Call log so tests can assert an endpoint was (or wasn't) hit.
  calls: string[]
  shareLinks: Record<string, MockShareLink[]>
  linksByToken: Record<string, LinkByTokenEntry>
  searchResults: SearchSeedEntry[]
  me: string
  owner: string
  sharedWithMe: SharedWithMeEntry[]
}

// ─── Mutable in-memory backend state ────────────────────────────────────────

export const mockState: MockStateShape = {
  role: 'owner', // 'owner' | 'editor' | 'commenter' | 'viewer'
  files: {},
  versions: {},     // fileId → [{ id, name, created_at, label }]
  comments: {},     // fileId → [comment]
  collaborators: {}, // fileId → [{ account_id, role }] (for @-mention autocomplete)
  suggestions: {},  // fileId → [suggestion]
  // WAVE37 server-collab authoritative op log: fileId → { seq, ops:[{seq,origin,op}] }.
  collab: {},
  // Call log so tests can assert an endpoint was (or wasn't) hit.
  calls: [],
  shareLinks: {},
  linksByToken: {},
  searchResults: [],
  me: 'you@vulos.test',
  owner: 'you@vulos.test',
  sharedWithMe: [],
}

let seq = 1
const uid = (p: string) => `${p}_${seq++}`

/** Reset the backend to a clean, seeded slate. Call in beforeEach. */
export function resetMock({ role = 'owner' }: { role?: string } = {}) {
  seq = 1
  mockState.role = role
  mockState.calls = []
  mockState.files = {
    doc1: {
      id: 'doc1',
      name: 'Design Notes',
      type: 'doc',
      content: { _html: '<p>Hello world</p>' },
    },
  }
  mockState.versions = {
    doc1: [
      { id: 'v2', name: 'Design Notes', author: 'alice@vulos.test', created_at: new Date(Date.now() - 60_000).toISOString(), label: '' },
      { id: 'v1', name: 'Design Notes', author: 'bob@vulos.test', created_at: new Date(Date.now() - 3_600_000).toISOString(), label: 'First draft' },
    ],
  }
  // Share links keyed by fileId (owner view) and by token (anon view).
  mockState.shareLinks = {}   // fileId → [link]
  mockState.linksByToken = {} // token → { link, content, requires_password, password }
  // Backend full-text search corpus (name/_body matched by the /search handler).
  mockState.searchResults = []
  mockState.comments = { doc1: [] }
  mockState.collaborators = { doc1: [] }
  mockState.suggestions = { doc1: [] }
  // Account-share identity defaults: the caller is the owner of the seeded doc.
  mockState.me = 'you@vulos.test'
  mockState.owner = 'you@vulos.test'
  mockState.sharedWithMe = []
}

// A restore is only permitted for owner/editor. viewer/commenter → 403.
// This mirrors the wave-14 server-side authorization the UI relies on.
const CAN_RESTORE = new Set(['owner', 'editor'])

const log = (method: string, path: string) => mockState.calls.push(`${method} ${path}`)

// validAssignee — the mock's copy of the server authz boundary: a comment can
// only be assigned to the file owner or a recorded collaborator; anything else
// (including a stranger id) is dropped to ''.
function validAssignee(fileId: string, requested: string | undefined): string {
  if (!requested) return ''
  const owner = mockState.owner || 'you@vulos.test'
  if (requested === owner) return requested
  const collabs = mockState.collaborators?.[fileId] || []
  return collabs.some((p) => p.account_id === requested) ? requested : ''
}

// ─── Handlers ───────────────────────────────────────────────────────────────

export const handlers = [
  http.get('/api/auth/status', () =>
    HttpResponse.json({ authenticated: true, account_id: 'you@vulos.test' })),

  http.get<{ id: string }>('/api/files/:id', ({ params }) => {
    log('GET', `/files/${params.id}`)
    const f = mockState.files[params.id]
    if (!f) return HttpResponse.json({ error: 'not found' }, { status: 404 })
    return HttpResponse.json(f)
  }),

  http.put<{ id: string }>('/api/files/:id', async ({ params, request }) => {
    log('PUT', `/files/${params.id}`)
    const body = await request.json() as { name?: string; content?: unknown }
    const f = mockState.files[params.id]
    if (f) Object.assign(f, { name: body.name ?? f.name, content: body.content ?? f.content })
    return HttpResponse.json(f || { id: params.id, ...body })
  }),

  // ── Version history ──────────────────────────────────────────────────────
  http.get<{ id: string }>('/api/files/:id/versions', ({ params }) => {
    log('GET', `/files/${params.id}/versions`)
    return HttpResponse.json(mockState.versions[params.id] || [])
  }),

  http.post<{ id: string; vid: string }>('/api/files/:id/versions/:vid/restore', ({ params }) => {
    log('POST', `/files/${params.id}/versions/${params.vid}/restore`)
    // ── WAVE-14 security: only owner/editor may restore ──────────────────
    if (!CAN_RESTORE.has(mockState.role)) {
      return HttpResponse.json(
        { error: 'forbidden: your role cannot restore versions' },
        { status: 403 },
      )
    }
    const f = mockState.files[params.id]
    return HttpResponse.json({ ...f, _restoredFrom: params.vid })
  }),

  http.post<{ id: string }>('/api/files/:id/versions', async ({ params, request }) => {
    log('POST', `/files/${params.id}/versions`)
    const body = await request.json().catch(() => ({})) as { label?: string }
    const v: MockVersion = { id: uid('v'), name: mockState.files[params.id]?.name, created_at: new Date().toISOString(), label: body.label || '' }
    ;(mockState.versions[params.id] ||= []).unshift(v)
    return HttpResponse.json(v)
  }),

  // ── Identity + account-share ───────────────────────────────────────────────
  // Caller identity (drives the share dialog's owner detection).
  http.get('/api/system/info', () => {
    log('GET', '/system/info')
    return HttpResponse.json({ account_id: mockState.me || 'you@vulos.test', is_admin: false })
  }),

  // Owner-only grant/revoke of an account's role on a file. Mirrors the server:
  // a non-owner caller → 403; an unknown role → 400.
  http.post<{ id: string }>('/api/files/:id/share', async ({ params, request }) => {
    log('POST', `/files/${params.id}/share`)
    if (mockState.role !== 'owner') {
      return HttpResponse.json(
        { error: 'only the document owner may perform this action' },
        { status: 403 },
      )
    }
    const body = await request.json() as { account_id: string; revoke?: boolean; role?: string }
    const list = (mockState.collaborators[params.id] ||= [])
    const idx = list.findIndex((c) => c.account_id === body.account_id)
    if (body.revoke) {
      if (idx >= 0) list.splice(idx, 1)
      return HttpResponse.json({ ok: true })
    }
    const role = body.role || 'editor'
    if (!['editor', 'commenter', 'viewer'].includes(role)) {
      return HttpResponse.json({ error: "role must be 'editor', 'commenter', or 'viewer'" }, { status: 400 })
    }
    if (idx >= 0) list[idx].role = role
    else list.push({ account_id: body.account_id, role })
    return HttpResponse.json({ ok: true })
  }),

  // "Shared with me" — files shared TO the caller (mock returns a fixed seed).
  http.get('/api/shared-files', () => {
    log('GET', '/shared-files')
    return HttpResponse.json({ files: mockState.sharedWithMe || [] })
  }),

  // ── Comments ─────────────────────────────────────────────────────────────
  // Collaborator roster for @-mention autocomplete AND the share dialog. The
  // owner is included as an 'owner' entry so the dialog can detect ownership.
  // validAssignee mirrors the server: only owner/collaborators are assignable.
  // (defined here so both POST and PUT comment handlers can call it)

  http.get<{ id: string }>('/api/files/:id/collaborators', ({ params }) => {
    log('GET', `/files/${params.id}/collaborators`)
    const collabs = mockState.collaborators?.[params.id] || []
    const owner = mockState.owner || 'you@vulos.test'
    return HttpResponse.json({ collaborators: [{ account_id: owner, role: 'owner' }, ...collabs] })
  }),

  http.get<{ id: string }>('/api/files/:id/comments', ({ params }) => {
    log('GET', `/files/${params.id}/comments`)
    return HttpResponse.json(mockState.comments[params.id] || [])
  }),

  http.post<{ id: string }>('/api/files/:id/comments', async ({ params, request }) => {
    log('POST', `/files/${params.id}/comments`)
    const body = await request.json() as { anchor?: unknown; author_id?: string; body?: string; mentions?: string[]; assignee?: string }
    const c: MockComment = {
      id: uid('c'),
      anchor: body.anchor,
      author_id: body.author_id,
      body: body.body,
      mentions: body.mentions || [],
      // Mirror the server: an assignee is only recorded when it is a real
      // collaborator (or the owner) of the file — otherwise it is dropped.
      assignee: validAssignee(params.id, body.assignee),
      state: 'open',
      created_at: new Date().toISOString(),
      replies: [],
    }
    ;(mockState.comments[params.id] ||= []).push(c)
    return HttpResponse.json(c)
  }),

  http.put<{ id: string; cid: string }>('/api/files/:id/comments/:cid', async ({ params, request }) => {
    log('PUT', `/files/${params.id}/comments/${params.cid}`)
    const patch = await request.json() as { assignee?: string; body?: string; state?: string }
    const c = (mockState.comments[params.id] || []).find((x) => x.id === params.cid)
    if (c) {
      // Validate an assignee change against the roster, mirroring the server.
      if (patch.assignee !== undefined) c.assignee = validAssignee(params.id, patch.assignee)
      if (patch.body !== undefined) c.body = patch.body
      if (patch.state !== undefined) {
        c.state = patch.state
        if (patch.state === 'resolved') c.assignee = '' // resolve clears assignment
      }
      return HttpResponse.json(c)
    }
    return HttpResponse.json({ id: params.cid, ...patch })
  }),

  http.delete<{ id: string; cid: string }>('/api/files/:id/comments/:cid', ({ params }) => {
    log('DELETE', `/files/${params.id}/comments/${params.cid}`)
    mockState.comments[params.id] = (mockState.comments[params.id] || []).filter((x) => x.id !== params.cid)
    return HttpResponse.json({ ok: true })
  }),

  http.post<{ id: string; cid: string }>('/api/files/:id/comments/:cid/replies', async ({ params, request }) => {
    log('POST', `/files/${params.id}/comments/${params.cid}/replies`)
    const body = await request.json() as { author_id?: string; body?: string; mentions?: string[] }
    const r: MockReply = { id: uid('r'), author_id: body.author_id, body: body.body, mentions: body.mentions || [], created_at: new Date().toISOString() }
    const c = (mockState.comments[params.id] || []).find((x) => x.id === params.cid)
    if (c) (c.replies ||= []).push(r)
    return HttpResponse.json(r)
  }),

  // ── Suggestions ──────────────────────────────────────────────────────────
  http.get<{ id: string }>('/api/files/:id/suggestions', ({ params }) => {
    log('GET', `/files/${params.id}/suggestions`)
    return HttpResponse.json(mockState.suggestions[params.id] || [])
  }),

  http.post<{ id: string }>('/api/files/:id/suggestions', async ({ params, request }) => {
    log('POST', `/files/${params.id}/suggestions`)
    const b = await request.json() as { kind?: string; author_id?: string; from?: unknown; to?: unknown; text?: string }
    const s: MockSuggestion = {
      id: uid('s'), kind: b.kind, author_id: b.author_id,
      from: b.from, to: b.to, text: b.text,
      state: 'pending', created_at: new Date().toISOString(),
    }
    ;(mockState.suggestions[params.id] ||= []).push(s)
    return HttpResponse.json(s)
  }),

  http.put<{ id: string; sid: string }>('/api/files/:id/suggestions/:sid', async ({ params, request }) => {
    log('PUT', `/files/${params.id}/suggestions/${params.sid}`)
    const b = await request.json() as { state?: string; reviewer_id?: string }
    const s = (mockState.suggestions[params.id] || []).find((x) => x.id === params.sid)
    if (s) Object.assign(s, { state: b.state, reviewer_id: b.reviewer_id })
    return HttpResponse.json(s || { id: params.sid, ...b })
  }),

  // ── Version diff ───────────────────────────────────────────────────────────
  http.get<{ id: string; vid: string }>('/api/files/:id/versions/:vid/diff', ({ params, request }) => {
    log('GET', `/files/${params.id}/versions/${params.vid}/diff`)
    const url = new URL(request.url)
    return HttpResponse.json({
      file_id: params.id,
      type: 'doc',
      against: url.searchParams.get('against') || 'current',
      old_label: 'First draft',
      new_label: 'current',
      diff: {
        kind: 'line',
        added: 1,
        removed: 1,
        summary: '1 line added, 1 line removed',
        lines: [
          { op: 'equal', text: 'Intro paragraph' },
          { op: 'delete', text: 'old sentence' },
          { op: 'insert', text: 'new sentence' },
        ],
      },
    })
  }),

  // ── Global full-text search ────────────────────────────────────────────────
  http.get('/api/search', ({ request }) => {
    log('GET', '/search')
    const url = new URL(request.url)
    const q = (url.searchParams.get('q') || '').toLowerCase()
    if (!q) return HttpResponse.json({ results: [], query: '' })
    const results = (mockState.searchResults || []).filter((r) =>
      r.name.toLowerCase().includes(q) || (r._body || '').toLowerCase().includes(q),
    ).map((r) => ({
      id: r.id, name: r.name, type: r.type || 'doc',
      snippet: r.snippet || `…contains «${q}» here…`,
      owner: r.owner || '', shared: !!r.shared,
    }))
    return HttpResponse.json({ results, query: q })
  }),

  // ── Share links (owner management) ─────────────────────────────────────────
  //
  // The server stores only a SHA-256 of each token, so the LIST endpoint can
  // never return one — only the mint response can. The mock strips `token` here
  // rather than storing token-free records, because the token still has to be
  // resolvable by the anonymous view route below; stripping at the boundary is
  // what the real handler does (models.ShareLink.Token is `omitempty` and the
  // store has nothing to put in it).
  http.get<{ id: string }>('/api/files/:id/share-links', ({ params }) => {
    log('GET', `/files/${params.id}/share-links`)
    const links = (mockState.shareLinks[params.id] || []).map(({ token: _token, ...rest }) => rest)
    return HttpResponse.json({ links })
  }),

  http.post<{ id: string }>('/api/files/:id/share-links', async ({ params, request }) => {
    log('POST', `/files/${params.id}/share-links`)
    if (mockState.role !== 'owner') {
      return HttpResponse.json({ error: 'only the document owner may perform this action' }, { status: 403 })
    }
    const body = await request.json().catch(() => ({})) as { password?: string; expires_in_seconds?: number }
    const token = uid('tok')
    const link: MockShareLink = {
      id: uid('link'),
      file_id: params.id,
      token,
      created_by: mockState.me,
      has_password: !!body.password,
      expires_at: body.expires_in_seconds && body.expires_in_seconds > 0
        ? new Date(Date.now() + body.expires_in_seconds * 1000).toISOString()
        : null,
      revoked: false,
      created_at: new Date().toISOString(),
    }
    ;(mockState.shareLinks[params.id] ||= []).push(link)
    mockState.linksByToken[token] = {
      link,
      content: mockState.files[params.id]?.content ?? null,
      name: mockState.files[params.id]?.name,
      requires_password: !!body.password,
      password: body.password || '',
    }
    return HttpResponse.json(link, { status: 201 })
  }),

  http.delete<{ id: string; lid: string }>('/api/files/:id/share-links/:lid', ({ params }) => {
    log('DELETE', `/files/${params.id}/share-links/${params.lid}`)
    const list = mockState.shareLinks[params.id] || []
    const link = list.find((l) => l.id === params.lid)
    if (link) {
      link.revoked = true
      delete mockState.linksByToken[link.token]
    }
    return HttpResponse.json({ ok: true })
  }),

  // ── Transfer ownership ─────────────────────────────────────────────────────
  http.post<{ id: string }>('/api/files/:id/transfer-owner', async ({ params, request }) => {
    log('POST', `/files/${params.id}/transfer-owner`)
    if (mockState.role !== 'owner') {
      return HttpResponse.json({ error: 'only the document owner may perform this action' }, { status: 403 })
    }
    const body = await request.json() as { new_owner: string }
    mockState.owner = body.new_owner
    return HttpResponse.json({ ok: true, owner: body.new_owner })
  }),

  // ── Anonymous read-only view (token-gated) ─────────────────────────────────
  http.get<{ token: string }>('/api/share/:token', ({ params }) => {
    log('GET', `/share/${params.token}`)
    const entry = mockState.linksByToken[params.token]
    if (!entry || entry.link.revoked) return HttpResponse.json({ error: 'link not found' }, { status: 404 })
    if (entry.requires_password) return HttpResponse.json({ requires_password: true, type: 'doc' })
    return HttpResponse.json({
      requires_password: false, id: entry.link.file_id, name: entry.name,
      type: 'doc', content: entry.content, read_only: true,
    })
  }),

  http.post<{ token: string }>('/api/share/:token', async ({ params, request }) => {
    log('POST', `/share/${params.token}`)
    const entry = mockState.linksByToken[params.token]
    if (!entry || entry.link.revoked) return HttpResponse.json({ error: 'link not found' }, { status: 404 })
    const body = await request.json().catch(() => ({})) as { password?: string }
    if (entry.requires_password && body.password !== entry.password) {
      return HttpResponse.json({ error: 'incorrect password', requires_password: true }, { status: 401 })
    }
    return HttpResponse.json({
      id: entry.link.file_id, name: entry.name, type: 'doc',
      content: entry.content, read_only: true,
    })
  }),

  // Image upload used by the docs toolbar (returns a fake URL).
  http.post('/api/upload', () =>
    HttpResponse.json({ url: 'http://localhost/uploaded.png' })),

  // NOTE: there are deliberately NO /v1/documents/:id/collab/* handlers here.
  // Office collaboration is peer-to-peer (Yjs over E2E-encrypted WebRTC); there
  // is no central-server collab relay to mock. A test that sees any /collab/*
  // request is a regression — the app must never call one.
]
