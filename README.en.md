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
- ⏳ **Tasks are decoupled from tabs**: closing a tab / losing the network does NOT stop a task — it keeps running server-side until it finishes or waits for your input; reopening the page automatically re-attaches to the background session (multiple tabs of the same browser run independently; a superseded tab shows a notice with a one-click take-back)
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
runtime process). **Closing a tab does NOT end the task** — the runtime keeps executing in the
background until the task completes or waits for your input; reopening the page (reload the same tab
or open a new one) automatically re-attaches to that background session so you can watch progress or
answer. Multiple tabs of the same browser run independently; if a tab's session is taken over by
another tab, the old page shows a notice with a "take back" button. Note: **restarting the zcode-webui
service process interrupts background tasks** (same as restarting the official desktop app) — do not
restart the service during long tasks.

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
| `ZCODE_APP_VERSION` | — | renderer version (auto-detected) | Override the version passed to the runtime; normally not needed |
| `ZCODE_VERSION` / `ZCODE_ARCH` | — | `3.8.1` / `x64` | Version and architecture for `npm run fetch-renderer` |
| `ZCODE_WEBUI_DETACHED_TTL_MS` | — | `0` (never) | Auto-terminate background sessions (no tab connected) after this many milliseconds; `0` keeps them until the task ends / the service restarts |
| `ZCODE_WEBUI_DEBUG_RPC` | — | off | Set `1` to log protocol message previews server-side (for debugging) |

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

- `GET <base>/api/health` — service status (renderer / runtime dir / login state / session counts: total, attached, background)
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
progress. Restarting the service process interrupts background tasks; if you want periodic cleanup of
long-disconnected sessions set `ZCODE_WEBUI_DETACHED_TTL_MS` (default 0 = never), or use
`POST /api/sessions/terminate` to terminate everything manually.

**Q: One of my tabs says "session taken over by another tab"?**
Multiple tabs of the same browser run independently; the notice only appears when a new tab took over
an idle session or a page reload took its own session back. The parked page is paused — click the
"take back" button in the notice to reclaim the session for that tab.

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
node scripts/dev/reattach-test.mjs      # session-decoupling protocol regression: detach-keeps-alive / reattach / adopt / supersede / terminate
node scripts/dev/reattach-ui-test.mjs   # real UI: reload mid-turn, re-attach, turn continues and result renders
node scripts/dev/reattach-close-test.mjs # real UI: close tab mid-turn, background turn completes, new tab adopts
```

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
scripts/dev/*.mjs          Playwright end-to-end dev scripts
```

## License and notices

- The code of this project is open source under [MIT](./LICENSE);
- The ZCode name, trademarks and client copyrights belong to their respective owners; this project
  contains and redistributes no official client files;
- References: [official ZCode docs](https://zcode.z.ai/cn/docs) · [Zhipu open platform](https://open.bigmodel.cn) ·
  [GLM Coding Plan](https://docs.bigmodel.cn/cn/coding-plan/overview).
