# zcode-webui

> 在浏览器里完整运行官方 ZCode 桌面端界面，并与 code-server 无缝协同。
> Run the official ZCode desktop UI entirely in your browser, working side by side with code-server.

**zcode-webui** 是一个自托管的 Web 壳层：它把官方 ZCode（智谱 GLM 编码智能体的桌面客户端）的界面
原样搬到浏览器中运行，后端直接复用你机器上的官方 ZCode 运行时（`zcode-server` + GLM Agent）。
它是对官方桌面端的**补充与扩展**：部署一次之后，手机、平板、瘦终端、任何装有浏览器的设备都可以随时
打开同一个 ZCode，进行任务管理、任务派发和会话推进——你的代码、会话和凭据始终留在自己的服务器上。

- 🖥️ 官方界面原样呈现：聊天、任务、工作区文件树、Wiki、MCP 等能力与桌面端一致
- 🤝 与 code-server 天然协同：可直接挂在 code-server 的 `/proxy/<port>/` 端口代理后，共用登录鉴权
- 🌐 任何终端设备可用：无需安装客户端，浏览器打开即用（WebSocket 被反代拦截时自动降级 HTTP 长轮询）
- 🔑 登录方式灵活：内置 OAuth 登录，或从已登录的官方桌面端导出凭据导入，与官方客户端共用同一凭据库
- 📦 不打包、不修改、不分发任何官方代码：渲染层资产由部署者在本地执行一个脚本、从官方 CDN 自行下载

---

## 目录

- [这个项目是什么](#这个项目是什么)
- [与官方的关系：我们只做了中间层](#与官方的关系我们只做了中间层)
- [完整使用指南（从零到可用）](#完整使用指南从零到可用)
  - [第 0 步 · 前置条件](#第-0-步--前置条件)
  - [第 1 步 · 注册 BigModel 账号并开通模型服务](#第-1-步--注册-bigmodel-账号并开通模型服务)
  - [第 2 步 · 下载安装官方 ZCode 并完成认证](#第-2-步--下载安装官方-zcode-并完成认证)
  - [第 3 步 · 提取认证信息（三种方式任选）](#第-3-步--提取认证信息三种方式任选)
  - [第 4 步 · 部署 zcode-webui](#第-4-步--部署-zcode-webui)
  - [第 5 步 · 与 code-server 协同（推荐）](#第-5-步--与-code-server-协同推荐)
  - [第 6 步 · 独立部署 / 自有反代](#第-6-步--独立部署--自有反代)
  - [第 7 步 · 开始使用](#第-7-步--开始使用)
- [配置参考](#配置参考)
- [HTTP API](#http-api)
- [安全须知](#安全须知)
- [常见问题（FAQ）](#常见问题faq)
- [测试](#测试)
- [已知限制](#已知限制)
- [目录结构](#目录结构)
- [许可证与声明](#许可证与声明)

---

## 这个项目是什么

官方 ZCode 是智谱出品的 Agentic Development Environment（ADE）桌面应用，把 GLM 编码模型、
自研编码 Agent、任务管理和文件管理整合在一个 Electron 桌面客户端里。桌面客户端有两个天然限制：

1. **必须在有图形界面的机器上安装运行**——服务器、容器、NAS 用不了；
2. **任务与桌面绑定**——出门在外只能靠官方手机遥控等桌面端在场的能力，无法独立使用完整界面。

zcode-webui 解决这两点：官方客户端的界面本身就是纯 Web 资产，我们把它交给一个轻量 Node 服务托管，
在浏览器侧注入一个极薄的适配层，再把浏览器与官方运行时（`zcode-server.cjs` + GLM Agent，仍运行在你自己的
机器上）用 WebSocket 桥接起来。于是：

- 你在**服务器/容器**里启动一个服务，浏览器打开 URL 就是完整 ZCode；
- 搭配 **code-server** 时，它就是你现有云端开发环境里的一个应用，和其他端口服务一样挂在
  `https://<你的域名>/proxy/3102/` 后面；
- 手机、平板、电视浏览器都能开箱即用，随时**查看任务进度、派发新任务、继续会话**；
- 桌面端与 WebUI 可同时存在：同一台机器、同一份 `~/.zcode` 凭据与数据，桌面端在家里用，
  WebUI 在路上用，互不冲突。

## 与官方的关系：我们只做了中间层

zcode-webui **尽可能依托官方实现，不重复造轮子**：

| 环节 | 谁来实现 |
|---|---|
| 界面（renderer） | 官方客户端原样，由部署者通过本项目脚本从官方 CDN 下载，**不进入本仓库、不二次分发** |
| Agent / 模型调用 / 会话存储 | 官方运行时 `zcode-server.cjs` 与 GLM Agent，**未做任何修改** |
| 登录认证 | 官方 CLI 的 OAuth 流程，凭据写入官方凭据库 `~/.zcode/v2/credentials.json`（与官方客户端共用） |
| **zcode-webui 负责的中间层** | ① 静态托管官方界面并注入启动配置；② `window.zcode` 浏览器适配层（桌面端预加载脚本的浏览器等价物）；③ MessagePort ↔ WebSocket 桥（含 HTTP 长轮询降级）；④ 拉起官方运行时进程并转发消息；⑤ 登录页、凭据导入、Web 目录选择器等配套小工具 |

因此本项目体积很小：核心只有几个源文件。官方界面升级时，只需重新执行一次下载脚本即可跟随官方版本。

> **免责声明**：本项目是社区项目，与智谱 / Z.ai 无隶属关系。它只提供与官方客户端的兼容层，
> 不包含任何官方代码；请遵守官方服务条款，模型调用费用按你订阅的官方套餐计费。

## 完整使用指南（从零到可用）

### 第 0 步 · 前置条件

**服务器/容器（运行 zcode-webui 的地方）需要：**

- Linux x64 或 arm64（推荐 Ubuntu/Debian 系，或任意能跑 Node 的 Linux 发行版）
- Node.js ≥ 18（本项目自身只依赖 Node）
- `curl`、`dpkg-deb`（下载与解包官方安装包用）
- 磁盘 ≥ 2GB 余量（官方渲染层资产 + 运行时）
- 能访问官方域名：`cdn-zcode.z.ai`（下载）、`zcode.z.ai`（登录/云 API）。
  若走模型 API 还需要 `api.z.ai`、`open.bigmodel.cn` 可达；网络受限环境见 [FAQ](#常见问题faq) 的代理配置。

**桌面端机器（第 2 步认证用，之后可不用）需要：**

- macOS（Apple Silicon / Intel）、Windows（x64 / ARM64）或 Linux x64 中的任意一台。

### 第 1 步 · 注册 BigModel 账号并开通模型服务

1. 打开 [智谱开放平台](https://open.bigmodel.cn)，点击右上角「注册/登录」，用手机号或邮箱完成注册；
2. 登录后前往 [GLM Coding Plan 套餐页](https://bigmodel.cn/coding-plan) 选择适合的订阅套餐并完成开通
   （个人版与团队版均有免费额度/试用可先体验，按官方页面为准）；
3. 开通后创建 API Key（**自己妥善保管，不要提交到任何公开仓库**）：
   - 个人版：`bigmodel.cn → 个人编程套餐 → 套餐概览 → 新建 API Key`；
   - 团队版：`bigmodel.cn → 团队编程套餐 → 我的套餐 → 获取 API Key`（团队 Key 与平台其他 Key 不通用）。
4. 如果你更习惯国际版：注册 [Z.ai](https://z.ai) 账号并开通对应订阅同样可用（ZCode 登录时选择
   「连接 Z.ai」）。

### 第 2 步 · 下载安装官方 ZCode 并完成认证

到 [ZCode 官方文档 · 安装](https://zcode.z.ai/cn/docs/install) 下载对应平台的安装包（当前稳定版 3.8.1）：

- macOS：下载 `.dmg`，拖入 Applications；若提示「已损坏」，执行
  `xattr -dr com.apple.quarantine /Applications/ZCode.app`；
- Windows：下载 `.exe` 双击安装；
- Linux：下载 `.AppImage`（或 `.deb`），`chmod +x` 后运行。

首次启动按引导完成设置，然后点击左下角「**连接使用**」进入登录页，任选其一完成接入：

- **连接 Z.ai**：用 Z.ai 账号（或 BigModel 账号互通登录）走官方 OAuth；
- **连接 BigModel**：绑定你在第 1 步开通的 BigModel 账号；
- **使用 API Key**：直接填入第 1 步创建的 API Key。

登录后选择任意项目目录作为工作区，发一句「列出当前目录的文件」验证回复正常，桌面端即就绪。
这台桌面机在本流程里的作用：**生成官方凭据与官方运行时**，供第 3、4 步提取与复用（日常也可以继续使用桌面端）。

> 桌面端有网络代理需求时，在「设置 → 常规 → 网络代理」里配置（注意该字段留空表示直连，不会自动读系统代理）。

### 第 3 步 · 提取认证信息（三种方式任选）

zcode-webui 与官方客户端共用 `~/.zcode` 凭据库。把认证信息带到服务器上有三种方式：

**方式 A · 直接在 WebUI 里 OAuth 登录（最简单，需要服务器能访问 zcode.z.ai）**

部署好服务后打开 `http://<服务器>:3102/login`，点「开始登录」，在弹出的授权链接里用浏览器完成 Z.ai
OAuth，凭据自动写入服务器的 `~/.zcode/v2/credentials.json`。服务器到 `zcode.z.ai/api/v1` 不通时
配置 `oauthProxy`（见 [FAQ](#常见问题faq)）。

**方式 B · 从已登录的桌面端导出凭据导入（无需服务器出网，推荐内网环境）**

1. 在**已登录的桌面电脑**上，用浏览器打开 zcode-webui 的凭据导出工具：
   `http://<服务器>:3102/export-credentials.html`（该页面完全在浏览器本地运行，凭据不出本机）；
2. 选择桌面端的凭据文件，或手动打开后粘贴内容：
   - Windows：`%USERPROFILE%\.zcode\v2\credentials.json`
   - macOS / Linux：`~/.zcode/v2/credentials.json`
3. 按提示填好该机的 platform / 主目录 / 用户名（页面已按当前系统预填猜测值），点「解密并生成」；
4. 把输出的 JSON 复制到 zcode-webui 登录页（`/login`）的「导入凭据」框，点「导入凭据」。
   导入接口会以 0600 权限写入服务器的 `~/.zcode/v2/credentials.json`。

**方式 C · 服务器上本来就装过官方 CLI 并已登录**

如果服务器上已经跑过官方 CLI（`zcode login`）或官方桌面端并登录过，`~/.zcode` 已就绪，
直接跳到第 4 步即可，无需再做任何认证操作。

### 第 4 步 · 部署 zcode-webui

```bash
# 1. 获取代码
git clone https://github.com/windviki/zcode-webui.git
cd zcode-webui

# 2. 安装依赖（只有 ws 一个运行时依赖）
npm install

# 3. 下载官方渲染层资产（从官方 CDN 下载官方安装包并提取界面，
#    默认版本 3.8.1，可用 ZCODE_VERSION=3.8.1 ZCODE_ARCH=x64 覆盖）
npm run fetch-renderer

# 4.（可选）创建本地配置；不创建则全部使用默认值
cp config.example.json config.json
#    常用字段：workspace（初始工作区目录，留空 = $HOME）、
#             oauthProxy / hostProxy（服务器出网代理，见 FAQ）

# 5. 启动
npm start          # 等价于 node src/server.mjs，默认 http://0.0.0.0:3102/
```

打开 `http://<服务器>:3102/`。已登录时直接进入 ZCode 界面；未登录会自动引导到 `/login`。

**长期运行（systemd 示例）**，`/etc/systemd/system/zcode-webui.service`：

```ini
[Unit]
Description=zcode-webui
After=network-online.target

[Service]
User=你的用户名
WorkingDirectory=/opt/zcode-webui
ExecStart=/usr/bin/node src/server.mjs
Restart=on-failure
Environment=ZCODE_WEBUI_PORT=3102
# 容器出网需要代理时按需放开：
# Environment=ZCODE_WEBUI_HOST_PROXY=http://127.0.0.1:7890
# Environment=ZCODE_WEBUI_OAUTH_PROXY=http://127.0.0.1:7890

[Install]
WantedBy=multi-user.target
```

### 第 5 步 · 与 code-server 协同（推荐）

如果你已经用 [code-server](https://github.com/coder/code-server) 搭建了云端开发环境，
把 zcode-webui 作为它的一个端口服务即可，公网入口就是 `https://<你的code-server域名>/proxy/3102/`：

```bash
node src/server.mjs --port 3102    # 根路径模式（默认）：不要设置 basePath！
```

什么都不用额外配置：

- code-server 会把 `/proxy/3102` 前缀剥掉后转发给本服务，本服务按根路径运行即可；
- 页面里的静态资源、WebSocket、API、登录页路径全部**按当前页面 URL 自动推导**，
  缺斜杠的 `/proxy/3102` 会被自动补全重定向；
- WebSocket 会走 `/proxy/3102/ws` 并带一次性令牌握手；若你的 SSO/网关不支持 WebSocket 升级，
  前端会自动降级为 HTTP 长轮询桥，功能不受影响；
- 无需任何 nginx 配置，code-server 原生端口转发即可，并天然共用 code-server 的登录鉴权。

### 第 6 步 · 独立部署 / 自有反代

**根路径独立部署**（本地/内网测试）：`npm start`，访问 `http://127.0.0.1:3102/`。

**带子路径独立部署**（挂到 `/zcode`，反代保留前缀）：

```bash
ZCODE_WEBUI_BASE_PATH=/zcode npm start
# 访问 http://127.0.0.1:3102/zcode/（裸 /zcode 会自动 302 补斜杠）
```

nginx 示例（保留前缀转发）：

```nginx
location /zcode/ {
    proxy_pass http://127.0.0.1:3102;   # 注意：不带 URI，前缀原样透传
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 300s;
}
```

### 第 7 步 · 开始使用

1. 浏览器打开 WebUI 地址（经 code-server 则是 `https://<域名>/proxy/3102/`）；
2. 未登录时先在 `/login` 完成登录（或导入凭据）；
3. 进入后通过「添加项目 → 打开文件夹」选择工作区（浏览器里会弹出内置的 Web 目录选择器，
   请允许本站弹窗）；
4. 在输入框下发任务，或在任务面板新建/跟进任务——与桌面端操作一致；
5. 手机、平板直接访问同一地址即可继续会话与派发任务。多个浏览器标签 = 多个独立会话
   （对应官方“每窗口一个进程”的模型），数据经官方数据目录共享。

## 配置参考

优先级：命令行参数 ≈ 环境变量 > `config.json` > 默认值。

| 环境变量 / 参数 | config.json | 默认 | 说明 |
|---|---|---|---|
| `ZCODE_WEBUI_PORT` / `--port` | `port` | `3102` | 监听端口 |
| `ZCODE_WEBUI_BASE_PATH` / `--base-path` | `basePath` | 空（根路径） | URL 前缀，如 `/zcode`（code-server 代理模式**不要设置**） |
| `ZCODE_WEBUI_WORKSPACE` / `--workspace` | `workspace` | `$HOME` | 注入给官方 UI 的初始工作区目录 |
| `ZCODE_WEBUI_LOCALE` | `locale` | `zh-CN` | 界面语言 |
| `ZCODE_WEBUI_OAUTH_PROXY` / `--oauth-proxy` | `oauthProxy` | 空 | 登录（OAuth）流程使用的 HTTP 代理，服务器无法直连 `zcode.z.ai/api/v1` 时配置 |
| `ZCODE_WEBUI_HOST_PROXY` / `--host-proxy` | `hostProxy` | 空 | 官方运行时与 Agent 访问云 API / 模型 API 的 HTTP 代理，容器直连 `api.z.ai`、`open.bigmodel.cn` 不通时配置 |
| `ZCODE_SERVER_RUNTIME_ROOT` | `serverRoot` | `~/.zcode/server` | 官方运行时目录（`zcode-server.cjs` 所在，通常无需修改） |
| `ZCODE_HOME` | — | `~/.zcode` | 官方数据/凭据目录（与官方 CLI 共用） |
| `ZCODE_APP_VERSION` | — | 渲染层版本（自动读取） | 覆盖传给运行时版本号，一般不需要 |
| `ZCODE_VERSION` / `ZCODE_ARCH` | — | `3.8.1` / `x64` | `npm run fetch-renderer` 的下载版本与架构 |
| `ZCODE_WEBUI_DEBUG_RPC` | — | 关 | 设 `1` 在服务端日志打印协议消息预览（联调用） |

## HTTP API

- `GET <base>/api/health` — 服务状态（renderer / 运行时目录 / 登录态 / 活跃连接数）
- `POST <base>/api/login/start` — 启动官方 CLI OAuth 登录（后台子进程）
- `GET <base>/api/login/status` — 登录状态、授权链接、实时输出
- `POST <base>/api/login/cancel` — 取消登录
- `POST <base>/api/login/import` — 导入凭据 JSON（写入官方凭据库）
- `GET <base>/api/fs/list?path=<dir>` — Web 目录选择器用的目录列表
- `POST <base>/bridge/open` / `GET <base>/bridge/poll` / `POST <base>/bridge/send` / `POST <base>/bridge/close` — HTTP 长轮询桥（前端自动使用）
- `WS <base>/ws?token=<每次启动随机>` — 前端协议桥（令牌注入在页面里，浏览器自动使用）

## 安全须知

- 服务默认监听 `0.0.0.0`，且**本服务自身不做用户鉴权**（与官方桌面的本地信任模型一致）：
  任何能访问该端口的客户端都能以服务器上的 ZCode 账号身份运行 Agent。
  **请务必把服务放在反向代理/登录网关之后**（code-server 登录、SSO、nginx basic auth 等），
  不要将 3102 端口直接暴露到公网。
- 凭据以 0600 权限写入 `~/.zcode/v2/credentials.json`；`config.json` 已被 `.gitignore` 排除，
  不要把含密钥/代理密码的配置提交进仓库。
- `/api/login/import` 与 `/api/fs/list` 可读取/写入服务器文件系统，同样依赖外层鉴权保护。
- WebSocket 令牌每次启动随机生成，用于防止误连其他 WS 服务（如 code-server 自身的 `/ws`），
  不是账号鉴权手段。

## 常见问题（FAQ）

**Q：发送消息提示「当前没有可用的模型供应商和模型，请先登录或配置 API Key」？**
先确认 `/login` 显示已登录；再确认 `ZCODE_SERVER_RUNTIME_ROOT` 指向的运行时与渲染层版本一致
（`npm run fetch-renderer` 会写入版本戳并自动同步）。旧版本的本项目存在一个已知缺陷会导致该报错，
请升级到最新代码。

**Q：服务器在容器/内网里，登录页一直卡在「等待 OAuth 端点响应」？**
服务器到 `zcode.z.ai/api/v1` 的网络不通。设置 `ZCODE_WEBUI_OAUTH_PROXY`（或 `config.json` 的
`oauthProxy`）指向一个出口网络可用的 HTTP 代理后重启服务；如果只是模型调用不通但登录正常，
配置 `ZCODE_WEBUI_HOST_PROXY`（或 `hostProxy`）即可，二者可同时使用。

**Q：「添加项目 → 打开文件夹」没反应？**
浏览器拦截了弹窗。允许本站弹窗即可；目录选择器是内置 Web 页面（`picker.html`），
从服务端配置的默认工作区开始浏览。

**Q：经 code-server 打开是白屏/一直转圈？**
确认访问的是带尾斜杠的 `/proxy/3102/`（不带会自动重定向）；确认 code-server 代理转发
WebSocket 正常（本项目会自动降级 HTTP 长轮询，正常来说两者任一可用即可）。
可访问 `<base>/debug` 自检页查看桥接状态。

**Q：官方界面版本怎么升级？**
执行 `ZCODE_VERSION=<新版本> npm run fetch-renderer` 后重启服务。注意渲染层版本应与服务器上
`~/.zcode/server` 的运行时版本保持一致（与官方桌面端同版本最稳妥）。

**Q：定时任务/闲时任务能跑吗？**
这两类由官方桌面端调度器驱动，WebUI 不重复实现。可以在服务器上用系统 cron 调用官方 CLI 的
`zcode -p/--resume` 等方式实现类似效果（按官方订阅规则计费）。

## 测试

```bash
npm run smoke                 # 静态服务 + 基础路径 + WS/HTTP 双桥全链路冒烟
ZCODE_WEBUI_BASE_PATH=/zcode npm run smoke -- /zcode
```

`scripts/dev/` 下附带一组 Playwright 端到端脚本（真实登录态下驱动官方界面：
发送会话、目录选择、两种部署模式回归等），可用 `ZCODE_WEBUI_TEST_URL`、
`ZCODE_WEBUI_TEST_DIR` 等环境变量指向自己的服务与目录。

## 已知限制

- 不支持 SSH / WSL / Docker 远程工作区的创建（服务本身就是服务器上的工作区；界面中相关入口会返回不支持）
- 手机 Remote Control、嵌入式浏览器（Browser Use 图形通道）、系统托盘、自动更新等桌面专属通道不可用；
  Browser Use 可走服务器上的无头 Chrome（Agent 自带支持）
- 定时/闲时任务依赖桌面端调度器（见 FAQ）
- 官方界面随版本演进，个别新版本 UI 可能暂时出现兼容性问题；请优先使用与运行时匹配的版本

## 目录结构

```
src/server.mjs             HTTP 静态服务 + base path + WS 桥 + 登录 API
src/frame.mjs              stdio 帧编解码（与官方运行时互通）
src/host.mjs               官方运行时进程拉起与握手
src/login.mjs              官方 CLI OAuth 登录子进程管理
src/rpclog.mjs             诊断日志（DEBUG_RPC 时使用）
web/bootstrap.js           浏览器侧：URL 参数、MessagePort↔WebSocket 桥、长轮询降级
web/zcode-bridge.js        window.zcode 浏览器适配层
web/login.html             登录页（OAuth + 凭据导入）
web/export-credentials.html  桌面端凭据导出工具（浏览器本地运行）
web/picker.html            Web 目录选择器
web/debug.html             桥接自检页
scripts/fetch-renderer.sh  从官方 CDN 下载官方客户端并提取渲染层（vendor/renderer，不入库）
scripts/extract-asar.cjs   安装包解包工具
scripts/smoke-test.mjs     冒烟测试
scripts/dev/*.mjs          Playwright 端到端联调脚本
```

## 许可证与声明

- 本项目代码以 [MIT](./LICENSE) 许可开源；
- 官方 ZCode 名称、商标与客户端版权归其权利方所有；本项目不包含、不分发任何官方客户端文件；
- 参考：[ZCode 官方文档](https://zcode.z.ai/cn/docs) · [智谱开放平台](https://open.bigmodel.cn) ·
  [GLM Coding Plan](https://docs.bigmodel.cn/cn/coding-plan/overview)。
