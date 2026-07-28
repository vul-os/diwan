# Dockerfile — Diwan deploy image (Go server + embedded Vite SPA).
#
# Produces the image the README advertises as
#   ghcr.io/vul-os/diwan:latest
# a single static Go binary that EMBEDS the built SPA (//go:embed all:dist in
# main.go) and serves everything on :8080. Runs completely standalone — no
# config file, no cloud, no account.
#
# ── BUILD CONTEXT (read before building) ──────────────────────────────────────
# Diwan's WebRTC collaboration fabric is first-party source under
# src/lib/collab/webrtc/ (no vendored npm package, no sibling-repo checkout of
# any kind needed), so a plain clone-and-build works with the repo itself as
# the build context:
#
#   docker build -t ghcr.io/vul-os/diwan:latest .
#
# Run:
#   docker run -d --name diwan -p 8080:8080 \
#     -v diwan-data:/srv/data -v diwan-uploads:/srv/uploads \
#     ghcr.io/vul-os/diwan:latest
#   # open http://localhost:8080

# ── Stage 1: build the SPA ─────────────────────────────────────────────────────
FROM node:20-bookworm AS web
WORKDIR /build
COPY . /build
# Drop any node_modules dragged in from the host (there is no .dockerignore
# excluding it). Host node_modules can hold platform-native binaries (e.g.
# macOS rollup) that break under Linux — force clean Linux installs.
RUN rm -rf /build/node_modules
# `npm ci` needs a lockfile in sync; the repo ships package-lock.json. Fall
# back to `npm install` only if ci fails (e.g. lockfile drifted locally).
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
# Produces dist/ (the embedded SPA). vite.config.js recreates dist/.gitkeep.
RUN npm run build:frontend

# ── Stage 2: build the static Go binary ───────────────────────────────────────
FROM golang:1.25-bookworm AS build
ARG VERSION=docker
WORKDIR /build
COPY . /build
# Overlay the freshly-built SPA so //go:embed all:dist bakes in real assets
# instead of the committed dist/.gitkeep placeholder.
COPY --from=web /build/dist /build/dist
RUN go mod download
# Pure-Go (Postgres via pgx, local storage without cgo) — CGO off yields a
# static binary that runs on a tiny alpine runtime.
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath \
    -ldflags="-s -w -X main.Version=${VERSION}" \
    -o /out/diwan .

# ── Stage 3: minimal non-root runtime ─────────────────────────────────────────
FROM alpine:3.20
# ca-certificates for outbound TLS (optional identity/entitlements seam, OTLP);
# wget for the healthcheck.
RUN apk add --no-cache ca-certificates wget \
 && adduser -D -u 10001 vulos
COPY --from=build /out/diwan /usr/local/bin/diwan
# The server's data_dir/uploads_dir default to ./data and ./uploads relative to
# CWD. Run from /srv and pre-create both subdirs (owned by vulos) so local
# storage + uploads have a writable home. Declare BOTH as volumes: /srv/data
# holds SQLite stores + the JSON file store (documents), and /srv/uploads holds
# uploaded file staging — without a volume there too, uploads are lost on
# container recreation even though /srv/data is persisted.
WORKDIR /srv
RUN mkdir -p /srv/data /srv/uploads && chown -R vulos:vulos /srv
USER vulos
VOLUME ["/srv/data", "/srv/uploads"]
EXPOSE 8080
# Liveness: main.go serves GET /healthz on :8080.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/usr/local/bin/diwan"]
