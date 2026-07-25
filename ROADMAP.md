# Ofisi — Roadmap

Ofisi is the **documents** surface of the Vulos project — a self-hosted,
open-source (MIT) suite for Documents, Sheets, Slides, Whiteboards, and
PDF/Signing that runs as a single Go binary with a React frontend. (Calendar
and Contacts come through the mail connector — CalDAV/CardDAV via lilmail.)
Today it is a fast, private, local-first editor suite with **live
peer-to-peer collaboration already running**: the same documents (and
whiteboards) edited together in real time by people on different Vulos
instances, end-to-end-encrypted with no central document server, and PDFs
signed with cryptographic audit trails — all riding the **Vulos peer fabric**
that already connects and routes instances across the network, with
relay/TURN fallback. This roadmap charts what's next: deeper import/export
fidelity and hardening the fabric further.

> **Product scope.** Ofisi is documents-only. Chat and video are **third-party**
> (Matrix/Element for chat; Element Call / Jitsi for video), not Vulos products;
> the **Vulos OS** is the shell that hosts the apps. Any chat/calling items
> previously tracked here are out of scope for this repo (see § 4).

The throughline: Ofisi never invents its own network. Real-time document
collaboration reuses the **same fabric the Vulos OS uses for device routing** —
P2P first (cr-sqlite/CRDT sync to buckets), relay/TURN when direct connectivity
fails. *Vulos — open.*

> **Stack invariants (FROZEN):** Go backend; React 18 / Vite / Tailwind frontend,
> **JSX only — never `.tsx`**; MIT license. Collaboration transport is the Vulos
> fabric (CRDT + relay), not a bespoke server. No telemetry, no required cloud
> account for the local single-binary mode.

---

## Status — Now / Next / Later

A snapshot of where the product actually is. The vision pillars that follow
(§ 1–4) give the full picture; this is the honest state of play.

### Now — shipped and live

- **Editors.** Documents (TipTap), Sheets (Fortune Sheet), Slides (the
  from-scratch positioned-object canvas), **Whiteboards** (Excalidraw-based,
  Yjs CRDT), and a PDF annotate-and-sign canvas — all running from the single
  Go binary, installable as a PWA, no account required in local mode.
- **Real-time collaboration.** Always peer-to-peer, no central document
  server: Docs and Whiteboards sync as Yjs CRDT updates, Sheets/Slides over
  LWW/tree CRDTs, inside an end-to-end-encrypted room. Peers connect directly
  over WebRTC, with a content-blind relay circuit as hard-NAT fallback only;
  presence and live cursors ride the same room.
- **Import / export.** Microsoft (`.docx`/`.xlsx`/`.pptx`) and ODF
  (`.odt`/`.ods`/`.odp`) plus `.pdf`/`.csv`/Markdown, all passing through one
  hardened trust boundary (`lib/importBounds.js`: size + zip-bomb + zip-slip +
  XXE caps, then a per-app sanitiser). Slide decks import as positioned objects.
- **Collaboration affordances.** Anchored, threaded, resolvable **comments**;
  **suggestion (track-changes)** mode (Postgres-backed); local **version
  history + snapshots** and restore.
- **Storage.** Local JSON/SQLite by default; org-bucket write-through to the
  S3-compatible store (Tigris or MinIO) when `VULOS_ORG_ID` is set, falling back
  gracefully when no credentials are present.
- **PDF Auto-Sign.** Full pipeline: field placement, per-signer scoped/expiring
  signing links, multi-signer orchestration (sequential/parallel), an **Ed25519
  cryptographic token per signature**, a **hash-chained append-only audit
  trail**, a completion certificate + sealed PDF, and a verification tool with a
  public pubkey endpoint.
- **Security.** Per-file ACLs enforced by every file-scoped handler; an
  adversarial pentest suite that stays green (see
  [`docs/SECURITY-TESTING.md`](docs/SECURITY-TESTING.md) and
  [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md)).
- **Offline / routing.** Offline-first PWA (service-worker app shell + LAN
  failover); client-side CRDT modules; per-document deep links and the
  `web+vulosoffice://` protocol handler.

### Next — actively planned

- **Import/export fidelity hardening** — nested tables, merged cells, embedded
  media, and slide transitions, driven by fixture-based round-trip checks.
- **PDF depth** — true text extraction (beyond overlay annotations) and
  form-field detection.

### Later — on the horizon

- **Multi-target builds** — build each app surface as both a standalone web
  bundle (served by path under `app.vulos.org`) and an embeddable `lib.jsx`
  export consumed by the Vulos OS shell, from one source tree via Vite
  multi-entry. **Owned by the subdomain/app-shell agent** while active —
  `vite.config.*`, `package.json`, and `src/apps/*/lib.jsx` are off-limits to
  other work in parallel.
- **Advanced signing** — qualified/eIDAS-QES or HSM-backed signatures remain an
  explicit **non-goal for v1**; the product ships strong tamper-evidence and
  audit trails, not government-grade qualified signatures.

> **Historical.** A Vulos Spaces surface (channels, DMs, threads, WebRTC
> voice/video, screen-share, scheduled meeting rooms) was built in an earlier
> wave. Vulos no longer builds comms — chat and video are third-party
> (Matrix/Element; Element Call / Jitsi). That code is retained for history only
> and is out of scope for this repo (§ 4).

---

## 1. Ofisi Core — Documents, Sheets, Slides, Whiteboards, PDF

The foundation, and what ships today: a clean, single-binary suite that opens in
the browser with no account required. Documents are edited with TipTap (rich
text, tables, task lists, images, links, pagination, headers/footers, equations),
Sheets with Fortune Sheet (a comprehensive formula engine, multi-sheet,
formatting, charts, pivots), Slides on a **from-scratch positioned-object
canvas** (free drag/resize/rotate of text, shapes, and images in normalized slide
space — not a Reveal.js document; Reveal.js survives only as the full-screen
*present* surface that hosts the same positioned objects), and PDFs with an
annotate-and-sign canvas. Files autosave to local JSON by default (PostgreSQL for
multi-user), and everything imports from / exports to Microsoft (`.docx`/`.xlsx`/
`.pptx`) and ODF (`.odt`/`.ods`/`.odp`) plus `.pdf`, `.csv`, and Markdown. Before
we network the suite, the single-player experience must be solid, lossless, and
trustworthy.

### Goals

- Keep the local-first, single-binary experience excellent and dependency-light.
- Make import/export round-trips lossless enough that Ofisi is a credible
  daily driver against LibreOffice and the incumbents.
- Harden autosave and storage so no edit is ever silently lost.
- Establish clean document models that the collaboration layer (§ 2) can
  wrap in CRDTs without a rewrite.

### Concrete features

- **Documents (TipTap):** headings, tables, lists, task lists, links, images,
  text styling, highlight, alignment, typography, live word/character count,
  page pagination, headers/footers, and equations.
- **Sheets (Fortune Sheet):** a comprehensive formula engine, multi-sheet
  workbooks, cell formatting, number formats, conditional formatting, data
  validation, charts, filters, pivot tables, named ranges, freeze panes, and
  `.xlsx`/`.ods`/`.csv` export.
- **Slides (from-scratch positioned-object canvas):** free-positioning authoring
  — drag/resize/rotate text boxes, shapes, and images in normalized [0,1] slide
  space (`SlideCanvas.jsx` / `slideObjects.js`), per-element entrance/emphasis/exit
  **animations**, editable **master slides**, themes, **presenter view** (notes +
  timer), and present-from-browser. The full-screen present overlay uses Reveal.js
  purely as a slide-to-slide **transition host** that renders our positioned
  objects — it is not the authoring model or the editor.
- **Whiteboards (Excalidraw-based):** an infinite hand-drawn canvas built on
  the MIT [Excalidraw](https://github.com/excalidraw/excalidraw) editor —
  shapes, arrows, freehand, text, and images. The scene is a Yjs CRDT, riding
  the **same** P2P collaboration engine as Docs (no separate collab stack).
- **PDF:** render, page thumbnails, zoom; place text, freehand draw, and
  signature/initial annotations; page reorder/insert/delete/rotate; flatten and
  download via pdf-lib.
- **Import / Export:** open from URL or local file. Export `.docx`, `.xlsx`,
  `.pptx`, `.pdf`, and Markdown. Import Microsoft (`.docx` via mammoth, `.xlsx`
  via SheetJS, `.pptx` via OOXML/JSZip) and ODF (`.odt`, `.ods`, `.odp`) — slide
  decks import as positioned objects (text + geometry + embedded raster images).
  Every import runs through one hardened trust boundary (`lib/importBounds.js`):
  size + zip-bomb + zip-slip + XXE caps, then a per-app content sanitiser.
- **Storage:** local JSON store; PostgreSQL backend for multi-user installs;
  optional password auth (JWT) off by default.
- **Single binary + PWA:** the Go binary embeds the built frontend; installable
  as a desktop/mobile app; offline-first with LAN-endpoint failover.

### Gaps to close

- **Fidelity:** track-and-fix import/export edge cases (nested tables, merged
  cells, embedded media, slide transitions) so round-trips are lossless.
- **PDF depth:** form-field detection and true text extraction (not just overlay
  annotations).

### Explicit non-goals

- **Not a clone of every legacy feature.** We do not chase macro languages,
  VBA, or pixel-exact legacy layout — we target the editing the majority needs.
- **No telemetry, no required account** for the local single-binary mode.
- **No proprietary file formats.** Open, inspectable JSON document models only.

---

## 2. Real-time Collaboration — Editing Over the Peer Fabric

The first networked pillar: open the same Document, Sheet, or Slide deck on two
Vulos instances and edit it together, live. Ofisi does not stand up a
collaboration server. It rides the **Vulos peer fabric** — the OS already syncs
state via **cr-sqlite/CRDT to buckets** and connects instances **P2P with
relay/TURN fallback**. Ofisi models its documents as CRDTs over that same
transport, so a doc converges across peers exactly the way the OS converges
device state — the signaling and relay primitives this builds on live in the
Vulos OS itself (github.com/vul-os/vulos).

### Goals

- Conflict-free concurrent editing of Docs, Sheets, and Slides across instances,
  with no central authority and no lost edits — convergence guaranteed by CRDTs.
- Reuse the OS fabric end-to-end: P2P (WebRTC data channels) first, **Vulos
  relay/TURN** fallback, bucket-backed CRDT sync for offline/late joiners.
- Make presence feel alive — who's here, where their cursor is, what they select.
- Layer human collaboration affordances (comments, suggestions) on top of the
  CRDT substrate, not bolted beside it.

### Concrete features

- **CRDT document model:** wrap each doc type in a CRDT (text/sequence CRDT for
  Docs, grid CRDT for Sheets, tree CRDT for Slides) that serializes to the same
  bucket/cr-sqlite sync the OS uses; offline edits merge on reconnect.
- **Fabric session join:** open a doc → join its fabric session keyed by file ID;
  P2P data channel where reachable, **relay circuit fallback** otherwise; bucket
  snapshot for cold/late joiners.
- **Presence:** live roster of collaborators with identity (Vulos account /
  accountAddress), color, and online state.
- **Live cursors & selections:** remote carets and selection ranges rendered in
  each editor.
- **Comments:** anchored, threaded comments on a text range / cell / slide
  object; resolve/reopen; notifications via the fabric.
- **Suggestion (track-changes) mode:** propose edits as suggestions a doc owner
  can accept/reject, stored as CRDT-friendly annotations.
- **Activity & version history:** per-document change feed and named snapshots
  derived from the CRDT op log.

> **Status.** Shipped: the client-side CRDT modules, comments, suggestions,
> presence, version history, and the **live peer-to-peer doc-sync channel**
> itself — collaboration is now always end-to-end-encrypted P2P (WebRTC
> direct, content-blind relay circuit as hard-NAT fallback only), with no
> server-mediated collaboration path left in the codebase.

### Explicit non-goals

- **No bespoke collaboration backend.** Transport is the Vulos fabric; we do not
  ship a parallel WebSocket sync server.
- **No OT (operational transform).** CRDTs only — to match the OS sync model and
  guarantee offline convergence.
- **No global hosted document cloud.** Documents live on the user's own
  instances/buckets; there is no central service that routes or stores them —
  peers connect directly, P2P.
- **Not real-time co-editing inside the PDF annotator** in v1 — PDF collaboration
  is the signing flow (§ 3), not live canvas co-editing.

---

## 3. PDF Auto-Sign — E-Signature with Cryptographic Audit Trail

A DocuSign-style signing pillar built on the existing PDF canvas. Open a PDF,
**place signature / initial / date / text fields anywhere** on the document,
then send a **signing link** to one or more signers. Each signer opens the link
and signs (draw, type, or upload). Every completed signature **generates a
cryptographic token** and appends to a **tamper-evident audit trail** — who
signed, when, from where, and the document hash before and after. The result is
a sealed, verifiable PDF plus a completion certificate. Where possible, signer
identity ties to the **Vulos account**.

This pillar is **shipped** (see Now). The notes below record its scope.

### Goals

- Turn the PDF annotator into a real, multi-party signing workflow with legal-
  grade auditability — self-hosted, no third-party signing service.
- Make every signature cryptographically verifiable and every document
  tamper-evident: any post-sign modification must be detectable.
- Support real signing ceremonies — multiple signers, defined order, reminders,
  and a final completion certificate.
- Anchor identity in Vulos account when available; allow link-based
  signers when not.

### Concrete features

- **Field-placement editor:** drag signature, initial, date, name, and free-text
  fields onto any page/coordinate; assign each field to a named signer/role;
  mark required/optional.
- **Signing links:** generate a unique, scoped, expiring link per signer; link
  opens a focused signing view of only that signer's fields.
- **Signer experience:** draw / type / upload a signature; auto-fill date; fill
  assigned text fields; consent checkbox; submit.
- **Multi-signer & signing order:** sequential or parallel signing; the next
  signer is invited only when prior steps complete; status per signer.
- **Cryptographic token per signature:** on completion, hash the document and
  the signature event and sign it (Ed25519 server keypair / signer identity) to
  produce a verifiable token bound to the document hash.
- **Tamper-evident audit trail:** immutable, append-only, hash-chained log of
  every event (created, sent, viewed, signed, declined, voided, completed) with
  timestamp, IP/identity, document hash before/after, and the per-signature token.
- **Completion certificate:** a generated certificate page (and machine-readable
  manifest) summarizing all signers, tokens, hashes, and timestamps, embedded
  in / attached to the final sealed PDF.
- **Verification:** a checker (`POST /api/sign/verify` + `/verify` UI, with a
  public `GET /api/sign/pubkey` endpoint) that re-hashes a sealed PDF and
  validates each token + audit chain, flagging any tampering.
- **Identity binding:** prefer authenticated Vulos account identity;
  fall back to link + email/typed identity for external signers.

### Explicit non-goals

- **Not a hosted SaaS signing service.** It runs on the user's own instance; no
  documents leave the operator's control by default.
- **No qualified/eIDAS-QES smartcard or HSM signing** in v1 — we provide strong
  tamper-evidence and audit trails, not (yet) government-grade qualified
  signatures.
- **No paid identity-verification vendors** (ID-scan, KYC) in the OSS core.
- **Signing never requires any hosted service** — it runs entirely on a
  self-hosted instance; link/notification delivery is your own SMTP relay, not
  anything Vulos operates.

---

## 4. Chat, Calling & Meetings — third-party (not built by Vulos)

Team chat + Spaces and real-time voice/video calling + meetings were once planned
as an Ofisi pillar. Vulos no longer builds comms: chat and video are provided by
**established third-party open protocols/apps**:

- **Chat** — Matrix / Element (the Slack equivalent).
- **Video** — Element Call / Jitsi (the Google-Meet equivalent).

The **Vulos OS** is the shell that hosts the apps; it can link out to whatever
comms app the user runs, but Ofisi never embeds chat or video, and neither is a
first-party Vulos product. The Spaces code built in an earlier wave is retained
for history only.

---

## Storage backend & co-location (finalized 2026-05-24)

### Storage-backend choice

Ofisi stores documents, sheets, and slides in the same S3-compatible
object store as OS sync. The same two-backend choice applies:

- **Tigris (default):** Per-org bucket prefix on Vulos Tigris; managed, durable, replicated.
- **MinIO local (complete BYO):** Customer's own MinIO instance. Document data never touches
  Vulos storage. Same Go storage interface; only the endpoint + credentials differ.

The storage backend is set by the Vulos OS or control plane at provisioning time. `vulos-office`
does not select or provision the backend — it receives the endpoint and credentials as
configuration (consistent with the rest of the suite).

### Co-location on a single instance

Ofisi can run co-located with the OS on a single box, sharing one bucket
and one CRDT/peering fabric. The BYO single-box story — "one box = your whole Vulos" — requires
only one shared bucket endpoint. The meta-bundle installer (`BUNDLE-01`
in `vulos`) wires this up; no vulos-office code changes are needed.

### Identity

Ofisi uses the same Vulos account identity as the OS. There is no separate Ofisi
identity — the Vulos account (email + password / OAuth / passkey) is the single identity for
all surfaces. Collaboration sessions are keyed by the Vulos account; presence and CRDT sync
ride the same P2P peer fabric and identity as the rest of the OS.

---

## Bundling decision

**Ofisi ships with the suite; nothing about it is sold separately.** There are no
per-active-user pricing tiers and no "mail tier" — mail is an experimental **connector**
(bring your own Gmail/Outlook/IMAP), never a billed product. Vulos sells nothing: Ofisi
installs by default alongside the other suite apps, and self-hosting it on your own box
costs nothing.

---

## Mail connector (Ofisi is not involved)

Ofisi is not involved in mail at all — PIM is a separate **bring-your-own-mailbox
connector** (`lilmail`, exposing `/v1`) that logs into your existing IMAP/SMTP mailbox; the OS
surfaces Calendar/Contacts widgets over it. There is no hosted Vulos mail. Ofisi installs
alongside the rest of the suite regardless of whether the connector is configured. There
is no "Mail tier" gating Ofisi.
</content>
</invoke>
