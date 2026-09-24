#!/usr/bin/env bash
#
# zcode-update.sh — ZCode 官方「前端渲染层 + 官方运行时」一体化更新
#
#   拉包 → 解包 → 校验 → 原子替换（旧的留备份）→ 重启服务 → 校验无新增问题
#
# 用法:
#   ./zcode-update.sh                 探测最新版本并更新（默认），完成后重启服务并校验
#   ./zcode-update.sh --check         只显示当前/官网/CDN 版本，不下载
#   ./zcode-update.sh -v 3.12.3       指定目标版本
#   ./zcode-update.sh --stable        只升级官网已公布的版本（不采用 CDN 上更新的构建）
#   ./zcode-update.sh --force         同版本也重新下载安装（可用于修复损坏的安装）
#   ./zcode-update.sh --renderer-only 只更新渲染层（不需要停服务）
#   ./zcode-update.sh --server-only   只更新官方运行时
#   ./zcode-update.sh --rollback      回滚到最近一次更新前的备份
#   ./zcode-update.sh --no-backup     不保留旧版本备份
#   ./zcode-update.sh --no-restart    更新后不重启服务
#   ./zcode-update.sh --no-smoke      跳过更新后的 smoke 校验
#   ./zcode-update.sh --no-ui-check   跳过更新后的界面启动校验
#   ./zcode-update.sh --no-auto-rollback  校验失败时不自动回滚
#   ./zcode-update.sh --yes           全自动，不询问
#
# 校验与回滚：更新后依次校验版本对齐、健康检查、WS/HTTP 协议桥（smoke-test）和界面
# 能否真正启动（ui-boot-check，headless Chromium）。任一项失败且存在备份时，默认自动
# 回滚到更新前的版本并再校验一次，避免「协议通了、界面是坏的」这类升级事故。
#
# 3.12.x 适配（2026-09 完成）：官方 3.12 起服务端口消息改为
# `{type:'zcode:service-port', databaseStartupId}` 对象，且渲染层必须再收到
# `zcode:database-startup-state`（桌面端「数据库启动通道」，phase=ready 且 startupId 对齐）
# 才会启动；否则 30 秒后停在「未能收到启动状态 / startup-channel-unavailable」。
# web/bootstrap.js 按注入的渲染层版本二选一（<=3.11 裸字符串，>=3.12 对象+启动状态）。
# 另注：3.12 起模型可用性改为服务端 entitlement 校验（account:*），若账号没有有效套餐，
# 界面会显示「当前没有可用模型」——此时用「管理模型 → 添加自定义模型/API Key」接入本地 key。
#
# 环境变量: ZCODE_HTTP_PROXY（代理）、ZCODE_WEBUI_HOME（数据目录）、
#           ZCODE_SERVER_RUNTIME_ROOT / ZCODE_HOME、ZCODE_ARCH=x64|arm64、
#           ZCODE_CDN_BASE / ZCODE_SITE_ORIGIN（镜像源）
#
# 版本探测为什么以 CDN 为准: 官网 changelog/install 页只公布「已公告」版本，而
# CDN 上往往已经躺着更新的构建（官方桌面端自己走的就是 CDN）。所以这里先读官网
# 版本当基线，再向 CDN 探测真实存在（manifest 在）的最高版本，两者不一致时会提示。
#
# 与 `zcode-webui upgrade`（src/upgrade.mjs）的关系: 部署的东西完全一致（同一
# CDN、同一 manifest、同样的 ~/.zcode/server 布局与 .asset-components 标记），
# 本脚本是纯 shell 实现，便于在没有 npm 包的环境里一条命令完成更新。
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

# 复用 zcode-service.sh 的端口/basePath 解析（config.json → 默认 3102）、
# 健康检查 is_up() 与启停 start()/stop()/info()/die()。被 source 时它不分发子命令。
# shellcheck source=zcode-service.sh
source "$SCRIPT_DIR/zcode-service.sh"

# ---------- 常量 ----------
CDN_BASE="${ZCODE_CDN_BASE:-https://cdn-zcode.z.ai/zcode/electron/releases}"
SITE_ORIGIN="${ZCODE_SITE_ORIGIN:-https://zcode.z.ai}"
SITE_PAGES=(
  "$SITE_ORIGIN/cn/changelog"
  "$SITE_ORIGIN/en/changelog"
  "$SITE_ORIGIN/cn/docs/install"
  "$SITE_ORIGIN/en/docs/install"
)
# 兜底版本（官网不可达时用）也是「已知可用」版本，不是最新版本：
# 与 scripts/fetch-renderer.sh 的 ZCODE_VERSION 默认值、src/upgrade.mjs 的
# DEFAULT_VERSION 保持一致。
PINNED_VERSION="3.12.3"

# 3.12.x 已适配（启动通道 + 对象形式的服务端口消息，见 web/bootstrap.js）。
# 后续版本不在这里设置固定上限；安装后由 UI 启动校验和失败回滚兜底。

DATA_HOME="${ZCODE_WEBUI_HOME:-$SCRIPT_DIR}"
RENDERER_DIR="$DATA_HOME/vendor/renderer"
TMP_BASE="$DATA_HOME/.upgrade-tmp"
KEEP_BACKUPS="${ZCODE_UPDATE_KEEP_BACKUPS:-2}"
# 界面启动校验访问的页面地址（PORT/BASE_PATH 由 zcode-service.sh 解析）
PAGE_URL="http://127.0.0.1:${PORT}${BASE_PATH}/"

# 官方运行时组件 id → 解包落点（与 src/upgrade.mjs 的 COMPONENT_TARGETS 一致）
component_target() {
  case "$1" in
    server-bundle|node-runtime) echo "." ;;
    node-pty)                   echo "build/Release" ;;
    glm)                        echo "agents/glm" ;;
    bfs|ripgrep|ugrep)          echo "tools/$1" ;;
    *)                          echo "" ;;
  esac
}
RUNTIME_REQUIRED=("zcode-server.cjs" "node" "agents/glm/zcode.cjs" "build/Release/pty.node")
RUNTIME_EXECUTABLES=("node" "zcode-server.cjs" "agents/glm/zcode.cjs" "tools/bfs/bfs" "tools/ripgrep/rg" "tools/ugrep/ugrep")

CURL=(curl -fsSL --retry 3 --connect-timeout 10)
if [[ -n "${ZCODE_HTTP_PROXY:-}" ]]; then CURL+=(--proxy "$ZCODE_HTTP_PROXY"); fi

log()  { printf '[zcode-update] %s\n' "$*"; }
step() { printf '\n[zcode-update] ── %s\n' "$*"; }
warn() { printf '[zcode-update] ! %s\n' "$*" >&2; }
ok()   { printf '[zcode-update] ✓ %s\n' "$*"; }
fail() { printf '[zcode-update] ✗ %s\n' "$*" >&2; }

usage() {
  cat <<'EOF'
用法: zcode-update.sh [选项]

  -v, --version X.Y.Z   指定目标版本（默认自动探测 CDN 上最新版本）
      --arch x64|arm64  目标架构（默认按 uname -m 判断）
      --check           只检查版本，不下载
      --stable          只升级官网已公布的版本（不采用 CDN 上更新的构建）
      --force           版本相同也重新下载安装
      --renderer-only   只更新渲染层
      --server-only     只更新官方运行时
      --rollback        回滚到最近一次更新前的备份
      --no-backup       不保留旧版本备份
      --no-restart      更新后不重启服务
      --no-smoke        跳过更新后的 smoke 校验
      --no-ui-check     跳过更新后的界面启动校验
      --no-guard-check  跳过更新后的守卫自检（repo-snapshot/api-cache 钩子对齐）
      --no-auto-rollback 校验失败时不自动回滚
  -y, --yes             全自动，不询问
  -h, --help            显示本帮助
EOF
}

# ---------- 参数 ----------
TARGET_VERSION=""
ARCH=""
MODE="full"           # full | renderer | server
CHECK_ONLY=0
FORCE=0
KEEP_BACKUP=1
DO_RESTART=1
DO_SMOKE=1
DO_UI_CHECK=1
DO_GUARD_CHECK=1
AUTO_ROLLBACK=1
STABLE_ONLY=0
ASSUME_YES=0
DO_ROLLBACK=0
LOG_MARK=0
WAS_UP=0
SERVICE_STOPPED=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -v|--version)    TARGET_VERSION="${2:-}"; shift 2 ;;
    --arch)          ARCH="${2:-}"; shift 2 ;;
    --check)         CHECK_ONLY=1; shift ;;
    --stable)        STABLE_ONLY=1; shift ;;
    --force)         FORCE=1; shift ;;
    --renderer-only) MODE="renderer"; shift ;;
    --server-only)   MODE="server"; shift ;;
    --rollback)      DO_ROLLBACK=1; shift ;;
    --no-backup)     KEEP_BACKUP=0; shift ;;
    --no-restart)    DO_RESTART=0; shift ;;
    --no-smoke)      DO_SMOKE=0; shift ;;
    --no-ui-check)   DO_UI_CHECK=0; shift ;;
    --no-guard-check) DO_GUARD_CHECK=0; shift ;;
    --no-auto-rollback) AUTO_ROLLBACK=0; shift ;;
    -y|--yes)        ASSUME_YES=1; shift ;;
    -h|--help)       usage; exit 0 ;;
    *) fail "未知参数: $1"; usage; exit 2 ;;
  esac
done

if [[ -z "$ARCH" ]]; then
  case "$(uname -m)" in
    x86_64|amd64)  ARCH="x64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) fail "不支持的架构: $(uname -m)（官方运行时只发布 linux-x64 / linux-arm64）"; exit 2 ;;
  esac
fi
case "$ARCH" in x64|arm64) ;; *) fail "--arch 仅支持 x64 / arm64"; exit 2 ;; esac
platform="linux-$ARCH"

# ---------- 依赖 ----------
for tool in curl node tar sha256sum find; do
  command -v "$tool" >/dev/null 2>&1 || { fail "'$tool' 未安装"; exit 1; }
done
if [[ "$MODE" != "server" ]] && ! command -v dpkg-deb >/dev/null 2>&1; then
  fail "dpkg-deb 未安装（解官方 .deb 需要；--server-only 可绕过）"
  exit 1
fi

# ---------- 路径与版本探测 ----------
resolve_server_root() {
  if [[ -n "${ZCODE_SERVER_RUNTIME_ROOT:-}" ]]; then printf '%s\n' "$ZCODE_SERVER_RUNTIME_ROOT"; return 0; fi
  local cfg="" f
  for f in "$DATA_HOME/config.json" "$SCRIPT_DIR/config.json"; do
    [[ -f "$f" ]] || continue
    cfg="$(read_json "$f" serverRoot '')"
    if [[ -n "$cfg" ]]; then printf '%s\n' "$cfg"; return 0; fi
  done
  if [[ -n "${ZCODE_HOME:-}" ]]; then printf '%s\n' "$ZCODE_HOME/server"; return 0; fi
  printf '%s\n' "$HOME/.zcode/server"
}
SERVER_ROOT="$(resolve_server_root)"

renderer_version() {
  if [[ -f "$RENDERER_DIR/.version" ]]; then tr -d ' \n' < "$RENDERER_DIR/.version"; fi
}

runtime_version() {
  local meta="$SERVER_ROOT/.asset-components/server-bundle.json" v=""
  if [[ -f "$meta" ]]; then
    v="$(node -e 'try{const m=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));const s=String(m.version||"").replace(/^v/,"").split("+")[0];if(/^[0-9]+\.[0-9]+\.[0-9]+$/.test(s))process.stdout.write(s)}catch(e){}' "$meta")"
  fi
  if [[ -z "$v" && -x "$SERVER_ROOT/node" && -f "$SERVER_ROOT/zcode-server.cjs" ]]; then
    v="$("$SERVER_ROOT/node" "$SERVER_ROOT/zcode-server.cjs" --version 2>/dev/null | head -1 | awk '{print $1}' || true)"
    if [[ ! "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then v=""; fi
  fi
  printf '%s' "$v"
}

# 官网公布的版本（changelog / install 页里内嵌的 \"version\":\"X.Y.Z\"）
site_version() {
  local url html v best=""
  for url in "${SITE_PAGES[@]}"; do
    html="$("${CURL[@]}" --max-time 20 "$url" 2>/dev/null || true)"
    [[ -n "$html" ]] || continue
    while IFS= read -r v; do
      [[ -n "$v" ]] || continue
      if [[ -z "$best" || "$(printf '%s\n%s\n' "$v" "$best" | sort -V | tail -1)" == "$v" ]]; then best="$v"; fi
    done < <(printf '%s' "$html" \
      | grep -o '\\"version\\":\\"[0-9]\+\.[0-9]\+\.[0-9]\+\\"' \
      | sed 's/.*\\"\([0-9.]*\)\\"/\1/' | sort -u)
    if [[ -n "$best" ]]; then printf '%s' "$best"; return 0; fi
  done
  printf ''
}

version_gt() { # version_gt A B → A 比 B 新则返回 0
  if [[ "$1" == "$2" ]]; then return 1; fi
  [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" == "$1" ]]
}

# 从基线版本向上探测 CDN 上真实存在的最高版本（并行探测，命中的版本各写一个文件）
probe_cdn_latest() {
  local base="$1" major minor patch bump pt cand dir best=""
  IFS=. read -r major minor patch <<<"$base"
  if [[ ! "$major" =~ ^[0-9]+$ || ! "$minor" =~ ^[0-9]+$ || ! "$patch" =~ ^[0-9]+$ ]]; then return 0; fi
  dir="$(mktemp -d "${TMPDIR:-/tmp}/zcode-probe.XXXXXX")"
  local cands=()
  for bump in 1 2; do
    for pt in 0 1 2 3 4 5; do cands+=("$major.$((minor + bump)).$pt"); done
  done
  for pt in $(seq $((patch + 1)) $((patch + 5))); do cands+=("$major.$minor.$pt"); done

  for cand in "${cands[@]}"; do
    (
      if "${CURL[@]}" -o /dev/null --max-time 8 "$CDN_BASE/$cand/manifest-$platform.json" 2>/dev/null; then
        printf '%s\n' "$cand" > "$dir/$cand"
      fi
    ) &
  done
  wait

  for cand in "$dir"/*; do
    [[ -e "$cand" ]] || continue
    cand="$(basename "$cand")"
    if [[ -z "$best" || "$(printf '%s\n%s\n' "$cand" "$best" | sort -V | tail -1)" == "$cand" ]]; then best="$cand"; fi
  done
  rm -rf "$dir"
  printf '%s' "$best"
}

# ---------- 日志/校验辅助 ----------
json_field() { # json_field <json> <a.b.c>
  node -e 'try{const v=process.argv[2].split(".").reduce((o,k)=>(o==null?o:o[k]),JSON.parse(process.argv[1]));process.stdout.write(v==null?"":String(v))}catch(e){}' "$1" "$2"
}
health_json() { "${CURL[@]}" --max-time 5 "$HEALTH_URL" 2>/dev/null || true; }
log_lines()   { local n; n="$(wc -l < "$LOG_FILE" 2>/dev/null || true)"; printf '%s' "${n:-0}"; }

# 只报告本次更新「新增」的异常行（历史噪音不算新问题）；命中只提示不失败
scan_new_log_errors() { # scan_new_log_errors <起始行号> <标签>
  local from="$1" label="$2" hits
  hits="$(tail -n "+$((from + 1))" "$LOG_FILE" 2>/dev/null \
    | grep -aiE "\[host\] spawn error|handshake timeout|EADDRINUSE|Cannot find module|is not a function|UnhandledPromiseRejection|host exited pid=[0-9]+ code=[1-9]" \
    | tail -n 20 || true)"
  if [[ -n "$hits" ]]; then
    warn "$label 新增异常日志:"
    printf '%s\n' "$hits" | sed 's/^/    /' >&2
    return 1
  fi
  return 0
}

smoke_check() {
  if [[ "$DO_SMOKE" != "1" ]]; then log '跳过 smoke 校验（--no-smoke）'; return 0; fi
  if [[ ! -f "$SCRIPT_DIR/scripts/smoke-test.mjs" ]]; then warn '未找到 scripts/smoke-test.mjs，跳过'; return 0; fi
  if [[ ! -d "$SCRIPT_DIR/node_modules/ws" ]]; then warn '未安装 ws（npm i），跳过 smoke 校验'; return 0; fi
  log '运行 smoke 校验（静态托管 + WS/HTTP 桥 + 新运行时握手）…'
  if node "$SCRIPT_DIR/scripts/smoke-test.mjs" "$BASE_PATH" "$PORT" 2>&1 | sed 's/^/    /'; then
    ok 'smoke 校验通过'
    return 0
  fi
  fail 'smoke 校验失败（见上面的 FAIL 行）'
  return 1
}

# 界面启动校验：协议通了不等于界面能用。官方 3.12.x 就属于「桥没问题、渲染层停在
# 启动失败页」，只有真的把页面跑起来才能发现。
ui_check() {
  if [[ "$DO_UI_CHECK" != "1" ]]; then log '跳过界面启动校验（--no-ui-check）'; return 0; fi
  if [[ ! -f "$SCRIPT_DIR/scripts/ui-boot-check.mjs" ]]; then warn '未找到 scripts/ui-boot-check.mjs，跳过'; return 0; fi
  if [[ ! -d "$SCRIPT_DIR/node_modules/playwright-core" ]]; then
    warn '未安装 playwright-core（npm i），跳过界面启动校验'
    return 0
  fi
  log '运行界面启动校验（headless Chromium 实跑官方渲染层）…'
  mkdir -p "$TMP_BASE"
  local rc=0
  node "$SCRIPT_DIR/scripts/ui-boot-check.mjs" "$PAGE_URL" "$TMP_BASE/ui-after-update.png" 2>&1 | sed 's/^/    /' || rc=$?
  if [[ "$rc" == "0" ]]; then ok '界面启动校验通过'; return 0; fi
  if [[ "$rc" == "3" ]]; then warn '界面启动校验跳过（环境缺少 Chromium）'; return 0; fi
  fail '界面启动校验失败：渲染层没有真正画出界面'
  return 1
}

# 守卫自检：repo-snapshot / api-cache 守卫的钩子是否仍对得上刚装好的运行时，
# 以及线上宿主是否真的加载了守卫（AGENTS.md 要求每次升级后必跑——挂进链路里，
# 免得靠人记）。任一 WARN 视为校验失败，走与 smoke/ui-check 相同的回滚路径：
# 新运行时若改了 bundle 结构导致守卫失效，回滚到备份版本正是恢复手段。
guard_check() {
  if [[ "$DO_GUARD_CHECK" != "1" ]]; then log '跳过守卫自检（--no-guard-check）'; return 0; fi
  local script="$SCRIPT_DIR/scripts/dev/repo-snapshot-guard-status.mjs"
  if [[ ! -f "$script" ]]; then warn '未找到 repo-snapshot-guard-status.mjs，跳过守卫自检'; return 0; fi
  log '运行守卫自检（守卫钩子对齐 + 线上拦截证据）…'
  local out rc=0
  out="$(node "$script" 2>&1)" || rc=$?
  printf '%s\n' "$out" | sed 's/^/    /'
  if [[ "$rc" == "0" && -z "$(printf '%s\n' "$out" | grep -E '^[[:space:]]*WARN')" ]]; then
    ok '守卫自检通过'
    return 0
  fi
  fail '守卫自检发现 WARN（守卫钩子可能与新运行时不匹配，先修守卫再继续用）'
  return 1
}

# ---------- 目标版本资源预检 ----------
# 官方发布是「先传 manifest/部分组件、后传其余组件」，只按 manifest 判定最新版可能
# 升到一半才发现 404。这里在动服务之前，把本次要用到的远端资源全部 HEAD 一遍。
preflight_target() { # preflight_target <version> <need_renderer> <need_runtime>
  local version="$1" want_renderer="$2" want_runtime="$3" dir
  dir="$(mktemp -d "${TMPDIR:-/tmp}/zcode-preflight.XXXXXX")"

  if [[ "$want_renderer" == "1" ]]; then
    (
      if ! "${CURL[@]}" -o /dev/null -r 0-0 --max-time 20 \
        "$CDN_BASE/$version/linux-$ARCH/ZCode-$version-linux-$ARCH.deb" 2>/dev/null; then
        printf '渲染层 %s（官方 .deb 缺失）\n' "$version" >> "$dir/missing"
      fi
    ) &
  fi

  if [[ "$want_runtime" == "1" ]]; then
    (
      local mf="$dir/manifest.json" id cver sha rel
      if ! "${CURL[@]}" --max-time 30 -o "$mf" "$CDN_BASE/$version/manifest-$platform.json" 2>/dev/null; then
        printf '运行时 manifest-%s.json 缺失\n' "$platform" >> "$dir/missing"
      else
        while IFS=$'\t' read -r id cver sha rel; do
          [[ -n "$id" ]] || continue
          if ! "${CURL[@]}" -o /dev/null -r 0-0 --max-time 20 "$CDN_BASE/${rel//+/%2B}" 2>/dev/null; then
            printf '运行时组件 %s %s 缺失\n' "$id" "$cver" >> "$dir/missing"
          fi
        done < <(node -e 'const m=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));for(const c of m.components)console.log([c.id,c.version,c.sha256,c.artifactPath].join("\t"))' "$mf")
      fi
    ) &
  fi
  wait

  if [[ -s "$dir/missing" ]]; then
    fail "v$version 的官方资源不完整（CDN 可能仍在发布该版本）:"
    sed 's/^/    /' "$dir/missing" >&2
    rm -rf "$dir"
    return 1
  fi
  rm -rf "$dir"
  ok "远端资源预检通过（v$version）"
}

# ---------- 渲染层 ----------
do_renderer() { # do_renderer <version>
  local version="$1" got
  step "更新渲染层 → v$version"
  ZCODE_WEBUI_HOME="$DATA_HOME" ZCODE_VERSION="$version" ZCODE_ARCH="$ARCH" FORCE=1 \
    bash "$SCRIPT_DIR/scripts/fetch-renderer.sh"
  got="$(renderer_version)"
  if [[ "$got" != "$version" ]]; then fail "渲染层版本不符（期望 $version，实际 '${got:-无}'）"; return 1; fi
  ok "渲染层已就位: v$got（$RENDERER_DIR）"
}

# ---------- 官方运行时 ----------
do_runtime() { # do_runtime <version>
  local version="$1" work manifest stage backup
  step "更新官方运行时 → v$version（$platform）"
  mkdir -p "$TMP_BASE"
  manifest="$TMP_BASE/manifest-$platform-$version.json"
  log "组件清单: $CDN_BASE/$version/manifest-$platform.json"
  if ! "${CURL[@]}" --max-time 30 -o "$manifest" "$CDN_BASE/$version/manifest-$platform.json"; then
    fail "组件清单下载失败（该版本可能没有 $platform 构建）"; return 1
  fi
  local appver; appver="$(json_field "$(cat "$manifest")" appVersion)"
  if [[ "$appver" != "$version" ]]; then fail "清单版本不符（期望 $version，清单为 '${appver:-空}'）"; return 1; fi

  work="$TMP_BASE/server-$version-$$"
  rm -rf "$work"; stage="$work/root"; mkdir -p "$stage"

  local id cver sha rel target url archive actual rows
  rows="$(node -e 'const m=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));for(const c of m.components)console.log([c.id,c.version,c.sha256,c.artifactPath].join("\t"))' "$manifest")"

  while IFS=$'\t' read -r id cver sha rel; do
    [[ -n "$id" ]] || continue
    target="$(component_target "$id")"
    if [[ -z "$target" ]]; then warn "未知组件 $id，跳过（请更新 zcode-webui 以支持新组件）"; continue; fi
    # 组件路径是 CDN_BASE 下的相对路径（形如 components/<platform>/<id>/<ver>.tar.gz）。
    # 版本号里的 "+" 必须编码成 %2B，否则 CDN 按空格处理会 404（等价于
    # src/upgrade.mjs 里的 artifactPath.split('/').map(encodeURIComponent)）。
    url="$CDN_BASE/${rel//+/%2B}"
    archive="$work/$id.tar.gz"
    log "  ↓ $id $cver"
    if ! "${CURL[@]}" --max-time 900 -o "$archive" "$url"; then fail "$id 下载失败: $url"; return 1; fi
    actual="$(sha256sum "$archive" | cut -d' ' -f1)"
    if [[ -z "${sha:-}" || "$actual" != "$sha" ]]; then
      fail "$id SHA256 校验失败（清单 ${sha:0:12}… vs 实际 ${actual:0:12}…）"; return 1
    fi
    log "  ✓ SHA256 校验通过（${actual:0:12}…）"
    mkdir -p "$stage/$target"
    if ! tar -xzf "$archive" -C "$stage/$target"; then fail "$id 解包失败"; return 1; fi
    rm -f "$archive"
    mkdir -p "$stage/.asset-components"
    printf '{\n  "id": "%s",\n  "version": "%s",\n  "sha256": "%s",\n  "platformArch": "%s"\n}\n' \
      "$id" "$cver" "$sha" "$platform" > "$stage/.asset-components/$id.json"
    case "$id" in
      glm)               printf '%s\n' "$cver" > "$stage/agents/glm/.version" ;;
      bfs|ripgrep|ugrep) printf '%s\n' "$cver" > "$stage/tools/$id/.version" ;;
    esac
  done <<<"$rows"

  local rel_path
  for rel_path in "${RUNTIME_EXECUTABLES[@]}"; do
    if [[ -e "$stage/$rel_path" ]]; then chmod 755 "$stage/$rel_path" || true; fi
  done
  for rel_path in "${RUNTIME_REQUIRED[@]}"; do
    if [[ ! -e "$stage/$rel_path" ]]; then fail "官方运行时组件不完整，缺少 $rel_path"; return 1; fi
  done
  log '校验新运行时结构 … 完成'

  # 原子替换：旧 root 改名成备份（名字里写旧版本，便于识别回滚目标），
  # staged root 就位；失败则把备份改回来
  local prev_version; prev_version="$(runtime_version)"
  backup="$SERVER_ROOT.bak-${prev_version:-unknown}-$(date +%s)"
  if [[ -d "$SERVER_ROOT" ]]; then
    if ! mv "$SERVER_ROOT" "$backup"; then fail "旧运行时改名失败: $SERVER_ROOT"; return 1; fi
  fi
  if ! mv "$stage" "$SERVER_ROOT"; then
    if [[ -d "$backup" ]]; then mv "$backup" "$SERVER_ROOT"; fi
    fail '新运行时就位失败，已恢复原运行时'; return 1
  fi
  rm -rf "$work"

  if [[ -d "$backup" ]]; then
    if [[ "$KEEP_BACKUP" == "1" ]]; then
      local p kept=0
      while IFS= read -r p; do
        [[ -n "$p" ]] || continue
        kept=$((kept + 1))
        if [[ "$kept" -gt "$KEEP_BACKUPS" ]]; then rm -rf "$p"; fi
      done < <(ls -1dt "$SERVER_ROOT".bak-* 2>/dev/null || true)
      log "  旧运行时已备份: $backup（回滚: $0 --rollback）"
    else
      rm -rf "$backup"
    fi
  fi

  local got; got="$(runtime_version)"
  if [[ "$got" != "$version" ]]; then fail "运行时版本不符（期望 $version，实际 '${got:-无}'）"; return 1; fi
  ok "官方运行时已就位: v$got（$SERVER_ROOT）"
}

# ---------- 更新后校验 ----------
verify_after_update() { # verify_after_update <target>
  local target="$1" rv sv health bad=0 hok hrenderer hhost selfv
  step '更新后校验'
  rv="$(renderer_version)"; sv="$(runtime_version)"
  if [[ "$rv" == "$target" ]]; then ok "渲染层版本: v$rv"; else fail "渲染层版本异常: '${rv:-无}'（期望 $target）"; bad=1; fi
  if [[ "$sv" == "$target" ]]; then ok "运行时版本: v$sv"; else fail "运行时版本异常: '${sv:-无}'（期望 $target）"; bad=1; fi
  if [[ "$rv" != "$sv" ]]; then fail "渲染层与运行时版本不一致（v$rv vs v$sv），界面会异常"; bad=1; fi

  if [[ -x "$SERVER_ROOT/node" ]]; then
    selfv="$("$SERVER_ROOT/node" "$SERVER_ROOT/zcode-server.cjs" --version 2>/dev/null | head -1 | awk '{print $1}' || true)"
    if [[ "$selfv" == "$target" ]]; then ok "zcode-server.cjs --version: $selfv"
    else warn "zcode-server.cjs 自报版本: '${selfv:-读取失败}'（期望 $target）"; fi
  fi

  if ! is_up; then
    warn "服务未运行，跳过健康检查、smoke 与界面校验（启动: $SCRIPT_DIR/zcode-service.sh start）"
    return "$bad"
  fi

  health="$(health_json)"
  hok="$(json_field "$health" ok)"
  hrenderer="$(json_field "$health" rendererLoaded)"
  if [[ "$hok" == "true" ]]; then ok '健康检查: ok'; else fail "健康检查异常: ${health:0:200}"; bad=1; fi
  if [[ "$hrenderer" == "true" ]]; then ok '健康检查: rendererLoaded'; else fail '健康检查: rendererLoaded=false（渲染层未加载）'; bad=1; fi

  smoke_check || bad=1
  ui_check || bad=1
  guard_check || bad=1

  health="$(health_json)"
  hhost="$(json_field "$health" hostVersion)"
  if [[ "$hhost" == "$target" ]]; then ok "官方运行时握手版本: $hhost"
  else warn "官方运行时握手版本: '${hhost:-null}'（期望 $target；新会话建立后会更新）"; fi

  if scan_new_log_errors "$LOG_MARK" '更新后'; then ok '新增日志中未发现异常'; fi
  return "$bad"
}

# ---------- 回滚 ----------
do_rollback() {
  step '回滚到最近一次更新前的备份'
  local rbackup sbackup was_up=0 ts r_cur="" s_cur="" rv sv
  rbackup="$(ls -1dt "$RENDERER_DIR".bak-* 2>/dev/null | head -1 || true)"
  sbackup="$(ls -1dt "$SERVER_ROOT".bak-* 2>/dev/null | head -1 || true)"
  if [[ -z "$rbackup" && -z "$sbackup" ]]; then
    die "没有找到任何备份（$RENDERER_DIR.bak-* / $SERVER_ROOT.bak-*）"
  fi
  log "渲染层备份: ${rbackup:-无}"
  log "运行时备份: ${sbackup:-无}"
  if is_up; then was_up=1; stop; SERVICE_STOPPED=1; fi

  ts="$(date +%s)"
  if [[ -n "$rbackup" ]]; then
    r_cur="$RENDERER_DIR.replaced-$ts"
    mv "$RENDERER_DIR" "$r_cur"; mv "$rbackup" "$RENDERER_DIR"
    log "渲染层回滚 → v$(renderer_version)（被替换的新版本保留在 $r_cur）"
  fi
  if [[ -n "$sbackup" ]]; then
    s_cur="$SERVER_ROOT.replaced-$ts"
    mv "$SERVER_ROOT" "$s_cur"; mv "$sbackup" "$SERVER_ROOT"
    log "运行时回滚 → v$(runtime_version)（被替换的新版本保留在 $s_cur）"
  fi

  # 备份可能是很久以前的（版本名也可能与实际内容不符），回滚后两个组件必须同版本，
  # 否则撤销本次回滚——半个组件回退比不回滚更坏。
  rv="$(renderer_version)"; sv="$(runtime_version)"
  if [[ -n "$rv" && -n "$sv" && "$rv" != "$sv" ]]; then
    warn "回滚后的版本对不齐（渲染层 v$rv vs 运行时 v$sv），撤销本次回滚"
    if [[ -n "$r_cur" ]]; then mv "$RENDERER_DIR" "$rbackup"; mv "$r_cur" "$RENDERER_DIR"; fi
    if [[ -n "$s_cur" ]]; then mv "$SERVER_ROOT" "$sbackup"; mv "$s_cur" "$SERVER_ROOT"; fi
    if [[ "$was_up" == "1" && "$DO_RESTART" == "1" ]]; then start; SERVICE_STOPPED=0; fi
    fail "已撤销回滚，当前版本 v$(renderer_version)/$(runtime_version)；可用 $0 -v <版本> 装一对匹配的版本"
    return 1
  fi

  if [[ "$was_up" == "1" && "$DO_RESTART" == "1" ]]; then
    start
    SERVICE_STOPPED=0
    if ! verify_after_update "$(renderer_version)"; then
      fail '回滚后校验未通过，请人工检查'
      return 1
    fi
  fi
  ok '回滚完成（如需恢复到回滚前的版本，把 .replaced-* 改名回去即可）'
}

# ---------- 失败兜底：更新途中挂了要把服务拉回来 ----------
on_exit() {
  local code=$?
  if [[ "$code" != "0" && "$SERVICE_STOPPED" == "1" && "$DO_RESTART" == "1" ]]; then
    warn "更新失败（exit $code），尝试恢复服务…"
    start || warn "服务恢复失败，请手动执行: $SCRIPT_DIR/zcode-service.sh start"
  fi
  exit "$code"
}
trap on_exit EXIT

# ========== 主流程 ==========
LOG_MARK="$(log_lines)"
log "zcode-update | 模式: $MODE | 平台: $platform | 数据目录: $DATA_HOME"
log "运行时目录: $SERVER_ROOT"
log "渲染层目录: $RENDERER_DIR"

if [[ "$DO_ROLLBACK" == "1" ]]; then
  if do_rollback; then exit 0; else exit 1; fi
fi

# 1. 目标版本
cur_renderer="$(renderer_version)"
cur_runtime="$(runtime_version)"
site_v="$(site_version)"
cdn_v=""
if [[ "$STABLE_ONLY" == "1" && -z "$TARGET_VERSION" ]]; then
  TARGET_VERSION="${site_v:-$PINNED_VERSION}"
elif [[ -z "$TARGET_VERSION" ]]; then
  base_v="${site_v:-$PINNED_VERSION}"
  cdn_v="$(probe_cdn_latest "$base_v")"
  TARGET_VERSION="${cdn_v:-$site_v}"
  if [[ -z "$TARGET_VERSION" ]]; then TARGET_VERSION="$PINNED_VERSION"; fi
fi

log ''
log "官网公布版本: ${site_v:-读取失败（兜底 $PINNED_VERSION）}"
if [[ "$STABLE_ONLY" == "1" ]]; then
  log 'CDN 探测: 已跳过（--stable）'
else
  log "CDN 探测最高版本: ${cdn_v:-未发现更新版本}"
fi
log "目标版本: $TARGET_VERSION"
log "当前渲染层: ${cur_renderer:-未安装}"
log "当前运行时: ${cur_runtime:-未安装}"
if [[ "$STABLE_ONLY" == "1" ]]; then
  log "（--stable：只采用官网公布版本）"
elif [[ -n "$site_v" && "$TARGET_VERSION" != "$site_v" ]] && version_gt "$TARGET_VERSION" "$site_v"; then
  log "（CDN 上已有比官网公告更新的构建，按 CDN 版本更新；--stable 可只跟官网版本）"
fi
# 不设置固定 shim 版本上限；安装后由 UI 启动校验和失败回滚兜底。

need_renderer=0; need_runtime=0
if [[ "$MODE" != "server" ]]; then
  if [[ "$FORCE" == "1" || "$cur_renderer" != "$TARGET_VERSION" ]]; then need_renderer=1; fi
fi
if [[ "$MODE" != "renderer" ]]; then
  if [[ "$FORCE" == "1" || "$cur_runtime" != "$TARGET_VERSION" ]]; then need_runtime=1; fi
fi

if [[ "$CHECK_ONLY" == "1" ]]; then
  log ''
  if [[ "$need_renderer" == "1" || "$need_runtime" == "1" ]]; then
    log "有更新可用: v${cur_renderer:-无}/${cur_runtime:-无} → v$TARGET_VERSION（渲染层: $need_renderer，运行时: $need_runtime）"
  else
    log "已是最新 v$TARGET_VERSION，无需更新"
  fi
  exit 0
fi

if [[ "$need_renderer" == "0" && "$need_runtime" == "0" ]]; then
  ok "渲染层与运行时均已是 v$TARGET_VERSION（--force 可强制重装）"
  if verify_after_update "$TARGET_VERSION"; then exit 0; else exit 1; fi
fi

# 1.5 远端资源预检（动服务之前先把 404 挡掉）
preflight_target "$TARGET_VERSION" "$need_renderer" "$need_runtime" \
  || die "v$TARGET_VERSION 尚不可用；可用 -v <较低版本> 指定其他版本，或稍后重试"

# 2. 要换运行时且服务在跑 → 先停（升级会整目录替换 ~/.zcode/server）
if is_up; then
  WAS_UP=1
  active_sessions="$(json_field "$(health_json)" sessions.total)"
  if [[ "$need_runtime" == "1" ]]; then
    if [[ "${active_sessions:-0}" != "0" && "$ASSUME_YES" != "1" && -t 0 ]]; then
      printf '[zcode-update] 服务有 %s 个活动会话，升级运行时会中断它们。继续？(y/N) ' "$active_sessions"
      read -r ans || ans=""
      if [[ "${ans,,}" != y* ]]; then log '已取消'; exit 0; fi
    elif [[ "${active_sessions:-0}" != "0" ]]; then
      warn "服务有 ${active_sessions} 个活动会话，升级运行时会中断它们"
    fi
    stop
    SERVICE_STOPPED=1
  else
    log '只更新渲染层，服务无需停止（浏览器刷新即可生效）'
  fi
fi

# 3. 渲染层
if [[ "$need_renderer" == "1" ]]; then
  do_renderer "$TARGET_VERSION"
else
  log "渲染层已是 v$TARGET_VERSION，跳过"
fi

# 4. 官方运行时
if [[ "$need_runtime" == "1" ]]; then
  do_runtime "$TARGET_VERSION"
else
  log "运行时已是 v$TARGET_VERSION，跳过"
fi

# 5. 重启 + 校验
if [[ "$WAS_UP" == "1" || "$need_runtime" == "1" ]]; then
  if [[ "$DO_RESTART" == "1" ]]; then
    step '重启服务'
    start
    SERVICE_STOPPED=0
  else
    warn "未自动重启服务；请执行: $SCRIPT_DIR/zcode-service.sh restart"
    SERVICE_STOPPED=0
  fi
fi

# 5. 重启 + 校验（校验不过就自动回滚，绝不把坏版本留在服务上）
if ! verify_after_update "$TARGET_VERSION"; then
  if [[ "$AUTO_ROLLBACK" == "1" ]]; then
    warn "v$TARGET_VERSION 校验未通过，自动回滚到更新前的版本…"
    do_rollback || warn "自动回滚未完成，请手动执行: $0 --rollback"
  else
    warn "校验未通过（--no-auto-rollback）；手动回滚: $0 --rollback"
  fi
  exit 1
fi

printf '\n[zcode-update] 更新完成：渲染层 v%s、运行时 v%s' "$(renderer_version)" "$(runtime_version)"
if is_up; then printf '、服务健康\n'; else printf '、服务未运行\n'; fi
