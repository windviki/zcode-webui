#!/usr/bin/env bash
# Local isolated base-path smoke (root-mode twin lives in sandbox-cli-test.sh).
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SB="$(mktemp -d /tmp/zwebui-bp.XXXXXX)"
mkdir -p "$SB/home" "$SB/zcode/v2" "$SB/data/vendor"
cp -a ~/.zcode/server "$SB/zcode/server"
cp -a "$ROOT/vendor/renderer" "$SB/data/vendor/renderer"
echo '{"oauth:bigmodel:access_token":"t"}' > "$SB/zcode/v2/credentials.json"

export ZCODE_WEBUI_HOME="$SB/data" ZCODE_HOME="$SB/zcode" HOME="$SB/home" ZCODE_WEBUI_BASE_PATH=/zcode
node "$ROOT/src/server.mjs" --port 3194 >"$SB/srv.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true; sleep 0.3; rm -rf "$SB"' EXIT

UP=0
for i in $(seq 1 60); do
  if curl -sf http://127.0.0.1:3194/zcode/api/health >/dev/null; then UP=1; break; fi
  sleep 0.5
done
[ "$UP" = "1" ] || { echo "FAIL server did not come up"; tail -20 "$SB/srv.log"; exit 1; }

node "$ROOT/scripts/smoke-test.mjs" /zcode 3194 | tail -30
exit "${PIPESTATUS[0]}"
