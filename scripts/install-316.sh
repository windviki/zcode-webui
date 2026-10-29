#!/usr/bin/env bash
# Install a ZCode >= 3.16 runtime (and optionally its renderer) for zcode-webui.
#
# Why this is a separate script: 3.16 stopped publishing the per-component
# manifest (manifest-<platform>.json) that zcode-update.sh consumes — the desktop
# app now BUNDLES its host. The pieces still exist, just inside the platform
# installer:
#
#   <deb>/opt/ZCode/resources/app.asar   → app/out/{host,renderer,metadata,...}
#   <deb>/opt/ZCode/resources/glm        → the agent CLI (zcode.cjs) + packages
#   <deb>/opt/ZCode/resources/tools      → bfs / ripgrep / ugrep
#   <deb>/opt/ZCode/resources/config     → provider catalog (zcode-builtin.json)
#
# The runtime is installed into its OWN directory (default ~/.zcode/server-3.16)
# so the 3.15 runtime stays intact: switching back is pointing
# ZCODE_SERVER_RUNTIME_ROOT at the old directory (or moving the symlink back).
#
# Usage:
#   scripts/install-316.sh <ZCode-x.y.z-linux-x64.deb> [--dest DIR] [--renderer] [--force]
#
#   --dest DIR    install the runtime here (default: $ZCODE_HOME/server-3.16,
#                 i.e. ~/.zcode/server-3.16)
#   --renderer    also replace vendor/renderer with this version (previous one
#                 is kept as vendor/renderer.bak-<version>-<ts>)
#   --force       install even when DIR already has a newer/equal version
#
# After installing:
#   * runtime-only trial:  ZCODE_SERVER_RUNTIME_ROOT=<DEST> ./zcode-service.sh restart
#   * full switch:         install with --renderer, then restart the service
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_HOME="${ZCODE_WEBUI_HOME:-$ROOT}"
ZCODE_HOME_DIR="${ZCODE_HOME:-$HOME/.zcode}"

DEB=""
DEST=""
WITH_RENDERER=0
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dest) DEST="${2:?--dest needs a directory}"; shift 2 ;;
    --renderer) WITH_RENDERER=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) DEB="$1"; shift ;;
  esac
done

DEST="${DEST:-$ZCODE_HOME_DIR/server-3.16}"

for tool in dpkg-deb node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: '$tool' is required" >&2; exit 1; }
done
[ -n "$DEB" ] && [ -f "$DEB" ] || { echo "ERROR: pass the official .deb (see --help)" >&2; exit 2; }

log() { printf '[install-316] %s\n' "$*"; }
die() { printf '[install-316] ERROR: %s\n' "$*" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/zcode316.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

log "unpacking $(basename "$DEB")"
dpkg-deb -x "$DEB" "$WORK/deb"
RES="$WORK/deb/opt/ZCode/resources"
[ -f "$RES/app.asar" ] || die "app.asar not found — is this an official 3.16+ installer?"

log "extracting app.asar (this takes a moment)"
node "$SCRIPT_DIR/extract-asar.cjs" "$RES/app.asar" "$WORK/app" >/dev/null
[ -f "$WORK/app/out/host/index.js" ] || die "out/host/index.js missing — this build predates 3.16?"

VER=""
if [ -f "$WORK/app/out/metadata/build-meta.json" ]; then
  VER="$(node -e 'try{process.stdout.write(String(require(process.argv[1]).appVersion||""))}catch(e){}' \
        "$WORK/app/out/metadata/build-meta.json")"
fi
[ -n "$VER" ] || die "cannot read out/metadata/build-meta.json (no version stamp)"
log "package version: $VER"

if [ -d "$DEST" ] && [ -f "$DEST/.version" ] && [ "$FORCE" != "1" ]; then
  CUR="$(tr -d ' \n' < "$DEST/.version")"
  if [ "$CUR" = "$VER" ]; then
    log "already installed at $DEST (v$CUR) — use --force to reinstall"
    exit 0
  fi
fi

log "staging runtime in $DEST"
mkdir -p "$DEST"
# app/ = the extracted asar (out/* + package.json + bundled node_modules)
rm -rf "$DEST/app.new"
mkdir -p "$DEST/app.new"
cp -a "$WORK/app/." "$DEST/app.new/"
for part in glm tools config; do
  [ -e "$RES/$part" ] || die "resources/$part missing from the installer"
  rm -rf "$DEST/$part.new"
  cp -a "$RES/$part" "$DEST/$part.new"
done
# The 3.16 host walks up from its cwd looking for this monorepo path to find the
# agent runtime entry (see resolveBundledWorkspaceZCodeAgentCommand). Keeping it
# as a symlink avoids a second 114 MB copy of glm/.
rm -rf "$DEST/apps.new"
mkdir -p "$DEST/apps.new/zcode-cli/packages/cli"
ln -s ../../../../glm "$DEST/apps.new/zcode-cli/packages/cli/dist"

rm -rf "$DEST/app" "$DEST/glm" "$DEST/tools" "$DEST/config" "$DEST/apps"
mv "$DEST/app.new" "$DEST/app"
mv "$DEST/glm.new" "$DEST/glm"
mv "$DEST/tools.new" "$DEST/tools"
mv "$DEST/config.new" "$DEST/config"
mv "$DEST/apps.new" "$DEST/apps"
printf '%s\n' "$VER" > "$DEST/.version"
log "runtime installed: $DEST (v$VER)"

if [ "$WITH_RENDERER" = "1" ]; then
  SRC="$DEST/app/out/renderer"
  [ -f "$SRC/index.html" ] || die "renderer not found inside the package"
  RENDERER_DIR="$DATA_HOME/vendor/renderer"
  PREV=""
  if [ -f "$RENDERER_DIR/.version" ]; then PREV="$(tr -d ' \n' < "$RENDERER_DIR/.version")"; fi
  BACKUP=""
  if [ -d "$RENDERER_DIR" ]; then
    BACKUP="$RENDERER_DIR.bak-${PREV:-unknown}-$(date +%s)"
    mv "$RENDERER_DIR" "$BACKUP"
    log "previous renderer kept at $BACKUP"
  fi
  mkdir -p "$(dirname "$RENDERER_DIR")"
  cp -a "$SRC" "$RENDERER_DIR"
  printf '%s\n' "$VER" > "$RENDERER_DIR/.version"
  log "renderer installed: $RENDERER_DIR (v$VER)"
else
  log "renderer NOT replaced (add --renderer to switch the UI as well)"
fi

cat <<EOF

next steps
  trial (keeps the current default runtime untouched):
    ZCODE_SERVER_RUNTIME_ROOT=$DEST $ROOT/zcode-service.sh restart
    # rollback: unset it and restart again
  make it the default:
    mv $ZCODE_HOME_DIR/server $ZCODE_HOME_DIR/server-3.15 && ln -s $DEST $ZCODE_HOME_DIR/server
EOF
