# Diwan – Architecture

## Overview

Diwan is a collaborative document editing + e-signing service. It exposes:
- File CRUD with version history
- REST persistence plus real-time collaboration (comments, suggestions, live
  co-editing). Live co-editing is always peer-to-peer over one E2E-encrypted
  room, in two CRDT flavours — see the note below
- E-signing workflow (envelope → sign → sealed PDF)

> **Scope:** Diwan is documents-only (Docs, Sheets, Slides, Whiteboards, PDF/Signing). Calendar
> and Contacts come from the bring-your-own-mailbox PIM connector (lilmail
> CalDAV/CardDAV + lilmail `/v1/calendar` + `/v1/contacts`), surfaced by the OS as
> standalone widgets. Chat and video are third-party (Matrix/Element; Element Call /
> Jitsi), not Vulos products. The Vulos OS is the shell that hosts the apps.

> **Collaboration transport note:** Live co-editing is CRDT-based and runs
> **entirely peer-to-peer — there is NO central document server.** The Diwan
> binary hosts no op-relay, no doc-state hub, and no server-mediated collab
> endpoint (confirmed in `main.go` at the `/v1` route block: "Office
> collaboration is ALWAYS peer-to-peer … deliberately NO central document
> server"). The codebase carries **two CRDT session flavours** — one live, one
> superseded but still tested — both riding the **same**
> end-to-end-encrypted room (`src/lib/crdt/p2pRoom.js`) over the same
> first-party `src/lib/collab/webrtc/fabric.js` fabric transport (re-homed
> from the vendored relay-client SDK — Diwan depends on no other Vulos
> product's package):
> - **Yjs session** (`YP2PCollabSession`, `src/lib/crdt/yP2PSession.js`) — the
>   structure-aware path used by **Docs**. The document is a Yjs document
>   (`src/lib/crdt/ydoc.js`), kept in lock-step with ProseMirror by
>   y-prosemirror; peers exchange Yjs updates + state-vector resyncs. The
>   whiteboard document type rides the same session with an Excalidraw-scene
>   validator (`boardYdoc.js`).
> - **Grid and tree sessions** — Sheets' LWW grid and Slides' fractional-index
>   tree ride the same fabric directly, through `SubstrateGridSession` /
>   `GridSession` and `TreeSession` rather than through a document session.
>   (A third path used to be listed here: `P2PCollabSession` over a hand-rolled
>   text RGA, `crdt/text.js` + `crdt/index.js`. It was superseded when Docs moved
>   to Yjs and no editor had constructed it since; the ~1,040 lines have been
>   deleted rather than left to read like an available mode.)
> - In both cases peers connect **directly** over WebRTC data channels
>   (STUN-assisted); a **content-blind relay** circuit is used only as a hard-NAT
>   fallback (per-session X25519 box — ciphertext only). Frames are sealed
>   AES-256-GCM under an HKDF-derived room key carried in the URL **fragment**
>   (`#vp2p=…`), which never reaches any server.
> - **Presence** (cursors + roster) rides the **same E2E room**, so the host never
>   learns who is in a room; it is ephemeral and never persisted. A read-only peer
>   holds the decryption key but not the RW-authority MAC, so its writes are
>   cryptographically refused.
> - **The only server role** is content-blind peer **discovery** (signaling + ICE),
>   resolved as a four-way choice (`src/lib/collab/transportSelection.js`, see
>   docs/COLLABORATION.md §3): (1) this server's own `/api/peering/*`, provided
>   by a host (Vulos OS / Pier) in front of Diwan; else (2) a configured
>   rendezvous URL (`config.yaml` `collab.rendezvous_url` / `VULOS_RENDEZVOUS_URL`)
>   pointing at ANY self-hosted `vulos-relayd`'s open rendezvous surface; else
>   (3) **this binary's OWN built-in surface** at `/api/rendezvous/*`
>   (`backend/rendezvous`, `collab.builtin_rendezvous`, **on by default**) — which
>   is what makes a bare standalone binary capable of real peer-to-peer with no
>   other product deployed and nothing configured; else (4) none is reachable and
>   collaboration stays **local-only** and autosaves, with the UI reporting
>   "Offline" honestly.
> - The built-in surface is **signature-authenticated** (Ed25519 over a
>   domain-separated canonical message), nonce + timestamp replay-refusing, capped
>   in every dimension, per-IP rate-limited, and holds only in-memory soft state
>   with minute-scale TTLs. It moves opaque bytes: the room key lives in an invite
>   link's URL fragment and reaches no server. Its wire format is byte-for-byte
>   relayd's, and the Go/JS implementations of the signed canonical message are
>   pinned to shared fixed vectors so they cannot drift apart.
>
> Ingress is validated **fail-closed**: every untrusted update is shadow-applied,
> converted against the real schema, and image/link-clamped before it can touch
> the live document (malformed/oversized/unrenderable updates drop, never throw).

## Component Map

```mermaid
%%{init: {'theme':'base','themeVariables':{'fontFamily':'ui-monospace, SFMono-Regular, Menlo, monospace','primaryColor':'#2A241C','primaryBorderColor':'#8E8677','primaryTextColor':'#F1EBE0','lineColor':'#D0471F','edgeLabelBackground':'#201B15','tertiaryTextColor':'#F1EBE0','clusterBorder':'#8E8677','clusterBkg':'transparent'}}}%%
flowchart TD
    classDef entry fill:#201B15,stroke:#8E8677,color:#C3BAAC
    classDef subject fill:#AE3917,stroke:#FF8759,color:#FFF1EA
    classDef downstream fill:#2A241C,stroke:#8E8677,color:#F1EBE0
    Browser["Browser clients (React SPA)"]
    Server["Gin HTTP Server (main.go)<br/>/api/files/* → FileHandler<br/>/api/files/:id/versions → ...<br/>/api/sign/* → SigningHandler<br/>/version → build info<br/>/metrics → obs.Handler()"]
    Storage["backend/storage/<br/>local, PG"]
    Signing["backend/signing/<br/>crypto.go"]
    Fileacl["backend/fileacl/<br/>(per-file ACLs)"]
    Obs["Observability: backend/obs/<br/>diwan_* metrics + OTel<br/>GET /metrics"]
    Browser -->|"HTTP REST"| Server
    Server --> Storage
    Server --> Signing
    Server --> Fileacl
    Server --> Obs
    class Browser entry
    class Server subject
    class Storage,Signing,Fileacl,Obs downstream
```

## Key Design Decisions

- **Gin framework**: chosen for its middleware ecosystem and existing codebase.
- **Client-side CRDT modules** (`src/lib/crdt/`): all merge logic lives in the
  browser — there is no server-side CRDT. Two families coexist:
  - **Yjs** (`ydoc.js`, `yP2PSession.js`) — the structure-aware path Docs (and
    the whiteboard document type) use; converges with no central authority.
  - **The shared substrate engine** (`substrateGrid.js` over the published
    `@vul-os/kotva-sync`) — Sheets' grid, and the DEFAULT for it
    (`VITE_SUBSTRATE_SYNC`, on unless a deployment turns it off).
  - **Hand-rolled CRDTs** — grid (LWW, `grid.js`, what a `VITE_SUBSTRATE_SYNC=off`
    build ships), tree (fractional-index, `tree.js`, Slides' only engine), plus
    comment/suggestion ordering.

  Sheets' two grid engines share the fabric's wire TYPES but not their op
  PAYLOADS or their total order, so peers on different engines cannot merge —
  and, before the engine-advertisement handshake, did not merge *silently*. A
  grid session now advertises its engine, infers a peer's engine from the shape
  of any op it sends, and REFUSES to keep replicating across a mismatch rather
  than degrading into two divergent documents. See `src/lib/crdt/gridEngine.js`
  and [COLLABORATION.md](COLLABORATION.md).

  Both families sync over the **single** collab transport: the E2E-encrypted
  peer-to-peer room (`p2pRoom.js`) on the first-party WebRTC fabric
  (`src/lib/collab/webrtc/fabric.js`). There is
  no server-mediated collab transport (no SSE op-stream, no doc-state hub) — the
  server's only collaboration role is content-blind peer discovery, served by
  default by this binary's own `/api/rendezvous/*` (`backend/rendezvous`), or by a
  host box's `/api/peering/*`, or by a configured rendezvous URL pointing at any
  self-hosted `vulos-relayd` (see the collaboration-transport note above and
  `src/lib/collab/transportSelection.js`).
- **Durability — whole-doc PUT + optional CRDT update log**: the primary store is
  a whole-document blob (`PUT /api/files/:id`) guarded by an optimistic-concurrency
  rev (a stale write is a `409` the client reconciles). Layered on top — behind
  `persistence.updatelog` (`backend/updatelog/`) — is a **per-file append-only
  CRDT update log** (`GET`/`POST /api/files/:id/updates`): every CRDT frame
  (opaque, encrypted-or-plain Yjs / sheet / slide update) is kept with a monotonic
  seq, and a client periodically posts a compacting `snapshot` frame (whole state +
  a `floor` seq) so the server can prune the frames it subsumes — while preserving
  any frame above the floor. Because CRDT updates are commutative + idempotent,
  replaying snapshot+frames converges byte-identically no matter how peers diverged
  offline, so this supersedes last-writer-wins for durability. It is **additive**:
  the frontend dual-writes (whole-doc autosave AND frame append), so the flag can be
  toggled without losing a document. The server stays content-blind (frames are
  opaque bytes).
  - **Store backends** mirror the primary storage choice: **local/S3 storage →
    filesystem `LocalStore`** (`data/updates/<id>/`), **postgres storage →
    `PostgresStore`** (`office.file_updates` + `office.file_update_snapshots`,
    sharing the storage pool). The Postgres append derives its monotonic per-file
    seq under a transaction-scoped **per-file advisory lock**, and the snapshot
    upsert + frame prune run in the same transaction (S3 has no append-with-
    monotonic-seq primitive, so it falls back to the filesystem log).
  - **Frames are metered**: an append passes the **same storage-quota gate** as
    the whole-doc PUT (`billing.GateStorage`), so the log is not a quota bypass
    (standalone/unlimited → no-op).
  - **Editors wired**: Docs and Whiteboard (both plain Y.Docs) use the Yjs
    `UpdateLogSync`; Sheets (LWW grid) and Slides (fractional tree) are op-based
    CRDTs and use `OpLogSync`, which carries discrete ops as frames and the
    compacted state as snapshot frames.
  - **Server-side compaction is advisory only**: the server *cannot* fold opaque
    CRDT frames into a snapshot (it cannot interpret them). When a file's
    un-compacted tail exceeds `updatelog.CompactAdviseThreshold` the append
    response carries `compact: true` (a throttled WARN is also logged) and the
    client compacts. Client-driven compaction stays primary.
- **E-signing**: PDF is sealed with a cryptographic hash; audit manifest JSON captures all signer events.
- **Auth**: JWT-based; configurable (`cfg.Auth.Enabled`). Per-user credentials stored in
  pure-Go SQLite (`backend/userauth/`).
- **Storage**: pluggable interface — local JSON (default), PostgreSQL (multi-user), or
  S3-compatible object store (BYO/Tigris).
- **Deploy modes** (`backend/deploymode/`, `DEPLOY_MODE`): exactly two — `standalone`
  (default; a fully sovereign self-host with no OS gateway in front — all features
  open, no billing/entitlement gating, blob I/O via the process-wide object client
  or a silent no-op) and `os` (Diwan running as an app **behind a Vulos OS box
  gateway**). Diwan is never centrally hosted by Vulos — `os` mode simply means
  it runs behind a self-hosted Vulos OS box, not any service Vulos operates. In
  `os` mode the process **refuses to boot** without an
  authenticated posture (native auth or SSO introspection) so a hosted deployment can
  never silently collapse every caller onto one shared identity.
- **Storage seam** (`backend/storage/seam_client.go`, `backend/handlers/bucket_store.go`):
  in `os` mode the gateway injects per-request `X-Vulos-Storage-*` headers describing a
  short-lived, per-user S3 slice, so Diwan never holds full-bucket credentials. The
  headers are honoured **only** when the request also carries a valid
  `X-Vulos-Storage-Broker-Auth` matching `VULOS_STORAGE_BROKER_SECRET` (constant-time),
  and the injected endpoint is SSRF-checked (`ValidateSeamEndpoint`: https always,
  http only for loopback/private hosts). Otherwise the seam headers are ignored and
  Diwan falls back to the standalone object client. In every mode blob keys are built
  by `storage.OrgScopedKey(accountID, name)`, which scopes each object under its
  owning account and sanitises every segment so a caller-influenced id can never inject
  a path separator or `..` and escape into another account's namespace.
- **Org-bucket wiring**: `backend/storage/backendconfig.go` carries `OfficeBackendConfig`
  for the S3 bucket + CRDT snapshot configuration used by the standalone object client.
- **Per-file ACLs**: `backend/fileacl/` enforces per-file read/write/admin permissions
  backed by SQLite or Postgres (co-located with the file store). Identity is always the
  server-verified requester (JWT subject / SSO tenant), never a client header, and a
  denied file op returns `404` so responses never leak whether a file exists.

## See Also

- Deployment: `docs/DEPLOY.md`
- Install (single-box with Vulos OS): `docs/INSTALL.md`
- Versioning & release: `docs/RELEASING.md`
- Security model: `SECURITY.md`, `THREAT-MODEL.md`
