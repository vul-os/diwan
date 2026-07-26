# Ofisi — How Collaboration Works

This chapter explains real-time collaboration in Ofisi end to end: how documents merge concurrent edits (CRDTs), how edits travel **peer-to-peer** with no central document server, what is and is not encrypted, how rooms are gated, and what happens on conflicts. It is written for users who want to understand what they're trusting, and for admins who need to know what their server can and cannot see. Everything here describes the actual implementation in this repository.

---

## 1. The one-minute model

- Collaboration in Ofisi is **always peer-to-peer**. There is **no central document server** — no server ever stores, relays, or reads your document's collaborative edits. This is the defining difference from server-mediated office suites (Collabora, OnlyOffice), where every keystroke passes through a document server.
- Every edit becomes a small **CRDT update**. CRDT updates are commutative and idempotent: peers can receive them in any order, more than once, over more than one channel, and still converge to the same document.
- The document you see is always your **local** copy, hydrated from your own saved content. Collaboration never blocks typing: if no peer is reachable, you keep editing locally and your changes autosave to your own storage.
- When you collaborate, edits ride an **end-to-end-encrypted peer-to-peer room**. Peers connect **directly** to each other over WebRTC; a relay is used only as a last-resort fallback for hard NATs, and even then it is **content-blind** (it moves ciphertext it cannot read).

| What travels | Where it goes | Who can read it |
|--------------|---------------|-----------------|
| Your document's collaborative edits | Directly between peers (WebRTC), E2E-encrypted | Only peers holding the invite key |
| Fallback when peers can't connect directly | A content-blind relay circuit (ciphertext only) | Nobody but the peers — the relay is blind |
| Peer discovery (rendezvous) | The host's signaling + ICE endpoints, **or** a configured self-hosted relayd (no host box needed — see §3) | Whichever one you use learns *that* peers share a room (a random id) — never content |
| Your own saved copy | Your own file storage (your box) | You (and whomever you grant account access) |

---

## 2. The CRDTs

All CRDT code lives in `src/lib/crdt/` (frontend).

- **Docs** — a **Yjs** document (`ydoc.js`). The ProseMirror/TipTap document is kept in lock-step with a `Y.XmlFragment` by y-prosemirror. Remote changes arrive as Yjs updates and become ProseMirror transactions with real positions — so **formatting and structure** (bold, headings, tables, lists, images, links) propagate correctly, and a remote change can never land at a wrong text offset. Yjs is a CRDT, so peers converge with **no central authority** — exactly what a serverless model requires.
- **Whiteboards** — a **Yjs** scene (`boardYdoc.js`): Excalidraw elements live one-per-id in a `Y.Map` so concurrent edits to *different* shapes merge cleanly, and image blobs in a second `Y.Map`. The whiteboard rides the **same** `yP2PSession` transport, the same E2E-encrypted room and the same content-blind relay fallback as Docs — there is **no** separate whiteboard/collab server. The session validates an untrusted peer's update through a fail-closed board validator (element/file ceilings + a raster-only image allow-list) instead of the ProseMirror one; the seam is a pluggable `applyUpdate` on the Y context.
- **Sheets grid** — a **last-writer-wins grid CRDT** (`grid.js`): concurrent writes to the *same cell* resolve to the later writer; writes to different cells merge cleanly. Charts, pivots, and conditional-formatting rules broadcast as their own ops.
- **Slides tree** — a **fractional-index tree CRDT** (`tree.js`) for slide/object ordering and object properties.
- **Comments and suggestions** have their own CRDTs (`comments.js`, `suggestions.js`).

**Ingress is fail-closed.** Every inbound update is untrusted (an invite link can be forwarded to anyone). It is decoded, applied to a **shadow document** first, converted to a ProseMirror document against the real schema, and checked (renderable? image/link clamps?) before it is allowed to touch the live document. A rejected update is dropped and counted; it never throws, never half-applies, and never reaches the renderer.

---

## 3. The transport — direct peer-to-peer first, content-blind relay only as fallback

Ofisi uses its own first-party `FabricClient` (`src/lib/collab/webrtc/fabric.js` — re-homed from the vendored relay-client SDK so Ofisi depends on no other Vulos product's package) to move CRDT updates between peers. Its connection strategy, in order:

1. **Direct WebRTC data channel (the default).** For each peer, the client negotiates an `RTCPeerConnection` and opens a data channel. Once connected (`connectionState === 'connected'`), edits flow **directly browser-to-browser** — nothing in the middle. NAT traversal uses **ICE/STUN** servers (and, when a peer pair needs it, **TURN** — a WebRTC-layer relay of already-encrypted traffic, still content-blind) from either the host's ICE endpoint or Ofisi's own configurable fallback (`VITE_STUN_URLS`/`VITE_TURN_*`, see [CONFIGURATION.md](CONFIGURATION.md)). Self-hosting your own TURN server (no other Vulos product required) is covered in [COTURN.md](COTURN.md).
2. **Content-blind relay circuit (fallback only).** If the direct connection *fails outright* — no ICE candidate pair works at all, TURN included, within a short timeout — the client falls back to a separate, application-level relay circuit built into `FabricClient` itself (HTTP deposit/pickup against the host box's `/api/peering/relay/*`, or a configured rendezvous relayd's mailbox surface). Payloads on this path are sealed with a per-session X25519 box, so the relay **routes ciphertext it cannot read**. This is the one fallback that does depend on a host box or a self-hosted `vulos-relayd` being present; it still never sees plaintext, and with a TURN server configured it should rarely trigger at all.

Both of the above need peer discovery: a place to exchange WebRTC offer/answer/ICE candidates, and ICE/STUN-TURN config. Ofisi picks **one of three transports** for that discovery, in this priority order (`src/lib/collab/transportSelection.js`, resolved fresh for every collab session):

1. **Host-box peering (`/api/peering/*`)** — this Ofisi server itself is fronted by a **Vulos OS / Ephor** deployment, which mounts:
   - Signaling: `wss://<host>/api/peering/stream` — exchanges offer/answer/ICE candidates.
   - ICE config: `GET /api/peering/ice` — returns the STUN/TURN servers to use.

   This is the original, unchanged default. It carries no document content, and it is the one transport that can bind an authenticated account session (an `authToken`) to the peer identity.

2. **Any relayd rendezvous (no Vulos OS / host box needed).** When host-box peering isn't reachable — most notably a **standalone** Ofisi binary, which mounts no `/api/peering/*` at all (see `main.go`) — Ofisi checks for a configured **rendezvous URL**: `config.yaml` `collab.rendezvous_url` / env `VULOS_RENDEZVOUS_URL` (see [CONFIGURATION.md](CONFIGURATION.md)). When set, the session uses that relayd's OPEN announce/resolve/signal/mailbox + ICE surface (`RendezvousClient` / `RendezvousSignalingClient`, part of Ofisi's first-party `src/lib/collab/webrtc/`) — any self-hosted `vulos-relayd` is enough, with **no Vulos OS and no account**. Everything else about the session is identical: direct WebRTC first, the same content-blind relay-circuit fallback, the same E2E crypto. **This is what makes a bare standalone Ofisi capable of real peer-to-peer collaboration** — and it is proven end to end, against a real relayd binary in a real browser, by `e2e-p2p/` (`npm run test:e2e:p2p`).

   **How the browser reaches it.** The browser calls the configured relayd's origin **directly**, cross-origin — Ofisi's server is not in the discovery path at all and never sees even the (already content-blind) rendezvous envelopes. What is in the loop is the relayd you chose, and nothing else. Stated plainly:

   - The **relayd** sees discovery metadata: a room's derived id, Ed25519 addresses, timing, sizes, IPs. Metadata only, and only the relay's.
   - It is **content-blind**: every signal/mailbox payload is sealed under the room key, which lives in the invite link's URL fragment and reaches no server.
   - Live document edits never traverse it. This is **discovery only**; edits ride the WebRTC data channel (or the content-blind relay circuit).
   - Still no Vulos OS, no account, no host box.

   This works because relayd's rendezvous role serves **CORS** (`Access-Control-Allow-Origin: *` on reads, a preflight that answers `POST` + `Content-Type`, and — deliberately — **never** `Allow-Credentials`, since the protocol authenticates with Ed25519 signatures in the body rather than with ambient cookies). `e2e-p2p/` asserts that posture against a real relayd *and* from a real browser on a different origin, so a relay that regressed it fails the suite instead of the field.

   Two operator consequences: the relay must be reachable from wherever users load Ofisi, and an **https** page cannot call an **http** relay — a public deployment needs TLS on the relay.

   > **History.** Until Ephor shipped CORS on the rendezvous role, its surface sent no CORS headers and answered the preflight with `405`, so a direct call was impossible in a browser. Ofisi carried a same-origin pass-through proxy at `/api/rendezvous/*` as a workaround. That proxy — and the `rendezvous_proxy_path` field it was advertised through — has been **removed**; the server-side of discovery is now nothing at all.

3. **Local-only.** Neither of the above is reachable (or reaches a network at all): peers cannot discover each other, so collaboration stays **local-only** (you keep editing; your work autosaves) and the UI says so honestly — an "Offline" pill and a plain explanation in the share dialog, never a false "Live".

Self-hosting either surface — the host-box peering endpoints, or a standalone `vulos-relayd` for its rendezvous surface — is enough to get direct P2P working for your own users; both store nothing and read nothing.

---

## 4. E2E-encrypted rooms ("Collaborate via link")

Collaboration is entered by sharing an **invite link**. Implementation: `src/lib/crdt/p2pRoom.js` (crypto), `src/lib/crdt/yP2PSession.js` (the Yjs document over the room), `src/apps/docs/useP2PCollab.js` + `P2PShareModal` (Docs UI).

### Room creation and invites

- Sharing mints a random **32-byte room key**.
- The invite payload (version, room id, capability, room key) is base64url-encoded into the **URL fragment**: `…/docs/collab#vp2p=<payload>`. Fragments are never sent in HTTP requests, so **no server ever receives the key**.
- Two links are minted from the *same* key: a **read-write** link (`cap=rw`) and a **read-only** link (`cap=ro`).

### Key derivation and framing

From the single room key, HKDF-SHA256 (WebCrypto, no third-party crypto JS) derives three independent values:

| Derived value | Held by | Purpose |
|---------------|---------|---------|
| `encKey` | rw + ro peers | AES-256-GCM content key — seals every update/presence frame |
| `macKeyRw` | **rw peers only** | HMAC proving read-write authority on document frames |
| `roomId` | everyone incl. relay | Non-secret rendezvous id |

Every frame on the wire is `magic "VP2P1" ‖ flags ‖ 12-byte fresh nonce ‖ AES-256-GCM(ciphertext‖tag)`, with authenticated associated data. The fabric session id is the derived `roomId` — **knowing the roomId admits nothing**; without `encKey` you cannot produce or read a single valid frame.

### What this guarantees (and what it doesn't)

Encrypted: document updates, snapshots (state-vector deltas), and presence frames. The relay and the host are **content-blind**.

- **The link is the key.** Anyone who obtains a link — from a chat log, a forwarded email, a shoulder-surf — has full access at that link's capability. There is no per-person identity inside the room. Treat rw links like passwords.
- **Revocation = rotation.** "Rotate" mints a brand-new room + key and re-shares; old links go dead. There is no finer-grained revocation.
- **Read-only is enforced cryptographically.** ro sessions never receive `macKeyRw` (it is stripped before the session is constructed), so an ro peer's update frames carry no RW MAC and rw peers reject them. An ro peer *can* decrypt content (it holds `encKey`) — read-only means "cannot write", not "cannot read".
- **Not hidden:** the fact that *some* peers share a room (the discovery service sees `roomId`, peer count, timing, IPs). This is metadata, not content.
- A malformed or tampered invite **fails closed**: the join throws, the editor logs `[p2p] join from link failed: …`, and stays in local mode.
- **Persistence is yours.** The room stores nothing anywhere central. Each participant's own copy autosaves through their normal document save path (to their own storage); a browser-local snapshot aids offline recovery.

---

## 5. The life of an edit

1. **Keystroke** — the editor updates instantly; the change becomes a Yjs update. Read-only sessions stop here (they produce no authoritative updates).
2. **Seal + send** — the update is sealed (AES-256-GCM, fresh nonce) and sent over the room: directly to each connected peer's WebRTC data channel, or over the content-blind relay circuit if direct failed.
3. **Apply** — receiving peers run the update through the fail-closed ingress (shadow-apply → validate → live-apply). Duplicates are no-ops (Yjs dedups by `(client, clock)`).
4. **Late joiners & reconnects** — on join (and after any reconnect) a peer sends its **state vector**; peers answer with exactly the delta it lacks. Two peers who both edited offline both keep their edits — a union merge, never "whoever has more wins".
5. **Presence** — cursor moves are coalesced (~120 ms); a roster entry not heard from for ~15 s is dropped (that's how a crashed tab disappears). Presence rides the same E2E room; it is never persisted.
6. **Autosave** — independently, your own copy autosaves to your storage with a crash-safe IndexedDB draft, and every save leaves a restorable version snapshot.

### A worked example

Alice (rw) shares a `#vp2p=` link with Bob (rw); Carol opens the ro link.

- Alice types "risks" into paragraph 2 while Bob deletes a sentence in paragraph 4 — both see their own change instantly, and each other's within a WebRTC round-trip. Yjs keeps both; no dialog, no lock.
- Carol's caret is visible (presence), but her write frames carry no RW MAC, so Alice and Bob discard them — she reads live, cannot write.
- Bob's laptop sleeps. Alice keeps editing. Bob wakes 10 minutes later: his session reconnects and sends its state vector; Alice's peer answers with exactly the edits he missed. Both converge — with no server involved.

---

## 6. Conflict behavior

**Live collaboration:** no locking, no "someone else is editing" dialogs. Concurrent edits merge via Yjs; both sides' edits survive. In Sheets, two simultaneous writes to the *same cell* resolve last-writer-wins; different cells always both apply.

**Duplicate delivery:** an update arriving over both a direct channel and the relay applies once — dedup by `(client, clock)`.

**Offline divergence:** each side keeps editing locally; on reconnect the state-vector exchange fetches exactly what each side missed and converges. Nothing is discarded.

**Whole-document saves (revision CAS):** independent of live collab, every file save carries the revision it was based on. A stale save gets `409 Conflict` with the current copy instead of clobbering it — the client reconciles and retries. This protects the "two devices, no live session" case.

**CRDT update log (opt-in — `persistence.updatelog`):** the revision-CAS model above is last-writer-wins for the *blob*: the two-devices case still forces one side to reconcile. The update log removes that by making durability itself CRDT-native. When enabled, the server exposes a per-file **append-only log** (`GET`/`POST /api/files/:id/updates`): the client appends each debounced edit as an opaque CRDT frame (the server never reads it) with a monotonic seq, and periodically posts a compacting **snapshot** (the whole state + a `floor` seq) so the server prunes the frames the snapshot subsumes while keeping any frame *above* the floor. On open, the client replays snapshot + missing frames. Because the frames are commutative + idempotent CRDT updates, two devices that both edited **offline** converge **byte-identically** with nothing discarded — no `409`, no reconcile. It is **additive/dual-write**: the whole-document autosave keeps running alongside it, so the flag can be turned on or off without ever losing a document.

All four editors are wired: **Docs** and **Whiteboard** are plain Y.Docs and use the Yjs `UpdateLogSync` (frames are base64 Yjs updates); **Sheets** (LWW grid) and **Slides** (fractional tree) are op-based CRDTs and use `OpLogSync`, which carries their discrete ops as frames and the compacted state as snapshot frames — the same offline-converge guarantee, proven by convergence tests per surface. The store backend follows `storage.type` (local/S3 → filesystem `data/updates/<id>/`; postgres → `office.file_updates` + `office.file_update_snapshots`), frame appends are storage-quota metered, and server-side compaction is **advisory only** (the server nudges a client to snapshot once the un-compacted tail is large — it cannot merge opaque frames itself). See [CONFIGURATION.md](CONFIGURATION.md) and `backend/updatelog/`.

**Undo:** undo operates on your own edits (the Yjs UndoManager is user-scoped); a remote peer's edit is not undone by your `Mod+Z`.

**Version history as the backstop:** every save produces restorable version snapshots with diffs, so even a semantically-wrong merge is recoverable by a human.

---

## 7. Access control — admin summary

- **Account sharing (the ACL)** — `backend/fileacl/`: roles `viewer` < `commenter` < `editor`, plus `owner`. Grants are owner-gated server-side, land in the append-only **audit log**, and no-access responses are `404` to avoid existence leaks. Read-only **share links** (256-bit token, optional bcrypt-hashed password, expiry capped at one year) reach *only* the anonymous read path. This governs who may open the document from **your storage** — it does **not** put a server in the live-collaboration path.
- **Live collaboration** — possession of the invite fragment. The host cannot enumerate, join, or read rooms; it also cannot audit their content. If your compliance posture requires all collaboration to be server-auditable, note that Ofisi's collaboration is deliberately end-to-end and peer-to-peer — auditing happens at the account-save and version-history layer, not in the wire.
- **Peer discovery** is available where either a host provides the peering fabric (Vulos OS / Ephor) **or** this deployment has a rendezvous URL configured (§3) — a self-hosted `vulos-relayd` with no Vulos OS or account. Neither present ⇒ no live P2P, automatically — the editor stays local-only.

---

## 8. Presence and cursors

- The presence bar shows everyone in the room (avatar stack + roster); remote carets/selections render in the text with per-user colors.
- Presence rides the E2E-encrypted room like everything else — the host does not learn who is in a room.
- Presence is ephemeral: it is never persisted anywhere.

---

## 9. Verifying it yourself (admins)

You can confirm the serverless property from the outside:

```bash
# 0. Or just run the proof: a real relayd + two standalone Ofisi servers +
#    two browsers, asserting convergence, the transport used, and that an
#    unconfigured deployment stays honestly local-only.
npm run test:e2e:p2p

# 1. There is NO server-mediated collab endpoint. These must 404:
curl -i "https://office.example.org/v1/documents/<id>/collab/stream"   # expect 404
curl -i "https://office.example.org/v1/documents/<id>/collab/ops"      # expect 404

# 2. Is the peering fabric present? (host-provided, not the Ofisi binary)
curl -i "https://office.example.org/api/peering/ice"   # 404 ⇒ standalone, no host-box discovery

# 3. Is a rendezvous URL configured instead (no host box needed)?
curl -i "https://office.example.org/api/reachability"  # rendezvous_url: "" ⇒ not configured (local-only)

# 4. When one IS configured, the browser calls that relayd DIRECTLY (§3), so
#    check the RELAY — Ofisi mounts nothing for discovery (this 404s by design):
curl -i "https://office.example.org/api/rendezvous/healthz"   # expect 404
curl -i "https://relay.example.org/rendezvous/healthz"        # {"role":"rendezvous"}
# …and that a browser on Ofisi's origin may call it (the CORS guarantee §3):
curl -i -H "Origin: https://office.example.org" "https://relay.example.org/rendezvous/ice"
#   expect: Access-Control-Allow-Origin: *   and NO Access-Control-Allow-Credentials
```

In the browser, DevTools → Network shows the truth: opening a `#vp2p=` link opens either a **WebSocket to `/api/peering/stream`** (host-box discovery) or cross-origin requests straight to the configured rendezvous URL (relayd discovery) — discovery only in both cases — and then a **WebRTC data channel** — and **no `collab/*` request ever appears**, because there is no document server to call. The document bytes travel inside the encrypted data channel, not any HTTP request.

---

## 10. Frequently asked questions

**Does my document ever touch a central server during collaboration?** No. Collaborative edits travel peer-to-peer, end-to-end-encrypted. The only server role is content-blind peer discovery (a rendezvous id and ICE config). Your saved copy lives in *your* storage.

**Can the admin read what we're editing live?** No — frames are AES-256-GCM sealed under a key that only exists in invite links (URL fragments never reach the server). The admin *can* see that a room exists (its derived id, peer count, timing, IPs) if the discovery service and relay are theirs.

**Can the admin read my saved document?** They can read what your storage holds, gated by the account ACL — that is ordinary file access, not collaboration. Collaboration itself is content-blind.

**Why is read-only "enforcement" if ro users can still read?** ro peers hold the decryption key but not the RW MAC key, so their write frames are unauthenticated and rw peers discard them. Read-only means "cannot write".

**Is there a maximum number of collaborators?** No explicit cap in the collab code; the practical bound is WebRTC mesh fan-out (each peer connects to the others) and your discovery/relay capacity.

**Does collaboration work across two different Ofisi servers?** Yes, as long as the peers can reach the same discovery surface — either both point at the same host-box peering fabric, or both resolve the same rendezvous URL — collaboration is between *browsers*, not servers. The document does not live on either server for the purpose of the live session.

**Does live P2P collaboration require a Vulos OS or a Vulos account?** No. A configured rendezvous URL (config.yaml `collab.rendezvous_url` / `VULOS_RENDEZVOUS_URL`, see [CONFIGURATION.md](CONFIGURATION.md)) gets a bare standalone Ofisi real peer-to-peer collaboration against any self-hosted `vulos-relayd` — no Vulos OS, no account. The standalone binary does carry the *discovery* traffic on its own origin (§3), because the relay serves no CORS; it stays content-blind, and the document never touches it. This is not a claim on paper: `npm run test:e2e:p2p` boots a real relayd and two standalone servers and makes two browsers converge through them.

**What happens with no network at all?** You keep editing; the CRDT applies locally and an IndexedDB draft protects your work. It syncs to peers when you reconnect, and autosaves to your storage.

---

## 11. What is stored where

| State | Location | Lifetime |
|-------|----------|----------|
| The document itself | **Your** file storage (`data/<id>.json` or Postgres schema `office`) | Until deleted; every save also snapshots into version history |
| Live collaboration edits | **Nowhere central** — only in the peers' browsers, in transit E2E-encrypted | The session; the host holds nothing |
| Presence (who's here, cursors) | In the peers' browsers only | Seconds — never written anywhere |
| Room recovery snapshot | Participant's browser `localStorage` | Per-browser; the server holds nothing for the room |
| Crash-safety drafts | Browser IndexedDB (`vulos-office-drafts`) | Until the next successful save |

Consequences: server backups capture your saved documents and version history; they never capture live collaboration traffic (there is nothing to capture). Clearing a browser's site data erases drafts and local snapshots but never the saved document.

---

## 12. Glossary

- **CRDT** — Conflict-free Replicated Data Type: a data structure whose operations commute, so replicas converge without coordination or locks.
- **Yjs** — the CRDT library backing the Docs document; carries structure and formatting, not just text.
- **Update** — one atomic Yjs change, carried as an envelope `{ y:1, u:<base64> }`.
- **Fabric** — Ofisi's own first-party peering transport (`src/lib/collab/webrtc/fabric.js`, re-homed from the vendored relay-client SDK): direct WebRTC first (with STUN, and optionally a self-hosted TURN server — see [COTURN.md](COTURN.md)), content-blind relay fallback, discovery via either the host box's `/api/peering/*` or a configured relayd's open rendezvous surface (see §3).
- **Rendezvous URL** — `config.yaml` `collab.rendezvous_url` / `VULOS_RENDEZVOUS_URL`: the base URL of a self-hosted `vulos-relayd`'s open rendezvous surface, letting a standalone Ofisi (no host box, no account) still discover peers. The browser calls that relayd **directly**, cross-origin — Ofisi's server is not in the discovery path — see §3 for what the relay does and does not see, and for the CORS/TLS requirements that puts on it.
- **Room** — an E2E-encrypted collaboration session identified by a key-derived `roomId`; membership = possession of the invite key.
- **Capability (`rw`/`ro`)** — what an invite link grants; `rw` links carry MAC authority to write, `ro` links can only decrypt.
- **Rotation** — minting a fresh room + key to revoke all previously shared links.
- **STUN / TURN** — NAT-traversal helpers; STUN discovers your public address for a direct connection, TURN relays (content-blind here) when direct fails. Configurable via `VITE_STUN_URLS`/`VITE_TURN_*` (see [CONFIGURATION.md](CONFIGURATION.md)); self-hosting your own TURN server is covered in [COTURN.md](COTURN.md).

---

## 13. Quick reference — "what can the server see?"

| You did… | Live path | Server can read live edits? |
|----------|-----------|-----------------------------|
| Clicked *Collaborate via link* / opened a `#vp2p=` link, peers connect directly | Direct WebRTC, E2E | **No** — content-blind, and no server is even in the path |
| Same, but a peer pair can't hole-punch | Content-blind relay fallback, E2E | **No** — the relay routes ciphertext |
| No peering fabric on the host and no rendezvous URL configured (bare standalone) | Local-only (autosave) | n/a — nothing is sent |
| No peering fabric on the host, but a rendezvous URL is configured | Direct WebRTC via a self-hosted relayd, E2E (fallback: content-blind relay) | **No** — same content-blind guarantee, no host box or account involved |
| Created a read-only share link | Anonymous read endpoint | Yes (it serves your saved copy) |
| No network at all | Local CRDT + IndexedDB draft | n/a — syncs when back |

For symptoms and fixes (peers not connecting, docs not syncing), see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
