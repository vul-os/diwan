# Diwan — Admin Guide

This chapter is for the person who runs Diwan: deploying it (bare binary, Docker, Fly.io, or as part of a Vulos OS bundle), configuring it (`config.yaml` + environment variables), understanding where documents actually live on disk, enabling multi-user auth, integrating with the Vulos OS, and backing it all up. Diwan is a **single Go binary with the entire web app embedded** — the default deployment is one process, one port (`:8080`), one data directory, no external dependencies. Every endpoint and variable named here exists in the code of this repository.

---

## 1. Deployment options

### 1.1 Single binary (simplest)

```bash
npm install
npm run build          # builds the frontend into dist/ and compiles the Go binary
./diwan
# → http://localhost:8080
```

Data lands in `./data` and `./uploads` relative to the working directory. With zero configuration you get single-user mode: no auth, local storage, no cloud.

Useful invocations:

```bash
./diwan --version            # print build version
./diwan version              # same
./diwan --no-rate-limit-writes   # disable write/collab token-bucket (trusted/internal only)
./diwan migrate up           # apply storage schema migrations (idempotent)
./diwan migrate status       # show which application tables exist
./diwan migrate-credential -admin you@example.org [-password PW]
                                    # one-shot: convert a legacy shared-password deploy
                                    # to a per-user credential (no-op once any user exists)
```

### 1.2 Docker

```bash
docker run -d \
  --name diwan \
  -p 8080:8080 \
  -v office-data:/srv/data \
  ghcr.io/vul-os/diwan:latest
```

Image facts (from the `Dockerfile`):

- Runs as non-root user `vulos` (uid 10001), `WORKDIR /srv`, so data is at **`/srv/data`** and uploads at **`/srv/uploads`**. Mount a volume at `/srv/data` (and at `/srv/uploads` if you want uploaded images to survive redeploys — the stock image only declares the data volume).
- `EXPOSE 8080`; built-in `HEALTHCHECK` polls `GET /healthz`.
- The binary is static (CGO off; Postgres via pure-Go pgx) on Alpine.

**Building the image yourself**: the WebRTC collaboration fabric is first-party source under `src/lib/collab/webrtc/` (no separate package, no sibling-repo checkout needed), so a plain build from the repo root always works:

```bash
docker build -t ghcr.io/vul-os/diwan:latest .
```

### 1.3 Fly.io

`fly.toml` is checked in. Because Fly's build context is the config file's directory, build and push the image out-of-band, then deploy by image reference:

```bash
docker build -t ghcr.io/vul-os/diwan:latest .
docker push ghcr.io/vul-os/diwan:latest
fly deploy -c fly.toml --image ghcr.io/vul-os/diwan:latest
```

The config mounts a volume `office_data` at `/srv/data`, checks `/healthz`, forces HTTPS, and documents setting `DATABASE_URL` / `IDENTITY_URL` / `VULOS_CP_TOKEN` as Fly secrets.

### 1.4 Vulos OS bundle

For a full sovereign box (OS + Mail + Diwan sharing one identity and storage fabric), use the bundle installer described in [INSTALL.md](INSTALL.md) / [GETTING-STARTED.md](GETTING-STARTED.md). The bundle also provides the `/api/peering/*` fabric endpoints that light up low-latency P2P collaboration and cross-app presence — a standalone Diwan binary does not serve those itself (see [COLLABORATION.md](COLLABORATION.md) §4).

---

## 2. Configuration

The server reads **`config.yaml` from its working directory** (the `migrate` subcommand accepts `-config <path>`; the server itself loads `./config.yaml`). Missing file ⇒ defaults, with a log line `Config error: … — using defaults`. Environment variables override the file.

```yaml
server:
  addr: ":8080"            # listen address
  data_dir: "./data"       # documents, versions, envelopes, SQLite stores
  uploads_dir: "./uploads" # uploaded images/files

auth:
  enabled: false           # true = require login
  password: "changeme"     # legacy shared password (migration source only)
  max_attempts: 5          # failed logins before lockout
  lockout_minutes: 15
  session_hours: 24        # JWT session lifetime

storage:
  type: "local"            # "local" (JSON files) or "postgres"
  postgres:
    host: "localhost"
    port: 5432
    user: "postgres"
    password: ""
    database: "diwan"
    sslmode: "disable"
```

### Environment variables

Core:

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Full `postgres://…` URL. When set, selects Postgres storage (schema `office`) and overrides `storage.type`. |
| `VULOS_DATABASE_URL` | Alias, checked if `DATABASE_URL` unset. |
| `DIWAN_JWT_SECRET` | HS256 secret for session JWTs. **Required when `auth.enabled: true`** — the server refuses to start without it (fatal at boot). |
| `DIWAN_DEV` | `1` = clearly-labelled insecure dev secret. Never in production. |
| `DIWAN_CORS_ORIGINS` | Comma-separated allowed origins (credentials allowed). Unset ⇒ all origins allowed *without* credentials — the startup log states which mode you're in. |
| `DIWAN_REGISTRATION_TOKEN` | Static fallback registration token (prefer minted invites). |

SQLite store paths (defaults under `data_dir`):

| Variable | Default |
|----------|---------|
| `VULOS_USERAUTH_DB` | `./data/userauth.db` |
| `VULOS_INVITES_DB` | `./data/invites.db` |
| `VULOS_AUDIT_DB` | `./data/audit.db` |
| `VULOS_FILEACL_DB` | `./data/fileacl.db` |

SSO / cloud seams (all optional; unset = fully standalone):

| Variable | Purpose |
|----------|---------|
| `IDENTITY_URL` | Identity provider base URL. When set, Diwan validates the browser's `vc_session` cookie via `POST {IDENTITY_URL}/api/session/introspect`, **fail-closed** (401 on invalid/unreachable). Unset ⇒ SSO path disabled. |
| `VULOS_CP_BASE_URL` | External control-plane URL (Vulos operates none — this points at your own, if you run one). Enables the entitlements/usage adapter and the `vk_` API-key introspection path for `/v1`. Unset ⇒ none of that code runs. |
| `VULOS_CP_TOKEN` | Service token presented as `X-Relay-Auth` to the CP / identity provider. Not a signing key. |
| `VULOS_ORG_ID` | Tenant/org scoping used by the cloud adapter and storage. |

Object storage / bundle (optional): `TIGRIS_ENDPOINT`, `TIGRIS_REGION`, `TIGRIS_ACCESS_KEY_ID`, `TIGRIS_SECRET_ACCESS_KEY`, and the bundle-shared `VULOS_STORAGE_MODE`, `VULOS_MINIO_ENDPOINT`, `VULOS_MINIO_REGION`, `VULOS_MINIO_BUCKET`, `VULOS_MINIO_CREDS_REF` — see [CONFIGURATION.md](CONFIGURATION.md) for that matrix.

Observability: `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME` (default `diwan`).

SMTP (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`) — only relevant for outbound notification mail in standalone setups.

Auth precedence per request: `vk_` API key → Diwan session JWT → SSO `vc_session` introspection → 401. Introspection results are cached in-process ~45 s.

---

## 3. Where documents live (storage)

### 3.1 Local storage (default)

Everything is human-inspectable JSON under `data_dir`:

| Path | Contents |
|------|----------|
| `data/<fileID>.json` | One JSON file per document (metadata + content) |
| `data/versions/<fileID>_<versionID>.json` | Version snapshots |
| `data/folders/` | Folder tree |
| `data/comments/`, `data/replies/`, `data/suggestions/` | Annotations |
| `data/envelopes/`, `data/signers/`, `data/sealed/` | Signing envelopes, signer records, sealed PDFs |
| `data/audit/<envelopeID>/<eventID>.json` | Per-envelope signing audit events |
| `data/userauth.db`, `invites.db`, `audit.db`, `fileacl.db` | SQLite: credentials, invites, security audit log, per-file ACLs |
| `uploads/` | Uploaded images (10 MB cap each, content-type sniffed, UUID filenames) |

Every id used to build a path is validated against a strict pattern (letters/digits/`_`/`-` only), so path traversal via crafted ids is rejected at the storage layer.

### 3.2 Postgres (multi-user / cloud)

Set `DATABASE_URL` (or `storage.type: postgres`). Diwan uses the dedicated schema **`office`** inside the database, so it co-exists with other Vulos products in one shared Postgres/Neon project. Tables are created automatically on first boot; `./diwan migrate up` applies the same migrations explicitly (idempotent — run it before a rolling restart after upgrades), and `migrate status` lists present tables. File ACLs move into Postgres too (`backend/storage/fileacl_postgres.go`).

### 3.3 Object storage (optional)

`backend/storage/backendconfig.go` exposes `OfficeBackendConfig` (with Tigris defaults via the `TIGRIS_*` vars) for per-org S3 bucket + CRDT snapshot wiring, injected by the control plane in hosted multi-tenant deployments. Standalone installs don't need it.

---

## 4. Enabling multi-user auth

1. Set `auth.enabled: true` in `config.yaml`.
2. `export DIWAN_JWT_SECRET="$(openssl rand -hex 32)"` — boot fails loudly without it.
3. Start the server, then bootstrap the first user via `POST /api/auth/register` (with `DIWAN_REGISTRATION_TOKEN` or an invite), or convert an old shared-password install with `./diwan migrate-credential -admin <account>`.
4. From an admin account, open **Settings → Admin** to mint **invite tokens** (single-use, expiring; the raw token is shown exactly once) and to read the **audit log** (ACL grants/revokes, registrations, invite events, role changes).

Related behavior to be aware of:

- Login is rate-limited and lockout-protected (`max_attempts` / `lockout_minutes`).
- When auth is enabled (multi-tenant), the **local-files browse/serve routes are disabled** (`/api/local-files*`) to avoid exposing the server's home directory across tenants — the startup log says so explicitly. The "open from server folder" feature is therefore single-user-only.
- Write endpoints (files, comments, collab ops, uploads…) share a per-IP token bucket: burst 30, refill 10/s. Disable only in trusted environments with `--no-rate-limit-writes`.
- Uploads are gated by billing/entitlements (`GateStorage`) — in standalone mode the cap is unlimited, so this is a no-op.

---

## 5. Integration into the Vulos OS

- **Embedding**: every editor surface ships as the npm library `diwan` with entries `diwan/docs`, `diwan/sheets`, `diwan/slides`, `diwan/whiteboard`, `diwan/pdf` — the Vulos OS (or your own app) mounts them as native panels. Built by `vite.config.lib.js` into `dist-lib/`. (The Go module and the binary it builds are named `diwan`; the npm package and the product are Diwan.)
- **Identity**: on a Vulos OS box, set `IDENTITY_URL` so Diwan introspects the shared `vc_session` cookie — Diwan deliberately holds no session-signing power in that mode.
- **Peering fabric**: the OS/Ephor host provides `/api/peering/stream` (WebSocket signaling) and `/api/peering/ice`; Diwan's collab code discovers them same-origin and lights up P2P collaboration + presence automatically. Without a host-box fabric, setting `collab.rendezvous_url` / `VULOS_RENDEZVOUS_URL` to any self-hosted `vulos-relayd` gets the same result with no OS involved (see [CONFIGURATION.md](CONFIGURATION.md)); with neither, it degrades gracefully to local-only.
- **Control plane** (self-wired, multi-tenant): `VULOS_CP_BASE_URL` + `VULOS_CP_TOKEN` + `VULOS_ORG_ID` enable entitlements (`GET {CP}/api/entitlements`, fails open on transient CP outage), usage metering (fire-and-forget `POST {CP}/api/usage`), and `vk_` API-key introspection for `/v1` (fail-closed `503` if the CP is unreachable during key validation). Vulos operates no control plane for you to point this at. See [SELFHOST.md](SELFHOST.md) for the full seam contract.

---

## 6. Running behind a reverse proxy

Diwan serves the app + API on one port, so proxying is one location block. Note: Diwan itself hosts **no** long-lived collaboration stream — collaboration is peer-to-peer with no central document server (see [COLLABORATION.md](COLLABORATION.md)). One path needs care, and only on a Vulos OS/Ephor host:

- **WebSocket** (`/api/peering/stream`): the content-blind peer-discovery signaling channel. It only exists when a Vulos OS/Ephor host provides the peering fabric; if you proxy such a deployment, `Upgrade`/`Connection` headers must be forwarded and read timeouts kept long, or peers fail to discover each other (see [TROUBLESHOOTING.md](TROUBLESHOOTING.md) §3).

nginx sketch:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Upgrade $http_upgrade;      # websockets (peering-fabric discovery)
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 1h;                        # keep the discovery WS open
}
```

Also remember the per-IP write rate limit (burst 30, refill 10/s): if the proxy hides client IPs, all users share one bucket. Preserve real client addresses, or relax limits deliberately.

---

## 7. Security hardening checklist

- [ ] `auth.enabled: true` + strong `DIWAN_JWT_SECRET` (32+ random bytes); never `DIWAN_DEV=1` in production.
- [ ] TLS in front (reverse proxy or Fly `force_https`); session cookies are HttpOnly, but the transport is on you.
- [ ] `DIWAN_CORS_ORIGINS` set to your exact origins if anything embeds Diwan or calls it cross-origin.
- [ ] First admin bootstrapped, then registration only via **invites** (avoid leaving a static `DIWAN_REGISTRATION_TOKEN` around).
- [ ] Keep the write rate-limit on (don't ship `--no-rate-limit-writes` to the internet).
- [ ] Volumes for `data/` *and* `uploads/`; backups tested (see §9).
- [ ] Review the audit log (Settings → Admin) periodically — every share/role/invite/registration event is recorded append-only.
- [ ] If cloud seams are unused, leave `VULOS_CP_BASE_URL`, `IDENTITY_URL` unset — the adapter code then never runs.
- [ ] Communicate the E2E "Collaborate via link" posture to your users: those sessions are content-blind to your server and not centrally auditable ([COLLABORATION.md](COLLABORATION.md) §5).

The repo also ships [SECURITY.md](../SECURITY.md), [THREAT-MODEL.md](THREAT-MODEL.md), and [SECURITY-TESTING.md](SECURITY-TESTING.md) with the full model and its regression tests.

---

## 8. Observability and operations

| Endpoint | Purpose |
|----------|---------|
| `GET /healthz` | Liveness — `{"status":"ok","version":"…"}` (used by Docker/Fly health checks) |
| `GET /version` | Build version |
| `GET /metrics` | Prometheus metrics (always on) |

- **Logs go to stdout/stderr** (standard Go log + Gin request log). There is no log file — capture with `docker logs`, `journalctl`, or `fly logs`. Startup lines announce every important mode decision: `[seam] integration mode: …`, `[sso] session introspection …`, `[cors] …`, `[rate-limit] …`, `[v1] API-key path …`, `[local-files] …`, `[apps] …`.
- **Traces**: set `OTEL_EXPORTER_OTLP_ENDPOINT` for OpenTelemetry export.
- **Security audit**: the application-level audit trail (shares, roles, invites, registrations) is in `data/audit.db`, readable in the admin panel. Signing envelopes keep their own audit events under `data/audit/`.

---

## 9. Backup and restore

What to back up:

| Deployment | Back up |
|------------|---------|
| Local storage (default) | The whole **`data/`** directory (documents, versions, annotations, envelopes, sealed PDFs, and all four SQLite DBs) **and `uploads/`** (inline images live here — losing it breaks images in documents) |
| Docker | The volume(s) at `/srv/data` (+ `/srv/uploads` if mounted) |
| Postgres | `pg_dump` of the `office` schema, plus `uploads/` (uploads stay on local disk unless object storage is configured) |
| `config.yaml` + env/secrets | Always — especially `DIWAN_JWT_SECRET` (losing it invalidates all sessions, not data) |

Practical notes:

- Everything in local mode is flat files + SQLite: a filesystem snapshot or `tar` of `data/` + `uploads/` while traffic is quiescent is a complete backup. For hot backups of the SQLite stores, prefer `sqlite3 <db> ".backup <dest>"` over raw copy.
- Version history is part of `data/versions/` — backing up documents without it loses restore points.
- **E2E "Collaborate via link" rooms store nothing on the server** — each participant's browser keeps local snapshots, and their own saves land in their account's storage as usual. There is nothing extra to back up, and nothing server-side to recover if a room's link is lost (rotate/reshare instead).
- Restore = put `data/` + `uploads/` back in the working directory (or restore the volume / `psql` the dump), then start the binary; run `./diwan migrate up` after restoring a Postgres dump onto a newer binary.
- Test restores by starting a scratch container against a copy of the backup and hitting `/healthz` + opening a document.

---

## 10. Upgrade checklist

1. Back up (above).
2. Pull/build the new image or binary.
3. Postgres: `./diwan migrate up` (idempotent) before or during the rolling restart; local storage migrates transparently.
4. Watch the startup log lines for the mode announcements you expect (seam/SSO/CORS/rate-limit).
5. Verify `/healthz`, then log in and open a document.

For failure symptoms and their fixes, continue to [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
