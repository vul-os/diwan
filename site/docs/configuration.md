# Diwan — Configuration Reference

All runtime configuration for Diwan is driven by `config.yaml` and environment variables. Environment variables take precedence over the config file.

By default the server looks for `config.yaml` in the process's current working directory. Override the path with `-config` (also accepted as `--config`; Go's flag parser treats both the same), e.g.:

```sh
diwan -config /etc/diwan/config.yaml
```

Diwan never refuses to start over a config problem — this is deliberate for a zero-config first run, but means a typo'd `-config` path fails silently:

- **Missing file** (wrong path, typo): silently falls back to built-in defaults — no error, no log line. If a setting doesn't seem to be taking effect, double-check the path first (e.g. `ls -la <path>`).
- **File present but invalid YAML**: falls back to defaults AND logs `Config error: … — using defaults` on boot.

The `migrate` subcommand (`diwan migrate up|status`) takes its own `-config` flag, defaulting the same way; it is a separate flag set from the server command, so pass it after `migrate`: `diwan migrate -config /etc/diwan/config.yaml up`.

---

## config.yaml

```yaml
server:
  addr: ":8080"            # Listen address (default :8080)
  data_dir: "./data"       # Root directory for SQLite stores, JSON file store
  uploads_dir: "./uploads" # Uploaded file staging area

auth:
  enabled: false           # true = require password login; false = open access (local dev)
  password: "changeme"     # Shared password (single-user mode / migration source)
  max_attempts: 5          # Failed logins before lockout
  lockout_minutes: 15      # Lockout duration
  session_hours: 24        # JWT session expiry

storage:
  type: "local"            # "local" (JSON files) or "postgres"
  postgres:                # Only used when type: "postgres"
    host: "localhost"
    port: 5432
    user: "postgres"
    password: ""
    database: "diwan"
    sslmode: "disable"

persistence:
  updatelog: false         # CRDT-native persistence (see below)

collab:
  rendezvous_url: ""       # Self-hosted relayd for OS-free P2P collab (see below)
```

### `persistence.updatelog` — the CRDT update log

Off by default. When `true`, Diwan exposes the per-file **append-only CRDT
update log** (`POST`/`GET /api/files/:id/updates`) — the durability
model that supersedes "single blob + 409 compare-and-swap". Every CRDT frame is
kept (opaque, encrypted-or-plain Yjs / sheet / slide updates), so two clients
that edited **offline** both converge with nothing discarded. It is **additive**:
the whole-document PUT keeps working and the frontend dual-writes, so toggling
this flag never loses a document.

**Store backend** follows `storage.type` automatically — no separate setting:

| `storage.type` | Update-log backend | Where frames live |
|----------------|--------------------|-------------------|
| `local` (default) | filesystem `LocalStore` | `<data_dir>/updates/<id>/` |
| `s3` | filesystem `LocalStore` (fallback) | `<data_dir>/updates/<id>/` |
| `postgres` | `PostgresStore` (shares the storage pool) | `office.file_updates` + `office.file_update_snapshots` |

The Postgres backend derives its monotonic per-file seq under a
transaction-scoped **per-file advisory lock** and runs snapshot-upsert + frame
prune in one transaction. (S3 has no atomic append-with-monotonic-seq primitive,
so its durable frame log stays on local disk; the whole-doc PUT still writes the
object copy to the bucket.)

**Quota**: a frame append passes the **same storage-quota gate** as a whole-doc
PUT, so the log cannot be used to bypass a storage cap (standalone/unlimited →
no-op).

**Compaction** is client-driven; the server can only *nudge*. It cannot fold
opaque CRDT frames into a snapshot itself, so when a file's un-compacted tail
grows past `updatelog.CompactAdviseThreshold` (default 600) the append response
returns `compact: true` and the client posts a snapshot. There is no server
setting to tune here.

The frontend only mirrors edits into the log when built with
`VITE_UPDATE_LOG=on` (Docs, Whiteboard, Sheets, and Slides are all wired);
without it the server routes still exist but the client keeps using
whole-document autosave (and self-disables the log path cleanly if the endpoint
is absent). Enable both together.

---

### `VITE_SUBSTRATE_SYNC` — run Sheets on the shared substrate engine

**On by default.** Frontend build flag only; there is no server setting.

Diwan's Sheets grid ships two interchangeable CRDT implementations:

* **on (default)** — `src/lib/crdt/substrateGrid.js`, an LWW
  register per `substrate/SYNC.md` §4.4 (the spec lives in the `kotva` repo; it
  is not linked relatively, because building Diwan must never require a sibling
  checkout) computed by the **shared** KOTVA Sync engine — the published npm
  package [`@vul-os/kotva-sync`](https://www.npmjs.com/package/@vul-os/kotva-sync),
  the same compiled core a Rust server runs, rather than a second implementation
  of the same spec. It was vendored under `third_party/` until the substrate was
  published; it is an ordinary pinned dependency now, and
  `src/lib/crdt/__tests__/substratePackageProvenance.test.js` pins both the
  lockfile's sha512 for the tarball and the SHA-256 of every installed file.
  `src/lib/crdt/kotvaSync.js` is the loader — the package is a wasm-pack
  *bundler* build whose entry point cannot be imported under Vitest, so that file
  instantiates the WebAssembly directly; it re-uses the published wrappers and
  `.wasm` byte-for-byte and re-implements no algebra.
* **`VITE_SUBSTRATE_SYNC=off`** — `src/lib/crdt/grid.js`, the hand-rolled LWW
  map Diwan shipped before the substrate existed. Still supported as a
  deployment-wide choice; it is a second implementation of the same idea, so two
  replicas on it converge because that one implementation is self-consistent
  rather than because they run the shared, vector-pinned algebra.

Storage and transport are identical on both paths: the same `OpLogSync`
adapter, the same server update log, the same fabric wire types. Only the merge
algebra differs.

**This must be uniform across a deployment.** The two engines are each
convergent but do not share a total order — `grid.js` resolves a conflicting
write by `(lamport counter, replicaId)` and ignores wall-clock time, while the
substrate uses a full HLC `(wall, counter, author)`. For two concurrent writes
to one cell they can pick different winners, so a build-time flag (rather than a
per-user rollout) is what keeps every replica on one engine.

**Cost.** The engine is WASM and loads by dynamic import, so first opening a
spreadsheet fetches ~23 kB of JS (5.7 kB gzipped) and a 402.0 kB WebAssembly
module (159.6 kB gzipped), once. Building with the flag **off** downloads
**nothing** extra.

**If that load fails**, the editor does *not* quietly switch algebra. For a
session that can replicate — a collaboration fabric is attached, or the update
log is on — it stays **local-only for that session**: the grid still opens,
edits, and autosaves the whole document, but no CRDT op is sent or applied.
Falling back to `grid.js` there would risk permanent, invisible divergence from
peers whose load succeeded (see the total-order note above), which is a worse
outcome than a visible loss of live collaboration. Only when nothing can
replicate (no peers, no update log) does it use `grid.js`.

One known case where the load always fails: the **CommonJS** artifact of the
library build. Bundlers replace `import.meta` with `{}` there, so the loader
cannot locate the `.wasm`. A CJS consumer therefore gets a single-user grid; use
the ESM build for collaboration.

Docs and Whiteboard are **not** affected: they use Yjs for rich text, which the
substrate's algebra does not model. Slides is not affected either — see
`src/lib/crdt/__tests__/substrateTree.mapping.test.js` for exactly how far the
substrate's movable tree reproduces it and what remains.

---

### `collab.builtin_rendezvous` — peer discovery served by this binary (default: **on**)

Diwan's backend never mediates live document content — the Docs/Whiteboard
invite-link path and the Sheets/Slides presence layer talk peer-to-peer over
Diwan's own first-party `FabricClient` (`src/lib/collab/webrtc/fabric.js`; see
[COLLABORATION.md](COLLABORATION.md) §3). But WebRTC cannot introduce two
browsers **unaided**: something has to carry the first offer/answer/ICE frames.

`collab.builtin_rendezvous` makes this binary that something. On by default, it
serves the signed, content-blind announce/resolve/signal/mailbox protocol at
`/api/rendezvous/*` on its own origin (`backend/rendezvous`), so **one `diwan` on
one box is all two people need** — no Vulos OS, no Ephor, no relay, no account.

Before it existed, discovery had to come from another product, and a standalone
binary with none available had no peer-to-peer at all.

```yaml
collab:
  builtin_rendezvous: true    # default; set false to serve no discovery yourself
```

| Variable | Description | Default |
|----------|-------------|---------|
| `VULOS_BUILTIN_RENDEZVOUS` / `DIWAN_BUILTIN_RENDEZVOUS` | Overrides `collab.builtin_rendezvous`. `1/true/on/yes` or `0/false/off/no`. | `true` |

**What your box can see, stated plainly.** Discovery metadata: which Ed25519 keys
are present, which key sent bytes to which, sizes, timing. Not content — every
payload is sealed under the room key, which lives in an invite link's URL fragment
and is never sent in an HTTP request, and live edits never traverse it at all.
Nothing is written to disk: it is in-memory soft state with TTLs of minutes, and a
restart simply makes both clients re-announce.

**It is safe to expose**, which matters because a cloud node is. Every write is
Ed25519-signed over a domain-separated, length-prefixed canonical message, carries
a fresh nonce and a timestamp (replays and stale envelopes are refused), and every
dimension — payload size, queue depth, key count, TTL — is capped before anything
is stored. The surface is per-IP rate-limited. Failures are refusals: 403 for a bad
signature, 409 for a replayed or stale envelope, 413 for an over-cap payload, and
nothing is stored in any of those cases. It is anonymous by design (invite-link
collaboration needs no account) and authenticates **only** by body signature, never
by cookie.

**Turning it off** is supported and degrades honestly: sessions fall back to
`collab.rendezvous_url` if set, else to local-only with the UI saying so. It never
degrades to a broken editor.

Verify it yourself:

```sh
curl -s  http://localhost:8080/api/reachability      # builtin_rendezvous_prefix: "/api/rendezvous"
curl -si http://localhost:8080/api/rendezvous/healthz # {"ok":true,"service":"rendezvous"}
```

`npm run test:e2e:p2p` proves the whole path with nothing mocked and nothing
external: one real binary, two real browsers, a real WebRTC data channel, the
server's own presence state read back as ground truth, and the negative control
(`e2e-p2p/builtin-rendezvous-p2p.e2e.js`).

---

### `collab.rendezvous_url` — delegate discovery to your own relay instead

Blank by default. When set, it names an **external** discovery surface and takes
precedence over the built-in one above — configuring it is an explicit choice, so
it wins. Reasons to: one shared relay across several deployments, or its
TURN/NAT-traversal help.

Diwan picks one of four discovery paths, in order:

1. **This server's own peering fabric** (`/api/peering/*`) — present only when
   a Vulos OS / Ephor deployment fronts Diwan. Unchanged default.
2. **A configured rendezvous URL** — the base URL of any **self-hosted
   `vulos-relayd`**'s OPEN rendezvous surface (announce/resolve/signal/mailbox
   + ICE). No Vulos OS and no account are required.

   The browser calls that relayd's origin **directly**, cross-origin. Diwan
   mounts nothing for discovery and is not in that path at all, so it never
   sees even the (content-blind) rendezvous envelopes — see
   [COLLABORATION.md](COLLABORATION.md) §3 for exactly what the relay does and
   does not see. Two things this puts on you as the operator:

   - The relayd must serve **CORS** on its rendezvous role. Every Ephor
     deployment with the role does; `npm run test:e2e:p2p` asserts the posture
     against a real one, from a real browser.
   - It must be reachable from wherever users load Diwan, over a scheme the
     page can call: an **https** Diwan cannot call an **http** relay, so a
     public deployment needs TLS on the relay.
3. **This binary's own built-in surface** — `collab.builtin_rendezvous` above.
   **This is what an unconfigured deployment uses.**
4. **Local-only** — none is reachable; the editor keeps working, autosaves,
   and says so honestly (an "Offline" pill) instead of showing a false "Live".

```yaml
collab:
  rendezvous_url: "https://relay.example.org"   # any self-hosted vulos-relayd
```

| Variable | Description | Default |
|----------|-------------|---------|
| `VULOS_RENDEZVOUS_URL` / `DIWAN_RENDEZVOUS_URL` | Overrides `collab.rendezvous_url`. Any URL a `vulos-relayd` serves its rendezvous surface on. | — (unset) |

Exposed **read-only** to the browser at the unauthenticated `GET /api/reachability`
(as `rendezvous_url`), so setting the env var takes effect without a frontend
rebuild — the same endpoint also carries `public_base_url`, this server's own
externally-reachable origin:

| Variable | Description | Default |
|----------|-------------|---------|
| `DIWAN_PUBLIC_URL` | This Diwan instance's externally-reachable origin (a public domain, or an Ephor tunnel URL when behind NAT/CGNAT). Used to build P2P invite links / signaling targets an external peer can actually reach, instead of blindly trusting `window.location.origin` (which may be a LAN-only address). | — (falls back to the visitor's own origin) |

`rendezvous_url` is `""` when nothing is configured, and
`builtin_rendezvous_prefix` is `""` when the built-in surface is off. Clients
treat empty as "not available" rather than guessing a default, and refuse a
prefix that is not an absolute same-origin path — that is what keeps a
deliberately-local-only deployment local-only instead of minting invite links that
could never connect anyone, or sending discovery somewhere unintended.

**No default endpoint anywhere.** Every URL Diwan uses for discovery comes from
this deployment: your own config, or the page's own origin. Nothing points at a
Vulos-run service.

See `backend/config/config.go` and `src/lib/collab/transportSelection.js` for
the selection logic, and `src/lib/collab/reachableBase.js` for the client-side
fetch/cache. The default path is proven end to end by
`e2e-p2p/builtin-rendezvous-p2p.e2e.js`; the external-relay posture by
`e2e-p2p/rendezvous-p2p.e2e.js`, which needs a prebuilt relayd in
`VULOS_RELAYD_BIN` and skips (loudly, with its reason) without one — it never
clones or builds another repository at test time.

---

### `collab.ice.*` — STUN/TURN configured at RUNTIME (works on a release binary)

Collaboration's default path is **direct WebRTC** — a data channel straight
between two browsers (see [COLLABORATION.md](COLLABORATION.md) §3). Making
that direct connection happen behind NAT needs **STUN** (near-universal, just
tells you your own public address) and, for the minority of peer pairs behind
a **symmetric NAT** that can't hole-punch at all, **TURN** (relays the traffic;
content-blind here — see §3). Neither requires a host box, a `vulos-relayd`, or
any other Vulos product.

Configure them **in the running server** and the browser picks them up from
`GET /api/rendezvous/ice`:

```yaml
collab:
  ice:
    stun_urls: ["stun:turn.example.org:3478"]
    turn_urls: ["turn:turn.example.org:3478", "turns:turn.example.org:5349"]
    # RECOMMENDED — coturn's static-auth-secret (its REST API). The secret never
    # leaves this process; each response carries a credential valid for turn_ttl_seconds.
    turn_secret: "…"
    turn_ttl_seconds: 3600
    # Or a long-lived pair, served verbatim to any caller. Ignored if turn_secret is set.
    # turn_username: "diwan"
    # turn_credential: "…"
```

| Variable | Description | Default |
|----------|-------------|---------|
| `VULOS_STUN_URLS` / `DIWAN_STUN_URLS` | Comma-separated `stun:` URLs. | — |
| `VULOS_TURN_URLS` / `DIWAN_TURN_URLS` | Comma-separated `turn:`/`turns:` URLs. Ignored unless a credential mode below is set — a credential-less TURN entry cannot authenticate. | — |
| `VULOS_TURN_SECRET` / `DIWAN_TURN_SECRET` | coturn `static-auth-secret`. Credentials are minted per request and expire. | — |
| `VULOS_TURN_USERNAME` / `DIWAN_TURN_USERNAME` | Long-lived TURN username. Ignored when a secret is set. | — |
| `VULOS_TURN_CREDENTIAL` / `DIWAN_TURN_CREDENTIAL` | Long-lived TURN credential. Ignored when a secret is set. | — |

**Why a runtime setting exists at all.** The `VITE_*` variables below are baked
into the JS bundle at build time, so an operator who **downloaded a release binary
or pulled the container cannot set them** without rebuilding the frontend — which
made [COTURN.md](COTURN.md) unusable for exactly the audience it is written for.
These fields are the same facts, supplied where that operator can actually supply
them.

**What this endpoint exposes.** `GET /api/rendezvous/ice` is unauthenticated — a
browser needs ICE servers before it has any session — so anything configured here
is readable by anyone who can reach the box. That is fine for STUN (a STUN server
only tells a caller its own address). For TURN, prefer `turn_secret`: the secret
stays server-side and each response carries a short-lived credential, so a leaked
response expires instead of being a permanent grant. `turn_username`/
`turn_credential` are supported for deployments with no REST secret, and are handed
out verbatim — stated as what it is rather than dressed up.

Unconfigured, the endpoint returns an **empty** list, which the browser reads as
"answer from my own config" — so leaving this alone changes nothing for a
deployment that already set the bundle's variables.

---

### `VITE_STUN_URLS` / `VITE_TURN_*` — the same thing at BUILD time

Build-time env vars consumed by `src/lib/collab/webrtc/call/ice.js`. Used when the
server-side ICE response above is empty (or unavailable):

| Variable | Description | Default |
|----------|-------------|---------|
| `VITE_STUN_URLS` | Comma-separated `stun:` URLs, e.g. `stun:stun.example.org:3478`. Set to the empty string `''` to disable STUN entirely (not just unset it). | the public Google STUN server |
| `VITE_TURN_URL` | Comma-separated `turn:`/`turns:` URLs for your TURN server, e.g. `turn:turn.example.org:3478,turns:turn.example.org:5349`. | — (no TURN by default) |
| `VITE_TURN_USERNAME` | TURN username (coturn `lt-cred-mech`: a static `user=` name, or the username half of a time-limited credential). | — |
| `VITE_TURN_CREDENTIAL` | TURN credential/password matching `VITE_TURN_USERNAME`. | — |

These take effect as a **fallback** — when the ICE endpoint in use
(`/api/peering/ice` on a host box, `/api/rendezvous/ice` on this binary, or a
configured relayd's ICE surface) is unreachable or returns nothing. TURN is never
defaulted (unlike STUN): a TURN server relays your traffic, so it is opt-in only,
via the variables above.

A host page may also inject these at runtime instead of build time, via
`window.__VULOS_ENDPOINTS__`:

```js
window.__VULOS_ENDPOINTS__ = {
  stunUrls: ['stun:stun.example.org:3478'],
  turn: { urls: ['turn:turn.example.org:3478'], username: 'diwan', credential: '…' },
}
```

**Self-hosting your own TURN server:** see [COTURN.md](COTURN.md) for a
complete, runnable coturn setup (apt and Docker), a minimal `turnserver.conf`,
the firewall ports to open, and exactly which of the settings above to point at
it — the runtime `collab.ice.*` ones if you are running a release binary, the
build-time `VITE_*` ones if you build the frontend yourself.

---

## Environment variables

### Auth / JWT

| Variable | Description | Default |
|----------|-------------|---------|
| `DIWAN_JWT_SECRET` | HS256 signing secret — **required** when `auth.enabled: true` | — |
| `DIWAN_REGISTRATION_TOKEN` | Static fallback registration token (prefer invite tokens) | — |

### SSO session introspection (multi-user)

Diwan holds **no session-signing power**. When an identity provider is configured it validates the browser's `vc_session` cookie by introspection instead of verifying a signature Diwan minted.

| Variable | Description | Default |
|----------|-------------|---------|
| `IDENTITY_URL` | Identity-provider base URL (sovereign box in self-host, CP in cloud). **SET** → Diwan introspects `vc_session` at `POST {IDENTITY_URL}/api/session/introspect` and fails **closed** (401) on invalid/expired/unreachable. **UNSET** → SSO disabled; existing local single-identity behavior unchanged. | — (unset) |
| `VULOS_CP_TOKEN` | Shared service-auth secret presented as `X-Relay-Auth` on the introspection call (== the provider's `CP_SHARED_SECRET`). Reused from the existing API-key / entitlements path — **not a signing key**. | — |

Precedence (first match wins): `vk_` API key → per-product session JWT → SSO `vc_session` introspection → 401. On a valid session the request is scoped to the resolved **user + tenant** (`tenantId` = account id); results are cached in-process for ~45s (bounded by the session's `expiresAt`) so it is not a round-trip per request.

**Operator quick-reference**

- Self-host single-user box: leave `IDENTITY_URL` unset. Nothing else to do.
- Multi-user with an external identity/control plane: point `IDENTITY_URL` at your own control-plane host (there is no default host — leave it unset and the box stays self-contained) and set `VULOS_CP_TOKEN=<CP shared secret>` (plus `auth.enabled: true` / `DIWAN_JWT_SECRET` if you also keep native JWT logins).

### Persistence

| Variable | Description | Default |
|----------|-------------|---------|
| `VULOS_PERSISTENCE_UPDATELOG` / `DIWAN_UPDATE_LOG` | Enable the CRDT update log (overrides `persistence.updatelog`). Accepts `1/true/on/yes`. | `false` |

### Database paths (SQLite)

| Variable | Description | Default |
|----------|-------------|---------|
| `VULOS_USERAUTH_DB` | Per-user credential store DSN | `./data/userauth.db` |
| `VULOS_INVITES_DB` | Invite-token store DSN | `./data/invites.db` |
| `VULOS_AUDIT_DB` | Append-only audit-log DSN | `./data/audit.db` |
| `VULOS_FILEACL_DB` | File-ACL store DSN (SQLite backend only) | `./data/fileacl.db` |

### S3-compatible storage (Tigris default)

These are consumed by `OfficeTigrisDefaults()` in `backend/storage/backendconfig.go`:

| Variable | Description | Default |
|----------|-------------|---------|
| `TIGRIS_ENDPOINT` | S3-compatible endpoint URL | `https://fly.storage.tigris.dev` |
| `TIGRIS_REGION` | Storage region | `auto` |
| `TIGRIS_ACCESS_KEY_ID` | Access key | — |
| `TIGRIS_SECRET_ACCESS_KEY` | Secret key | — |

For BYO/MinIO deployments inject `OfficeBackendConfig` directly (see [INSTALL.md](INSTALL.md)).

### Bundle (shared with Vulos OS)

Written by the OS storage-mode selector; consumed by all three bundle services:

| Variable | Description |
|----------|-------------|
| `VULOS_STORAGE_MODE` | `central-tigris` (default) or `local-minio-sync` |
| `VULOS_MINIO_ENDPOINT` | MinIO endpoint (only in `local-minio-sync` mode) |
| `VULOS_MINIO_REGION` | Region (default `auto`) |
| `VULOS_MINIO_BUCKET` | Shared bucket name |
| `VULOS_MINIO_CREDS_REF` | Path to credentials file |

### SMTP (optional)

Diwan itself does not send mail. If you want outbound notifications, point Diwan at an external SMTP relay:

| Variable | Description |
|----------|-------------|
| `SMTP_HOST` | SMTP relay host |
| `SMTP_PORT` | SMTP port (default `587`) |
| `SMTP_USER` | SMTP username |
| `SMTP_PASSWORD` | SMTP password |
| `SMTP_FROM` | From address |

### Observability (OpenTelemetry)

| Variable | Description |
|----------|-------------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP endpoint for traces (optional) |
| `OTEL_SERVICE_NAME` | Service name tag (default `diwan`) |

Prometheus metrics are always available at `GET /metrics` (no env var needed).

---

## Org-bucket wiring

`backend/storage/backendconfig.go` exposes `OfficeBackendConfig` for per-org S3 bucket + CRDT snapshot configuration, injected by whatever control plane fronts a multi-tenant deployment (self-configured — Vulos operates none). This is the canonical configuration path for such deployments — do not duplicate it in environment variables.

---

## See also

- [GETTING-STARTED.md](GETTING-STARTED.md) — first-run walkthrough
- [DEPLOY.md](DEPLOY.md) — production deployment
- [INSTALL.md](INSTALL.md) — single-box bundle install
- [ARCHITECTURE.md](ARCHITECTURE.md) — component map
