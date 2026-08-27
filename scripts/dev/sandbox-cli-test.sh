#!/usr/bin/env bash
# Isolated end-to-end test of the CLI automation (setup --yes -> health ->
# status -> bad-input survival -> stale-pid guard -> cli stop) inside a
# sandboxed HOME/ZCODE_HOME/data-home on a private port. Never touches the
# production instance or ~/.zcode; the runtime & renderer are hard-link-copied
# so no CDN download happens here (Docker fresh-runtime verify covers that).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SB="$(mktemp -d /tmp/zwebui-sandbox.XXXXXX)"
PORT="${ZWEBUI_TEST_PORT:-3191}"
mkdir -p "$SB/home" "$SB/zcode/v2" "$SB/zcode/cli" "$SB/data"

echo "== sandbox: $SB =="
cp -al "$HOME/.zcode/server" "$SB/zcode/server" 2>/dev/null || cp -a "$HOME/.zcode/server" "$SB/zcode/server"
mkdir -p "$SB/data/vendor"
cp -al "$ROOT/vendor/renderer" "$SB/data/vendor/renderer" 2>/dev/null || cp -a "$ROOT/vendor/renderer" "$SB/data/vendor/renderer"

# synthetic credentials (no real secrets leave ~/.zcode)
cat > "$SB/zcode/v2/credentials.json" <<'EOF'
{"oauth:bigmodel:access_token":"sandbox-token","oauth:bigmodel:user_info":"{\"id\":\"sandbox-user\"}"}
EOF

export ZCODE_WEBUI_HOME="$SB/data" ZCODE_HOME="$SB/zcode" HOME="$SB/home" ZCODE_VERSION=3.9.2

cleanup() {
  # scope the kill to this test's exact port argument so prod can never match
  pkill -f "server\.mjs --port ${PORT}" 2>/dev/null || true
  rm -rf "$SB"
}
trap cleanup EXIT

fail() { echo "FAIL: $1"; exit 1; }

echo "== 1. setup --yes =="
node "$ROOT/src/cli.mjs" setup --yes --port "$PORT" --workspace "$SB/home" 2>&1 | tee "$SB/setup.log"
grep -q '健康检查通过' "$SB/setup.log" && echo "PASS setup health gate"
grep -oP '已启动服务 pid=\d+' "$SB/setup.log" | grep -oP '\d+' > "$SB/svc.pid"
[ -s "$SB/svc.pid" ] || fail "no detached pid in setup output"
[ "$(stat -c %a "$SB/data/config.json")" = "600" ] && echo "PASS config written 0600"

echo "== 2. health assertions =="
curl -sf "http://127.0.0.1:$PORT/api/health" | node -e '
let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
  const j=JSON.parse(s);
  const need=(c,m)=>{ if(!c){ console.error("FAIL "+m); process.exit(1);} console.log("ok   "+m); };
  need(j.ok===true,"health ok");
  need(j.version==="0.1.0","health exposes version");
  need(j.login&&j.login.loggedIn===true,"synthetic credentials detected");
  need(j.rendererLoaded===true,"renderer loaded");
  need(!!j.serverRoot,"serverRoot present");
});'
echo "PASS health assertions"

echo "== 3. status / doctor =="
node "$ROOT/src/cli.mjs" status | grep -q '"ok":true' && echo "PASS status"
node "$ROOT/src/cli.mjs" doctor | grep -q 'runtime (' && echo "PASS doctor runtime"

echo "== 4. malformed HTTP URL must not crash =="
node -e '
const net=require("net");
const s=net.connect('"$PORT"',"127.0.0.1",()=>{ s.write("GET /%zz HTTP/1.1\r\nHost: x\r\n\r\n"); s.end(); });
let got=false;
s.on("data",()=>{got=true;});
s.on("close",()=>{ console.log(got?"server responded":"connection closed silently"); setTimeout(()=>process.exit(0),300); });
s.on("error",e=>{ console.error("conn error",e.message); process.exit(1); });
setTimeout(()=>process.exit(0),4000);'
sleep 0.5
curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null || fail "crashed after malformed URL"
echo "PASS survived malformed HTTP URL"

echo "== 5. malformed WS upgrade path must not crash =="
node -e '
const net=require("net");
const s=net.connect('"$PORT"',"127.0.0.1",()=>{ s.write("GET /%zz HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: aaaa\r\nSec-WebSocket-Version: 13\r\n\r\n"); });
s.on("close",()=>{ setTimeout(()=>process.exit(0),300); });
s.on("error",()=>process.exit(1));
setTimeout(()=>process.exit(0),4000);'
sleep 0.5
curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null || fail "crashed after malformed ws upgrade"
echo "PASS survived malformed WS upgrade"

echo "== 6. EOF on stdin must not hang interactive setup =="
# NO --yes: every prompt goes through ask(); stdin=/dev/null forces EOF.
# The historic bug: rl.question never resolved on EOF -> CLI hung forever.
if timeout 90 node "$ROOT/src/cli.mjs" setup --port "$PORT" --workspace "$SB/home" \
     --no-start --no-systemd </dev/null > "$SB/eof.log" 2>&1; then
  echo "PASS ask() resolves on EOF (interactive-less setup completed)"
else
  RC=$?
  if [ "$RC" = "124" ]; then fail "setup hung waiting on stdin (EOF not handled)"; else fail "setup exited rc=$RC"; fi
fi

echo "== 7. stop must refuse a recycled foreign PID =="
SVC_PID="$(cat "$SB/svc.pid")"
kill -0 "$SVC_PID" 2>/dev/null || fail "setup-started service not alive before stop test"
sleep 300 & FAKE_PID=$!
echo "$FAKE_PID" > "$SB/data/zcode-webui.pid"
STOP_OUT="$(node "$ROOT/src/cli.mjs" stop 2>&1 || true)"
echo "$STOP_OUT" | grep -q '拒绝停止' && echo "PASS foreign-pid kill refused"
kill -0 "$FAKE_PID" 2>/dev/null && echo "PASS fake sleeper unharmed"
kill "$FAKE_PID" 2>/dev/null || true

echo "== 8. genuine stop via restored pidfile =="
echo "$SVC_PID" > "$SB/data/zcode-webui.pid"
node "$ROOT/src/cli.mjs" stop | grep -q '已停止' && echo "PASS cli stop accepted"
sleep 1
if curl -sf -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then fail "still alive after stop"; fi
kill -0 "$SVC_PID" 2>/dev/null && fail "service pid still alive" || echo "PASS service process gone"

echo "== 9. status exits non-zero when down =="
if node "$ROOT/src/cli.mjs" status >/dev/null 2>&1; then fail "status should fail when down"; else echo "PASS status non-zero when down"; fi

echo "SANDBOX-CLI OK"
