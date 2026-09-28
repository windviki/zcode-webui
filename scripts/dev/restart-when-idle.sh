#!/usr/bin/env bash
# Restart zcode-webui as soon as no agent turn is running.
#
# Why: shim-side guards that must live *inside* the host process (the NODE_OPTIONS
# preload injected by src/host.mjs, e.g. src/repo-snapshot-guard.cjs) only apply to
# hosts spawned by a server started AFTER the change. Restarting while a turn is in
# flight kills it, so this waits for a quiet window first — the /api/active signal
# (streaming hosts + running/error-fresh task rows; /api/background alone missed
# attached tabs and error-stuck rows, which cost us one interrupted turn on
# 2026-09-28) — and then does stop -> start -> health gate on its own. It is meant
# to be fired detached so it survives the session that started it.
#
# Usage:
#   setsid nohup bash scripts/dev/restart-when-idle.sh >/dev/null 2>&1 & disown
#   tail -f /tmp/zwebui-idle-restart.log        # watch it work
#
# Env: ZWEBUI_IDLE_PORT (default from config.json), ZWEBUI_IDLE_POLL (s, 20),
#      ZWEBUI_IDLE_CHECKS (consecutive quiet polls required, 3),
#      ZWEBUI_IDLE_MAX_WAIT (s, 21600), ZWEBUI_IDLE_LOG (/tmp/zwebui-idle-restart.log)
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
LOG="${ZWEBUI_IDLE_LOG:-/tmp/zwebui-idle-restart.log}"
POLL="${ZWEBUI_IDLE_POLL:-20}"
CHECKS="${ZWEBUI_IDLE_CHECKS:-3}"
MAX_WAIT="${ZWEBUI_IDLE_MAX_WAIT:-21600}"
PORT="${ZWEBUI_IDLE_PORT:-$(node -e '
  try { process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).port || 3102)); }
  catch { process.stdout.write("3102"); }
' "$REPO/config.json")}"
URL="http://127.0.0.1:${PORT}/api/active"

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }

{
  log "watching $URL (quiet checks: $CHECKS x ${POLL}s, give up after ${MAX_WAIT}s)"
  quiet=0
  waited=0
  while [ "$waited" -lt "$MAX_WAIT" ]; do
    body="$(curl -sf -m 3 "$URL" 2>/dev/null || true)"
    active="$(printf '%s' "$body" | tr -d ' ' | sed -n 's/.*"active":\(true\|false\).*/\1/p')"
    why="$(printf '%s' "$body" | tr -d ' ' | sed -n 's/.*"reasons":\[\([^]]*\)\].*/\1/p' | head -c 160)"
    if [ "$active" != "true" ] && [ "$active" != "false" ]; then
      log "service not answering yet (it may already be restarting) — retrying"
      quiet=0
    elif [ "$active" = "false" ]; then
      quiet=$((quiet + 1))
      log "quiet window $quiet/$CHECKS"
    else
      [ "$quiet" -gt 0 ] && log "activity returned — waiting"
      log "ACTIVE: ${why:-<no reasons>}"
      quiet=0
    fi
    if [ "$quiet" -ge "$CHECKS" ]; then
      log "no turn running — restarting to arm the host preload"
      cd "$REPO" || exit 1
      if ./zcode-service.sh restart; then
        log "restart finished; health: $(curl -sf -m 3 "http://127.0.0.1:${PORT}/api/health" | head -c 200)"
      else
        log "RESTART FAILED — check $REPO/zcode-webui.log"
        exit 1
      fi
      # The host is spawned on the first client connect, so drive one protocol round
      # trip (the project's own smoke test) to force it, then look for the preload line.
      log "forcing a host spawn with scripts/smoke-test.mjs …"
      smoke="$(node "$REPO/scripts/smoke-test.mjs" "" "$PORT" 2>&1 | tail -4 | tr '\n' ' ')"
      log "smoke: $smoke"
      if grep -aq 'repo-snapshot-guard: armed' "$REPO/zcode-webui.log"; then
        log "VERIFIED: guard preload is active in the freshly spawned host"
      else
        log "WARNING: restart done but the guard line is missing — check the preload wiring"
      fi
      exit 0
    fi
    sleep "$POLL"
    waited=$((waited + POLL))
  done
  log "gave up after ${MAX_WAIT}s without a quiet window — restart manually when convenient"
} >> "$LOG" 2>&1
