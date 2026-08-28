#!/usr/bin/env bash
# In-place restart of a RUNNING zcode-webui instance, safe to fire from a
# session that lives inside the very service being restarted: the script is
# meant to run under setsid/nohup so it survives the agent's death and
# completes kill -> start -> health-gate on its own.
#
# Usage (from a session that will die with the old server):
#   setsid nohup bash scripts/dev/restart-webui.sh >/dev/null 2>&1 & disown
#
# Required: ZWEBUI_RESTART_PID (pid of the running server). Optional:
#   ZWEBUI_RESTART_PORT   (default 3102)
#   ZWEBUI_RESTART_REPO   (default: repo root of this script)
#   ZWEBUI_RESTART_ENV    (file with KEY=VALUE lines to replicate the old
#                          server's environment; default: captured live from
#                          /proc/$PID/environ before the kill)
set -uo pipefail

REPO="${ZWEBUI_RESTART_REPO:-$(cd "$(dirname "$0")/../.." && pwd)}"
PORT="${ZWEBUI_RESTART_PORT:-3102}"
PID="${ZWEBUI_RESTART_PID:?set ZWEBUI_RESTART_PID to the running server pid}"
LOG="${ZWEBUI_RESTART_LOG:-/tmp/zwebui-restart.log}"
sleep "${ZWEBUI_RESTART_GRACE:-5}"   # let the firing session flush its last message

{
  echo "=== restart begin $(date) (pid $PID, port $PORT) ==="
  CMD="$(tr '\0' ' ' < /proc/$PID/cmdline 2>/dev/null)"
  case "$CMD" in
    *server.mjs*) echo "target verified: $CMD" ;;
    *) echo "FATAL: pid $PID is not a zcode-webui server (cmd: ${CMD:-gone})"; exit 1 ;;
  esac

  # replicate the old server's environment exactly (no host-injected extras)
  ENV_FILE="${ZWEBUI_RESTART_ENV:-/tmp/zwebui-restart-env.txt}"
  if [ ! -f "$ENV_FILE" ]; then
    tr '\0' '\n' < "/proc/$PID/environ" > "$ENV_FILE" 2>/dev/null
    chmod 600 "$ENV_FILE"
  fi

  kill "$PID"
  for i in $(seq 1 40); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
  kill -9 "$PID" 2>/dev/null || true
  sleep 1
  cd "$REPO" || exit 1

  env -i /bin/bash -c "
    set -u
    while IFS= read -r l; do [ -n \"\$l\" ] && export \"\${l?}\"; done < '$ENV_FILE'
    cd '$REPO'
    nohup node src/server.mjs --port $PORT >> zcode-webui.log 2>&1 &
  "

  OK=""
  for i in $(seq 1 60); do
    H="$(curl -sf -m2 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)"
    if [ -n "$H" ]; then OK=1; echo "health: $H"; break; fi
    sleep 1
  done
  if [ -n "$OK" ]; then echo "=== RESTART OK $(date) ==="
  else echo "=== RESTART FAILED $(date) — see $REPO/zcode-webui.log ==="; fi
  rm -f "$ENV_FILE"
} >> "$LOG" 2>&1
