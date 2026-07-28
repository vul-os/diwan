# Threat Model — Diwan

STRIDE pass. Last updated: 2026-06-26.

> **Scope:** Diwan is the **documents-only** product (Docs, Sheets, Slides,
> PDF/Signing). Calendar/Contacts come from the bring-your-own-mailbox PIM connector
> (lilmail, CalDAV/CardDAV), and chat/video are third-party (Matrix/Element; Element
> Call / Jitsi) — those surfaces are out of scope here.

---

## Scope and Trust Boundaries

```
[Browser clients (multiple users)]
        |
        v (HTTPS, authenticated session)
[Backend API (Go handlers)]
        |             |
        v             v
[CRDT fabric]  [PDF signing]
        |
        v
[Storage (SQLite + blob)]
```

Trust boundaries:
- **Browser ↔ Backend API**: authenticated session. Browser input is untrusted.
- **Backend API ↔ Storage**: server-internal; storage is private to the backend process.
- **PDF signing**: signing key is held server-side; signing operation is privileged.

---

## Component 1: CRDT Fabric

### Trust boundaries
- CRDT operations are submitted by authenticated clients.
- The merge engine applies operations from all participants; each participant's operations are trusted within their session scope.
- A malicious or buggy client can submit valid-looking but semantically destructive operations.

### Top 3 STRIDE threats

| # | Category | Threat |
|---|----------|--------|
| 1 | **Tampering** | A client submits a large number of CRDT operations in rapid succession, causing unbounded memory growth in the merge engine (algorithmic DoS). |
| 2 | **Tampering** | Crafted CRDT operation vector clocks with forged peer IDs allow a client to replay or suppress another client's edits. |
| 3 | **Information Disclosure** | Deleted CRDT operations (tombstones) retain original content in the operation log; a user who should no longer have access can reconstruct deleted data. |

### Mitigations in code
- Per-session operation rate limiting in `crdt/` handlers.
- Peer IDs in operations are derived from the authenticated session, not supplied by the client.
- Document compaction (tombstone GC) implemented in `crdt/` to prune old operation history.

### Residual risks
- Compaction is manual / scheduled; tombstone data persists until GC runs.
- CRDT convergence proofs for custom document types are informal; corner-case divergence is possible.

---

## Component 2: PDF Auto-Sign

### Trust boundaries
- Signing key stored server-side; accessible only to the signing handler.
- Client supplies the document to be signed; document content is untrusted.
- Signed output is written to blob storage and returned to the client.

### Top 3 STRIDE threats

| # | Category | Threat |
|---|----------|--------|
| 1 | **Tampering** | Maliciously crafted PDF (e.g. with incremental update or JavaScript) causes the signing library to sign unexpected content or execute code during parsing. |
| 2 | **Repudiation** | No audit log of which user triggered signing of which document; disputes about authorised signatures cannot be resolved. |
| 3 | **Elevation of Privilege** | Path traversal in the document input path allows an attacker to sign arbitrary server-side files. |

### Mitigations in code
- PDF parsed and re-serialised to a clean PDF/A-like structure before signing, stripping JavaScript and incremental updates.
- Signing audit log records: document hash, signing user, timestamp, and resulting signature ID.
- Document input resolved under `UPLOAD_ROOT`; `..` traversal rejected.

### Residual risks
- PDF re-serialisation completeness depends on library coverage; novel PDF attack surfaces may not be normalised.
- Signing key rotation process is manual; no automated key expiry enforcement.

---

## Overall Residual Risks

1. PDF re-serialisation provides best-effort normalisation; novel PDF attack vectors may survive.
2. CRDT tombstone data retention until GC creates a window where deleted content is recoverable.
3. Signing key rotation is manual; long-lived keys increase blast radius of a key compromise.
