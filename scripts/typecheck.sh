#!/usr/bin/env sh
# Typecheck the client without installing a Node toolchain on the host.
#
# Every import under src/ is relative and the DOM/ES2022 libs ship inside the
# typescript package, so the client needs only tsc plus @types/node (solver.ts
# reads the `process` global behind a typeof guard) - no `npm ci`, no
# node_modules in the repo. Both live in a Docker volume so they are fetched
# once rather than per run, and the repo is mounted read-only because --noEmit
# writes nothing.
#
# Versions are pinned to what package-lock.json resolves, so a pass here means
# the same thing as a pass in the Docker build.
#
# Usage: scripts/typecheck.sh [extra tsc args]
#   e.g. scripts/typecheck.sh --watch
set -eu

TS_VERSION=5.9.3
NODE_TYPES_VERSION=26.1.2
IMAGE=node:22-alpine
VOLUME=unstable-truck-tsc
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

if ! docker run --rm -v "$VOLUME:/ts" "$IMAGE" \
     sh -c 'test -x /ts/node_modules/.bin/tsc && test -d /ts/node_modules/@types/node' 2>/dev/null; then
  echo "Fetching typescript@$TS_VERSION + @types/node@$NODE_TYPES_VERSION into the '$VOLUME' volume (one time)..." >&2
  docker run --rm -v "$VOLUME:/ts" -w /ts "$IMAGE" \
    npm install --silent --no-fund --no-audit \
    "typescript@$TS_VERSION" "@types/node@$NODE_TYPES_VERSION"
fi

exec docker run --rm \
  -v "$ROOT:/app:ro" \
  -v "$VOLUME:/ts" \
  -w /app \
  "$IMAGE" /ts/node_modules/.bin/tsc \
  --noEmit --typeRoots /ts/node_modules/@types "$@"
