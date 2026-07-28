<div align="center">

<img src="docs/assets/diwan-logo.png" alt="Diwan" width="120" />

# Diwan

### A real, self-hostable collaborative office suite you own.

Documents, spreadsheets, slides, and whiteboards — **CRDT-native** and
**real-time**, shipped as a single binary, running on **your own storage**.
No cloud account, no telemetry, no lock-in.

[![Version](https://img.shields.io/badge/version-0.3.0-blue.svg)](CHANGELOG.md)
[![License: MIT OR Apache-2.0](https://img.shields.io/badge/License-MIT%20OR%20Apache--2.0-D0471F.svg)](LICENSE-MIT)
[![Self-hostable](https://img.shields.io/badge/self--hostable-single%20binary-E07A5F)](docs/SELFHOST.md)
[![CRDT · real-time](https://img.shields.io/badge/CRDT-real--time%20P2P-14B8A6)](docs/COLLABORATION.md)
[![Tests](https://img.shields.io/badge/tests-passing-D0471F)](docs/TESTING.md)
[![Go](https://img.shields.io/badge/Go-1.25-00ADD8?logo=go&logoColor=white)](https://golang.org)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)](https://react.dev)

[**Quickstart**](#quick-start) · [**Docs**](docs/) · [**Collaboration**](docs/COLLABORATION.md) · [**Architecture**](docs/ARCHITECTURE.md) · [**Self-hosting**](docs/SELFHOST.md)

<br/>

<img src="docs/screenshots/home-light.png" alt="Diwan — documents, sheets, slides, and whiteboards in one warm, self-hosted suite" width="900" />

</div>

---

## What is Diwan?

Diwan is a **standalone, self-hostable office suite** — documents, spreadsheets,
slides, and whiteboards in one clean, modern web app, shipped as a **single Go
binary** with the entire frontend embedded. There is no cloud account to create,
nothing phones home, and your files live in **your own storage**.

Real-time co-editing is **peer-to-peer and CRDT-native**: there is no central
document server. Peers sync directly over an end-to-end-encrypted channel, and
because edits are conflict-free (CRDTs), everyone converges with no authority in
the middle. What you run is what you own.

It carries the torch lit by **LibreOffice** and **OpenOffice** — the projects
that proved productivity software can be free, open, and community-driven — into
the browser, on a fast React frontend and a lightweight Go backend.

```mermaid
%%{init: {'theme':'base','themeVariables':{'fontFamily':'ui-monospace, SFMono-Regular, Menlo, monospace','primaryColor':'transparent','primaryBorderColor':'#14b8a6','primaryTextColor':'#8f969e','lineColor':'#8a8f98','nodeBorder':'#5f8f8a','edgeLabelBackground':'transparent','clusterBorder':'#3f8f86','clusterBkg':'transparent'}}}%%
flowchart LR
    you["you (browser)"] -->|edits| diwan["Diwan<br/>single binary"]
    peer["a collaborator"] -.->|"E2E-encrypted P2P (WebRTC)"| you
    diwan --> store["your storage<br/>files · SQLite · Postgres · S3"]
    diwan --> surfaces["Docs · Sheets · Slides<br/>Whiteboards · PDF signing"]
```

> *A diwan was a register of records, and a collected volume of work. This one is yours.*

<sub>The mark is an **iwan** — the vaulted portal at the heart of Persian and Ottoman
architecture, the arch you pass through to reach the room where the registers were
kept. Give it a quarter turn clockwise and it becomes a **D**: the arch's two legs
are the bars, the teal threshold is the stem.</sub>

---

## Features

| | |
|---|---|
| 📝 **Documents** | Rich-text editing (TipTap) — headings, tables, inline images, footnotes, task lists, links; anchored **comments**, **suggestions** (track-changes with accept/reject), **version history** with restore, find/replace, live outline + word count. |
| 📊 **Spreadsheets** | A full grid (Fortune Sheet) — formulas, number formats, conditional formatting, **data validation**, **charts**, **filters**, **pivot tables**, **named ranges**, freeze panes. |
| 🖼️ **Slides** | A from-scratch positioned-object canvas — free drag/resize/rotate of text, shapes, and images; per-element **animations**, **themes**, editable **master slides**, per-slide **transitions**, and a **presenter view** (notes + timer). |
| 🎨 **Whiteboards** | An infinite hand-drawn canvas built on the MIT [Excalidraw](https://github.com/excalidraw/excalidraw) editor — shapes, arrows, freehand, text, and images. The scene is a **Yjs CRDT** synced over the **same** E2E-encrypted P2P engine as Docs. |
| ⚡ **Real-time co-editing** | **Always peer-to-peer, no central document server.** Edits sync as CRDT updates inside an **end-to-end-encrypted** room; peers connect directly over WebRTC with a **content-blind relay** only as a hard-NAT fallback. Share by invite link — the key rides the URL fragment and never reaches any server. |
| 📄 **PDF import / export & signing** | Import and export `.docx` · `.xlsx` · `.csv` · `.pptx` · Markdown · HTML · **PDF**. View, annotate, fill AcroForm fields, and **sign** PDFs, including multi-party signing envelopes with a cryptographic audit trail. |
| 💾 **Your own storage** | Local files + SQLite by default; optional **PostgreSQL** (schema `office`) for multi-user; optional **S3-compatible** object store. Nothing is hosted for you unless you choose it. |
| 🔓 **No lock-in** | Open formats in and out, MIT-licensed, single self-contained binary. Every editor is also published as an npm library (the `diwan` package — `diwan/docs`, `diwan/sheets`, `diwan/slides`, `diwan/whiteboard`, `diwan/pdf`) so you can embed any surface in your own app. |

Diwan is **documents-only** by design: Docs, Sheets, Slides, Whiteboards, and
PDF signing. Chat, video, and mail are deliberately *not* part of it.

---

## Screenshots

Diwan wears a warm, **light-first** "Workshop" identity — an ember/terracotta
accent, a paper-tinted canvas, Fraunces on the page and Hanken Grotesk in the
chrome — with a full dark theme (and *System*) one click away.

|  |  |
| :---: | :---: |
| **Documents** — the Fraunces "paper", comments & suggestions | **Spreadsheets** — formulas, formats, charts, pivots |
| <img src="docs/screenshots/docs-editor-light.png" alt="Diwan Documents editor" /> | <img src="docs/screenshots/sheets-editor-light.png" alt="Diwan Spreadsheets editor" /> |
| **Slides** — masters, themes, transitions, present | **Whiteboards** — Excalidraw canvas on the P2P CRDT engine |
| <img src="docs/screenshots/slides-editor-light.png" alt="Diwan Slides editor" /> | <img src="docs/screenshots/whiteboard-editor-light.png" alt="Diwan Whiteboard editor" /> |
| **Files** — your docs, sheets, slides & local drive | **Signing** — annotate & sign PDFs |
| <img src="docs/screenshots/apphome-docs-light.png" alt="Diwan Docs file list" /> | <img src="docs/screenshots/pdf-editor-light.png" alt="Diwan PDF signing" /> |

**Light &amp; dark** — every surface ships both, light-first:

|  |  |
| :---: | :---: |
| <img src="docs/screenshots/home-dark.png" alt="Diwan workspace, dark theme" /> | <img src="docs/screenshots/docs-editor-dark.png" alt="Diwan Documents editor, dark theme" /> |

> Regenerate anytime with `npm run screenshots` — it boots the app with seeded
> demo data (no real backend or credentials needed) and captures every surface
> in light **and** dark at retina. See [docs/SCREENSHOTS.md](docs/SCREENSHOTS.md).

---

## Quick start

Diwan runs **by itself** — no account, no cloud, no external service required.

### Docker (one-liner)

```bash
docker run -d \
  --name diwan \
  -p 8080:8080 \
  -v diwan-data:/srv/data \
  ghcr.io/vul-os/diwan:latest
```

Open <http://localhost:8080>.

### From source (single binary)

Prerequisites: [Go 1.25+](https://golang.org/dl/) and [Node.js 18+](https://nodejs.org/) with npm.

```bash
git clone https://github.com/vul-os/diwan.git
cd diwan

# Install deps and build the frontend + single binary
npm install
npm run build

# Run — single-user, local storage, no auth, no cloud
./diwan
```

Open <http://localhost:8080>. Data lives in `./data` and `./uploads` — that's the
whole app, in one file. The Go module and the binary it builds are named
`diwan`; the npm package and the product are **Diwan**.

To require login (still fully standalone):

```bash
# config.yaml → auth.enabled: true
export DIWAN_JWT_SECRET="$(openssl rand -hex 32)"
./diwan
```

### Develop

```bash
npm run dev:web   # Vite dev server (:5173) + Go API (:8080), live reload
```

Open <http://localhost:5173>.

### Install from the Vulos app store

Diwan also installs as a one-click app on a **Vulos OS** box (`DEPLOY_MODE=os`),
where it runs behind the box gateway with scoped storage and single sign-on. It
is the **same binary** — the app store just wires identity and storage for you.
Self-hosting it yourself is always the default path, and never second-class.

---

## Architecture

```mermaid
%%{init: {'theme':'base','themeVariables':{'fontFamily':'ui-monospace, SFMono-Regular, Menlo, monospace','primaryColor':'transparent','primaryBorderColor':'#14b8a6','primaryTextColor':'#8f969e','lineColor':'#8a8f98','nodeBorder':'#5f8f8a','edgeLabelBackground':'transparent','clusterBorder':'#3f8f86','clusterBkg':'transparent'}}}%%
flowchart TD
    FE["React + Vite + Tailwind frontend<br/>Docs · Sheets · Slides · Whiteboards · PDF signing"]
    BE["Go backend (Gin)<br/>handlers · userauth · signing · storage · obs"]
    Seam["backend/seam — Identity · Entitlements · Usage<br/>standalone defaults (local, unlimited, no-op)"]
    Adapter["backend/integration<br/>(optional identity/entitlements adapter, opt-in)"]
    FE -->|"embedded into the binary"| BE
    BE --> Seam
    Seam -->|optional| Adapter
```

Diwan is a **single Go binary with the whole frontend embedded** — one file to
deploy. With zero configuration it runs as a single-user, local-storage app on
your own machine. Everything that *could* tie it to an external service lives
behind a small set of Go interfaces in `backend/seam`; the standalone build
wires local, unlimited, no-op defaults and never imports the optional adapter.

Real-time collaboration is **CRDT-based and always peer-to-peer**: Docs and
whiteboards sync as Yjs updates, Sheets and Slides use LWW/tree CRDTs, all inside
an end-to-end-encrypted room whose key never reaches any server. The only server
role is **content-blind peer discovery** — it learns *that* peers share a random
room id, never any content — and that role can be filled either by a Vulos OS /
Ephor host in front of Diwan, **or by pointing this deployment's own
`config.yaml` (`collab.rendezvous_url` / `VULOS_RENDEZVOUS_URL`) at any
self-hosted `vulos-relayd`**, so a bare standalone binary gets real P2P collab
with no Vulos OS or account at all. In that mode the browser talks to the relayd
**directly** — Diwan's own server is not in the discovery path and sees nothing
of it. See
[docs/COLLABORATION.md](docs/COLLABORATION.md) §3 and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Documentation

Full documentation lives in **[`docs/`](docs/)**.

| Document | Description |
|----------|-------------|
| [Getting started](docs/GETTING-STARTED.md) | Run it locally, in Docker, or in production |
| [Self-hosting](docs/SELFHOST.md) | Run fully standalone; the optional identity/entitlements seam |
| [Collaboration](docs/COLLABORATION.md) | How real-time P2P CRDT editing works, end to end |
| [Architecture](docs/ARCHITECTURE.md) | Component map and design decisions |
| [Configuration](docs/CONFIGURATION.md) | Env vars, `config.yaml`, storage, OTEL reference |
| [API](docs/API.md) | REST API — files, versions, collab, signing |
| [Admin guide](docs/ADMIN-GUIDE.md) | Deploy, back up, and operate the server |
| [Deploy](docs/DEPLOY.md) | Docker, single-box co-location, static CDN |
| [Testing](docs/TESTING.md) | Vitest unit + RTL/MSW integration, Playwright E2E |
| [Roadmap](ROADMAP.md) · [Changelog](CHANGELOG.md) | Plans and version history |

---

## Development

```bash
npm run dev:web        # Vite (:5173) + Go API (:8080)
npm test               # unit + RTL/MSW integration tests (Vitest)
npm run test:e2e       # browser E2E (Playwright, backend mocked)
npm run test:e2e:p2p   # REAL P2P: a live vulos-relayd + two standalone servers
npm run build          # frontend dist/ + Go binary
npm run screenshots    # regenerate the docs/screenshots gallery

go build ./...  &&  go test ./...  &&  go vet ./...
```

> **Frozen invariants:** pure Go (no CGO), JSX only (never `.tsx`), no third-party
> SSO or payment lock-in in the standalone build. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Security

Diwan centralises HTML sanitisation in one audited DOMPurify policy, treats CRDT
ingress as fail-closed, gates read-only collaborators cryptographically, and
enforces per-file ACLs when multi-user auth is on. Found a vulnerability? Please
report it **privately** — see [SECURITY.md](SECURITY.md), [THREAT-MODEL.md](docs/THREAT-MODEL.md),
and [SECURITY-TESTING.md](docs/SECURITY-TESTING.md). Do not open public issues for
security reports.

---

## Contributing

Pull requests are welcome — bug fixes, signing robustness, accessibility, tests,
and docs especially. For major changes, open an issue first. See
[CONTRIBUTING.md](CONTRIBUTING.md) for setup, code style, and the frozen
invariants. No CLA required.

---

## License

[MIT](LICENSE-MIT) OR [Apache-2.0](LICENSE-APACHE) — © VulOS. Diwan is a VulOS
project; source and issues at [github.com/vul-os/diwan](https://github.com/vul-os/diwan).

---

<p align="center">
  <a href="https://vulos.org"><img src="site/assets/vulos-logo.png" alt="vulos" height="20"></a><br>
  <sub><a href="https://vulos.org"><b>vulos</b></a> — open by design</sub>
</p>
