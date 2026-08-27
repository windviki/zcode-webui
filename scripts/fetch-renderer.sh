#!/usr/bin/env bash
# Fetch the official ZCode desktop client and extract its renderer (the web UI)
# into vendor/renderer. Version pinned via ZCODE_VERSION (default 3.9.2 — keep
# in sync with DEFAULT_VERSION in src/upgrade.mjs).
set -euo pipefail

VERSION="${ZCODE_VERSION:-3.9.2}"
ARCH="${ZCODE_ARCH:-x64}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# ZCODE_WEBUI_HOME redirects all mutable state away from the package directory
# (used by the npm-installed CLI; unset = repo checkout layout)
DATA_HOME="${ZCODE_WEBUI_HOME:-$ROOT}"
WORK="$DATA_HOME/.fetch-tmp"
DEST="$DATA_HOME/vendor/renderer"

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

for tool in curl dpkg-deb node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: '$tool' is required but not installed" >&2; exit 1; }
done

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
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
cp -R "$WORK/app/out/renderer" "$DEST"
printf '%s\n' "$VERSION" > "$DEST/.version"

echo "renderer ready: $DEST ($(du -sh "$DEST" | cut -f1))"
