# zcode-webui

> Language: [中文](./README.md) | **English**

> Run the official ZCode desktop UI entirely in your browser, working side by side with code-server.
> 在浏览器里完整运行官方 ZCode 桌面端界面，并与 code-server 无缝协同。

**zcode-webui** is a self-hosted web shell: it serves the UI of the official ZCode desktop client
(Zhipu's GLM coding agent) unchanged in the browser, backed directly by the official ZCode runtime
(`zcode-server` + GLM Agent) running on your machine. It is a **complement and extension** of the
official desktop app: deploy it once, and phones, tablets, thin clients — any device with a browser —
can open the same ZCode anytime to manage tasks, dispatch work and keep conversations going. Your code,
sessions and credentials stay on your own server.

- 🖥️ Official UI unchanged: chat, tasks, workspace file tree, Wiki, MCP — identical to the desktop app
- 🤝 Works naturally with code-server: mount it behind code-server's `/proxy/<port>/` port proxy and share its login
- 🌐 Any device, no client install: just open the URL (falls back to HTTP long-polling when reverse proxies block WebSocket upgrades)
- 🔑 Flexible sign-in: built-in OAuth login, or import credentials exported from a logged-in official desktop app — shares the official credential store
- 🔍 Desktop-grade zoom: Ctrl+wheel or trackpad/touchscreen **two-finger pinch** zooms the UI (50%–200%, remembered per browser)
- ⏳ **Tasks are decoupled from tabs**: closing a tab / losing the network does NOT stop a task — it keeps running server-side until it finishes or waits for your input; reopening the page loads the latest data of the same session automatically (session data is persisted to the shared store; **every page load uses a brand-new runtime process** that is never shared with other devices/tabs — no double execution, no protocol cross-talk; a busy old process keeps running in the background, an idle one retires immediately)
- ♻️ Automatic session maintenance: idle background sessions are auto-reaped under a triple guard (detached duration + frame silence + no running task); running or waiting-for-input sessions are never reaped; when auto-reconnect gives up, the page shows a one-click "reconnect" button
- 🧭 One-command npm deployment: `npm i -g` then `zcode-webui setup` walks you through all preparation, configuration and startup
- 📦 No official code is bundled, modified, or redistributed: renderer assets are downloaded by the deployer from the official CDN with a local script

---

## Table of contents

- [What this project is](#what-this-project-is)
- [Relationship with the official app: we only build the middle layer](#relationship-with-the-official-app-we-only-build-the-middle-layer)
- [Complete usage guide (from zero to working)](#complete-usage-guide-from-zero-to-working)
  - [Step 0 · Prerequisites](#step-0--prerequisites)
  - [Step 1 · Create a BigModel account and enable the model service](#step-1--create-a-bigmodel-account-and-enable-the-model-service)
  - [Step 2 · Download and install official ZCode, then authenticate](#step-2--download-and-install-official-zcode-then-authenticate)
  - [Step 3 · Get the credentials onto the server (three options)](#step-3--get-the-credentials-onto-the-server-three-options)
  - [Step 4 · Deploy zcode-webui](#step-4--deploy-zcode-webui)
  - [Step 5 · Integrate with code-server (recommended)](#step-5--integrate-with-code-server-recommended)
  - [Step 6 · Standalone / your own reverse proxy](#step-6--standalone--your-own-reverse-proxy)
  - [Step 7 · Start using it](#step-7--start-using-it)
- [Configuration reference](#configuration-reference)
- [zcode-webui command line (npm package)](#zcode-webui-command-line-npm-package)
- [Official CLI headless usage (optional)](#official-cli-headless-usage-optional)
- [HTTP API](#http-api)
- [Security notes](#security-notes)
- [FAQ](#faq)
- [Tests](#tests)
- [Known limitations](#known-limitations)
- [Directory layout](#directory-layout)
- [License and notices](#license-and-notices)

---

## What this project is

Official ZCode is Zhipu's Agentic Development Environment (ADE): a desktop app that combines GLM coding
models, a self-developed coding agent, task management and file management in one Electron client.
The desktop client has two natural limitations:

1. **It must be installed on a machine with a GUI** — no servers, containers or NAS boxes;
2. **Tasks are tied to the desktop** — away from the machine you can only use limited remote features that require the desktop to be present.

zcode-webui addresses both: the official client's UI is pure web assets, so we serve them from a small
Node service, inject a thin browser-side adapter, and bridge the browser to the official runtime
(`zcode-server.cjs` + GLM Agent, still running on your own machine) over WebSocket. As a result:

- You run one service on your **server/container** and the URL is a complete ZCode;
- Together with **code-server**, it becomes just another app in your existing cloud dev environment,
  served at `https://<your-code-server-domain>/proxy/3102/`;
- Phone, tablet or TV browsers work out of the box — **check task progress, dispatch new tasks,
  continue sessions** anytime;
- Desktop and WebUI can coexist: same machine, same `~/.zcode` credentials and data — desktop at home,
  WebUI on the road, no conflicts.

## Relationship with the official app: we only build the middle layer

zcode-webui **reuses the official implementation as much as possible**:

| Layer | Who implements it |
|---|---|
| UI (renderer) | The official client, unchanged — downloaded by the deployer from the official CDN with a project script; **never committed to this repo, never redistributed** |
| Agent / model calls / session storage | The official runtime `zcode-server.cjs` and GLM Agent, **unmodified** |
| Authentication | The official CLI's OAuth flow; credentials are written to the official store `~/.zcode/v2/credentials.json` (shared with the official client) |
| **The middle layer built by zcode-webui** | ① static hosting of the official UI with injected startup config; ② the `window.zcode` browser adapter (browser equivalent of the desktop preload); ③ MessagePort ↔ WebSocket bridge (with HTTP long-polling fallback); ④ spawning the official runtime process and relaying messages; ⑤ companion tools: login page, credential import, web directory picker |

That keeps the project tiny — a handful of source files. When the official UI upgrades, re-running the
download script once is enough to follow the official version.

> **Disclaimer**: this is a community project, not affiliated with Zhipu / Z.ai. It only provides a
> compatibility layer around the official client and contains no official code; please comply with the
> official terms of service. Model usage is billed according to your official subscription.

## Complete usage guide (from zero to working)

> Want to move faster? The project is published on npm — three commands to deploy:
> `npm install -g @aixyzstudio/zcode-webui` → `zcode-webui setup` (an interactive wizard that guides
> all preparation and configuration) → `zcode-webui start`. See
> [zcode-webui command line (npm package)](#zcode-webui-command-line-npm-package)
> alongside the manual steps below.

### Step 0 · Prerequisites

**The server/container (where zcode-webui runs) needs:**

- Linux x64 or arm64 (Ubuntu/Debian recommended, or any Linux distro that can run Node)
- Node.js ≥ 18 (the project itself only depends on Node)
- `curl`, `dpkg-deb` (to download and unpack the official installer)
- ≥ 2GB free disk (official renderer assets + runtime)
- Access to official domains: `cdn-zcode.z.ai` (downloads), `zcode.z.ai` (login/cloud API).
  For model APIs also `api.z.ai` / `open.bigmodel.cn`; see the [FAQ](#faq) for proxy setup in restricted networks.

**A desktop machine (used for authentication in step 2, optional afterwards):**

- Any one of macOS (Apple Silicon / Intel), Windows (x64 / ARM64) or Linux x64.

### Step 1 · Create a BigModel account and enable the model service

1. Open the [Zhipu open platform](https://open.bigmodel.cn), click "注册/登录" in the top right and sign up with a phone number or email;
2. Go to the [GLM Coding Plan page](https://bigmodel.cn/coding-plan) and subscribe to a plan
   (individual and team plans both have trial/free quotas — follow the official page);
3. Create an API Key (**keep it private, never commit it to any public repository**):
   - Individual: `bigmodel.cn → 个人编程套餐 (Individual Coding Plan) → 套餐概览 (Overview) → 新建 API Key (Create API Key)`;
   - Team: `bigmodel.cn → 团队编程套餐 (Team Coding Plan) → 我的套餐 (My Plan) → 获取 API Key` (team keys are not interchangeable with other platform keys).
4. Prefer the international edition? Register a [Z.ai](https://z.ai) account and subscribe there —
   choose "Connect Z.ai" when logging in to ZCode.

### Step 2 · Download and install official ZCode, then authenticate

Download the installer for your platform from the [official ZCode install docs](https://zcode.z.ai/cn/docs/install)
(current stable: 3.8.1):

- macOS: open the `.dmg` and drag ZCode into Applications; if macOS says it is damaged, run
  `xattr -dr com.apple.quarantine /Applications/ZCode.app`;
- Windows: run the `.exe` installer;
- Linux: download the `.AppImage` (or `.deb`), `chmod +x` and run it.

Complete the first-run setup, then click "**连接使用** (Connect)" in the bottom left to reach the
login page and pick one of:

- **Connect Z.ai** — official OAuth with your Z.ai account (BigModel accounts can sign in too);
- **Connect BigModel** — bind the BigModel account you enabled in step 1;
- **Use an API Key** — paste the API key created in step 1.

After login, choose any project directory as the workspace and send "list the files in this directory"
to confirm replies work. The desktop machine's role in this flow: **it produces the official
credentials and the official runtime** that steps 3–4 reuse (you can keep using the desktop too).

> If the desktop needs a proxy, configure it under Settings → General → Network proxy
> (an empty field means direct connection — it does not follow system proxy env vars).

### Step 3 · Get the credentials onto the server (three options)

zcode-webui shares the `~/.zcode` credential store with the official client. Three ways to bring
credentials to the server:

**Option A · OAuth login directly in the WebUI (simplest; the server must reach zcode.z.ai)**

After deploying, open `http://<server>:3102/login`, click "开始登录 (Start login)", complete the Z.ai
OAuth in the authorization link, and credentials are written to `~/.zcode/v2/credentials.json`
automatically. If the server cannot reach `zcode.z.ai/api/v1`, configure `oauthProxy` (see [FAQ](#faq)).

**Option B · Export credentials from a logged-in desktop and import them (no server egress; recommended for intranets)**

1. On the **logged-in desktop machine**, open the export tool served by zcode-webui in a browser:
   `http://<server>:3102/export-credentials.html` (runs entirely in the local browser; credentials never leave the machine);
2. Pick the desktop credential file, or open and paste its contents:
   - Windows: `%USERPROFILE%\.zcode\v2\credentials.json`
   - macOS / Linux: `~/.zcode/v2/credentials.json`
3. Fill in that machine's platform / home directory / username as prompted (the page pre-fills guesses), click "解密并生成 (Decrypt and generate)";
4. Copy the output JSON into the "导入凭据 (Import credentials)" box on the zcode-webui login page (`/login`) and import it.
   The import endpoint writes `~/.zcode/v2/credentials.json` on the server with mode 0600.

**Option C · The server already has a logged-in official CLI/desktop**

If the server has already run the official CLI (`zcode login`) or the official desktop and is logged in,
`~/.zcode` is ready — skip to step 4, no further authentication needed.

### Step 4 · Deploy zcode-webui

**Option 1 (recommended for newcomers) · npm install + wizard**: `npm install -g @aixyzstudio/zcode-webui`
→ `zcode-webui setup` (the interactive wizard guides in order: environment checks → official runtime
check and how to obtain it → credential check → renderer download → config → optional systemd/immediate
start) → `zcode-webui start`. See [zcode-webui command line (npm package)](#zcode-webui-command-line-npm-package).

**Option 2 · git clone, manual deployment**:
```bash
# 1. Get the code
git clone https://github.com/windviki/zcode-webui.git
cd zcode-webui

# 2. Install dependencies (only one runtime dependency: ws)
npm install

# 3. Download the official renderer assets (fetches the official installer from the
#    official CDN and extracts the UI; default version 3.8.1,
#    override with ZCODE_VERSION=3.8.1 ZCODE_ARCH=x64)
npm run fetch-renderer

# 4. (Optional) create the local config; defaults are used otherwise
cp config.example.json config.json
#    Common fields: workspace (initial workspace dir, empty = $HOME),
#                   oauthProxy / hostProxy (server egress proxies, see FAQ)

# 5. Start
npm start          # equals node src/server.mjs, default http://0.0.0.0:3102/
```

Open `http://<server>:3102/`. Already logged in → the ZCode UI appears; not logged in → you are guided to `/login`.

**Long-running (systemd example)** at `/etc/systemd/system/zcode-webui.service`:

```ini
[Unit]
Description=zcode-webui
After=network-online.target

[Service]
User=your-user
WorkingDirectory=/opt/zcode-webui
ExecStart=/usr/bin/node src/server.mjs
Restart=on-failure
Environment=ZCODE_WEBUI_PORT=3102
# Uncomment when the container needs a proxy for egress:
# Environment=ZCODE_WEBUI_HOST_PROXY=http://127.0.0.1:7890
# Environment=ZCODE_WEBUI_OAUTH_PROXY=http://127.0.0.1:7890

[Install]
WantedBy=multi-user.target
```

### Step 5 · Integrate with code-server (recommended)

If you already run [code-server](https://github.com/coder/code-server) for your cloud dev environment,
add zcode-webui as one of its port services — the public entry is `https://<your-code-server-domain>/proxy/3102/`:

```bash
node src/server.mjs --port 3102    # root mode (default): do NOT set basePath!
```

Nothing else to configure:

- code-server strips the `/proxy/3102` prefix before forwarding, so the service simply runs at root;
- all page assets, WebSocket, API and login paths are **derived from the current page URL**;
  a bare `/proxy/3102` without trailing slash is auto-redirected;
- the WebSocket goes to `/proxy/3102/ws` with a one-time token handshake; if your SSO/gateway
  refuses WebSocket upgrades, the frontend automatically falls back to the HTTP long-polling bridge;
- no nginx config needed — code-server's native port forwarding is enough, and you inherit its login.

### Step 6 · Standalone / your own reverse proxy

**Root standalone** (local/intranet testing): `npm start`, open `http://127.0.0.1:3102/`.

**Sub-path standalone** (mounted at `/zcode`, proxy preserves the prefix):

```bash
ZCODE_WEBUI_BASE_PATH=/zcode npm start
# open http://127.0.0.1:3102/zcode/ (bare /zcode gets a 302 to add the slash)
```

nginx example (prefix-preserving forward):

```nginx
location /zcode/ {
    proxy_pass http://127.0.0.1:3102;   # note: no URI — the prefix passes through unchanged
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 300s;
}
```

### Step 7 · Start using it

1. Open the WebUI URL in a browser (via code-server: `https://<domain>/proxy/3102/`);
2. If not logged in, sign in at `/login` (or import credentials);
3. Choose a workspace with "Add project → Open folder" (a built-in web directory picker pops up —
   allow popups for this site);
4. Send tasks in the composer, or create/follow tasks in the task panel — same as the desktop app;
5. Phones and tablets just open the same address to continue sessions and dispatch tasks.

**Tab/task lifecycle** (important): each browser tab connects to one server-side "session" (an official
runtime process), and **one process serves exactly one page for its whole lifetime**. **Closing a tab
does NOT end the task** — the runtime keeps executing in the background until the task completes or
waits for your input; reopening the page (reload the same tab or open a new one) spawns a **fresh
process** that loads the latest data of the same session (sessions and tasks live in the shared
server-side store, so progress is visible immediately). A just-departed old process keeps running in
the background when it is busy (mid-task / waiting for input) and retires immediately when idle.
Sessions with an online page are **never reaped**, no matter how long they sit idle; short network
drops trigger automatic reconnects, and if reconnecting gives up the page shows a one-click
"reconnect" button. Multiple tabs/devices of the same account use independent processes; if a tab is
superseded, the old page shows a notice with a "take back" button. Note: **restarting the
zcode-webui service process interrupts background tasks** (same as restarting the official desktop
app) — do not restart the service during long tasks.

## Configuration reference

Priority: CLI args ≈ env vars > `config.json` > defaults.

| Env var / arg | config.json | Default | Meaning |
|---|---|---|---|
| `ZCODE_WEBUI_PORT` / `--port` | `port` | `3102` | Listen port |
| `ZCODE_WEBUI_BASE_PATH` / `--base-path` | `basePath` | empty (root) | URL prefix such as `/zcode` (do NOT set in code-server proxy mode) |
| `ZCODE_WEBUI_WORKSPACE` / `--workspace` | `workspace` | `$HOME` | Initial workspace directory injected into the official UI |
| `ZCODE_WEBUI_LOCALE` | `locale` | `zh-CN` | UI language |
| `ZCODE_WEBUI_OAUTH_PROXY` / `--oauth-proxy` | `oauthProxy` | empty | HTTP proxy for the login (OAuth) flow; set when the server cannot reach `zcode.z.ai/api/v1` directly |
| `ZCODE_WEBUI_HOST_PROXY` / `--host-proxy` | `hostProxy` | empty | HTTP proxy for the official runtime/agent's cloud & model API calls; set when the container cannot reach `api.z.ai` / `open.bigmodel.cn` directly |
| `ZCODE_SERVER_RUNTIME_ROOT` | `serverRoot` | `~/.zcode/server` | Official runtime directory (where `zcode-server.cjs` lives; usually no change needed) |
| `ZCODE_HOME` | — | `~/.zcode` | Official data/credential directory (shared with the official CLI) |
| `ZCODE_WEBUI_HOME` | — | `~/.zcode-webui` (npm install) / project dir (git deploy) | Data directory of this service: `config.json`, the downloaded renderer and the device id. Git deployments automatically use the project dir when it already contains `config.json` or `vendor/renderer` (backward compatible) |
| `ZCODE_APP_VERSION` | — | renderer version (auto-detected) | Override the version passed to the runtime; normally not needed |
| `ZCODE_VERSION` / `ZCODE_ARCH` | — | `3.8.1` / `x64` | Version and architecture for `npm run fetch-renderer` |
| `ZCODE_WEBUI_DETACHED_TTL_MS` | — | `1800000` (30 min) | Idle background sessions are auto-reaped after being detached this long, when no task is running and no frames are flowing; `0` = keep forever |
| `ZCODE_WEBUI_FRAME_QUIET_MS` | — | `600000` (10 min) | Reap precondition: no host→browser frames within this window (working turns stream frames; idle hosts are silent) |
| `ZCODE_WEBUI_RUNNING_TASK_STALE_MS` | — | `7200000` (2 h) | Global reaper safety: while the tasks index has a "running" task updated within this window, NOTHING is reaped (hosts waiting for user input are protected too) |
| `ZCODE_WEBUI_DEBUG_RPC` | — | off | Set `1` to log protocol message previews server-side (for debugging) |

## zcode-webui command line (npm package)

The project is published on npm (package name `@aixyzstudio/zcode-webui`). After installing it, a wizard
covers the whole "prepare → configure → deploy" flow:

```bash
npm install -g @aixyzstudio/zcode-webui      # requires Node.js ≥ 18
zcode-webui setup               # interactive wizard (see below)
zcode-webui start               # run the service (foreground, Ctrl-C stops)
```

**What `setup` walks you through** (each step checks and tells you exactly what is missing):

1. **Environment**: Node / curl / dpkg-deb readiness;
2. **Official runtime**: checks `~/.zcode/server/zcode-server.cjs`; if missing it explains how to
   obtain it (run the official desktop once, or `scp -r user@host:~/.zcode/server ~/.zcode/server`),
   or point `ZCODE_SERVER_RUNTIME_ROOT` elsewhere;
3. **Credentials**: checks `~/.zcode/v2/credentials.json`; if missing it points you to the `/login`
   page or the `/export-credentials.html` desktop import tool;
4. **Renderer**: downloads the official installer from the official CDN and extracts the UI
   (`ZCODE_VERSION` selects a version);
5. **Service config**: asks for port / workspace / locale / reverse-proxy prefix / the two proxies,
   writes `config.json` (mode 0600, existing values are merged);
6. **Bonus**: rebuilds the official CLI headless config `~/.zcode/cli/config.json` when the desktop
   already has a Coding Plan key (see [Official CLI headless usage](#official-cli-headless-usage-optional));
7. **Optional**: generate a systemd user unit (no sudo, `systemctl --user enable --now zcode-webui`)
   or start the service immediately in the background.

`--yes` skips all prompts (defaults, no start); common flags: `--port/--workspace/--locale/
--base-path/--oauth-proxy/--host-proxy`, `--no-fetch`, `--no-start`, `--no-systemd`.

| Command | What it does |
|---|---|
| `zcode-webui setup` | Interactive wizard (steps above). Supports `--yes` (all defaults, no start) plus `--port/--workspace/--locale/--base-path/--oauth-proxy/--host-proxy`, `--no-fetch`, `--no-start`, `--no-systemd` |
| `zcode-webui start` | Run the service in the foreground (equals `node src/server.mjs`; args pass through) |
| `zcode-webui fetch-renderer` | Download/update the official renderer (`ZCODE_VERSION`/`ZCODE_ARCH` override available) |
| `zcode-webui doctor [--net]` | Environment and readiness checks (`--net` adds CDN/cloud API reachability checks) |
| `zcode-webui status` | Print service health (non-zero exit when not running) |
| `zcode-webui version` / `help` | Version / help |

After an npm install, all mutable data (config, renderer, device id, logs) lives in the data
directory `~/.zcode-webui` (override with `ZCODE_WEBUI_HOME`; git deployments keep using the
project directory), so the package directory stays read-only. Upgrade with
`npm update -g @aixyzstudio/zcode-webui`.

## Official CLI headless usage (optional)

The zcode-webui service itself does **not** need a CLI config (it drives the official runtime
directly). But if you want to use the official CLI directly without a browser (SSH terminal, system
cron jobs, scripted session resumes), the CLI needs its own model config at
`~/.zcode/cli/config.json`:

```bash
cp cli-config.example.json ~/.zcode/cli/config.json
chmod 600 ~/.zcode/cli/config.json
# Edit the file: replace provider.bigmodel.options.apiKey with your Coding Plan API Key
# (bigmodel.cn → Individual Coding Plan → Overview → Create API Key;
#  or run the official CLI's `zcode login` once to generate the file for you)
```

Then you can drive it headlessly from the terminal (sharing the same credential store and session
data as the WebUI):

```bash
# send a message to a specific session and keep it running (no TUI)
~/.zcode/server/node ~/.zcode/server/agents/glm/zcode.cjs \
  --cwd /path/to/workspace \
  --resume sess_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx \
  --prompt 'continue' --locale zh-CN

# or run a one-off prompt (--max-turns caps the number of turns)
~/.zcode/server/node ~/.zcode/server/agents/glm/zcode.cjs \
  --cwd /path/to/workspace --prompt 'list the files in this directory' --max-turns 1
```

> Note: `cli-config.example.json` is a **sanitized sample** — its apiKey is a placeholder. Never
> commit a filled-in config; keep the real `~/.zcode/cli/config.json` outside any repository with
> mode 0600.

## HTTP API

- `GET <base>/api/health` — service status (renderer / runtime dir / login state / session counts: total, attached, background / reaper switch and TTL)
- `POST <base>/api/sessions/terminate` — terminate ALL sessions immediately (including background sessions; use with care)
- `POST <base>/api/login/start` — start the official CLI OAuth login (background subprocess)
- `GET <base>/api/login/status` — login status, authorization URL, live output
- `POST <base>/api/login/cancel` — cancel login
- `POST <base>/api/login/import` — import credentials JSON (written to the official credential store)
- `GET <base>/api/fs/list?path=<dir>` — directory listing for the web directory picker
- `POST <base>/bridge/open` / `GET <base>/bridge/poll` / `POST <base>/bridge/send` / `POST <base>/bridge/close` — HTTP long-polling bridge (used automatically by the frontend)
- `WS <base>/ws?token=<random per start>` — frontend protocol bridge (token injected into the page; used automatically by the browser)

## Security notes

- The service listens on `0.0.0.0` and **performs no user authentication itself** (same local trust
  model as the official desktop): anyone who can reach the port can run agents as the server's ZCode
  account. **Always put the service behind a reverse proxy / login gateway** (code-server login, SSO,
  nginx basic auth, …) and never expose port 3102 directly to the public internet.
- Browser identity is tracked with an HttpOnly cookie (`zwebui_client`) used to re-attach background
  sessions after reopening the page; it contains no account information, but different browsers get
  independent sessions.
- Credentials are written with mode 0600 to `~/.zcode/v2/credentials.json`; `config.json` is already
  excluded by `.gitignore` — never commit configs containing keys or proxy passwords.
- `/api/login/import`, `/api/fs/list` and `/api/sessions/terminate` can read/write the server
  filesystem or kill background tasks — they also rely on the outer authentication layer.
- The WebSocket token is regenerated on every service start and only prevents accidentally connecting
  to the wrong WS service (e.g. code-server's own `/ws`); it is not account authentication.

## FAQ

**Q: Will a task keep running after I close the tab?**
Yes. The task keeps executing server-side until it finishes or waits for your input; reopening the
page (reload or a new tab) automatically re-attaches to the background session so you can watch
progress. Idle background sessions are auto-reaped (by default after 30 minutes detached with no
running task and no frame activity; running or waiting-for-input sessions are never reaped). Tune or
disable with `ZCODE_WEBUI_DETACHED_TTL_MS` (`0` = keep forever), or use
`POST /api/sessions/terminate` to terminate everything manually. Restarting the service process
still interrupts background tasks.

**Q: One of my tabs says "session taken over by another tab"?**
Multiple tabs of the same browser run independently; the notice only appears when a new tab took over
an idle session or a page reload took its own session back. The parked page is paused — click the
"take back" button in the notice to reclaim the session for that tab.

**Q: How do I zoom the UI?**
Ctrl+wheel or trackpad/touchscreen two-finger pinch (app zoom 50%–200%, remembered per browser);
keyboard Ctrl/⌘ + `+`/`-`/`0` remains the browser page zoom — the two coexist.

**Q: Sending a message fails with "no usable model provider/model — please log in or configure an API key"?**
First confirm `/login` shows logged in, then make sure the runtime pointed to by
`ZCODE_SERVER_RUNTIME_ROOT` matches the renderer version (`npm run fetch-renderer` writes a version
stamp and syncs it automatically). Old versions of this project had a known defect causing this error —
upgrade to the latest code.

**Q: The login page is stuck at "waiting for the OAuth endpoint" (server in a container/intranet)?**
The server cannot reach `zcode.z.ai/api/v1`. Set `ZCODE_WEBUI_OAUTH_PROXY` (or `oauthProxy` in
`config.json`) to an HTTP proxy with a working egress path and restart the service. If login works
but model calls fail, set `ZCODE_WEBUI_HOST_PROXY` (or `hostProxy`); both can be used together.

**Q: "Add project → Open folder" does nothing?**
The browser blocked the popup. Allow popups for this site; the directory picker is the built-in web
page (`picker.html`) and starts browsing from the server's default workspace.

**Q: Blank screen / spinner when opening through code-server?**
Make sure the URL has the trailing slash (`/proxy/3102/`; the bare path auto-redirects) and that the
code-server proxy forwards WebSocket upgrades (this project falls back to HTTP long-polling, so
either transport works). The `<base>/debug` self-check page shows the bridge status.

**Q: How do I upgrade the official UI version?**
Run `ZCODE_VERSION=<new-version> npm run fetch-renderer` and restart the service. Keep the renderer
version in sync with the runtime under `~/.zcode/server` (matching the official desktop version is
safest).

**Q: Do scheduled / idle-time tasks work?**
Those are driven by the official desktop scheduler, which the WebUI does not re-implement. You can
achieve similar results on a server with system cron driving the official CLI (`zcode -p`/`--resume`),
billed per the official subscription rules.

## Tests

```bash
npm run smoke                 # static serving + base path + WS/HTTP dual-bridge smoke test
ZCODE_WEBUI_BASE_PATH=/zcode npm run smoke -- /zcode
node scripts/dev/reattach-test.mjs      # session lifecycle regression: detach-keeps-alive / fresh host per load / background busy host / supersede / terminate
node scripts/dev/reattach-ui-test.mjs   # real UI: reload mid-turn, fresh host loads the session, turn continues and result renders
node scripts/dev/reattach-close-test.mjs # real UI: close tab mid-turn, background turn completes, new tab loads the same session
node scripts/dev/reload-crash-test.mjs  # regression: no official-renderer "reading 'kind'" crash after reload
node scripts/dev/zoom-test.mjs           # zoom regression: ctrl+wheel / pinch / normal scroll / zoom channel
```

**Docker full-chain verification** (npm package install → wizard config → service start → bridges →
real model call, all inside a real container):

```bash
bash scripts/docker/verify.sh              # pack local artifact → build image → verify in container → cleanup
ZCODE_VERIFY_SKIP_FETCH=1 bash scripts/docker/verify.sh   # reuse an existing renderer, skip the in-container CDN download
ZCODE_VERIFY_REGISTRY=1 bash scripts/docker/verify.sh     # install from the npmjs registry instead (after publishing)
```

The script copies your local `~/.zcode` (official runtime + credentials) into a **temporary sandbox**
at run time, injects it into the container and deletes it afterwards — no credentials ever enter the
image layers or this repository. Override the defaults with
`ZCODE_VERIFY_SOURCE/PROXY/NETWORK/KEEP` (the proxy and its docker network are auto-detected).

`scripts/dev/` also contains a set of Playwright end-to-end scripts (driving the official UI in a real
logged-in state: sending sessions, directory picking, both deployment-mode regressions, …).
Point them at your own service/directory with `ZCODE_WEBUI_TEST_URL` / `ZCODE_WEBUI_TEST_DIR`.

## Known limitations

- Creating SSH / WSL / Docker remote workspaces is not supported (the service itself is the
  workspace on the server; those entries in the UI return unsupported)
- Desktop-only channels are unavailable: phone Remote Control, embedded browser (Browser Use visual
  channel), system tray, auto-update; Browser Use can use headless Chrome on the server (built into the agent)
- Scheduled / idle-time tasks depend on the desktop scheduler (see FAQ)
- Background task persistence depends on the zcode-webui service process staying alive; a service
  restart interrupts background tasks
- In HTTP long-polling fallback mode (`?transport=http`) tasks also keep running in the background
  after the tab closes, but reopening the page cannot re-attach as seamlessly as in WebSocket mode
  (results are still visible in the task panel)
- The official UI evolves with releases; occasional compatibility gaps may appear — prefer versions
  that match your runtime

## Directory layout

```
src/server.mjs             HTTP static serving + base path + WS bridge + login API
src/cli.mjs                zcode-webui command line (setup wizard / start / doctor / status …)
src/dirs.mjs               data directory resolution (ZCODE_WEBUI_HOME / repo mode)
src/frame.mjs              stdio frame codec (interop with the official runtime)
src/host.mjs               official runtime process spawn + handshake
src/login.mjs              official CLI OAuth login subprocess management
src/rpclog.mjs             diagnostic logging (used by DEBUG_RPC)
web/bootstrap.js           browser side: URL params, MessagePort↔WebSocket bridge, long-polling fallback
web/zcode-bridge.js        window.zcode browser adapter
web/login.html             login page (OAuth + credential import)
web/export-credentials.html  desktop credential export tool (runs in the local browser)
web/picker.html            web directory picker
web/debug.html             bridge self-check page
config.example.json        zcode-webui service config template
cli-config.example.json    official CLI model config template (sanitized sample)
scripts/fetch-renderer.sh  downloads the official client from the official CDN and extracts the renderer (vendor/renderer, not committed)
scripts/extract-asar.cjs   installer unpacker
scripts/smoke-test.mjs     smoke test
scripts/docker/            Docker full-chain verification (verify.sh + container-verify.sh)
scripts/dev/*.mjs          Playwright end-to-end dev scripts (session takeover + zoom regressions included)
```

## License and notices

- The code of this project is open source under [MIT](./LICENSE);
- The ZCode name, trademarks and client copyrights belong to their respective owners; this project
  contains and redistributes no official client files;
- References: [official ZCode docs](https://zcode.z.ai/cn/docs) · [Zhipu open platform](https://open.bigmodel.cn) ·
  [GLM Coding Plan](https://docs.bigmodel.cn/cn/coding-plan/overview).
