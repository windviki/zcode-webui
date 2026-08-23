#!/usr/bin/env bash
# Fetch the official ZCode desktop client and extract its renderer (the web UI)
# into vendor/renderer. Version pinned via ZCODE_VERSION (default 3.8.1).
set -euo pipefail

VERSION="${ZCODE_VERSION:-3.8.1}"
ARCH="${ZCODE_ARCH:-x64}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$ROOT/.fetch-tmp"
DEST="$ROOT/vendor/renderer"

if [ -f "$DEST/index.html" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "renderer already present at $DEST (set FORCE=1 to re-fetch)"
  exit 0
fi

URL="${ZCODE_URL:-https://cdn-zcode.z.ai/zcode/electron/releases/$VERSION/linux-$ARCH/ZCode-$VERSION-linux-$ARCH.deb}"
echo ">> downloading $URL"
rm -rf "$WORK"; mkdir -p "$WORK"
curl --fail -L --retry 3 -sS -o "$WORK/zcode.deb" "$URL"

echo ">> extracting deb"
dpkg-deb -x "$WORK/zcode.deb" "$WORK/debroot"
ASAR="$(find "$WORK/debroot" -name app.asar | head -1)"
if [ -z "$ASAR" ]; then echo "app.asar not found"; exit 1; fi

echo ">> extracting asar ($ASAR)"
node "$ROOT/scripts/extract-asar.cjs" "$ASAR" "$WORK/app"

echo ">> copying renderer"
rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
cp -R "$WORK/app/out/renderer" "$DEST"
printf '%s\n' "$VERSION" > "$DEST/.version"

echo ">> cleaning up"
rm -rf "$WORK"
echo "renderer ready: $DEST ($(du -sh "$DEST" | cut -f1))"
