#!/usr/bin/env bash
# Runs INSIDE the verification container (see verify.sh).
# Full chain:
#   doctor -> setup --yes (fresh env: AUTO-install renderer + official runtime,
#             write config, start detached, wait healthy) -> health assertions
#             -> packaged smoke (WS + HTTP bridges + host round trip)
#             -> upgrade no-op check -> real model turn via the official CLI
#             -> terminate sessions -> `zcode-webui stop` dogfood.
# ZCODE_VERIFY_FRESH_RUNTIME=1 makes step 2 prove the fully automated install
# path on a machine that never ran the official desktop.
set -euo pipefail

export ZCODE_WEBUI_HOME="${ZCODE_WEBUI_HOME:-/root/.zcode-webui}"
PROXY="${ZCODE_VERIFY_PROXY:-}"
# make every remote operation (version probe, component downloads, renderer
# fetch, model turn) go through the sandbox proxy up front
[ -n "$PROXY" ] && export ZCODE_HTTP_PROXY="$PROXY" ZCODE_NO_PROXY="localhost,127.0.0.1"
PORT=3102
FRESH="${ZCODE_VERIFY_FRESH_RUNTIME:-0}"
mkdir -p /workspace
cd /workspace

echo "===== 1. doctor ====="
DOCTOR_OUT="$(zcode-webui doctor)"
echo "$DOCTOR_OUT"
if [ "$FRESH" = "1" ]; then
  echo "$DOCTOR_OUT" | grep -q 'runtime: MISSING' || { echo "FATAL: fresh sandbox should report runtime MISSING"; exit 1; }
fi

echo "===== 2. setup --yes (one-shot automated deploy) ====="
EXTRA=()
[ -n "$PROXY" ] && EXTRA+=(--oauth-proxy "$PROXY" --host-proxy "$PROXY")
if [ "${ZCODE_VERIFY_SKIP_FETCH:-0}" = "1" ]; then EXTRA+=(--no-fetch); fi
SETUP_LOG="$(mktemp)"
zcode-webui setup --yes --port "$PORT" --workspace /workspace "${EXTRA[@]}" | tee "$SETUP_LOG"
grep -q '健康检查通过' "$SETUP_LOG" || { echo "FATAL: setup did not reach a healthy service"; exit 1; }

echo "===== 3. health assertions ====="
HEALTH="$(curl -sf "http://127.0.0.1:$PORT/api/health")"
echo "$HEALTH"
echo "$HEALTH" | grep -q '"loggedIn":true' || { echo "FATAL: credentials not usable in container"; exit 1; }
echo "$HEALTH" | grep -q '"rendererLoaded":true' || { echo "FATAL: renderer not loaded"; exit 1; }
curl -sf "http://127.0.0.1:$PORT/api/health" | grep -q '"serverRoot":"[^"]' || { echo "FATAL: serverRoot missing after automated install"; exit 1; }

echo "===== 4. packaged smoke test ====="
if ! node "$(npm root -g)/@aixyzstudio/zcode-webui/scripts/smoke-test.mjs" "" "$PORT"; then
  echo "--- smoke failed; service log tail:"
  tail -80 "$ZCODE_WEBUI_HOME/zcode-webui.log" || true
  exit 1
fi

echo "===== 5. upgrade: must be a fast no-op right after setup ====="
UP_LOG="$(mktemp)"
zcode-webui upgrade --yes | tee "$UP_LOG"
grep -q '已是最新\|无需升级' "$UP_LOG" || { echo "FATAL: upgrade should skip when already current"; cat "$UP_LOG"; exit 1; }

echo "===== 6. real model turn via the official CLI ====="
CLI="/root/.zcode/server/agents/glm/zcode.cjs"
[ -f "$CLI" ] || CLI="$(find /root/.zcode -name zcode.cjs -path '*agents*' | head -1)"
OUT="$(/root/.zcode/server/node "$CLI" --cwd /workspace --prompt '只回复 ok 两个字，不要做任何其他操作' --locale zh-CN 2>&1 | tail -3 || true)"
echo "$OUT"
echo "$OUT" | grep -q 'ok' || { echo "FATAL: model turn failed"; exit 1; }

echo "===== 7. ops: terminate sessions, then stop the service via the CLI ====="
curl -sf -X POST "http://127.0.0.1:$PORT/api/sessions/terminate" | grep -q '"ok":true'
zcode-webui stop
if curl -sf -m 3 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  echo "FATAL: service still answering after stop"; exit 1
fi

echo "CONTAINER-VERIFY OK"
