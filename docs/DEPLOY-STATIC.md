# Diwan — Static Deploy Guide

Diwan ships the `office` SPA, built with Vite and uploaded to Tigris
object storage for CDN delivery.

> Diwan is the **documents-only** product (Docs, Sheets, Slides, PDF/Signing).
> Calendar and Contacts come from the bring-your-own-mailbox PIM connector
> (**lilmail**), surfaced by the OS as standalone widgets — not from Diwan.
> Chat and video are third-party (Matrix/Element; Element Call / Jitsi), not
> Vulos products. The **Vulos OS** is the shell that hosts the apps.

## Prerequisites

- AWS CLI v2 (used to upload to Tigris via the S3-compatible API)
- Node.js 20+ and npm (for Vite builds)

## Credentials

| Variable | Description |
|---|---|
| `TIGRIS_ACCESS_KEY_ID` | Tigris access key |
| `TIGRIS_SECRET_ACCESS_KEY` | Tigris secret key |
| `TIGRIS_BUCKET` | Bucket name (e.g. `diwan-static`) |
| `TIGRIS_ENDPOINT` | Optional; defaults to `https://fly.storage.tigris.dev` |

## Usage

Deploy all targets:
```sh
./scripts/deploy-static.sh
```

Deploy a single target:
```sh
./scripts/deploy-static.sh office
```

Deploy and write a `latest` pointer so CDN routing resolves the current SHA:
```sh
./scripts/deploy-static.sh office --latest
./scripts/deploy-static.sh all --latest
```

## CDN URLs

Each deploy uploads to `<target>/<sha>/` in the bucket, served via Tigris static:

| Target | Served under | Bucket path |
|---|---|---|
| office | `app.vulos.org/office/` | `office/<sha>/` |

Static files are served under the Vulos app hub (`app.vulos.org`, Tigris-backed,
configured in your `fly.toml` or DNS CNAME). Apps are reached by **path** under
the app hub — there are no per-product subdomains, per the canonical
vulos-naming-and-urls URL scheme.

## SPA Fallback

All targets are single-page applications that rely on the HTML5 History API.
Configure your Fly.io `fly.toml` or static server to serve `index.html` for
any unmatched path:

```toml
[[http_service]]
  # ...

[[http_service.checks]]
  # ...

# Serve SPA index.html for all unmatched paths.
[http_service.static]
  fallback = "index.html"
```

## How the `--latest` flag works

With `--latest`, the script writes the deployed SHA as a plain-text object at
`<target>/latest` in the bucket. Your CDN router or Fly proxy can read this to
resolve the current deployment without a full directory listing.

## Tigris + the app hub (`app.vulos.org`)

Static assets are uploaded to Tigris (`fly.storage.tigris.dev`) and served
under the Vulos app hub (`app.vulos.org`). The Tigris bucket must have public static serving
enabled. See the [Tigris docs](https://www.tigrisdata.com/docs/objects/static-website/)
for bucket configuration.
