# Ofisi – Deployment Guide

## Requirements

- Linux host or container runtime
- Go 1.21+
- Node.js 20+ (for frontend build)
- PostgreSQL (optional; defaults to SQLite)

## Quick Start (Docker)

```sh
docker run -d \
  --name vulos-office \
  -p 8080:8080 \
  -v office-data:/data \
  ghcr.io/vul-os/ofisi:latest
```

## Building from Source

```sh
git clone https://github.com/vul-os/ofisi.git
cd ofisi

# Build frontend
npm ci && npm run build

# Build backend (no CGO required)
CGO_ENABLED=0 go build -trimpath -o vulos-office .
./vulos-office
```

## Configuration

Copy `config.yaml.example` to `config.yaml` and edit:

```yaml
server:
  addr: ":8080"
  uploads_dir: "/data/uploads"
auth:
  enabled: true
  jwt_secret: "<secret>"
database:
  driver: sqlite   # or postgres
  dsn: "/data/office.db"
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTel OTLP endpoint (optional) |
| `VULOS_OFFICE_JWT_SECRET` | HS256 signing secret (required when auth enabled) |
| `VULOS_OFFICE_REGISTRATION_TOKEN` | Static fallback registration token (optional; prefer invite tokens) |
| `VULOS_USERAUTH_DB` | Per-user credential SQLite DSN (default `./data/userauth.db`) |
| `VULOS_INVITES_DB` | Invite-token SQLite DSN (default `./data/invites.db`) |
| `VULOS_AUDIT_DB` | Append-only audit-log SQLite DSN (default `./data/audit.db`) |
| `VULOS_FILEACL_DB` | File-ACL SQLite DSN, sqlite backend only (default `./data/fileacl.db`) |

## Accounts, registration & invites

- **Login** verifies against a per-user credential store (bcrypt). While **no**
  users are registered, the instance is in OSS single-user mode and the legacy
  shared `auth.password` still authenticates.
- **Registration** on a bootstrapped instance (≥1 user) requires authorization:
  an admin JWT, the static `VULOS_OFFICE_REGISTRATION_TOKEN`, **or** a
  single-use/expiring **invite token** minted by an admin
  (`POST /api/admin/invites`, or the Admin Console UI). Invite tokens are stored
  hashed; the raw token is shown once at mint time.
- All ACL grants/revokes, registrations, and invite events are recorded in an
  append-only **audit log** (`GET /api/admin/audit`, admin-only).

## Observability

- `GET /metrics` — Prometheus `vulos_office_*` metrics.
- OTel traces when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.

## Upgrading

Stop, replace binary, restart. SQLite schema is versioned; auto-migrated on startup.

### Upgrading from a shared-password deploy (avoid lockout)

Older deploys used a single shared `auth.password` with client-asserted account
ids. After upgrading, login on a bootstrapped instance requires a **per-user
credential** — so if you add any user without first migrating, existing
operators can no longer log in with the shared password.

Run the one-shot migration **once** after upgrading (before adding other users)
to seed the first per-user credential from your existing shared password:

```bash
# Uses auth.password from config.yaml unless -password is given.
./vulos-office migrate-credential -admin you@vulos.org

# Or pass an explicit password / DB path:
./vulos-office migrate-credential -admin you@vulos.org -password 's3cret' -db /data/userauth.db
```

The command is **idempotent** — it is a no-op once any user exists, so it is
safe to run on every boot or in an entrypoint script. After migrating, log in
with that account + the shared password, then mint invite tokens (Admin Console
→ Invites, or `POST /api/admin/invites`) to onboard the rest of your team.
