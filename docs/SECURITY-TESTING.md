# Security Testing — Diwan

This document describes the **pentest / adversarial test suite** for the
`diwan` backend (Go) and the document/slide HTML render path (JSX/vitest).

> Diwan is the documents-only product. Chat and video are third-party
> (Matrix/Element; Element Call / Jitsi), not Vulos products; this document covers
> only Diwan's own attack surface.

The suites are written attacker-first: every test **attempts a concrete attack
and asserts it is blocked**. A green run means the corresponding defense holds.
If one of these tests ever goes red, treat it as a **live vulnerability**, not a
flaky test.

## How to run

Go (backend) pentests:

```bash
cd diwan

# Run only the pentest suites (verbose):
CGO_ENABLED=0 go test ./backend/... -run 'Pentest' -v

# Or the whole backend test suite (includes pentests + unit tests):
CGO_ENABLED=0 go build ./... && CGO_ENABLED=0 go vet ./... && CGO_ENABLED=0 go test ./...
```

Frontend (HTML render / sanitiser) pentest:

```bash
cd diwan
npx vitest run src/apps/slides/sanitize.test.js
# or the full vitest suite:
npm test
```

## Where the tests live

| File | Layer | Attack classes |
|------|-------|----------------|
| `backend/middleware/pentest_token_test.go` | Auth middleware | 1 (auth/token), 2 (identity at middleware) |
| `backend/handlers/pentest_files_test.go` | File handlers | 2 (identity spoof), 3 (file IDOR), 6 (CSRF/ambient authority) |
| `backend/handlers/pentest_authorid_test.go` | Comment/author binding | 2 (author-id forgery) |
| `backend/handlers/pentest_envelopes_test.go` | Signing envelopes | 3 (envelope/signer authz) |
| `backend/handlers/pentest_localfiles_test.go` | Local-file serve | 3 (path traversal) |
| `backend/handlers/pentest_creds_test.go` | Auth/creds | 5 (per-user credentials) |
| `backend/handlers/pentest_helpers_test.go` / `pentest_storage_test.go` | test harness | (support) |
| `backend/handlers/sharelink_sec_test.go` | Share-link view route | 3 (write escalation from a token), 7 (brute force / existence oracle) |
| `backend/handlers/sharelink_token_once_test.go` | Share-link management API | 7 (credential-at-rest: no endpoint may re-emit a link token) |
| `backend/storage/local_sharelinks_hash_test.go` / `postgres_sharelinks_test.go` | Share-link persistence | 7 (credential-at-rest: no backend may store a token in the clear) |
| `src/apps/slides/sanitize.test.js` | JSX render path | 4 (XSS) |

These build on (and do not replace) the pre-existing focused tests:
`backend/middleware/auth_test.go`, `backend/handlers/files_authz_test.go`,
`backend/handlers/auth_creds_test.go`, and `src/apps/slides/sanitize.test.js`.

## Threat coverage (attack classes)

### 1. Auth / token forgery (`pentest_token_test.go`)
- Forged JWT signed with the **wrong secret** → 401.
- **alg=none** (unsigned) token → 401 (alg-confusion blocked).
- **RS256** token presented to an HS256 verifier → 401 (the middleware pins the
  signing method to `*SigningMethodHMAC`).
- **Expired** token (validly signed) → 401.
- **Tampered** payload (signature no longer matches) → 401.
- **Missing** token on a protected route → 401.
- Garbage bearer value → 401.
- **Dev-secret gating**: the well-known dev key is rejected while a real secret
  is configured; with **no secret and dev mode off** the verifier **fails closed
  (503)** — it never silently accepts the dev key.

### 2. Identity spoofing (`pentest_token_test.go`, `pentest_files_test.go`, `pentest_authorid_test.go`)
- A forged `X-Account-ID` header does **not** change the acting identity for a
  non-admin; identity is taken only from the verified JWT `sub`.
- Admin impersonation via `X-Account-ID` is gated on the **verified admin
  scope** (`vulos:admin` audience), not on header presence.
- A forged author id on a comment/reply is rejected — authorship is bound to the
  verified identity, not the request body.

### 3. File IDOR / ACL (`pentest_files_test.go`, `pentest_envelopes_test.go`, `pentest_localfiles_test.go`)
The per-file ACL (`backend/fileacl`) is enforced by **every** file-scoped
handler, all sharing the process-wide `SharedFileAuthz`. The pentests prove a
non-owner cannot pivot from a denied `GET /files/:id` to an open sibling endpoint:
- Non-owner Get/Update/Delete/**export**/**comment**/**version** → **404**
  (no existence leak — denial mimics "not found").
- `List` returns only the caller's accessible files (no cross-tenant leak).
- An explicit **share** grants the grantee access across the secondary handlers;
  a non-shared **third party is still denied**.
- A non-owner **cannot self-share** the victim's file to gain access.
- Admins bypass the ACL (by design).
- Signing-envelope and signer endpoints are scoped to the document owner / the
  scoped signer token; the local-file serve path rejects `..` traversal.

### 4. XSS (`src/apps/slides/sanitize.test.js`)
Exercises the document/slide HTML render pipeline (DOMPurify `sanitize()` →
`dangerouslySetInnerHTML`) with hostile content (`<script>`, `<img onerror>`,
`<svg onload>`, `<iframe>`, `javascript:` / `vbscript:` URLs, autofocus/ontoggle
handlers). Assertions are **DOM-level**: no executable element survives and no
element carries an `on*` handler or a `javascript:`/`vbscript:` URL attribute.

### 5. Per-user credentials (`pentest_creds_test.go`, plus `auth_creds_test.go`)
- Once a user is registered, the legacy **shared password** can no longer
  authenticate that account (self-asserted-identity hole stays closed).
- Wrong password → rejected.
- **No user-enumeration oracle**: an unknown account and a wrong password return
  the same `ErrInvalidCredential`; the store also runs a dummy bcrypt compare to
  keep timing roughly constant.
- Empty password never authenticates.
- Registration validation: duplicate registration is rejected (no account
  takeover); passwords shorter than 8 chars are rejected.

### 6. CSRF / method (`pentest_files_test.go`)
The office API is **bearer/JWT-driven**: every handler trusts only the
context identity derived from the verified token (`Authorization: Bearer` or an
explicit token). A cross-site request cannot attach the `Authorization` header,
so **classic CSRF is N/A** for the bearer path. The session **cookie** path is
mitigated with `HttpOnly` + `SameSite=Lax` (see `backend/handlers/auth.go`
`Login`), and the token is never returned in the response body. The pentest
proves there is **no ambient authority**: a state-changing request that carries
no verified token (and only a forged `X-Account-ID`) is attributed to the local
`self` identity, **never** to an attacker-named account.

### 7. Credentials at rest (`sharelink_token_once_test.go`, `local_sharelinks_hash_test.go`, `postgres_sharelinks_test.go`)

A share-link token is a bearer capability: possession is access. It was stored
**in the clear** — as the filename and a `token` field in
`data/sharelinks/<token>.json`, and in `share_links.token` on Postgres — so
read access to the store was read access to every document those links pointed
at. `backend/invites` had the right shape all along (SHA-256 of the raw token,
raw shown once at mint); share links now match it.

The suites above assert the negative space directly: that the plaintext is
absent from the bytes on disk and from the database column, that no read path
on any backend can return a token, that the management endpoint emits no
`token` key at all, and that presenting the stored hash to the view route does
not open the document. Records written by the previous release convert in place
on first use, and there are tests for that too — an existing link that stopped
working would be as much a defect as a leaked one.

## Findings

One finding, fixed: share-link tokens were stored in plaintext (see class 7
above). Everything else in this suite was already blocked when the tests were
written. If you add a new file-scoped, signer-scoped, or admin-scoped endpoint,
extend the relevant pentest suite with a negative test before shipping — and if
you add a new bearer credential, store its hash, not it.
