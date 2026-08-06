# Changelog

All notable changes to Diwan are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).  
Diwan uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

Nothing yet.

---

## [0.1.0] - 2026-08-06

Diwan's first release: a documents suite (Docs, Sheets, Slides, PDF/Signing)
with genuine peer-to-peer collaboration — no central document server — and an
honest, self-hostable single binary. This entry consolidates the project's
pre-release development history into one changelog record for the version
actually being tagged.

### Added — Diwan serves its own peer discovery: real P2P from one bare binary

- **The problem.** WebRTC cannot introduce two browsers to each other unaided —
  something has to carry the first offer/answer/ICE frames. Diwan could only get
  that from *another product*: a Vulos OS / Ephor host mounting
  `/api/peering/*`, or an operator-run `vulos-relayd` named in
  `collab.rendezvous_url`. With neither, every session fell through to
  local-only and a standalone binary had **no peer-to-peer at all**. The
  product's central claim was conditional on a second deployment.
- **`backend/rendezvous`** now serves that protocol from this binary, at
  `/api/rendezvous/*`, **on by default** (`collab.builtin_rendezvous`). One
  `diwan` on one box is sufficient for two people: no Vulos OS, no Ephor, no
  relay, no account, nothing to configure. Ephor remains supported and still
  takes precedence when configured — it is a choice now, not a prerequisite.
- It carries **no document content**. Every payload is opaque bytes sealed under
  a room key that lives in an invite link's URL fragment and reaches no server;
  edits ride the direct data channel once peers are introduced. State is
  in-memory only, with minute-scale TTLs — a discovery cache, deliberately not a
  durable log of who talked to whom.
- **Safe to expose, because a cloud node is exposed.** Every write is
  Ed25519-signed over a domain-separated, length-prefixed canonical message;
  each carries a fresh nonce and timestamp, so replays (409) and stale envelopes
  (409) are refused; payload size (413), queue depth, key count and TTLs are all
  capped before anything is stored; capacity exhaustion is 503; a bad signature
  is 403. Per-IP rate-limited (240-token burst, 40/s). Anonymous by design —
  invite-link collaboration needs no account — and authenticating **only** by
  body signature, never by cookie, so ambient credentials buy nothing.
- The wire format is byte-for-byte the one an external relayd speaks, so a
  deployment can move between the two with no rebuild. The Go and JavaScript
  implementations of the signed canonical message are pinned to **shared fixed
  vectors** (`backend/rendezvous/canonical_interop_test.go` and
  `src/lib/collab/webrtc/__tests__/canonicalInterop.test.js`), including a real
  JS-made signature verified by the Go verifier — a one-byte drift between them
  would otherwise surface only as an unexplained wall of 403s in the field.
- `GET /api/reachability` gained `builtin_rendezvous_prefix`, reported as a
  same-origin **path**. Empty means "this server offers no discovery"; the client
  refuses anything that is not an absolute same-origin path rather than pasting
  it onto our origin. **No default endpoint in any branch** — every discovery URL
  comes from this deployment's own config or the page's own origin.
- CI proves the default path end to end without depending on another repo: the
  `e2e-p2p` job builds only this repository and runs
  `e2e-p2p/builtin-rendezvous-p2p.e2e.js` — one real binary serving its own
  discovery surface, two real browser contexts, a real WebRTC data channel, the
  server's own presence state read back as ground truth, an assertion that
  neither the room key nor the typed text appears in any discovery payload, and
  a negative control. It additionally asserts the default-path tests were
  **collected by name** after the run, since `playwright test` exits 0 when
  every test skipped — a regression that made the suite skip itself would
  otherwise look exactly like success. The external-relay posture keeps its own
  suite (`rendezvous-p2p.e2e.js`), which skips loudly unless
  `VULOS_RELAYD_BIN` points at a prebuilt relayd, with the built-in surface off
  so its premise ("nothing of ours is in the discovery path") holds exactly.

### Added — STUN/TURN configurable at runtime (`collab.ice.*`)

- `docs/COTURN.md` told operators to set `VITE_STUN_URLS` / `VITE_TURN_*`, which
  are **baked into the JS bundle at build time** — so anyone running a downloaded
  release binary or the container image could not follow it without rebuilding
  the frontend. The document was unusable for exactly its audience.
- `collab.ice.*` (with `VULOS_STUN_URLS` / `VULOS_TURN_*` env overrides) is the
  same configuration supplied where that operator can supply it, served to
  browsers at `GET /api/rendezvous/ice`. Unconfigured it returns an **empty**
  list, which the client already treats as "answer from my own config" — so
  nothing changes for a deployment that had set the bundle's variables.
- `turn_secret` implements coturn's REST (`static-auth-secret`) mode: the secret
  never leaves the process and each response carries a credential that expires.
  Preferred over `turn_username`/`turn_credential`, because the ICE endpoint must
  be unauthenticated (a browser needs ICE servers before it has a session) and a
  long-lived credential placed there is readable by anyone who can reach the box.
  That trade-off is stated in the docs rather than glossed.
- STUN/TURN are also directly configurable at build time
  (`VITE_STUN_URLS`, `VITE_TURN_URL`, `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL`,
  or runtime `window.__VULOS_ENDPOINTS__` injection), so a standalone deployment
  can self-host its own TURN server (coturn) for peers behind strict/symmetric
  NAT without depending on a host box or a `vulos-relayd`. Default behaviour is
  unchanged in spirit: STUN via the public Google server unless overridden, TURN
  opt-in only.

### Changed — Collaboration is always peer-to-peer; there is no central document server

- **Diwan's differentiator is that co-editing is genuinely distributed
  peer-to-peer** — unlike Collabora/OnlyOffice, which route every edit through a
  central document server. The codebase went through a server-mediated collab
  path during development (an SSE op-relay + authoritative SQLite op-log +
  server presence); it never shipped and has been deleted in full, along with
  the cloud P2P fabric transport that preceded the current WebRTC engine. Both
  are absent from this release.
- **What collaboration is, in full, as of this release:** the document rides an
  **end-to-end-encrypted room** as **Yjs** updates (`yP2PSession.js`). Peers
  connect **directly over WebRTC** data channels (STUN-assisted); a
  **content-blind relay** circuit (per-session X25519 box — ciphertext only) is
  used solely as a hard-NAT fallback. Presence and live remote cursors ride the
  same E2E room. The only server role is content-blind peer **discovery**
  (`/api/rendezvous/*` built in, or `/api/peering/*` on a Vulos OS / Ephor host)
  — never document content. A bare standalone binary with discovery disabled
  stays **local-only** and autosaves, honestly showing "Offline" instead of a
  fake "Live".
- `DocsEditor` hydrates its Y.Doc **locally** from the document's own
  authoritative content (a deterministic content-derived seed) — saving your own
  file to your own storage, never a collaboration server.
- Covered by `collabGate`, which asserts co-editing ON makes **zero**
  `/collab/*` requests to any server-mediated endpoint; `yP2PSession.multipeer`
  tests cover 3-peer mesh convergence, late-joiner state-vector catch-up, and
  document-path wire opacity (a captured frame never contains the plaintext);
  the `collab.e2e` smoke asserts the real browser issues no server-collab
  request. COLLABORATION.md, ARCHITECTURE.md, ADMIN-GUIDE.md,
  TROUBLESHOOTING.md, USER-GUIDE.md, and README describe this model.
- The superseded hand-rolled text-RGA CRDT cluster (`src/lib/crdt/text.js`,
  `src/lib/crdt/index.js`'s `DocsCollabSession`/`diffToOps`,
  `src/lib/crdt/p2pSession.js`'s `P2PCollabSession`, and the Go mirror
  `backend/crdt/text.go`) is gone — Docs runs on Yjs + y-prosemirror. Their
  properties live on in retargeted tests: `p2pShare.integration.test.jsx`
  drives the live `YP2PCollabSession` (modal → invite-link → converge →
  read-only-refused → opaque-frames), and `tables.test.js` keeps its
  structured-doc guard.

### Added — Sheets refuses to sync across a CRDT-engine mismatch

- **The hole a build-time flag cannot close.** `VITE_SUBSTRATE_SYNC` keeps one
  engine per build of one deployment — not one engine per *room*. A tab loaded
  before the flag was flipped, the CommonJS library build (which can never locate
  the `.wasm` and so always runs `grid.js`), and two deployments meeting through
  one invite link all put two engines in one document.
- **And what happened then was not "different winners".** The two engines share
  the fabric's message *types* but not their op *payloads*: `grid.js` sends
  `{kind, id, key:{r,c}, v}`, `substrateGrid.js` sends `{dsync:1, b:<canonical
  bytes>}`. A `grid.js` op reaching the substrate was dropped by
  `opBytesFromWire` returning null — no error, no event, nothing rendered. A
  substrate op reaching `grid.js` read `op.key.r` on an undefined `key` and
  **threw inside a fabric event listener**, once per remote keystroke. Snapshots
  crossed no better. So nothing merged, in either direction, permanently — while
  the presence roster and the status pill both said "Live".
- **`src/lib/crdt/gridEngine.js`** is the engine-advertisement handshake, and it
  is two-layered on purpose. Every session announces its engine id in a
  `grid_hello` frame and answers a peer's hello with its own; *and* it classifies
  every inbound op and snapshot by shape, because the commonest mismatch of all
  — a peer on a bundle that predates this change — will never send a hello. An
  op payload that cannot be classified counts as foreign, never as benign.
- On a mismatch the session latches closed **one way** and stops replicating
  entirely: no op sent, none applied, and nothing appended to the durable update
  log (the second place two engines can meet). It still answers a hello, so the
  peer that caused the mismatch learns of it too rather than being left believing
  it is collaborating. The pill turns to a danger-tone **"Not syncing"** — the
  only status in that component that is an error rather than a phase, because
  everything else there resolves itself and this never will — and a banner tells
  the user their work is still saving and to reload once everyone is on one
  build. Local editing and whole-document autosave are untouched.
- The trade is stated rather than hidden: a **visible** loss of live
  collaboration in exchange for not producing two plausible spreadsheets that
  silently disagree.

### Changed — Sheets runs on the shared substrate engine by default

- `VITE_SUBSTRATE_SYNC` defaults **on**, so `substrateGrid.js` over the
  published [`@vul-os/kotva-sync`](https://www.npmjs.com/package/@vul-os/kotva-sync)
  package is the engine a real deployment uses. `grid.js` (the earlier
  hand-rolled CRDT) remains selectable deployment-wide with
  `VITE_SUBSTRATE_SYNC=off`. Two replicas converge because they run the same
  compiled, vector-pinned algebra rather than because two implementations agree
  most of the time.
- **The WASM-load fallback could otherwise diverge two peers silently**: a failed
  engine load fell straight back to `grid.js`. The two engines do not share a
  total order — `grid.js` resolves a conflicting write by `(lamport, replicaId)`
  and ignores wall-clock time, the substrate uses a full HLC — so a client that
  fell back could pick a different winner for the same pair of concurrent writes
  and diverge permanently, with both users seeing a plausible spreadsheet and no
  error anywhere. The fallback is now conditional on there being nothing to
  diverge from (no fabric, no update log); otherwise the session **fails closed**
  and stays local-only, which loses live collaboration visibly instead of
  corrupting data invisibly.
- The shared merge engine is a **published npm package**, not a vendored copy:
  `package.json` pins the registry version exactly and `package-lock.json`
  carries npm's sha512 for the tarball. The published package is a wasm-pack
  *bundler* build whose entry point cannot be imported under Vitest, so a
  first-party, environment-agnostic loader lives at `src/lib/crdt/kotvaSync.js`
  — it uses the published wrappers and `.wasm` byte-for-byte and re-implements no
  algebra. `src/lib/crdt/__tests__/substratePackageProvenance.test.js` pins the
  lockfile's sha512 for the tarball, recomputes the SHA-256 and size of every
  installed file, asserts the recorded and installed file sets match in both
  directions with the count pinned, and fails if any dependency reappears as a
  local `file:`/`link:` path.

### Fixed — opening an invite link could silently never connect

- `DocsEditor` attaches the ProseMirror schema to its Y context only once the
  editor has **mounted**, so there is a window where the context is truthy but
  incomplete. `useP2PCollab`'s auto-join effect fires on the context becoming
  truthy; when it won that race, `YP2PCollabSession` threw `missing Y context`
  and the catch tore the session down **for good**. The user got an invite link
  that never connected, with only a console warning, and whether it happened
  depended on how long the transport probe took. Observed while bringing up the
  built-in-rendezvous E2E suite, where the faster same-origin probe loses the
  race reliably.
- Both the join and the share path now wait (bounded) for the context to become
  complete. A genuinely broken context still fails loudly rather than hanging.

### Fixed — env config was ignored when there was no config.yaml

- `config.Load` returned `Default()` on a missing file **without** applying the
  env overrides, so every `VULOS_*` / `DIWAN_*` variable was silently dropped in
  exactly the deployment that had nothing else to configure with — a container or
  PaaS image configured entirely from the environment.

### Security — share-link tokens are stored hashed

- Share-link tokens were persisted **in the clear** — as
  `data/sharelinks/<token>.json` on the file backend and in
  `share_links.token` on Postgres — so anyone who could read the store (a
  backup, a stray `SELECT *`) held working, unexpiring read capabilities to the
  documents those links pointed at. Only a SHA-256 hash is stored now, the same
  discipline `backend/invites` already applied to registration tokens.
- Existing links keep working: both backends convert existing records in place
  on first use, and the view route hashes whatever a visitor presents.
- The link URL is shown **once**, in the mint response.
  `GET /api/files/:id/share-links` no longer returns a token for any link, and
  the share dialog says "URL shown only when created" for links the current
  session did not mint. Revoking still works from the link id.
- Covered by `backend/storage/local_sharelinks_hash_test.go`,
  `backend/storage/postgres_sharelinks_test.go`,
  `backend/handlers/sharelink_token_once_test.go` and a dual-backend contract
  test.

### Security — dependency bumps

- `golang.org/x/crypto` and `golang.org/x/image` (plus the `x/sync` / `x/text`
  they pull) are kept current, clearing patchable advisories `govulncheck`
  flagged in required modules. `govulncheck` reports **0 reachable**
  vulnerabilities.

### Security — CRDT, sanitiser and import hardening

- **CRDT DoS fail-close** — remote text ops are validated (codepoint bounds, no
  UTF-16 surrogates) before apply and dropped on failure instead of throwing, so
  a malformed/oversized op can't crash or DoS the editor on bootstrap.
- **Sanitiser hardening** — centralised DOMPurify policy in `src/lib/sanitize.js`;
  inline `style` uses a **property allow-list** (positioning overlays,
  `content:`, fetch/exec functions all dropped fail-closed).
- **Image src policy + collab ingress** — `<img>` restricted to raster data: URIs
  (require `;base64,`; reject SVG/XML/HTML and the raster MIME-lie form) and
  http(s)/relative URLs; `srcset`/`href`/`xlink:href` channels closed. The same
  `isSafeImageSrc` predicate gates the collab/JSON-reload ingress path so a
  hostile peer op can't smuggle an unsafe `src`.
- **Chart export injection** — spreadsheet formula-injection prefixes
  (`=`/`+`/`-`/`@`) neutralised and cell data escaped before SVG render; charts
  clamped to finite geometry on draft-restore.
- **Import boundary** (`lib/importBounds.js`) — compressed-size gate, zip-bomb
  caps (entry count + declared/actual decompressed size), zip-slip entry-name
  rejection, XXE-safe XML parsing (DOCTYPE/ENTITY stripped), and per-sheet
  cell/sheet caps. Every imported document flows through its app sanitiser
  (`sanitizeDocHtml` / `sanitizeObjects` / CSV formula-injection guard) before
  render; embedded images are extracted (never fetched) and remote refs dropped.
- **`.ics` import SSRF guard**: calendar-style subscription URLs are validated
  against a blocklist before fetch.
- **Per-file ACLs**: `backend/fileacl/` enforces read/write/admin permissions on
  every file, backed by SQLite (local) or Postgres (multi-user), covered by
  dedicated auth-bypass and file-ACL pentest suites
  (`backend/handlers/pentest_*_test.go`).

### Added — Docs structured content

- **Tables** (resizable columns, header scope), **inline images** (raster-only,
  base64 or http(s), resize / align / alt), and real **footnotes** (auto-numbered
  inline refs + a re-derived footnote list, baked into HTML/DOCX/Markdown export).
- **Comments** — anchored text-range comments with threading and resolve/reopen.
- **Suggestions** — track-changes mode with insert/delete proposals and an
  accept/reject workflow.
- **Version history** — named snapshots with restore, plus an activity feed.
- **Find/replace** — highlights all matches via ProseMirror inline decorations
  (yellow for all matches, outlined for the current one), with a regex-mode
  toggle that shows a danger indicator and returns no results on an invalid
  pattern rather than throwing.
- A live **document outline / ToC**, a **word-count** modal, and a **page
  break** insert (a real CSS page break on print).
- **Subscript / superscript** (`Mod+,` / `Mod+.`), a **custom font-size** input
  (1–400pt) in the font-size dropdown, and a corrected **line-spacing** control
  that applies at paragraph-node level rather than via a text-style mark.
- **Export** — DOCX (images + tables + footnotes preserved), Markdown (GFM
  pipe-tables), sanitised HTML, and PDF. Print (`Ctrl+P`/`Cmd+P`) sets the
  document title to the file name for the print dialog and restores it after.

### Added — Sheets

- **Charts** (column / bar / line / area / pie) rendered as live SVG, persisted
  locally and round-tripped through a "Vulos Charts" metadata sheet on XLSX
  export.
- **Data validation** (list / checkbox / date / number / text / custom),
  **number formats** (currency / percent / date / accounting, XLSX-roundtripped),
  and **conditional formatting**.
- **Filters** (named views), **pivot tables** (SUM/AVG/COUNT/MAX/MIN into a new
  sheet), and **named ranges**.
- A built-in **formula bar**, **freeze rows/columns** (top row, first column, or
  a custom count), and **cell-level comments**.
- **Find/replace** (Ctrl+F / Ctrl+H) across all sheets' cell data, with
  prev/next navigation and replace-one/replace-all.
- **Paste-values-only** (Cmd+Shift+V): reads the clipboard, parses TSV, and
  strips leading `=` so pasted formulas land as inert text.
- **CSV**, **XLSX** and **.ods** import/export (values, formulas as inert data,
  number formats, merged cells, multi-sheet, column widths + row heights, chart
  metadata) via SheetJS, client-side with no server round-trip.

### Added — Slides

- **Themes** (preset gallery), editable **master slides** (title/content/section
  layouts), per-slide **transitions** and entrance animations.
- **Presenter view** — a second window with current/next slide, speaker notes,
  timer, and progress, synced via BroadcastChannel.
- **Template gallery** (pitch / project plan / lesson plan / quarterly review),
  a **grid/overview mode** for reordering slides by drag, and inline-toolbar
  parity (undo/redo, heading styles, font size, strikethrough, link insert,
  text color).
- **PPTX** export (via pptxgenjs) alongside PDF.

### Added — Whiteboards, a Diwan document type

- **Vulos Board is a first-class Diwan document type.** The Excalidraw-based
  collaborative whiteboard is a `whiteboard` file type alongside doc/sheet/slide/
  PDF — "**New → Whiteboard**" from the launcher, the app rail, and the file
  browser.
- **It rides Diwan's own distributed peer-to-peer collab engine** — the exact
  same `YP2PCollabSession` + WebRTC transport, E2E-encrypted room, content-blind
  signalling and TURN-only-on-hard-NAT fallback that Docs uses. There is no
  separate whiteboard/collab server and no second collab stack. The scene is a
  Yjs CRDT (Excalidraw elements merge one-per-id via `lib/crdt/boardYdoc.js`),
  and the P2P session's validator is pluggable so it can carry either a
  ProseMirror document or an Excalidraw scene.
- The Y.Doc is hydrated **locally** from the file's own scene (sovereign
  storage, the same hydrate-from-file pattern as Docs) and saved back to the
  file — a standalone binary works local-only with autosave and an honest
  "Offline" pill.
- Includes `ExcalidrawYBinding` (Yjs⇄Excalidraw glue, incl. a raster-only image
  allow-list that refuses active-content blobs). Depends on the MIT
  [`@excalidraw/excalidraw`](https://github.com/excalidraw/excalidraw) editor
  (attribution in THIRD-PARTY-NOTICES).

### Added — Diwan interop (import + export fidelity)

- **Unified Open flow**: drag-and-drop + file-picker on every app home detects the
  format (.docx/.xlsx/.pptx/.odt/.ods/.odp/.md/.txt/.html/.csv/.pdf) and routes to
  the right app + importer, with progress/error/unsupported states.
- **Docs**: `.odt` import (best-effort ODF→semantic HTML: headings, bold/italic/
  underline, lists, tables, links, embedded raster images) and `.odt` export
  (best-effort). `.docx` import (mammoth) flows embedded images to inline data:
  URIs with no network fetch.
- **Slides**: `.pptx` / `.odp` import into the positioned-object model (text
  boxes, images, positions/sizes from EMU/ODF geometry, bold/italic runs, pptx
  speaker notes). Best-effort fidelity.
- Legacy **binary** `.doc` / `.xls` / `.ppt` (OLE2) are not supported — users are
  asked to re-save as the modern zip/ODF variant. `.pptx`/`.odp` import fidelity
  is content-level, not rendering-faithful (theme colours/fonts, gradients,
  tables, charts, SmartArt, animations, transitions, masters/layouts and vector
  auto-shapes are dropped/approximated); `.odt` import drops character styling
  beyond bold/italic/underline.

### Added — PDF forms and signing

- **Fill interactive PDF forms** (AcroForm, DocuSign/Adobe parity): the PDF
  editor detects AcroForm fields on load and surfaces a one-click "Fill N
  fields" affordance that seeds editable, exactly positioned text/checkbox
  annotations at each field box, reusing the annotate → export pipeline. The
  PDF↔screen coordinate mapping (Y-flip, scale) lives in a pure, unit-tested
  `formFields.js` module.
- **Signing pipeline**: `GET /api/sign/pubkey` returns the server's Ed25519
  public key so external parties can independently verify signature tokens.
  `EnvelopeDashboard.jsx` gains a download-sealed-PDF action and an inline
  "Verify document integrity" action; `SignView.jsx`'s done-screen links to
  `/verify`.
- **Tamper-evident audit chain**: all audit events (created, sent, viewed,
  signed, declined, voided, completed) participate in a hash chain, each
  entry's `prev_event_hash` computed from the prior event and appended
  atomically.
- The seal→verify hash is computed **before** manifest attachment
  (`FinalDocHash = sha256(certPDF[:lastEOF])`), and `verify.go` re-extracts and
  re-hashes the same pre-manifest slice to confirm — fixing an earlier
  circular-dependency bug where the embedded manifest hash could never match a
  freshly hashed sealed PDF. The `startXref` offset recorded on incremental PDF
  updates points at the actual `xref` keyword rather than the base section's
  start, so PDF readers locate the cross-reference table correctly.
- Covered end-to-end by `backend/handlers/seal_verify_test.go`: sign → seal →
  verify round-trip, tamper detection (byte-flip in the pre-manifest area), the
  HTTP multipart verify endpoint (200 clean / 422 tampered), verify-by-envelope-
  id, the pubkey endpoint, the download gate (409 before all signed), manifest
  hash presence, chain-broken detection, and idempotent sealing.

### Added — Standalone, server-honest Settings + admin surface

A self-hoster running Diwan standalone gets a Settings surface that reports what
the instance is **actually** doing, instead of hardcoded placeholders.

- **`GET /api/system/info`** — honest runtime facts: build version, storage
  backend (`local`/`postgres`) + data/uploads directories, object-store status
  (MinIO/S3/Tigris, endpoint + bucket, never credentials), auth mode
  (`disabled`/`shared`/`per-user`) + registered-user count, standalone-vs-cloud
  integration mode, and the caller's account id + admin status.
- **`POST /api/auth/password`** — authenticated self-service password rotation
  against the per-user credential store, re-verifying the current password
  first. Shared-password and auth-disabled modes return honest guidance
  pointing at `config.yaml` rather than silently failing.
- **Settings overhaul** (`src/components/Settings.jsx`): Account / Appearance /
  Security / Storage tabs reading `/api/system/info`, plus an **Admin** tab
  (invite tokens + audit log) shown only to admins.
- A focus trap (`useFocusTrap`) is applied to the shared `Modal` component, so
  every dialog in the app traps and restores keyboard focus correctly.

### Added — Build, versioning and release tooling

- **Build-time version injection** via `-ldflags "-X main.Version=vX.Y.Z"`.
  `GET /version` returns the build version as JSON, and `--version` / `version`
  on the CLI prints it and exits.
- `.github/workflows/release.yml`: a release pipeline triggered on `v*` tags —
  cross-compiles linux/amd64 and linux/arm64, builds the frontend, generates
  SHA-256 checksums, and creates a GitHub Release; it verifies the tag matches
  `web/package.json`'s version before proceeding.
- **Observability**: `backend/obs/` provides Prometheus metrics (`diwan_*`) and
  OpenTelemetry tracing.
- **`@vulos/office-client` library**: a multi-entry Vite build
  (`vite.config.lib.js`) exporting `docs`, `sheets`, `slides`, `pdf` as
  individually importable sub-packages for embedding elsewhere.
- File versioning: `ListVersions`, `GetVersion`, `RestoreVersion`,
  `PruneVersions`, `LabelVersion` on the storage interface, backing Docs/Sheets/
  Slides' version-history panel.
- **`OfficeBackendConfig`** (`backend/storage/backendconfig.go`) — per-org S3
  bucket + CRDT snapshot configuration, injectable by an operator's control
  plane.

### Changed — self-contained: no dependency on another Vulos product's package

- Removed the `@vulos/relay-client` npm dependency (`third_party/relay-client`)
  entirely. Diwan does not depend on any other Vulos product's package.
- **Endpoint selection** (cloud↔LAN failover used by the API client, PWA
  bootstrap, and `main.jsx`/`office.jsx` entry points) is first-party code at
  `src/lib/endpoints/` (`index.js`, `offlineBootstrap.js`) plus
  `src/lib/roundTripCheck.js` (the xlsx import/export fidelity dev tool).
- The `FabricClient` WebRTC transport (plus signalling/rendezvous/prekey/
  relay-box support code) is first-party source at `src/lib/collab/webrtc/`
  rather than a vendored package dependency. Unused subpaths the SDK shipped
  but Diwan never imported (a Node health-check export, region-aware PoP
  selection, audio/video calling signalling) were dropped rather than carried
  along.

### Changed — UI/UX

- Rebuilt on a **token-first, near-black design system** (`src/design/
  tokens.css`): IDE aesthetic, one deep-teal accent, Inter chrome + mono
  micro-UI, hairline borders, deep no-bloom elevation. Dark is the default
  canvas; a clean light theme is opt-in. Shared primitives: `SaveStatus`
  (breathing save dot), `Avatar`/`AvatarStack` (deterministic presence chips),
  `EmptyState`, `DocThumb` (per-type launcher thumbnails), plus a
  `.toolbar-surface` / `<ToolbarButton>` toolbar language and `.doc-desk` /
  `.slide-stage` canvas surfaces.
- A shared **`ErrorState`** primitive (role="alert", tokenised, optional Retry)
  completes the loading / empty / error async-state family alongside
  `LoadingState` / `EmptyState`, adopted in `ActivityFeed` and `HistoryPanel`.

### Fixed — app-shell crash on a non-array list response

- The `@-mention` notifications poll in the sidebar rail did `items.filter(...)`
  on a value guarded only by `items || []`. A non-array body (an `{}` envelope,
  an error body that slipped a 200, or an unmodeled endpoint) is truthy, so it
  poisoned the store and threw during render — taking down the **entire UI on
  every route** (Docs, Sheets, Slides), intermittently. Hardened at the seam:
  `notificationsStore.fetch` and `filesStore.{fetchFiles,fetchFolders,
  fetchSharedWithMe}` now coerce any non-array to `[]`. Covered by store
  regression tests and a hermetic `/notifications` E2E fixture.

### Changed — the identity/access surface is documents-only

Diwan is scoped to **documents only** (Docs, Sheets, Slides, PDF/Signing).
Real-time chat + Spaces, video calling/meetings, calendar and contacts were
developed in this repository at various points and have all been split out:

- **Vulos Meet** (video calling/meetings) and **Vulos Talk** (team chat +
  Spaces) are separate products, combined with Diwan by the **wede** shell.
  Diwan's sidebar keeps an **external** launcher link to Talk
  (`talk.vulos.org`) — a cross-product link, not an in-process surface.
- **Calendar and Contacts** are served by the **mail connector** (lilmail
  CalDAV/CardDAV + `/v1/calendar` + `/v1/contacts` + `@vulos/mail-ui`) instead
  of this repo. `/calendar` and `/contacts` deep-links redirect to the Mail
  product (`VITE_MAIL_URL`, default `https://mail.vulos.org`).
- Identity uses the `@vulos.org` account namespace throughout.
- Dead code left by these extractions (meeting/spaces models, their storage
  CRUD methods and Postgres schema, the corresponding frontend API client
  methods and UI) has been removed rather than left unreferenced.

---

[Unreleased]: https://github.com/vul-os/diwan/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/vul-os/diwan/releases/tag/v0.1.0
