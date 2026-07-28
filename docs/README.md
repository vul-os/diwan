# Diwan — Documentation Index

| Document | Description |
|----------|-------------|
| [GETTING-STARTED.md](GETTING-STARTED.md) | Full setup walkthrough (dev + prod + Docker + bundle) |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Component map, collaboration transports, key design decisions |
| [API.md](API.md) | REST API reference (files, versions, collab, signing) |
| [CONFIGURATION.md](CONFIGURATION.md) | All env vars, config.yaml reference, OTEL/SMTP/storage |
| [COLLABORATION.md](COLLABORATION.md) | How real-time P2P collaboration works end to end |
| [COTURN.md](COTURN.md) | Self-hosting a TURN server (coturn) for collaboration behind strict NAT |
| [TESTING.md](TESTING.md) | Test layers (Vitest unit + RTL/MSW integration, Playwright E2E) |
| [SCREENSHOTS.md](SCREENSHOTS.md) | Screenshot gallery + how to regenerate |
| [DEPLOY.md](DEPLOY.md) | Deployment guide — Docker, single-box co-location |
| [DEPLOY-STATIC.md](DEPLOY-STATIC.md) | Static SPA deploy to Tigris / the app hub CDN |
| [INSTALL.md](INSTALL.md) | Single-box install with Vulos OS + shared storage |
| [SELFHOST.md](SELFHOST.md) | Run fully standalone; the optional identity/entitlements seam |
| [SECURITY-TESTING.md](SECURITY-TESTING.md) | Adversarial pentest suite and threat coverage |
| [THREAT-MODEL.md](THREAT-MODEL.md) | STRIDE threat model |
| [SLOs.md](SLOs.md) | Service level objectives |
| [RELEASING.md](RELEASING.md) | Release policy and CI pipeline |
| [../src/design/DESIGN.md](../src/design/DESIGN.md) | Design system (near-black token model, primitives) |
| [../ROADMAP.md](../ROADMAP.md) | Planned features, milestones, and Now/Next/Later status |
| [../CHANGELOG.md](../CHANGELOG.md) | Version history |
| [../SECURITY.md](../SECURITY.md) | Security policy |

## Quick links

- Backend entry point: `main.go` (Gin HTTP server)
- File/version API: `backend/handlers/`
- PDF signing: `backend/signing/`
- Observability: `backend/obs/` + `GET /metrics`
- Library exports: `src/lib/index.js`, `src/apps/*/lib.jsx`
