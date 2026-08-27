#!/usr/bin/env bash
# Investigate "machine went to sleep mid-task and the session stopped" by
# emulating suspend/resume with docker pause/unpause: ALL processes inside the
# container freeze (CPU + network I/O), long-lived TLS streams die while
# paused, and everything resumes at once on unpause — the same conditions a
# suspended host faces after waking up.
#
# What it measures:
#   1. does an in-flight REAL model turn survive a 180s freeze?
#   2. what does the official task index say afterwards (what would the UI show)?
#   3. is zcode-webui able to spawn a fresh host right after resume?
#
# Isolation: sandbox copy of ~/.zcode injected with docker cp (no bind mounts,
# no credentials in image layers); own image tag; deleted after the run.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STAGE="$(mktemp -d /tmp/zwebui-suspend.XXXXXX)"
CTX="$STAGE/ctx"
SANDBOX="$STAGE/zcode-sandbox"
IMAGE="${ZCODE_SUSPEND_IMAGE:-zcode-webui-suspend:local}"
SOURCE="${ZCODE_VERIFY_SOURCE:-$HOME/.zcode}"
NAME="zcode-webui-suspend"
PAUSE_AFTER="${ZCODE_SUSPEND_AFTER:-25}"     # seconds of streaming before freeze
PAUSE_SECS="${ZCODE_SUSPEND_SECS:-180}"

cleanup() {
  docker unpause "$NAME" >/dev/null 2>&1 || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  [ "${ZCODE_SUSPEND_KEEP:-0}" = "1" ] || rm -rf "$STAGE"
}
trap cleanup EXIT

# ---- network/proxy autodetect (same logic as verify.sh) ----
NET="${ZCODE_VERIFY_NETWORK:-}"
PROXY="${ZCODE_VERIFY_PROXY:-}"
if [ -z "$NET" ]; then
  for cand in viki-net lobehub-sandbox-mcp_default; do
    if docker network inspect "$cand" >/dev/null 2>&1; then NET="$cand"; break; fi
  done
fi
if [ -z "$PROXY" ]; then
  IPS="$(docker inspect glash -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' 2>/dev/null | tr ' ' '\n' | grep -v '^$' || true)"
  [ -n "$IPS" ] || IPS="$(docker network inspect "$NET" -f '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null)"
  for ip in $IPS; do
    if docker run --rm --network "$NET" curlimages/curl:latest -sf -o /dev/null -x "http://$ip:7890" --max-time 5 https://zcode.z.ai/ 2>/dev/null; then
      PROXY="http://$ip:7890"; break
    fi
  done
fi
[ -n "$NET" ] && [ -n "$PROXY" ] || { echo "need network+proxy (set ZCODE_VERIFY_NETWORK/PROXY)"; exit 1; }
echo "[suspend-test] net=$NET proxy=$PROXY"

# ---- build & stage ----
mkdir -p "$CTX"
(cd "$ROOT" && npm pack >/dev/null 2>&1)
TGZ="$(ls "$ROOT"/*.tgz | head -1)"
mv "$TGZ" "$CTX/zcode-webui.tgz"
cat > "$CTX/Dockerfile" <<'EOF'
FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends dpkg-dev curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /root/.zcode-webui/vendor/renderer /root/.zcode/v2 /root/.zcode/cli /root/.zcode/server
COPY zcode-webui.tgz /tmp/zcode-webui.tgz
RUN npm install -g /tmp/zcode-webui.tgz
COPY inner.sh /usr/local/bin/suspend-inner
RUN chmod +x /usr/local/bin/suspend-inner
CMD ["sleep","infinity"]
EOF
cat > "$CTX/inner.sh" <<'INNER'
#!/usr/bin/env bash
# runs inside the container; orchestrated externally via pause/unpause
set -uo pipefail
exec > >(tee /tmp/inner.log) 2>&1
PORT=3105
echo "[inner] starting service"
zcode-webui start --port "$PORT" > /tmp/svc.log 2>&1 &
for i in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null && break; sleep 1; done
curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null || { echo "[inner] FATAL no health"; exit 11; }
echo "[inner] healthy"

export ZCODE_HTTP_PROXY="${ZCODE_VERIFY_PROXY}" ZCODE_NO_PROXY="localhost,127.0.0.1"
CLI=/root/.zcode/server/agents/glm/zcode.cjs
( cd /tmp && /root/.zcode/server/node "$CLI" --cwd /tmp \
    --prompt '请从 1 数到 200，每行输出一个数字，不要输出其他任何内容，不要使用任何工具。' \
    --locale zh-CN > /tmp/turn.out 2>&1 ; echo $? > /tmp/turn.exit ) &
TURN=$!
echo "[inner] turn started pid=$TURN"
sleep "${ZCODE_SUSPEND_AFTER:-25}"
echo "[inner] MARKER: about-to-freeze (turn streaming)"
# the orchestrator freezes the whole container around here
for i in $(seq 1 400); do
  [ -f /tmp/turn.exit ] && break
  sleep 1
done
RC="$(cat /tmp/turn.exit 2>/dev/null || echo none)"
echo "[inner] MARKER: turn finished rc=$RC after $(date +%s) epoch"
echo "--- turn output tail:"
tail -6 /tmp/turn.out
echo "--- task index states:"
node -e '
(async () => {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync("/root/.zcode/v2/tasks-index.sqlite", { readOnly: true });
    const rows = db.prepare("SELECT task_id, task_status, updated_at FROM tasks ORDER BY updated_at DESC LIMIT 5").all();
    console.log(JSON.stringify(rows));
  } catch (e) { console.log("(task index unreadable: " + e.message + ")"); }
})();'
sleep 1
echo "[inner] post-resume service check:"
curl -sf -m 5 "http://127.0.0.1:$PORT/api/health" | head -c 200 || echo "(service unhealthy)"
echo
node "$(npm root -g)/@aixyzstudio/zcode-webui/scripts/smoke-test.mjs" "" "$PORT" | tail -4 || true
touch /tmp/inner.done
echo "[inner] DONE"
INNER

cp -a "$SOURCE" "$SANDBOX"
chmod -R u+rwX "$SANDBOX"
docker build -q -t "$IMAGE" "$CTX" >/dev/null
echo "[suspend-test] creating container…"
CID="$(docker create --name "$NAME" --network "$NET" -e "ZCODE_VERIFY_PROXY=$PROXY" \
  -e "ZCODE_SUSPEND_AFTER=$PAUSE_AFTER" "$IMAGE")"
docker cp "$SANDBOX/." "$CID:/root/.zcode/"
# seed the renderer from the repo so this test exercises only the sleep path
RSRC="$ROOT/vendor/renderer"
docker start "$CID" >/dev/null
docker exec "$NAME" mkdir -p /root/.zcode-webui/vendor/renderer
docker cp "$RSRC/." "$CID:/root/.zcode-webui/vendor/renderer/"
# launch the experiment inside (detached; it tees its own log to /tmp/inner.log)
docker exec -d "$NAME" /usr/local/bin/suspend-inner
echo "[suspend-test] inner running; freezing in ${PAUSE_AFTER}s…"
( sleep "$((PAUSE_AFTER + 8))"; echo "[suspend-test] PAUSE (emulating system suspend)"; docker pause "$NAME" >/dev/null ) &
WATCHDOG=$!
trap 'kill $WATCHDOG 2>/dev/null || true; cleanup' EXIT
docker logs -f "$NAME" 2>&1 | sed 's/^/[container] /' &
LOGS=$!
echo "[suspend-test] sleeping ${PAUSE_SECS}s frozen…"
sleep "$((PAUSE_AFTER + PAUSE_SECS))"
echo "[suspend-test] UNPAUSE (resume)"
docker unpause "$NAME" >/dev/null
# wait for the inner script's completion sentinel before tearing down
SENTINEL=0
for i in $(seq 1 100); do
  if docker exec "$NAME" test -f /tmp/inner.done 2>/dev/null; then SENTINEL=1; break; fi
  sleep 3
done
[ "$SENTINEL" = "1" ] || echo "[suspend-test] WARNING: inner.done never appeared"
kill "$LOGS" 2>/dev/null || true
# pull the artifacts out of the container BEFORE any teardown
docker cp "$NAME:/tmp/inner.log" "$STAGE/inner.log" 2>/dev/null || true
docker cp "$NAME:/tmp/turn.out" "$STAGE/turn.out" 2>/dev/null || true
docker cp "$NAME:/tmp/turn.exit" "$STAGE/turn.exit" 2>/dev/null || true
docker cp "$NAME:/tmp/svc.log" "$STAGE/svc.log" 2>/dev/null || true
echo "[suspend-test] ===== turn.exit:"; cat "$STAGE/turn.exit" 2>/dev/null || echo "(missing)"
echo "[suspend-test] ===== turn.out tail:"; tail -8 "$STAGE/turn.out" 2>/dev/null || echo "(missing)"
echo "[suspend-test] ===== inner log tail:"
tail -45 "$STAGE/inner.log" 2>/dev/null || { echo "(inner.log missing — raw docker logs:)"; docker logs "$NAME" 2>&1 | tail -60; }
echo "[suspend-test] ===== service log grep (host lifecycle):"
grep -E 'host exited|host spawned|terminating host|handshake' "$STAGE/svc.log" 2>/dev/null | tail -12 || true
echo "SUSPEND-TEST COMPLETE"
