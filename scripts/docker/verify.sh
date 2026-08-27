#!/usr/bin/env bash
# Full-chain verification of the zcode-webui npm package inside a real Docker
# container, using a SANDBOX COPY of your local official ZCode data (~/.zcode:
# runtime + credentials). The copy is mounted at run time only and deleted
# afterwards — no credentials ever enter the image layers or this repository.
#
# Usage:
#   bash scripts/docker/verify.sh                # pack + build + run + cleanup
#   ZCODE_VERIFY_REGISTRY=1 bash scripts/docker/verify.sh   # install from npmjs registry instead
#   ZCODE_VERIFY_SKIP_FETCH=1 bash scripts/docker/verify.sh # reuse sandbox renderer, skip CDN download
#   ZCODE_VERIFY_KEEP=1 bash scripts/docker/verify.sh       # keep the staging dir for debugging
#
# Overridable environment:
#   ZCODE_VERIFY_SOURCE    local .zcode dir to sandbox       (default: $HOME/.zcode)
#   ZCODE_VERIFY_NETWORK   docker network to join            (default: auto viki-net)
#   ZCODE_VERIFY_PROXY     http proxy for the container      (default: auto glash on that network)
#   ZCODE_VERIFY_IMAGE     image tag                         (default: zcode-webui-verify:local)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STAGE="$(mktemp -d /tmp/zcode-webui-verify.XXXXXX)"
CTX="$STAGE/ctx"
SANDBOX="$STAGE/zcode-sandbox"
IMAGE="${ZCODE_VERIFY_IMAGE:-zcode-webui-verify:local}"
SOURCE="${ZCODE_VERIFY_SOURCE:-$HOME/.zcode}"
KEEP="${ZCODE_VERIFY_KEEP:-0}"

cleanup() {
  docker rm -f zcode-webui-verify >/dev/null 2>&1 || true
  if [ "$KEEP" = "1" ]; then
    echo "[verify] keeping staging dir: $STAGE"
  else
    rm -rf "$STAGE"
  fi
}
trap cleanup EXIT

# ---- proxy / network autodetect ----
NET="${ZCODE_VERIFY_NETWORK:-}"
PROXY="${ZCODE_VERIFY_PROXY:-}"
if [ -z "$NET" ]; then
  for cand in viki-net lobehub-sandbox-mcp_default; do
    if docker network inspect "$cand" >/dev/null 2>&1; then NET="$cand"; break; fi
  done
  [ -n "$NET" ] || { echo "no docker network found; set ZCODE_VERIFY_NETWORK"; exit 1; }
fi
if [ -z "$PROXY" ]; then
  # auto-discover a local proxy: prefer a container named "glash", fall back to
  # the docker network gateway, then probe each candidate on port 7890
  IPS="$(docker inspect glash -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' 2>/dev/null | tr ' ' '\n' | grep -v '^$' || true)"
  [ -n "$IPS" ] || IPS="$(docker network inspect "$NET" -f '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null)"
  for ip in $IPS; do
    if docker run --rm --network "$NET" curlimages/curl:latest -sf -o /dev/null -x "http://$ip:7890" --max-time 5 https://zcode.z.ai/ 2>/dev/null; then
      PROXY="http://$ip:7890"; break
    fi
  done
  [ -n "$PROXY" ] || { echo "no reachable proxy on network $NET; set ZCODE_VERIFY_PROXY"; exit 1; }
fi
echo "[verify] network=$NET proxy=$PROXY"

# ---- package artifact ----
mkdir -p "$CTX"
if [ "${ZCODE_VERIFY_REGISTRY:-0}" = "1" ]; then
  PKG="${ZCODE_VERIFY_PKG:-@aixyzstudio/zcode-webui}"
  echo "[verify] installing from registry: $PKG"
  cat > "$CTX/Dockerfile" <<'EOF'
FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends dpkg-dev curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /root/.zcode-webui/vendor/renderer /root/.zcode/v2 /root/.zcode/cli
ARG ZCODE_VERIFY_PKG
RUN npm install -g "${ZCODE_VERIFY_PKG}" --registry=https://registry.npmjs.org
COPY container-verify.sh /usr/local/bin/container-verify
RUN chmod +x /usr/local/bin/container-verify
CMD ["container-verify"]
EOF
  DOCKER_BUILD_ARGS=(--build-arg "ZCODE_VERIFY_PKG=$PKG")
else
  echo "[verify] packing local tarball"
  (cd "$ROOT" && rm -f *.tgz && npm pack >/dev/null)
  TGZ="$(ls "$ROOT"/*.tgz | head -1)"
  cp "$TGZ" "$CTX/zcode-webui.tgz"
  rm -f "$TGZ"
  cat > "$CTX/Dockerfile" <<'EOF'
FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends dpkg-dev curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /root/.zcode-webui/vendor/renderer /root/.zcode/v2 /root/.zcode/cli
COPY zcode-webui.tgz /tmp/zcode-webui.tgz
RUN npm install -g /tmp/zcode-webui.tgz
COPY container-verify.sh /usr/local/bin/container-verify
RUN chmod +x /usr/local/bin/container-verify
CMD ["container-verify"]
EOF
  DOCKER_BUILD_ARGS=()
fi
cp "$ROOT/scripts/docker/container-verify.sh" "$CTX/container-verify.sh"

# ---- sandbox copy of the local ZCode data, injected with docker cp at run time ----
# Default: copy the whole ~/.zcode (runtime + credentials) so the chain starts
# from a known-good installation.
# ZCODE_VERIFY_FRESH_RUNTIME=1: copy ONLY the credential/config files and let
# the container prove the automated-setup path (runtime auto-install from the
# official component channel) on a machine that never ran the desktop.
if [ "${ZCODE_VERIFY_FRESH_RUNTIME:-0}" = "1" ]; then
  echo "[verify] fresh-runtime sandbox: credentials only (no server/) -> $SANDBOX"
  mkdir -p "$SANDBOX/v2" "$SANDBOX/cli"
  for f in v2/credentials.json cli/config.json; do
    [ -f "$SOURCE/$f" ] && cp -a "$SOURCE/$f" "$SANDBOX/$f"
  done
  [ -f "$SANDBOX/v2/credentials.json" ] || { echo "no credentials.json under $SOURCE/v2; cannot verify login state"; exit 1; }
else
  [ -d "$SOURCE" ] || { echo "ZCODE_VERIFY_SOURCE not found: $SOURCE"; exit 1; }
  echo "[verify] sandboxing $SOURCE -> $SANDBOX"
  cp -a "$SOURCE" "$SANDBOX"
fi
chmod -R u+rwX "$SANDBOX"

# ---- build & run ----
echo "[verify] docker build -t $IMAGE"
docker build -t "$IMAGE" "${DOCKER_BUILD_ARGS[@]}" "$CTX"

# NOTE: this daemon may live in a different mount namespace (forwarded socket),
# where bind mounts silently appear as empty dirs. Inject the sandbox with
# `docker cp` at run time instead — credentials still never enter the image.
echo "[verify] creating container and copying the sandbox data…"
FRESH="${ZCODE_VERIFY_FRESH_RUNTIME:-0}"
CID="$(docker create --name zcode-webui-verify --network "$NET" \
  -e "ZCODE_VERIFY_PROXY=$PROXY" \
  -e "ZCODE_VERIFY_SKIP_FETCH=${ZCODE_VERIFY_SKIP_FETCH:-0}" \
  -e "ZCODE_VERIFY_FRESH_RUNTIME=$FRESH" \
  "$IMAGE")"
if [ "$FRESH" = "1" ]; then
  # per-file injection so the parent dirs come pre-made from the image
  docker cp "$SANDBOX/v2/." "$CID:/root/.zcode/v2/"
  if [ -f "$SANDBOX/cli/config.json" ]; then
    docker cp "$SANDBOX/cli/config.json" "$CID:/root/.zcode/cli/config.json"
  fi
else
  docker cp "$SANDBOX/." "$CID:/root/.zcode/"
fi
if [ "${ZCODE_VERIFY_SKIP_FETCH:-0}" = "1" ]; then
  # seed the renderer from the repo checkout so the container skips the CDN download
  RSRC="${ZCODE_VERIFY_RENDERER_SRC:-$ROOT/vendor/renderer}"
  if [ -d "$RSRC/index.html" ] || [ -f "$RSRC/index.html" ]; then
    docker cp "$RSRC/." "$CID:/root/.zcode-webui/vendor/renderer/"
  else
    echo "[verify] WARNING: ZCODE_VERIFY_SKIP_FETCH=1 but no renderer at $RSRC"
  fi
fi
echo "[verify] docker start -a (full chain inside the container)…"
docker start -a "$CID"
echo "[verify] PASS"
