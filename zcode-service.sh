#!/usr/bin/env bash
#
# zcode-webui 独立服务控制脚本
#
#   ./zcode-service.sh start     启动 zcode-webui（脱离调用方进程树）
#   ./zcode-service.sh stop      停止 zcode-webui
#   ./zcode-service.sh restart   重启
#   ./zcode-service.sh status    查看状态与健康检查
#   ./zcode-service.sh logs      跟踪日志（Ctrl-C 退出）
#   ./zcode-service.sh health    只做健康检查，输出 /api/health
#
# 设计要点：
#   1. start 用 `setsid nohup … &` 拉起 server.mjs。setsid 让服务进入全新的
#      session/进程组，因此在 dsh webui 里点「重启 dsh」时，dsh 退出前按它
#      自己的进程组清理子进程，不会波及 zcode-webui。
#   2. stop 只杀本工程精确匹配的 server.mjs（PID 文件优先，pgrep 兜底），
#      绝不使用 pkill -f node 之类的宽匹配，避免误杀无关 node 进程。
#   3. 端口等配置照常从 config.json / 环境变量读取，与 server.mjs 的优先级
#      保持一致（环境变量 > config.json > 默认值 3102）。

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

PID_FILE="$SCRIPT_DIR/.service.pid"
LOG_FILE="$SCRIPT_DIR/zcode-webui.log"

# ---------- 配置（环境变量优先，其次 config.json，最后默认） ----------
read_json() { # read_json <file> <key> <default>
  node -e '
    const fs = require("node:fs");
    const [file, key, fallback] = process.argv.slice(1);
    try {
      const c = JSON.parse(fs.readFileSync(file, "utf8"));
      const v = c[key];
      process.stdout.write(String(v === undefined || v === null ? fallback : v));
    } catch {
      process.stdout.write(String(fallback));
    }
  ' "$1" "$2" "$3"
}

PORT="${ZCODE_WEBUI_PORT:-}"
if [[ -z "$PORT" && -f "$SCRIPT_DIR/config.json" ]]; then
  PORT="$(read_json "$SCRIPT_DIR/config.json" port 3102)"
fi
PORT="${PORT:-3102}"
case "$PORT" in
  ''|*[!0-9]*) PORT=3102 ;;
esac

BASE_PATH="${ZCODE_WEBUI_BASE_PATH:-}"
if [[ -z "$BASE_PATH" && -f "$SCRIPT_DIR/config.json" ]]; then
  BASE_PATH="$(read_json "$SCRIPT_DIR/config.json" basePath '')"
fi
# 规范化：/x/ -> /x，'' 或 '/' 视为无前缀
BASE_PATH="${BASE_PATH#/}"
BASE_PATH="${BASE_PATH%/}"
BASE_PATH="/${BASE_PATH}"
if [[ "$BASE_PATH" == "/" ]]; then BASE_PATH=""; fi

HEALTH_URL="http://127.0.0.1:${PORT}${BASE_PATH}/api/health"

info() { printf '[zcode-service] %s\n' "$*"; }
die()  { info "错误：$*"; exit 1; }

# ---------- 进程发现 ----------
# 精确匹配本工程的 server.mjs：既覆盖本脚本用绝对路径启动的服务进程，
# 也覆盖历史会话里 `cd 仓库 && node src/server.mjs …` 拉起的旧实例。
server_pids() {
  {
    pgrep -f "node $SCRIPT_DIR/src/server\.mjs" || true
    pgrep -f "node src/server\.mjs" || true
  } | sort -un
}

pid_matches_server() { # pid_matches_server <pid>
  local pid="$1" line
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  line="$(tr '\0' ' ' < "/proc/$pid/cmdline")"
  case "$line" in
    *"$SCRIPT_DIR/src/server.mjs"*|*"src/server.mjs"*) return 0 ;;
    *) return 1 ;;
  esac
}

is_up() { curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; }

# ---------- 命令 ----------
start() {
  if is_up; then
    info "zcode-webui 已在运行（端口 $PORT，健康检查通过）"
    return 0
  fi

  local stale
  stale="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$stale" ]] && pid_matches_server "$stale"; then
    info "PID 文件指向 $stale 但健康检查失败，先停止该残留进程…"
    kill "$stale" 2>/dev/null || true
    for _ in {1..10}; do
      pid_matches_server "$stale" || break
      sleep 0.5
    done
  fi
  rm -f "$PID_FILE"

  info "启动 zcode-webui（端口 $PORT，日志 $LOG_FILE）…"
  local args=(node "$SCRIPT_DIR/src/server.mjs" --port "$PORT")
  [[ -n "$BASE_PATH" ]] && args+=(--base-path "$BASE_PATH")

  # 关键：setsid 建立新 session/进程组，让服务脱离本脚本（以及可能包裹
  # 本脚本的 dsh 会话）的进程组；nohup 再挡一次 SIGHUP。
  setsid nohup "${args[@]}" >>"$LOG_FILE" 2>&1 </dev/null &
  echo $! > "$PID_FILE"

  for _ in {1..30}; do
    is_up && { info "就绪（pid $(cat "$PID_FILE")）"; return 0; }
    sleep 0.5
  done
  die "启动后 15 秒内健康检查未通过，请查看 $LOG_FILE"
}

stop() {
  info "停止 zcode-webui…"
  local pid="${1:-}"
  if [[ -z "$pid" && -s "$PID_FILE" ]]; then pid="$(cat "$PID_FILE")"; fi

  if [[ -n "$pid" ]] && pid_matches_server "$pid"; then
    kill "$pid" 2>/dev/null && info "已向 pid $pid 发送 SIGTERM"
    for _ in {1..20}; do
      pid_matches_server "$pid" || break
      sleep 0.5
    done
    if pid_matches_server "$pid"; then
      info "pid $pid 未退出，发送 SIGKILL"
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$PID_FILE"

  # 兜底清理：仅精确匹配本工程 server.mjs 的残留进程
  local p
  for p in $(server_pids); do
    pid_matches_server "$p" || continue
    kill "$p" 2>/dev/null && info "已清理残留进程 pid $p"
  done

  for _ in {1..20}; do
    if ! is_up && [[ -z "$(server_pids)" ]]; then break; fi
    sleep 0.5
  done
  if is_up || [[ -n "$(server_pids)" ]]; then
    info "警告：仍有进程存活，请检查 ps -ef | grep server.mjs"
  else
    info "已停止"
  fi
}

restart() { stop; start; }

status() {
  local pids
  pids="$(server_pids | tr '\n' ' ')"
  printf 'zcode-webui : %s（端口 %s）\n' "${pids:-未运行}" "$PORT"
  if is_up; then
    printf '健康检查   : OK (%s)\n' "$HEALTH_URL"
  else
    printf '健康检查   : FAIL (%s)\n' "$HEALTH_URL"
  fi
}

health() {
  if is_up; then
    curl -fsS --max-time 2 "$HEALTH_URL" && printf '\n'
  else
    die "健康检查失败（$HEALTH_URL）"
  fi
}

logs() { tail -n "${1:-100}" -f "$LOG_FILE"; }

case "${1:-}" in
  start)    start ;;
  stop)     stop ;;
  restart)  restart ;;
  status)   status ;;
  health)   health ;;
  logs)     logs "${2:-100}" ;;
  *) echo "用法: $0 {start|stop|restart|status|health|logs [N]}"; exit 1 ;;
esac
