#!/usr/bin/env bash
# Runs INSIDE the verification container (see verify.sh).
# Full chain: doctor -> setup wizard (--yes) -> service start -> health ->
# packaged smoke test (static + base path + WS/HTTP bridges + host round trip)
# -> real model turn through the official CLI with the mounted credentials.
set -euo pipefail

export ZCODE_WEBUI_HOME="${ZCODE_WEBUI_HOME:-/root/.zcode-webui}"
PROXY="${ZCODE_VERIFY_PROXY:-}"
PORT=3102
mkdir -p /workspace
cd /workspace

echo "===== 1. doctor ====="
zcode-webui doctor

echo "===== 2. setup (non-interactive) ====="
EXTRA=()
[ -n "$PROXY" ] && EXTRA+=(--oauth-proxy "$PROXY" --host-proxy "$PROXY")
if [ "${ZCODE_VERIFY_SKIP_FETCH:-0}" = "1" ]; then EXTRA+=(--no-fetch); fi
zcode-webui setup --yes --port "$PORT" --workspace /workspace "${EXTRA[@]}"
echo "config written:"; cat "$ZCODE_WEBUI_HOME/config.json"

echo "===== 3. start + health ====="
zcode-webui start --port "$PORT" > /tmp/zcode-webui.log 2>&1 &
SRV_PID=$!
trap 'kill $SRV_PID 2>/dev/null || true' EXIT
HEALTH=""
for _ in $(seq 1 60); do
  if HEALTH="$(curl -sf "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)"; then
    [ -n "$HEALTH" ] && break
  fi
  sleep 1
done
if [ -z "$HEALTH" ]; then
  echo "FATAL: service did not become healthy"; tail -40 /tmp/zcode-webui.log; exit 1
fi
echo "$HEALTH"
echo "$HEALTH" | grep -q '"loggedIn":true' || { echo "FATAL: credentials not usable in container"; exit 1; }
echo "$HEALTH" | grep -q '"rendererLoaded":true' || { echo "FATAL: renderer not loaded"; exit 1; }

echo "===== 4. packaged smoke test ====="
node "$(npm root -g)/@aixyzstudio/zcode-webui/scripts/smoke-test.mjs" "" "$PORT"

echo "===== 5. real model turn via the official CLI (mounted credentials) ====="
CLI="/root/.zcode/server/agents/glm/zcode.cjs"
[ -f "$CLI" ] || CLI="$(find /root/.zcode -name zcode.cjs -path '*agents*' | head -1)"
export ZCODE_HTTP_PROXY="$PROXY" ZCODE_NO_PROXY="localhost,127.0.0.1"
OUT="$(/root/.zcode/server/node "$CLI" --cwd /workspace --prompt '只回复 ok 两个字，不要做任何其他操作' --locale zh-CN 2>&1 | tail -3 || true)"
echo "$OUT"
echo "$OUT" | grep -q 'ok' || { echo "FATAL: model turn failed"; exit 1; }

echo "===== 6. stop ====="
kill "$SRV_PID" 2>/dev/null || true
wait "$SRV_PID" 2>/dev/null || true
echo "CONTAINER-VERIFY OK"
