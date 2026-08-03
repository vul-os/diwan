# Frontend testing — Diwan

Two complementary layers cover the React app. Both are hermetic (no Go backend,
no relay): the API surface is mocked.

```
┌─────────────────────────────────────────────────────────────────────┐
│ Layer 1 — Vitest (jsdom)            npm test                         │
│   • unit tests (helpers, CRDT, exporters, pure logic)               │
│   • RTL + MSW integration: real component trees (real TipTap editor, │
│     real HistoryPanel/CommentsPanel/SuggestionPanel, real api client)│
│     with /api served by Mock Service Worker (msw/node).             │
│   • runs everywhere, fast, no browser.                              │
├─────────────────────────────────────────────────────────────────────┤
│ Layer 2 — Playwright (chromium)     npm run test:e2e                 │
│   • real browser against a production `vite preview` build.         │
│   • the entire backend is mocked in-browser via page.route.         │
│   • covers the flows jsdom cannot: the @fortune-sheet canvas grid,  │
│     reveal.js rendering, real toolbar + menu interaction.           │
├─────────────────────────────────────────────────────────────────────┤
│ Layer 3 — Real P2P integration      npm run test:e2e:p2p             │
│   • NOTHING mocked, and nothing external: one real diwan binary     │
│     serving its OWN discovery surface + two real browsers + real    │
│     WebRTC. Cannot be skipped — it depends on this repo only.       │
│   • proves peer-to-peer collaboration with no other product at all. │
│   • plus an optional suite for the external-relay posture, which    │
│     skips (loudly) unless VULOS_RELAYD_BIN names a prebuilt relayd. │
│   • separate config/job so it cannot destabilise layers 1–2.        │
└─────────────────────────────────────────────────────────────────────┘
```

## Running

### Layer 1 — Vitest (runs now, no setup)

```bash
npm test                      # whole suite
npx vitest run src/__tests__/msw/           # just the MSW integration tests
npx vitest                    # watch mode
```

The MSW integration tests live in `src/__tests__/msw/`:

| File | Covers |
|------|--------|
| `versionHistory.integration.test.jsx` | snapshot list + restore; **wave-14** role gate (viewer/commenter refused, owner/editor allowed) |
| `comments.integration.test.jsx` | add / resolve / reopen / reply, tab filters |
| `suggestions.integration.test.jsx` | create / accept / reject, state PUT round-trip |
| `docsEditor.integration.test.jsx` | **real TipTap** — typing order (no "olleh"), **wave-19** font size/family, bold/heading/list/link, export menu (DOCX/PDF/MD) |
| `p2pShare.integration.test.jsx` | **wave-25** share modal, invite parse → room, ro rejection, E2E crypto seal, two-session convergence |
| `slidesEditor.integration.test.jsx` | **full SlidesEditor mount** — open, add slide, reorder, presenter toggle, presence pill |
| `sheetsEditor.integration.test.jsx` | cell-edit round-trip via SheetsFindReplace, presence pill derivation |

**How the mock works.** `src/__tests__/msw/handlers.js` is a small, *stateful*
in-memory backend (files, versions, comments, suggestions). `resetMock({ role })`
reseeds it per test; the `role` flips the server-side restore gate. Requests flow
through the *real* `src/lib/api.js` client → `fetch` → MSW. The CRDT stores
(`getCommentStore`, `getSuggestionStore`) are module singletons, so the tests
`evict*Store()` in `beforeEach` to avoid cross-test leakage.

### Layer 2 — Playwright (one-time browser install)

```bash
npx playwright install --with-deps chromium   # once
npm run test:e2e                              # builds vite, serves preview, runs
npm run test:e2e:ui                           # interactive UI mode
```

`pretest:e2e` runs `vite build` first; `playwright.config.js` then serves the
build with `vite preview` on port **47317** (an uncommon port, and
`reuseExistingServer: false`, so a stale preview of another Vulos app on a shared
port can never be tested by mistake). Service workers are blocked so a cached PWA
shell can't shadow the mocks.

**How the mock works.** `e2e/fixtures.js` installs a `page.route('**/api/**')`
handler mirroring the MSW backend (auth, files, versions with the wave-14 gate,
comments, suggestions). The `officePage` fixture attaches it automatically;
`installBackend(page, { role })` lets a test choose the role for the restore gate.

### Layer 3 — Real P2P integration (`npm run test:e2e:p2p`)

The one layer with **no mocks at all**. It exists because the repo's central
architectural claim — *two people collaborate peer-to-peer through one bare
`diwan` binary, with no Vulos OS, no Pier, no relay and no account* — was
otherwise covered only by selector unit tests with a fake fabric.

```bash
npm run test:e2e:p2p
```

Two files, and the distinction matters:

**`builtin-rendezvous-p2p.e2e.js` — the DEFAULT path. Cannot be skipped.**
It boots ONE standalone `diwan` serving its own discovery surface at
`/api/rendezvous/*`, plus a second instance with discovery disabled for the
negative control. Two browser contexts load the first one. Everything it needs it
builds from this repository, so there is no condition under which it silently
does not run — which matters because a guard that can be skipped is absent
exactly when something has broken.

It asserts: a standalone Diwan serves no `/api/peering/*` but does advertise
`builtin_rendezvous_prefix`; the surface refuses an unsigned write over real HTTP
*and stores nothing*; both browsers speak the protocol to that origin; the
**server's own presence state** knows the Ed25519 key each browser signed an
announce for (soft state a client cannot fabricate); the room key from the invite
fragment never appears in any request body, and neither does the typed text —
so what the server moved was ciphertext, not content; the edits converge **both
ways** (CRDT convergence, not last-writer-wins); and the negative control — with
discovery disabled and no relay, the editor still works, speaks no discovery
protocol, and says "Offline" honestly.

**`rendezvous-p2p.e2e.js` — the OPTIONAL external-relay posture.** Two standalone
`diwan` servers with their built-in surface **off**, both pointed at a real
`vulos-relayd`, so the premise "nothing of ours is in the discovery path" is
exactly true. It also pins the relay's CORS contract (`Allow-Origin: *`, a
preflight that succeeds, no `Allow-Credentials`) both by header inspection and by
fetching the relay from a real Chromium page on a Diwan origin, since only a
browser enforces CORS — plus offline divergence merging as a union on reconnect.

This file **skips** unless `VULOS_RELAYD_BIN` names a prebuilt relayd, and it
prints that as the reason. It deliberately **fetches nothing at test time**: it
used to `git clone` a sibling relay repo, which meant the job failed when that
repo was renamed — for a reason unrelated to the code under test, while the claim
it was meant to guard went unchecked.

| Requirement | Notes |
|-------------|-------|
| Go toolchain | builds the Diwan binary (`go build`) after `vite build`, since the binary embeds `dist/` |
| `VULOS_RELAYD_BIN` | optional, and only for the external-relay file. Never inferred from a sibling directory; nothing is cloned or built from another repo. |
| Chromium flags | `playwright.p2p.config.js` sets `--disable-features=WebRtcHideLocalIpsWithMdns` so two loopback contexts can actually see each other's host candidates. This affects candidate visibility only — no protocol, signaling path or crypto changes. |

In both files the transport that carried the edits is asserted as *either* a
direct host/host WebRTC pair *or* the content-blind relay circuit, and the run
logs which — rather than pretending "direct" in a sandbox where ICE cannot
complete, or accepting neither and letting a broken transport pass.

CI additionally asserts that the default-path tests were **collected by name**
after the run, because `playwright test` exits 0 when everything skipped: a
regression that made the suite skip itself would otherwise look exactly like
success.

### The mocked E2E specs (layer 2):

| File | Covers |
|------|--------|
| `docs.e2e.js` | open doc, typing order, bold, **wave-19 font size**, outline, find, word count, export menu |
| `collab.e2e.js` | version restore (owner ✓ / **wave-14** viewer ✗ 403), comments add + resolve |
| `p2p.e2e.js` | **wave-25** share modal generates rw+ro links; ro fragment survives navigation |
| `sheets-slides.e2e.js` | Sheets: open + cell type + presence; Slides: open + add slide + presenter + presence |

## Coverage boundaries (what's tested where, and why)

- **Sheets grid interaction** (click a cell, formula bar) is Playwright-only:
  `@fortune-sheet` needs a real `<canvas>` and hangs under jsdom. The cell/model
  logic is unit-tested in vitest.
- **P2P convergence / read-only *enforcement* / crypto seal** is proven headless
  with an injected in-process fabric (`src/lib/crdt/__tests__/yP2PSession.test.js`
  and `p2pShare.integration.test.jsx`, both against the LIVE `YP2PCollabSession`).
  The browser E2E covers the *sharer UI* and invite-link format; full ro
  enforcement in the browser would need a live relay.
- **Cross-engine refusal** (`src/lib/crdt/__tests__/gridEngineHandshake.test.js`)
  is deliberately a unit test with a shared in-process bus rather than a browser
  one, because the scenario it pins — two peers on DIFFERENT builds of the app in
  one room — is not something a single Playwright build can construct. It runs a
  real `GridSession` and a real `SubstrateGridSession` on one bus and asserts both
  stop replicating. It also records the OLD behaviour directly against the CRDT
  internals (a substrate op reaching `grid.js` throws on `op.key.r`; a `grid.js`
  op reaching the substrate is dropped returning `false`), so the regression is a
  fact in the suite rather than a claim in a comment.

## Repository-integrity gates (Go `go test ./...`, root package)

These are not frontend tests, but they run in the same CI job as the Go backend
and they fail the build, so they belong on this page.

| Test | Fails when |
|------|-----------|
| `docs_mirror_test.go` → `TestSiteDocsMirrorIsInSync` | a page under `docs/` (or `CHANGELOG.md` / `ROADMAP.md`) stops being byte-identical to its `site/docs/` mirror. There is no generator for that mirror; this is its replacement. It had already drifted — the published changelog was 26 lines behind. |
| `docs_mirror_test.go` → `TestSiteDocsPageListIsMirrored` | `site/docs.html` publishes a page the mirror table does not cover, so a new site page cannot start drifting unnoticed. |
| `docs_links_test.go` → `TestMarkdownRelativeLinksResolve` | any relative Markdown link in `README.md`, `docs/` or `third_party/*/VENDOR.md` points at a file that does not exist. It caught three dead links on the README's front page. `site/docs/` is excluded: its links are rewritten at render time by `site/docs.html`, so resolving them as file paths is the wrong model. |

Both files assert a **minimum amount of work done** (files walked, links
checked, pairs compared) as well as the result, so a broken walk or a regex that
stops matching fails loudly instead of passing vacuously.

## Substrate-engine provenance (Vitest)

The shared CRDT engine used to be a copy vendored under
`third_party/dmtap-sync-wasm/`. It is now the published npm package
`@vul-os/kotva-sync`, pinned to an exact version, and
`src/lib/crdt/__tests__/substratePackageProvenance.test.js` guards it in two
layers:

* **the tarball** — `package-lock.json` records a sha512 SRI for the exact
  artifact npm fetched, and the test pins that string, so the dependency cannot
  move to a different published tarball without someone updating the constant
  deliberately. It also fails if any dependency reappears as a local
  `file:`/`link:` path, for which npm records no integrity at all.
* **the installed bytes** — the lockfile hash covers the tarball and stops
  mattering once it is unpacked, so the test also recomputes the SHA-256 and size
  of every file in `node_modules/@vul-os/kotva-sync`, asserts the recorded set
  matches the installed set in both directions, and asserts the coverage count so
  a shrunken manifest cannot pass by checking less.

It also asserts the compiled module still declares exactly the one host import
`src/lib/crdt/kotvaSync.js` supplies, which is the one upstream change that would
otherwise become a bare `LinkError` at runtime.

**It cannot skip.** There is no toolchain to detect and no service to reach; if
the package is not installed, every read throws and the suite fails — the correct
outcome, because an uninstalled engine means `substrateGrid.js` cannot load
either.

The gate exists because the vendored copy had silently gone stale against
upstream (a 395,912-byte `.wasm` against upstream's 400,930-byte build) and
nothing failed. Upstream records the same class of incident in
`bindings/go/embed.go`: a stale committed module aborted the allocator on every
response whose Rust-side String capacity outran its length. Never edit a digest
to make this test pass — re-record it from a fresh install.

## Share-link token storage (Go)

The share-link token is stored only as a SHA-256 hash. Four suites hold that
line, and each fails if the plaintext returns:

| Test | Fails when |
|------|-----------|
| `backend/storage/local_sharelinks_hash_test.go` | the file backend writes a token into a record or a filename; a pre-hash data directory does not convert; a converted link stops resolving |
| `backend/storage/postgres_sharelinks_test.go` | the Postgres backend writes a token into `share_links.token`, or the backfill of pre-fix rows does not run. **Requires `VULOS_TEST_POSTGRES_DSN`**; it skips with a message naming exactly what went unverified, and CI's `go-postgres` job always sets it |
| `backend/storage/backend_contract_test.go` | either backend returns a token from a read path, or accepts a link with no token |
| `backend/handlers/sharelink_token_once_test.go` | `GET /api/files/:id/share-links` emits a `token` key (even an empty one), or the stored hash works as a credential on the anonymous view route |
