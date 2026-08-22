#!/usr/bin/env sh
# Typecheck the server without installing a Node toolchain on the host.
#
# The companion to scripts/typecheck.sh, which covers the client only. The
# client needs nothing but tsc, because every import under src/ is relative -
# server/ imports express and pg, so it needs those packages (and their types)
# actually present to resolve `import express from "express"`.
#
# They live in their own Docker volume, fetched once, at the versions
# package-lock.json resolves - so a pass here means the same thing as the
# server half of `npm run build`. The repo is mounted read-only and copied into
# a writable layer, because NodeNext resolution wants node_modules to sit next
# to the sources and the real checkout has none.
#
# What this does NOT cover: running anything. It is a type check, not a test -
# no DB, no HTTP, no express at runtime.
#
# Usage: scripts/typecheck-server.sh [extra tsc args]
set -eu

TS_VERSION=5.9.3
NODE_TYPES_VERSION=26.1.2
EXPRESS_VERSION=5.2.1
EXPRESS_TYPES_VERSION=5.0.6
PG_VERSION=8.22.0
PG_TYPES_VERSION=8.20.3
IMAGE=node:22-alpine
VOLUME=unstable-truck-server-deps
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

if ! docker run --rm -v "$VOLUME:/deps" "$IMAGE" \
     sh -c 'test -x /deps/node_modules/.bin/tsc && test -d /deps/node_modules/express && test -d /deps/node_modules/pg' 2>/dev/null; then
  echo "Fetching server typecheck dependencies into the '$VOLUME' volume (one time)..." >&2
  docker run --rm -v "$VOLUME:/deps" -w /deps "$IMAGE" \
    npm install --silent --no-fund --no-audit \
    "typescript@$TS_VERSION" "@types/node@$NODE_TYPES_VERSION" \
    "express@$EXPRESS_VERSION" "@types/express@$EXPRESS_TYPES_VERSION" \
    "pg@$PG_VERSION" "@types/pg@$PG_TYPES_VERSION"
fi

exec docker run --rm \
  -v "$ROOT:/src:ro" \
  -v "$VOLUME:/deps" \
  "$IMAGE" sh -c '
    set -eu
    mkdir -p /app
    # package.json comes along for its "type": "module" - NodeNext decides
    # ESM-vs-CommonJS from the nearest package.json, and without it every
    # import.meta in server/ is an error.
    cp -r /src/server /src/tsconfig.json /src/package.json /app/
    ln -s /deps/node_modules /app/node_modules
    cd /app
    exec /deps/node_modules/.bin/tsc -p server/tsconfig.json --noEmit "$@"
  ' -- "$@"
