# Diwan — Install Guide

This document covers how to install and run `diwan` either co-located
with the Vulos OS (the recommended single-box deployment) or as a
standalone service.

For an end-to-end deployment walkthrough (Docker, building from source,
upgrading), see [`DEPLOY.md`](DEPLOY.md).

---

## Co-located deployment (recommended)

The supported "easy path" is the **co-located bundle**: one box runs the Vulos
OS and diwan, sharing **one S3-compatible bucket endpoint**
(Tigris by default, using your own Tigris credentials; local MinIO via the OS-side storage selector
opt-in). Both services share one CRDT/peering fabric and one identity.

### Use the bundle installer (canonical command)

The `vulos` repo provides a meta-bundle installer (`BUNDLE-01`,
[`scripts/install-vulos.sh`](https://github.com/vul-os/vulos/blob/main/scripts/install-vulos.sh))
that provisions the OS + office, writes their systemd units, and seeds the
shared storage config. Do **not** duplicate it here — invoke it:

```sh
# Tigris-backed (default)
curl -fsSL https://get.vulos.org | sudo bash

# Local-MinIO-backed (BYO single-box)
curl -fsSL https://get.vulos.org | sudo bash -s -- --storage=minio
```

After install:

```sh
sudo systemctl enable --now vulos-bundle.target
```

See https://github.com/vul-os/vulos/blob/dev/docs/SELF-HOST-BUNDLE.md for the full bundle reference.

### Shared storage config (env)

The OS-side storage-mode selector (`STORE-LOCAL-01`,
`vulos/backend/internal/storagemode/`) writes a single shared env file
(consumed by `vulos.service` and `diwan.service`)
with the following variables. Diwan reads these at startup and passes them
into [`OfficeBackendConfig`](../backend/storage/backendconfig.go):

| Variable                | Purpose                                                                 |
|-------------------------|-------------------------------------------------------------------------|
| `VULOS_STORAGE_MODE`    | `central-tigris` (default) or `local-minio-sync` (BYO single-box MinIO) |
| `VULOS_MINIO_ENDPOINT`  | S3 endpoint URL (only when mode is `local-minio-sync`)                  |
| `VULOS_MINIO_REGION`    | Region label (defaults to `auto`)                                       |
| `VULOS_MINIO_BUCKET`    | Bucket shared by OS + office (e.g. `vulos-bundle`)                      |
| `VULOS_MINIO_CREDS_REF` | Path to the credentials file (e.g. `/var/lib/vulos/minio/.minio_secret`) |

In `central-tigris` mode, office falls back to the canonical Tigris env vars
(`TIGRIS_ENDPOINT`, `TIGRIS_REGION`, `TIGRIS_ACCESS_KEY_ID`,
`TIGRIS_SECRET_ACCESS_KEY`) via `OfficeTigrisDefaults()`.

### Systemd unit ordering

The bundle installer writes the units below — `diwan` starts **after**
`vulos.service` and the shared `vulos-fabric.service` oneshot (which performs the
shared identity/fabric init). Both are pulled in by `vulos-bundle.target` (the
all-up sentinel).

```mermaid
%%{init: {'theme':'base','themeVariables':{'fontFamily':'ui-monospace, SFMono-Regular, Menlo, monospace','primaryColor':'#2A241C','primaryBorderColor':'#8E8677','primaryTextColor':'#F1EBE0','lineColor':'#D0471F','edgeLabelBackground':'#201B15','tertiaryTextColor':'#F1EBE0','clusterBorder':'#8E8677','clusterBkg':'transparent'}}}%%
flowchart TD
    classDef entry fill:#201B15,stroke:#8E8677,color:#C3BAAC
    classDef subject fill:#AE3917,stroke:#FF8759,color:#FFF1EA
    classDef downstream fill:#2A241C,stroke:#8E8677,color:#F1EBE0
    Net["network-online.target"]
    MinIO["[vulos-minio.service]<br/>(optional — local-MinIO mode only)"]
    Fabric["vulos-fabric.service<br/>(shared fabric identity init — oneshot)"]
    OS["vulos.service (OS backend, :8443)"]
    Diwan["diwan.service (office backend, :8445)"]
    Bundle["vulos-bundle.target"]
    Net --> MinIO
    MinIO --> Fabric
    Fabric --> OS
    Fabric --> Diwan
    Diwan --> Bundle
    class Net entry
    class Diwan subject
    class MinIO,Fabric,OS,Bundle downstream
```

The relevant ordering for office (from
[`scripts/diwan.service`](https://github.com/vul-os/vulos/blob/main/scripts/diwan.service)
in the `vulos` repo):

```ini
[Unit]
After=network-online.target vulos-fabric.service vulos.service
Requires=vulos-fabric.service

[Install]
WantedBy=multi-user.target vulos-bundle.target
```

Diwan is intentionally ordered **after** `vulos.service` and the fabric
oneshot so the shared bucket creds + fabric identity are already in place
before office tries to open the storage backend. The bundle target
([`scripts/vulos-bundle.target`](https://github.com/vul-os/vulos/blob/main/scripts/vulos-bundle.target))
`Wants=` and `After=` both services so `systemctl start vulos-bundle.target`
brings the suite up atomically (and `systemctl stop` tears it down).

---

## Standalone office

If you only want the office suite (no Vulos OS), run office
directly and inject the storage endpoint yourself via
[`OfficeBackendConfig`](../backend/storage/backendconfig.go) — there is no
endpoint-selection logic inside diwan; it just receives what you give
it. See the storage/co-location notes in [`ROADMAP.md`](../ROADMAP.md).

The two accepted shapes:

### Tigris (managed default)

```go
cfg := storage.OfficeTigrisDefaults()
cfg.Bucket = "my-office-bucket"
cfg.Prefix = "acct-1234"
client, err := storage.NewOfficeS3Client(cfg)
```

Reads `TIGRIS_ENDPOINT`, `TIGRIS_REGION`, `TIGRIS_ACCESS_KEY_ID`,
`TIGRIS_SECRET_ACCESS_KEY` from env (defaults to
`https://fly.storage.tigris.dev` / region `auto`).

### MinIO (BYO self-host)

```go
cfg := storage.OfficeBackendConfig{
    Kind:            storage.OfficeBEKindMinIO,
    Endpoint:        "https://minio.example.lan",   // must be https://
    Region:          "auto",
    Bucket:          "diwan",                 // required
    Prefix:          "acct-1234",
    AccessKeyID:     "…",
    SecretAccessKey: "…",
}
client, err := storage.NewOfficeS3Client(cfg)
```

Both backends use the same S3-compatible interface (pure-Go SigV4, no CGO).
Diwan logs the resolved endpoint at startup.

For the runtime config file and Docker quick-start, see
[`DEPLOY.md`](DEPLOY.md).
