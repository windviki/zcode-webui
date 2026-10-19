#!/usr/bin/env bash
# Fetch the official ZCode desktop client and extract its renderer (the web UI)
# into vendor/renderer. Version pinned via ZCODE_VERSION (default 3.15.3 — keep
# in sync with PINNED_VERSION in zcode-update.sh and DEFAULT_VERSION in
# src/upgrade.mjs).
#
# The extraction is staged under $DATA_HOME/.fetch-tmp.XXXXXX and only swapped
# into place once index.html and the hashed entry asset are both present, so a
# failed or interrupted download never leaves a half-written renderer behind.
# The previous renderer is kept as vendor/renderer.bak-<version>-<ts> (newest 2
# kept) so a bad official release can be rolled back by renaming it back.
#
# Env: ZCODE_VERSION, ZCODE_ARCH (x64|arm64), FORCE=1 (re-fetch even if present),
#      ZCODE_URL (override the .deb URL), ZCODE_WEBUI_HOME (data home override).
set -euo pipefail

VERSION="${ZCODE_VERSION:-3.15.3}"
ARCH="${ZCODE_ARCH:-x64}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# ZCODE_WEBUI_HOME redirects all mutable state away from the package directory
# (used by the npm-installed CLI; unset = repo checkout layout)
DATA_HOME="${ZCODE_WEBUI_HOME:-$ROOT}"
DEST="$DATA_HOME/vendor/renderer"
WORK=""

cleanup() { if [ -n "$WORK" ] && [ -d "$WORK" ]; then rm -rf "$WORK"; fi; }
trap cleanup EXIT

for tool in curl dpkg-deb node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: '$tool' is required but not installed" >&2; exit 1; }
done

if [ -f "$DEST/index.html" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "renderer already present at $DEST (set FORCE=1 to re-fetch)"
  exit 0
fi

URL="${ZCODE_URL:-https://cdn-zcode.z.ai/zcode/electron/releases/$VERSION/linux-$ARCH/ZCode-$VERSION-linux-$ARCH.deb}"

# The staging dir must share a filesystem with $DEST for the final mv(1) to be atomic.
mkdir -p "$DATA_HOME"
WORK="$(mktemp -d "$DATA_HOME/.fetch-tmp.XXXXXX")"

echo ">> downloading $URL"
curl --fail -L --retry 3 -sS -o "$WORK/zcode.deb" "$URL"
echo ">> deb size $(du -h "$WORK/zcode.deb" | cut -f1)"

echo ">> extracting deb"
dpkg-deb -x "$WORK/zcode.deb" "$WORK/debroot"
ASAR="$(find "$WORK/debroot" -name app.asar | head -1)"
if [ -z "$ASAR" ]; then echo "ERROR: app.asar not found in $URL" >&2; exit 1; fi

echo ">> extracting asar ($ASAR)"
node "$ROOT/scripts/extract-asar.cjs" "$ASAR" "$WORK/app"

SRC="$WORK/app/out/renderer"
if [ ! -f "$SRC/index.html" ]; then echo "ERROR: $SRC/index.html missing — 官方包结构异常" >&2; exit 1; fi
if ! ls "$SRC"/assets/index-*.js >/dev/null 2>&1; then echo "ERROR: no assets/index-*.js in extracted renderer" >&2; exit 1; fi

echo ">> staging renderer"
STAGE="$WORK/renderer"
cp -R "$SRC" "$STAGE"
printf '%s\n' "$VERSION" > "$STAGE/.version"

echo ">> swapping renderer into place"
mkdir -p "$(dirname "$DEST")"
PREV_VERSION=""
if [ -f "$DEST/.version" ]; then PREV_VERSION="$(tr -d ' \n' < "$DEST/.version")"; fi
BACKUP=""
if [ -d "$DEST" ]; then
  BACKUP="$DEST.bak-${PREV_VERSION:-unknown}-$(date +%s)"
  mv "$DEST" "$BACKUP"
fi
if ! mv "$STAGE" "$DEST"; then
  if [ -n "$BACKUP" ]; then mv "$BACKUP" "$DEST"; fi
  echo "ERROR: renderer swap failed" >&2
  exit 1
fi

# prune old renderer backups, newest 2 kept
if [ -n "$BACKUP" ]; then
  while IFS= read -r p; do
    [ -n "$p" ] && rm -rf "$p"
  done < <(ls -1dt "$DEST".bak-* 2>/dev/null | tail -n +3 || true)
  echo ">> previous renderer kept at $BACKUP"
fi

echo "renderer ready: $DEST (v$VERSION, $(du -sh "$DEST" | cut -f1))"
