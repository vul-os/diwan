#!/usr/bin/env bash
# deploy-static.sh — build and upload Diwan static bundles to Tigris CDN.
#
# Usage:
#   ./scripts/deploy-static.sh [office|all] [--latest]
#
# Required env vars:
#   TIGRIS_ACCESS_KEY_ID      — Tigris access key
#   TIGRIS_SECRET_ACCESS_KEY  — Tigris secret key
#   TIGRIS_BUCKET             — target bucket name (e.g. diwan-static)
#
# Optional:
#   TIGRIS_ENDPOINT           — defaults to https://fly.storage.tigris.dev

set -euo pipefail

TARGET="${1:-all}"
LATEST=false
for arg in "$@"; do
  [[ "$arg" == "--latest" ]] && LATEST=true
done

: "${TIGRIS_ACCESS_KEY_ID:?TIGRIS_ACCESS_KEY_ID is required}"
: "${TIGRIS_SECRET_ACCESS_KEY:?TIGRIS_SECRET_ACCESS_KEY is required}"
: "${TIGRIS_BUCKET:?TIGRIS_BUCKET is required}"
TIGRIS_ENDPOINT="${TIGRIS_ENDPOINT:-https://fly.storage.tigris.dev}"

GIT_SHA="$(git rev-parse --short HEAD)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ALL_TARGETS=(office)

if [[ "$TARGET" == "all" ]]; then
  TARGETS=("${ALL_TARGETS[@]}")
else
  TARGETS=("$TARGET")
fi

export AWS_ACCESS_KEY_ID="$TIGRIS_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$TIGRIS_SECRET_ACCESS_KEY"
export AWS_REGION="auto"

for t in "${TARGETS[@]}"; do
  echo "==> Building $t …"
  (cd "$REPO_ROOT" && npx vite build --config "vite.config.${t}.js")

  DIST_DIR="$REPO_ROOT/dist-${t}"
  S3_PATH="s3://${TIGRIS_BUCKET}/${t}/${GIT_SHA}/"

  echo "==> Uploading $DIST_DIR → $S3_PATH"
  aws s3 sync "$DIST_DIR" "$S3_PATH" \
    --endpoint-url "$TIGRIS_ENDPOINT" \
    --no-progress \
    --delete

  CDN_URL="https://cdn.vulos.org/${t}/${GIT_SHA}/"
  echo "    CDN: $CDN_URL"

  if [[ "$LATEST" == true ]]; then
    echo -n "$GIT_SHA" | aws s3 cp - "s3://${TIGRIS_BUCKET}/${t}/latest" \
      --endpoint-url "$TIGRIS_ENDPOINT" \
      --content-type "text/plain"
    echo "    Latest pointer: https://cdn.vulos.org/${t}/latest → $GIT_SHA"
  fi
done

echo ""
echo "Done. Deployed SHA: $GIT_SHA"
echo "CDN URLs:"
for t in "${TARGETS[@]}"; do
  echo "  https://cdn.vulos.org/${t}/${GIT_SHA}/"
done
