#!/usr/bin/env sh
# Build the itch.io zip: compile TypeScript, inject the config block into
# index.html, strip source maps, and package everything with index.html at
# the zip root (itch requires this).
#
# Mirrors scripts/typecheck.sh: same image, same pinned tsc in a Docker
# volume, but emits into a staging directory instead of --noEmit.
set -eu

TS_VERSION=5.9.3
NODE_TYPES_VERSION=26.1.2
IMAGE=node:22-alpine
VOLUME=unstable-truck-tsc
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

# Ensure the tsc volume is populated (same block as typecheck.sh).
if ! docker run --rm -v "$VOLUME:/ts" "$IMAGE" \
     sh -c 'test -x /ts/node_modules/.bin/tsc && test -d /ts/node_modules/@types/node' 2>/dev/null; then
  echo "Fetching typescript@$TS_VERSION + @types/node@$NODE_TYPES_VERSION into the '$VOLUME' volume (one time)..." >&2
  docker run --rm -v "$VOLUME:/ts" -w /ts "$IMAGE" \
    npm install --silent --no-fund --no-audit \
    "typescript@$TS_VERSION" "@types/node@$NODE_TYPES_VERSION"
fi

STAGE="$ROOT/out/stage"
OUT="$ROOT/out/unstable-truck-itch.zip"
# Previous builds leave root-owned files (Docker writes as root); clean up
# inside a container so ownership doesn't matter, then recreate the directory.
if [ -d "$ROOT/out" ]; then
  docker run --rm -v "$ROOT/out:/out" "$IMAGE" rm -rf /out/stage /out/unstable-truck-itch.zip
fi
mkdir -p "$STAGE"

# --- Compile and strip source maps (inside the container so file ownership
#     isn't a problem) ---
echo "Compiling TypeScript..."
docker run --rm \
  -v "$ROOT:/app:ro" \
  -v "$STAGE:/out" \
  -v "$VOLUME:/ts" \
  -w /app \
  "$IMAGE" sh -c '/ts/node_modules/.bin/tsc --outDir /out/dist --typeRoots /ts/node_modules/@types && find /out/dist -name "*.js.map" -delete'

# --- Copy style.css ---
cp "$ROOT/style.css" "$STAGE/style.css"

# --- Generate itch index.html (inject config block before the main script) ---
CONFIG_BLOCK='<script>\
    window.UNSTABLE_TRUCK_API = "https://lewistrick.com/unstable-truck/";\
    window.UNSTABLE_TRUCK_SHARE_URL = "https://lewistrick.itch.io/unstable-truck";\
    window.UNSTABLE_TRUCK_SRC = "itch";\
  </script>'

sed "s|<script type=\"module\" src=\"dist/main.js\">|${CONFIG_BLOCK}\n  &|" \
  "$ROOT/index.html" > "$STAGE/index.html"

# --- Zip (index.html must be at the root) ---
echo "Packaging..."
(cd "$STAGE" && python3 -m zipfile -c "$OUT" index.html style.css dist)

# --- Post-build assertions ---
LISTING=$(python3 -m zipfile -l "$OUT")

if ! echo "$LISTING" | grep -q '^index\.html '; then
  echo "FAIL: index.html is not at the zip root" >&2
  echo "$LISTING" >&2
  exit 1
fi

for BANNED in logs.html server/ db/ images/ scripts/ .git/; do
  if echo "$LISTING" | grep -q "^$BANNED\|/$BANNED"; then
    echo "FAIL: zip contains '$BANNED'" >&2
    exit 1
  fi
done

SIZE=$(du -h "$OUT" | cut -f1)
echo "Built: $OUT ($SIZE)"
