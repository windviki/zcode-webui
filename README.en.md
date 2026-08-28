# zcode-webui

> Language: [中文](./README.md) | **English**

Run the official ZCode desktop UI entirely in your browser, backed by the official runtime on your own
machine (`zcode-server` + GLM Agent). A companion to the official desktop app: deploy once, then open the
same ZCode from phones, tablets, thin clients — any browser — to dispatch tasks and drive sessions.
Your code, sessions and credentials stay on your server.

- 🖥️ **The official UI, as-is**: chat, tasks, workspace tree — same capabilities as the desktop;
  following an official UI update is just re-running one download script
- 🤝 **Natural code-server integration**: mount under `/proxy/<port>/` and share its auth; falls back to
  HTTP long-polling automatically when WebSocket is blocked
- ⏳ **Tasks decoupled from tabs**: closing a tab / losing network never kills a task; idle background
  sessions are reaped under a triple safety condition, working ones never are
- 🔑 **Flexible login**: built-in OAuth, or import credentials exported from a logged-in desktop client;
  shares the same credential store as official clients
- 🔍 App-level zoom via Ctrl+wheel or pinch (50%–200%): midpoint-anchored, finger-tracking pan,
  composited transform preview during the gesture, crisp re-rasterized commit at the end
- 🧭 `zcode-webui setup`: fully automated deploy of the renderer, the official runtime, config and startup
- 📦 Ships no, modifies no, redistributes no official code; the core is just a few source files

## Quick start

> Requirements: Linux x64/arm64 · Node.js ≥ 18 · `curl`, `dpkg-deb`, `tar` · ≥ 2GB disk ·
> reachability of `cdn-zcode.z.ai` (downloads) and `zcode.z.ai` (login).

```bash
npm install -g @aixyzstudio/zcode-webui   # needs Node.js >= 18
zcode-webui setup --yes                   # fully automated: renderer download → official runtime
                                          # install → config → start → health gate
```

Open `http://<server>:3102/`. If not logged in, visit `/login` for OAuth first (when the server cannot
reach `zcode.z.ai/api/v1`, pass `setup --oauth-proxy <proxy>` or see the [FAQ](#faq)).

For git-based deployment see [Manual deployment](#manual-deployment-git-clone); running plain
`zcode-webui setup` gives you the interactive wizard instead.

## Relationship with the official client: only a middle layer

| Part | Implemented by |
|---|---|
| UI (renderer) | The official client verbatim; deployed locally via this project's script from the official CDN. **Never committed to this repo, never redistributed** |
| Agent / model calls / session store | The official runtime (`zcode-server.cjs`) + GLM Agent, **unmodified** |
| Authentication | The official CLI OAuth flow; credentials go to the official store `~/.zcode/v2/credentials.json` |
| **This project's layer** | Serves the official UI with injected bootstrap config; the `window.zcode` browser shim; a MessagePort ↔ WebSocket bridge; spawns and relays the official runtime |

> **Disclaimer**: community project, not affiliated with Zhipu / Z.ai; contains no official code.
> Follow the official terms of service; model usage is billed per your subscription.

## Manual deployment (git clone)

```bash
git clone https://github.com/windviki/zcode-webui.git
cd zcode-webui && npm install          # only runtime dependency: ws

npm run fetch-renderer                 # downloads the official installer from the CDN and extracts
                                       # the UI (default 3.9.2; override ZCODE_VERSION=… ZCODE_ARCH=x64)

cp config.example.json config.json     # optional; common fields: workspace / oauthProxy / hostProxy

npm start                              # equals node src/server.mjs, default http://0.0.0.0:3102/
```

For long-running setups prefer `zcode-webui setup --systemd`, or a system-level unit:

```ini
[Unit]
Description=zcode-webui
After=network-online.target

[Service]
User=youruser
WorkingDirectory=/opt/zcode-webui
ExecStart=/usr/bin/node src/server.mjs
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## code-server integration (recommended)

Run in root mode (**do NOT set basePath**): `node src/server.mjs --port 3102`.
Nothing else to configure — your public entry is `https://<domain>/proxy/3102/`:

- asset paths, APIs, WebSocket and the login page are derived from the page URL; the bare `/proxy/3102`
  (missing slash) is auto-redirected;
- when WebSocket fails, the frontend degrades to the HTTP long-polling bridge automatically;
- authentication is delegated to code-server; no nginx required.

Sub-path deployment behind your own reverse proxy: `ZCODE_WEBUI_BASE_PATH=/zcode npm start`
(a bare `/zcode` gets 302-redirected); nginx just forwards with the prefix preserved
(`proxy_pass http://127.0.0.1:3102;` without URI + standard Upgrade headers).

## Login & credentials (pick one)

**A · OAuth directly in the WebUI (simplest; server must reach zcode.z.ai)**
Open `<service-url>/login`, click "start login" and finish the Z.ai OAuth in the authorization link;
credentials land in the server's `~/.zcode/v2/credentials.json`.

**B · Export credentials from a logged-in desktop client (no server egress needed)**
On the desktop machine open `<service-url>/export-credentials.html` (runs entirely in your browser),
pick its `~/.zcode/v2/credentials.json`, fill in platform/home-dir/username to decrypt, paste the output
JSON into `/login` → import.

**C · The server was already logged in via the official CLI/desktop**
`~/.zcode` is ready — nothing to do.

## Task lifecycle (important, 30 seconds)

Every tab connects to its own server-side session (an official runtime process), and one process serves
exactly one page for its whole lifetime. **Closing a tab / switching devices does not end tasks**: the
process parks in the background until its work finishes or waits for your input; a reopened page
**adopts that still-running process first** — same pid, live progress continues seamlessly — and only
spawns a fresh one when nothing is adoptable (loading the latest persisted state from the shared store).
Only the page you are actively using is the LIVE view: switching devices moves it with you, while the
page left behind shows a "taken over" notice with one-click take-back — two agents can never drive the
same work simultaneously. Idle background processes are reaped after
30 minutes by default (working / waiting-for-input ones never are); online pages are never reaped.
**Restarting the zcode-webui service interrupts background tasks** (same as restarting the desktop app).

## Configuration reference

Priority: CLI args ≈ env vars > `config.json` > defaults.

| Env / flag | config.json | Default | Meaning |
|---|---|---|---|
| `ZCODE_WEBUI_PORT` / `--port` | `port` | `3102` | Listen port |
| `ZCODE_WEBUI_BASE_PATH` / `--base-path` | `basePath` | empty (root) | URL prefix, e.g. `/zcode` (do NOT set in code-server proxy mode) |
| `ZCODE_WEBUI_WORKSPACE` / `--workspace` | `workspace` | `$HOME` | Initial workspace directory |
| `ZCODE_WEBUI_LOCALE` | `locale` | `zh-CN` | UI language |
| `ZCODE_WEBUI_OAUTH_PROXY` / `--oauth-proxy` | `oauthProxy` | empty | HTTP proxy for the OAuth flow (server can't reach `zcode.z.ai/api/v1`) |
| `ZCODE_WEBUI_HOST_PROXY` / `--host-proxy` | `hostProxy` | empty | HTTP proxy used by the runtime/agent for cloud + model APIs (`api.z.ai`, `open.bigmodel.cn`) |
| `ZCODE_SERVER_RUNTIME_ROOT` | `serverRoot` | `~/.zcode/server` | Official runtime directory (rarely changed) |
| `ZCODE_HOME` | — | `~/.zcode` | Official data/credential directory (shared with the CLI) |
| `ZCODE_WEBUI_HOME` | — | see notes | Data home of this service (config, renderer, device id, logs); defaults to `~/.zcode-webui` for npm installs; git checkouts keep using the project dir when it already contains `config.json` or `vendor/renderer` |
| `ZCODE_VERSION` / `ZCODE_ARCH` | — | `3.9.2` / `x64` | Version/architecture for `fetch-renderer` |
| `ZCODE_WEBUI_DETACHED_TTL_MS` | — | `1800000` | Reap detached background hosts after this long when idle; `0` = keep forever |
| `ZCODE_WEBUI_FRAME_QUIET_MS` | — | `600000` | Reap precondition: no host→browser frames within this window |
| `ZCODE_WEBUI_RUNNING_TASK_STALE_MS` | — | `7200000` | Global reap guard: nothing is reaped while the task index has a recent "running" task |
| `ZCODE_WEBUI_DEBUG_RPC` | — | off | Set `1` to log protocol message previews (debugging) |

## CLI reference (npm package)

| Command | Purpose |
|---|---|
| `zcode-webui setup` | One-shot deploy wizard: target-version resolution → env checks → **automatic official-runtime install** when missing (via the official component channel) → credential check → renderer download → writes `config.json` (0600) → optional systemd user unit → starts the service and waits for the health gate. `--yes` = non-interactive defaults AND start (add `--no-start` to skip starting); other flags `--port/--workspace/--locale/--base-path/--oauth-proxy/--host-proxy/--server-root/--version/--arch/--fetch/--no-fetch/--systemd/--no-systemd` |
| `zcode-webui start` | Run in the foreground (Ctrl-C stops; extra args pass through) |
| `zcode-webui stop` | Stop the background instance or the systemd service (foreground ones: Ctrl-C) |
| `zcode-webui upgrade` | One-command upgrade of renderer + official runtime (below) |
| `zcode-webui fetch-renderer` | Download/update just the renderer (`ZCODE_VERSION`/`ZCODE_ARCH` override) |
| `zcode-webui doctor [--net]` | Readiness checks: node/curl/dpkg-deb, runtime + agent entry, credentials, renderer, **renderer↔runtime version alignment**, service status; `--net` adds connectivity checks |
| `zcode-webui status` | Print health JSON (non-zero exit when not running) |
| `zcode-webui version` / `help` | Version / help |

All mutable data lives in the data home (`~/.zcode-webui`, override with `ZCODE_WEBUI_HOME`; git checkouts
keep using the project dir), so the package directory stays read-only.

### One-command upgrade

```bash
zcode-webui upgrade                    # detect latest from the website, upgrade renderer + runtime
zcode-webui upgrade --yes --restart    # non-interactive, stop/start the service around the upgrade
```

Flow: resolve the newest version from the [changelog](https://zcode.z.ai/cn/changelog) → re-extract the
renderer → download the runtime components listed in the official manifest (each SHA256-verified),
assemble them in a fresh directory and **atomically swap** them in (previous root kept as
`~/.zcode/server.bak-<version>-<timestamp>`, only the most recent backup retained). When the service is
running you are asked whether to stop it first (`--yes` skips the prompt without stopping).
Other flags: `--version X.Y.Z`, `--arch x64|arm64`, `--renderer-only` / `--server-only`,
`--force` (reinstall even when current), `--no-backup`.
Note: `upgrade` updates the official components only; upgrade zcode-webui itself with
`npm update -g @aixyzstudio/zcode-webui`.

## Official CLI headless usage (optional)

The WebUI itself needs no CLI config. To also use the official CLI headlessly (shares credentials and the
session store with the WebUI):

```bash
cp cli-config.example.json ~/.zcode/cli/config.json && chmod 600 ~/.zcode/cli/config.json
# replace provider.bigmodel.options.apiKey with your Coding Plan API Key (or run official `zcode login`)

~/.zcode/server/node ~/.zcode/server/agents/glm/zcode.cjs \
  --cwd /path/to/workspace --prompt 'list files in this directory' --max-turns 1
# continue an existing session: add --resume sess_xxx --prompt 'go on'
```

> Keep key files at 0600 outside any repo; set `ZCODE_HTTP_PROXY`/`ZCODE_NO_PROXY` if a proxy is needed.

## HTTP API

- `GET <base>/api/health` — service status (version / renderer / runtime / login / session counts / reaper)
- `POST <base>/api/sessions/terminate` — terminate every session immediately (including background ones)
- `POST <base>/api/login/start` · `GET /api/login/status` · `POST /api/login/cancel` — OAuth flow
- `POST <base>/api/login/import` — import a credentials JSON into the official store
- `GET <base>/api/fs/list?path=<dir>` — directory listing for the web picker
- `POST <base>/bridge/open` · `GET /bridge/poll` · `POST /bridge/send` · `POST /bridge/close` — HTTP long-polling bridge
- `WS <base>/ws?token=<random per boot>` — frontend protocol bridge

## Security notes

- The service listens on `0.0.0.0` and does **no user authentication itself** (local trust model):
  anyone who can reach the port runs agents as your server's ZCode account. **Always put it behind a
  reverse proxy / gateway** (code-server login, SSO, basic auth…); never expose the port publicly.
- `/api/fs/list`, `/api/login/import` and `/api/sessions/terminate` read the filesystem / write the
  credential store / kill tasks — protected by the same outer auth assumption.
- Credentials land in `~/.zcode/v2/credentials.json` (0600); `config.json` is gitignored — never commit
  configs containing secrets.
- The WS token guards against connecting to the wrong WS service; it is NOT authentication.

## FAQ

**Q: Do tasks survive closing the tab?**
Yes, they run in the background until finished or waiting for input; reopen the page to catch up
(see *Task lifecycle*). Idle background hosts are reaped after 30 minutes by default;
set `ZCODE_WEBUI_DETACHED_TTL_MS=0` to disable reaping, or clear everything via
`POST /api/sessions/terminate`.

**Q: How do I zoom?** Ctrl+wheel or pinch (50%–200%, remembered per browser); Ctrl/⌘ +/- remains browser
page zoom, both coexist.

**Q: Sending says "no usable model provider"?**
Check you are logged in at `/login`; run `zcode-webui doctor` and look at the **version alignment**
line (if mismatched, align via `zcode-webui upgrade`); still failing means outdated project code — update.

**Q: OAuth stuck waiting? Model calls fail while login works?**
Set `oauthProxy` for the former and `hostProxy` for the latter (env var or `config.json`; both may be
used together) pointing at a reachable HTTP proxy, then restart the service.

**Q: "Add project → open folder" does nothing?** Allow pop-ups for the site; the folder picker is a
built-in web page.

**Q: Blank page through code-server?** Use the trailing-slash URL `/proxy/3102/` (auto-redirects);
WebSocket failures degrade to long-polling automatically; `<base>/debug` shows bridge status.

**Q: Clicking a session shows "ZCode agent server command is not configured"?**
The runtime can't find the agent entry. Recent versions inject the locating env vars automatically;
run `zcode-webui doctor` (check `agent server`), then **restart the service** so the fixed code is
running. Custom paths: override `ZCODE_AGENT_SERVER_COMMAND` / `ZCODE_AGENT_SERVER_ARGS_JSON`.

**Q: How do I upgrade the official UI?** Just run `zcode-webui upgrade` (see *One-command upgrade*).

**Q: My in-progress task stopped after the server slept / lost network?**
Two distinct cases:

- **It is actually still running (common)**: any device reopening the page **adopts the still-running
  process first — live progress, seamless continuation**, and the previously active page demotes itself
  to a paused state with one-click take-back. No duplicate-agent conflict by construction.
- **The turn really died**: suspend/network loss cuts the stream and that turn fails (the service
  log prints `process stall of ~Ns` for correlation). Resume headlessly with the official CLI:
  `~/.zcode/server/node ~/.zcode/server/agents/glm/zcode.cjs --cwd <workspace> --resume <sessionId> --prompt 'continue'`;
  reloading the page loads the latest persisted state. Avoid sleep during long tasks.

**Q: Do scheduled tasks work?**
That scheduler belongs to the official desktop. Emulate with system cron calling the official CLI's
`--prompt/--resume`, billed per your subscription.

## Testing

```bash
npm run smoke                            # static serving + base path + WS/HTTP bridges end-to-end
bash scripts/docker/verify.sh            # full chain in Docker: npm package → automated install →
                                         # service → smoke → real model turn
ZCODE_VERIFY_FRESH_RUNTIME=1 bash scripts/docker/verify.sh   # stricter: container holds ONLY credentials,
                                                             # proving setup auto-installs everything else
                                                             # (CDN components + SHA256 verification)
```

Docker verification copies your local `~/.zcode` into a temporary sandbox injected at run time and deleted
afterwards; no credentials ever enter image layers or the repository. Override with
`ZCODE_VERIFY_SOURCE/PROXY/NETWORK/KEEP/SKIP_FETCH`. `scripts/dev/` additionally contains Playwright
end-to-end regressions driving the real logged-in UI (`ZCODE_WEBUI_TEST_URL`/`TEST_DIR` point at your own).

## Known limitations

- No SSH/WSL/Docker remote-workspace creation (the service already runs on your workspace machine)
- Desktop-only channels unavailable: phone remote control, tray icon, auto-update (Browser Use works via
  headless Chrome on the server)
- Scheduled/idle-time tasks depend on the desktop scheduler (see FAQ)
- Restarting the service interrupts background tasks; in HTTP long-polling mode reopened pages cannot
  seamlessly take over a session (results remain visible in the task panel)
- The official UI evolves between versions; occasionally a newer UI may lag behind — keep renderer and
  runtime on matching versions

## Repository layout

```
src/server.mjs             HTTP serving + base path + WS bridge + login API + session management
src/cli.mjs                zcode-webui CLI (setup / start / stop / upgrade / doctor / status)
src/dirs.mjs               Data-home resolution (ZCODE_WEBUI_HOME / repo mode)
src/frame.mjs              stdio frame codec (talks to the official runtime)
src/host.mjs               Official runtime process spawning + handshake
src/upgrade.mjs            Version discovery + component download/verification + atomic swap
src/login.mjs              Official CLI OAuth login subprocess management
src/rpclog.mjs             Diagnostic logging (DEBUG_RPC)
web/bootstrap.js           Browser side: URL params, MessagePort↔WebSocket bridge, polling fallback
web/zcode-bridge.js        window.zcode browser shim
web/{login,picker,debug}.html etc   Login page / directory picker / self-check / credential export
config.example.json        Service config template (sanitized)
cli-config.example.json    Official CLI model-config template (sanitized)
scripts/fetch-renderer.sh  Downloads the official client from CDN, extracts the renderer (not committed)
scripts/smoke-test.mjs     Smoke test
scripts/docker/            Full-chain Docker verification (verify.sh + container-verify.sh)
scripts/dev/*.mjs          Playwright end-to-end scripts
```

## License

- Code licensed under [MIT](./LICENSE);
- The official ZCode name, trademark and client are property of their owners; this project neither
  includes nor redistributes any official client files;
- References: [official docs](https://zcode.z.ai/cn/docs) · [BigModel](https://open.bigmodel.cn) ·
  [GLM Coding Plan](https://docs.bigmodel.cn/cn/coding-plan/overview).
