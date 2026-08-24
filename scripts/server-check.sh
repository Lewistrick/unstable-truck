#!/usr/bin/env sh
# Compile the server and run the checks that don't need a database.
#
# Same Docker trick as scripts/typecheck.sh and scripts/typecheck-server.sh: no
# Node toolchain on the host, dependencies pinned to package-lock.json in a
# volume, repo mounted read-only and copied into a writable layer.
#
# Unlike a typecheck this actually emits and runs code, so it covers the two
# server modules that import nothing external - password.ts and rate-limit.ts.
# Everything else in server/ needs a live Postgres and an HTTP client to
# exercise, and stays unverified until deploy.
#
# Usage: scripts/server-check.sh
set -eu

IMAGE=node:22-alpine
VOLUME=unstable-truck-server-deps
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

"$(dirname -- "$0")/typecheck-server.sh" >/dev/null

exec docker run --rm \
  -v "$ROOT:/src:ro" \
  -v "$VOLUME:/deps" \
  "$IMAGE" sh -c '
    set -eu
    mkdir -p /app
    cp -r /src/server /src/scripts /src/tsconfig.json /src/package.json /app/
    ln -s /deps/node_modules /app/node_modules
    cd /app
    /deps/node_modules/.bin/tsc -p server/tsconfig.json
    node scripts/password-check.mjs
    echo
    node scripts/rate-limit-check.mjs
    echo
    node scripts/account-state-check.mjs
  '
