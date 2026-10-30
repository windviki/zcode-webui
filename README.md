# zcode-webui

> 语言 / Language：**中文** | [English](./README.en.md)

在浏览器里完整运行官方 ZCode 桌面端界面，后端复用你机器上的官方运行时（`zcode-server` + GLM Agent）。
它是对官方桌面端的补充：部署一次之后，手机、平板、瘦终端、任何有浏览器的设备都能随时打开同一个 ZCode，
进行任务派发与会话推进——代码、会话和凭据始终留在你自己的服务器上。

- 🖥️ **官方界面原样呈现**：聊天、任务、文件树等能力与桌面端一致；官方界面升级只需重新执行一次下载脚本
- 🤝 **与 code-server 天然协同**：挂在 `/proxy/<port>/` 即可，共用其登录鉴权；WebSocket 被拦截时自动降级 HTTP 长轮询
- ⏳ **任务与标签页解耦**：关闭标签页/断网不中断任务；空闲的后台会话按三重条件自动回收，运行中的永不回收
- 🔑 **登录灵活**：内置 OAuth 登录，或从已登录的桌面端导出凭据导入；与官方客户端共用同一凭据库
- 🔍 Ctrl+滚轮 / 双指捏合应用级缩放（50%–200%）：以捏合点为锚点平滑缩放、随手平移，
  页面永不脱离视口（边缘保护，缩小方向逐帧直接提交，无白边）
- 🧭 `zcode-webui setup` 一键部署：渲染层、官方运行时、配置、启动全自动
- 📦 不打包、不修改、不分发任何官方代码；核心只有几个源文件

## 快速开始

> 前提：Linux x64/arm64 · Node.js ≥ 18 · `curl`、`dpkg-deb`、`tar` · 磁盘 ≥ 2GB ·
> 能访问 `cdn-zcode.z.ai`（下载）与 `zcode.z.ai`（登录）。

```bash
npm install -g @aixyzstudio/zcode-webui   # 需要 Node.js ≥ 18
zcode-webui setup --yes                   # 全自动：渲染层下载 → 官方运行时安装 → 写配置 → 启动 → 健康检查
```

完成后浏览器打开 `http://<服务器>:3102/`。未登录时先访问 `/login` 完成 OAuth（服务器无法直连
`zcode.z.ai/api/v1` 时用 `setup --oauth-proxy <代理>` 或见 [FAQ](#常见问题faq)）。

git 部署方式见[手动部署](#手动部署git-clone)；想省事也可以只跑 `zcode-webui setup` 进入交互式向导。

## 与官方的关系：我们只做了中间层

| 环节 | 谁来实现 |
|---|---|
| 界面（renderer） | 官方客户端原样，由部署者通过本项目脚本从官方 CDN 下载，**不进入本仓库、不二次分发** |
| Agent / 模型调用 / 会话存储 | 官方运行时 `zcode-server.cjs` 与 GLM Agent，**未做任何修改** |
| 登录认证 | 官方 CLI 的 OAuth 流程，凭据写入官方库 `~/.zcode/v2/credentials.json`（与官方客户端共用） |
| **本项目的中间层** | 托管官方界面并注入启动配置；`window.zcode` 浏览器适配层；MessagePort ↔ WebSocket 桥；拉起官方运行时进程并转发消息 |

> **免责声明**：社区项目，与智谱 / Z.ai 无隶属关系；不含任何官方代码。请遵守官方服务条款，
> 模型调用费用按你的订阅计费。

### 默认禁用：官方客户端的「工作区快照」静默上传

官方 3.x 客户端（**含无界面的服务器运行时，不只是桌面端**）在发起 prompt 时会走这样一条链路：
向 `GET /api/v1/snapshot/upload-credential` 申请上传凭证 → 按筛选规则扫描工作区打包
（**`.git/**` 不经过密钥文件名过滤，也不受体积上限约束**）→ AES 加密、密钥由服务端下发的 RSA 公钥
封装（本地没有解密私钥）→ 以 OSS 表单上传 `repo-snapshot.tar.gz.enc` 并在服务端登记。
本地痕迹在 `~/.zcode/v2/checkpoints/<workspace-hash>/`（明文 manifest + 密文）。设置项「仓库快照索引」
（`repoSnapshotIndexingEnabled`）**不参与采集判定**，也没有可用开关关闭它。

本项目默认在宿主进程内拦掉这条链路（四层，`src/repo-snapshot-guard.cjs`，由 `src/host.mjs` 以
`NODE_OPTIONS=--require` 注入）：

1. 凭证请求本地回 `{code:0,data:null}` —— 运行时按「服务端没发凭证」处理，在扫描/打包**之前**就返回；
2. 快照密文的对象上传按 OSS 表单特征（`file=repo-snapshot.tar.gz.enc` / `key=repo-snapshot*` /
   `x-oss-signature` 头）拒 403 —— 覆盖「设置里配了代理、走运行时内置 undici 从而绕过
   `globalThis.fetch`」以及内存中已缓存凭证的情况；
3. **产物读取拒绝**：`~/.zcode/v2/checkpoints/*/{pending,tmp}/*` 经 `openAsBlob` / `createReadStream`
   的读取被拒 —— 3.12.3 起对象上传改走运行时**内置 undici**（preload 补不到它的 fetch），这一层与
   传输实现无关：拿不到产物就拼不出上传体；
4. `~/.zcode/v2/checkpoints/*/{pending,tmp,manifests,extra-manifests}/` 的写入被拒绝
   （`state.json` 保持可写，状态仓库与宿主不受影响）。

每次拦截都写 stderr，日志里表现为 `[host:stderr] [zcode-webui] repo-snapshot-guard: ...`，可审计。

- **恢复官方行为**：设 `ZCODE_WEBUI_ALLOW_REPO_SNAPSHOT=1` 后重启服务
  （若已按需对 `checkpoints` 目录做过只读加固，先 `chmod u+w` 回来）。
- **影响面**：登录、对话、协议桥、本机会话回滚不受影响（`npm run smoke` 全绿）；依赖该上传的官方功能
  （仓库快照索引 / 跨设备恢复类）会因拿不到凭证而静默跳过。
- **排查工具**（仓库内，不随 npm 包发布）：`node scripts/dev/repo-snapshot-audit.mjs` 盘点本机快照记录；
  `node scripts/dev/repo-snapshot-guard-test.mjs` 守卫自检。

> **观测依据**（2026-09-18，本机可复核）：渲染层 3.12.3 + 服务器运行时 3.11.2；12 个工作区存在快照记录，
> 其中 10 份上传被服务端确认，两份合计 177 MiB 密文未获回执；manifest 为**明文**，其中
> `.git/objects/pack` 实测 57.6 MiB / 63.9 MiB / 21.5 MiB 三例。外部独立取证见
> <https://blog.ferstar.org/posts/zcode-silent-workspace-snapshot-upload/>。
> 以上均为对本机可核查行为的陈述，不对服务端数据的用途作推断。

## 手动部署（git clone）

```bash
git clone https://github.com/windviki/zcode-webui.git
cd zcode-webui && npm install          # 运行时依赖只有 ws

npm run fetch-renderer                 # 从官方 CDN 下载安装包并提取界面
                                       # （默认 3.15.3，可用 ZCODE_VERSION=… ZCODE_ARCH=x64 覆盖）

cp config.example.json config.json     # 可选；常用字段 workspace / oauthProxy / hostProxy

npm start                              # 等价于 node src/server.mjs，默认只监听 http://127.0.0.1:3102/
```

长期运行建议用上面的 `zcode-webui setup --systemd`，或手写系统级单元：

```ini
[Unit]
Description=zcode-webui
After=network-online.target

[Service]
User=你的用户名
WorkingDirectory=/opt/zcode-webui
ExecStart=/usr/bin/node src/server.mjs
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## 与 code-server 协同（推荐）

以根路径模式启动（**不要设置 basePath**）：`node src/server.mjs --port 3102`。
之后无需任何额外配置——公网入口就是 `https://<域名>/proxy/3102/`：

- 资源路径、API、WebSocket、登录页都按页面 URL 自动推导；缺斜杠的 `/proxy/3102` 自动补全重定向；
- WebSocket 不通时前端自动降级为 HTTP 长轮询桥；
- 共用 code-server 的登录鉴权，无需 nginx。

自有反代的子路径部署：`ZCODE_WEBUI_BASE_PATH=/zcode npm start`（裸 `/zcode` 会 302 补斜杠）；
nginx 保留前缀转发即可（`proxy_pass http://127.0.0.1:3102;` 不带 URI + 常规 Upgrade 头）。

## 登录与凭据（三种方式任选）

**A · 直接在 WebUI 里 OAuth 登录（最简单，需要服务器能访问 zcode.z.ai）**
打开 `<服务地址>/login` 点「开始登录」，在授权链接里完成 Z.ai OAuth，凭据自动写入服务器的
`~/.zcode/v2/credentials.json`。

**B · 从已登录的桌面端导出凭据导入（无需服务器出网）**
在桌面电脑上打开 `<服务地址>/export-credentials.html`（纯浏览器本地运行），选择该机的
`~/.zcode/v2/credentials.json` 并填入 platform/主目录/用户名解密，把输出 JSON 粘贴到 WebUI 的
`/login`「导入凭据」框。

**C · 服务器上本来就登录过官方 CLI / 桌面端**
`~/.zcode` 已就绪，直接使用。

## 3.16 运行时的三个补丁（装机后需重打）

3.16 的 host/agent 都是整包发布物，以下三处是我们对官方运行时的**有界化补丁**
（每个脚本幂等、写前备份、可 `--revert`，默认目标 `$ZCODE_HOME/server`）：

| 脚本 | 修什么 | 实测效果 |
|---|---|---|
| `scripts/patch-316-browser-ctx.mjs` | `sendConversationCommandV4`/`sendPrompt` 在发消息前 `await XA(browserControlExecutor, …)` 抓"浏览器环境上下文"；没有 in-app browser 时后端调用会挂满 ~30 s（两边零日志） | **首次消息 30.0 s → 3.6 s**（回车→开始推理） |
| `scripts/patch-316-refresh.mjs` | 每条 sendText 前 `await providerRefreshRegistry` 的 30 s 超时 | 已有会话的消息 30 s → 毫秒级 |
| `scripts/patch-316-balance-cache.mjs` | `billing/balance` 去重窗口只有 1 s，一次发送串行 4 次 ×10 s | 重复查询 10 s → 0 ms |

重新安装 3.16 运行时（`scripts/install-316.sh`）后，三个脚本都要重跑一遍。

## 页面断线恢复

- **应用层心跳**：页面每 10s 发一次 `{"kind":"zcode-webui-ping"}`，服务端回 `pong`。浏览器
  自己发不了 WS 协议层 ping，而半开 TCP（手机休眠、NAT 超时、代理断开）会让
  `readyState` 长时间停在 OPEN——以前的表现就是「回来一看页面是死的，得手动刷新」。
  现在可见状态下 45s 没有任何入站消息即判定链路已死，主动断开并走热重连。
- **切回前台/联网/聚焦即探测**：`visibilitychange`、`pageshow`、`focus`、`online` 都会立刻
  probe 或在必要时直接重连，不再依赖被浏览器节流的定时器。
- **热重连不刷新页面**：同一页面重连时带 `resume=1`，服务端把离线期间的帧按序回放
  （同标签页 era 复用），端口不用重建。
- **页面 presence 租约**：页面开着（含切到后台）就每 45s 通过普通 HTTP 续租一次；被浏览器冻结/进入 bfcache 时
  再发一次 12 小时的长租约（`freeze` / `pagehide persisted`）。服务端据此
  保留该标签页的宿主和 parked era，**不再因为后台时间长而回收**。关闭标签页会发 closing 信标，
  没送到也会在租约（默认 30 分钟）过期后恢复原有回收策略。这是「隔很久回到同一标签页」
  能直接热重连、而不是整页重载的关键。
- **回放缺口不再强刷**：离线期间积压超过回放缓冲（默认 32MB / 4096 帧）时，保留页面、丢弃陈旧
  回放，并给出「重新同步 / 关闭」两个按钮——界面正常时可以直接关掉提示继续用，不必为了清提示
  而整页刷新。单个超大**响应帧**（文件内容、截图等）不会再把整段回放拖垮：只跳过该响应，重连后
  给对应调用合成一个可重试错误。
- **只有宿主进程真的重启才需要刷新**：那时会先显示「会话进程已重启，正在恢复会话…」再刷新，
  不会看起来像崩溃。

### 与 dsh / kimi 的重连差异（源码对照）

- **dsh**（`dsh-client-connection` + `dsh-api-session-controller`）：连接按 generation 管理，
  指数退避（默认 500ms ×2，上限 10s），`online/offline` 会暂停/恢复重试；重连成功后
  `handleConnected()` 清空投影缓存、重新拉会话列表，已打开的会话各自 `resync()` 重开历史窗口。
  没有整页刷新。
- **Kimi Code Web**：WebSocket 帧带 `seq/epoch`，订阅恢复时带 `sinceSeq`；服务端要么补发，
  要么回 `resync_required`，客户端收到后重新 `GET session` 并重置投影。窗口重新可见时若 socket
  被判 stale 会主动重连。也没有整页刷新。
- **本垫片**：官方渲染层的 service port 是一次性握手，没有对外的「重新初始化 / 重新订阅」协议，
  垫片无法命令它从快照重建整个 React 状态树。因此这里的策略是**别让会话丢**：presence 租约保住
  宿主与 era，断线期间按序补帧；只有宿主进程本身消失（重启/崩溃/被回收）时，整页刷新才是唯一
  可靠的恢复路径。这是与 dsh/kimi 的根本架构差异，不是退避参数或心跳策略的差异。

## 任务生命周期（重要，30 秒读完）

同一账号只有一个正在运行的宿主进程，**所有设备的页面都作为它的视图接入**：

- **多设备同时实况**：任何设备打开页面即接入同一进程——历史与实时输出全部可见、持续推送；
  换设备、多设备同时开着看，互不干扰、互不刷新；
- **关闭标签页不结束任务**：最后一个页面离开后，进程转入后台继续执行直到完成或等待输入
  （空闲默认 30 分钟回收；执行中/等待输入的永不回收）；
- **注意**：若另一台设备的任务还在执行就发新指令，两个代理仍会并发操作同一批文件——
  请等任务完成，或明确需要并行时再发；
- **重启 zcode-webui 服务进程会中断后台任务**（与桌面端重启一致）。
- **Esc 防误停**：官方渲染层把 `Esc` 绑成「停止当前生成」，且只放过对话框内的按键——
  中文输入法取消候选词、关搜索框、随手按一下，都会**直接把正在跑的一轮打断**（连带取消
  全部在跑的子代理）。本垫片在捕获阶段加了一道确认：可停时第一次 `Esc` 只提示
  「再按一次 Esc 停止生成」，2.5 秒内第二次 `Esc` 才真正停止（仍然走官方停止路径），
  对话框/菜单/下拉里的 `Esc` 不受影响。每次拦截与停止按钮点击都会以 `kind=stop-guard`
  写进服务日志，事后可判定停因（按钮 vs Esc）。

## 配置参考

优先级：命令行参数 ≈ 环境变量 > `config.json` > 默认值。

| 环境变量 / 参数 | config.json | 默认 | 说明 |
|---|---|---|---|
| `ZCODE_WEBUI_PORT` / `--port` | `port` | `3102` | 监听端口 |
| `ZCODE_WEBUI_HOST` / `--host` | `host` | `127.0.0.1` | 监听地址；需要其它机器访问时设 `0.0.0.0`（同时自行加门禁，见安全须知） |
| `ZCODE_WEBUI_ACCESS_TOKEN` / `--access-token` | `accessToken` | 空（关闭） | 可选访问令牌：设置后页面/API/WS 全部要求先用它在门禁页换 Cookie（30 天有效；改令牌即全部失效） |
| `ZCODE_WEBUI_BASE_PATH` / `--base-path` | `basePath` | 空（根路径） | URL 前缀，如 `/zcode`（code-server 代理模式**不要设置**） |
| `ZCODE_WEBUI_WORKSPACE` / `--workspace` | `workspace` | `$HOME` | 初始工作区目录 |
| `ZCODE_WEBUI_LOCALE` | `locale` | `zh-CN` | 界面语言 |
| `ZCODE_WEBUI_OAUTH_PROXY` / `--oauth-proxy` | `oauthProxy` | 空 | OAuth 登录用的 HTTP 代理（服务器直连 `zcode.z.ai/api/v1` 不通时） |
| `ZCODE_WEBUI_HOST_PROXY` / `--host-proxy` | `hostProxy` | 空 | 运行时/Agent 访问云与模型 API 的 HTTP 代理（`api.z.ai`、`open.bigmodel.cn` 不通时） |
| `ZCODE_WEBUI_QUOTA_RESET` | — | `on` | 重置机会自动使用：`on`（默认，择机使用）/ `dry-run`（只记录决策）/ `off`。触发条件：有任务且池余量 ≤5%；或收到厂商「配额耗尽」429/402 硬信号；或池已用尽且自然重置尚远；或机会将过期且池用量 ≥30%。池的自然重置就在眼前时一律不用；每日上限 6 次；详见 AGENTS.md |
| `ZCODE_SERVER_RUNTIME_ROOT` | `serverRoot` | `~/.zcode/server` | 官方运行时目录（通常无需修改） |
| `ZCODE_HOME` | — | `~/.zcode` | 官方数据/凭据目录（与官方 CLI 共用） |
| `ZCODE_WEBUI_HOME` | — | 见右 | 本服务数据目录（config、渲染层、设备标识、日志）；npm 安装默认 `~/.zcode-webui`，git 部署且项目根已有 `config.json` 或 `vendor/renderer` 时沿用项目目录 |
| `ZCODE_VERSION` / `ZCODE_ARCH` | — | `3.15.3` / `x64` | `fetch-renderer` 的下载版本与架构 |
| `ZCODE_WEBUI_DETACHED_TTL_MS` | — | `1800000` | 后台会话脱离超过该时长且无任务运行、无帧活动时回收；`0` = 永不回收 |
| `ZCODE_WEBUI_PRESENCE_LEASE_MS` | — | `1800000` | 页面 presence 租约有效期：页面开着（含后台）每 45s 续租，租约新鲜时保留宿主与 parked era；`0` = 关闭该保护 |
| `ZCODE_WEBUI_PRESENCE_MAX_TABS` | — | `32` | 每个宿主最多记住多少个标签页的 presence |
| `ZCODE_WEBUI_PRESENCE_FROZEN_MAX_MS` | — | `43200000` | 冻结/bfcache 页面单次长租约的上限（默认 12h），防止丢失 closing 信标后永久占用宿主 |
| `ZCODE_WEBUI_RESUME_BUF_MAX_MB` | — | `32` | 每标签页离线补帧缓冲的字节上限；单个超大响应会跳过而不是丢弃整段 |
| `ZCODE_WEBUI_RESUME_BUF_MAX_FRAMES` | — | `4096` | 每标签页离线补帧缓冲的帧数上限 |
| `ZCODE_WEBUI_RESUME_PARK_MS` | — | `600000` | 无 presence 租约时，parked era 在宿主空闲多久后退休；`0` = 不退休 |
| `ZCODE_WEBUI_FRAME_QUIET_MS` | — | `600000` | 回收条件之一：最近该时长内无 host→浏览器帧 |
| `ZCODE_WEBUI_AGENT_WRITE_ACTIVE_MS` | — | `600000` | CLI 数据库（message/part/session_entry）最近写入在该窗口内时不回收（长回合的静默模型调用） |
| `ZCODE_WEBUI_MODEL_REQUEST_ACTIVE_MS` | — | `7200000` | CLI 日志里未配对的 `model.request.started` 视为在途请求，超过该时长才忽略 |
| `ZCODE_WEBUI_REAP_INTERVAL_MS` | — | `60000` | 空闲回收扫描间隔 |
| `ZCODE_WEBUI_DEFERRED_RELAY_CLOSE_IDLE_MS` | — | `300000` | pagehide 触发 `/bridge/close` 时，若 agent 仍忙则延迟到该空闲窗口后再关闭 HTTP relay |
| `ZCODE_WEBUI_RUNNING_TASK_STALE_MS` | — | `7200000` | 回收的全局保险：索引里有窗口内的 running 任务时不回收任何会话 |
| `ZCODE_WEBUI_DEBUG_RPC` | — | 关 | 设 `1` 在日志打印协议消息预览（联调用） |

## 命令行参考（npm 包）

| 命令 | 作用 |
|---|---|
| `zcode-webui setup` | 一键部署向导：目标版本解析 → 环境检查 → **官方运行时自动安装**（缺失时，来自官方组件通道）→ 凭据检查 → 渲染层下载 → 写 `config.json`（0600）→ 可选 systemd 用户单元 → 启动并等健康检查通过。`--yes` 非交互全默认并启动（配 `--no-start` 只装不启）；其它参数 `--port/--workspace/--locale/--base-path/--oauth-proxy/--host-proxy/--server-root/--version/--arch/--fetch/--no-fetch/--systemd/--no-systemd` |
| `zcode-webui start` | 前台启动（Ctrl-C 停止；参数透传给 server.mjs） |
| `zcode-webui stop` | 停止后台实例或 systemd 服务（前台进程请 Ctrl-C） |
| `zcode-webui upgrade` | 一键升级官方渲染层 + 官方运行时（见下节） |
| `zcode-webui fetch-renderer` | 仅下载/更新渲染层（`ZCODE_VERSION`/`ZCODE_ARCH` 覆盖） |
| `zcode-webui doctor [--net]` | 就绪检查：node/curl/dpkg-deb、运行时+agent 入口、凭据、渲染层、**渲染层↔运行时版本对齐**、服务状态；`--net` 附带连通性检查 |
| `zcode-webui status` | 打印健康 JSON（未运行返回非 0） |
| `zcode-webui version` / `help` | 版本 / 帮助 |

所有可变数据存放在数据目录（`~/.zcode-webui`，可 `ZCODE_WEBUI_HOME` 覆盖；git 部署沿用项目目录），
包目录保持只读。

### 一键升级

```bash
zcode-webui upgrade                    # 自动探测官网最新版，同步升级渲染层 + 官方运行时
zcode-webui upgrade --yes --restart    # 非交互，并在前后自动停/启服务
```

流程：从[更新日志](https://zcode.z.ai/cn/changelog)取最新版本号 → 重提取渲染层 →
下载官方组件清单中的运行时组件（逐一 SHA256 校验）在新目录组装后**原子替换**
（旧目录备份为 `~/.zcode/server.bak-<版本>-<时间戳>`，仅留最近一份）。服务运行中默认询问是否先停
（`--yes` 跳过询问但不停止）。其它参数：`--version X.Y.Z`（指定版本）、`--arch x64|arm64`、
`--renderer-only` / `--server-only`、`--force`（同版本强制重装）、`--no-backup`。
注意：`upgrade` 只升官方组件；zcode-webui 自身用 `npm update -g @aixyzstudio/zcode-webui` 升级。

> **3.12.x 已适配**：官方 3.12 起服务端口消息改成 `{type:'zcode:service-port', databaseStartupId}`
> 对象，并要求桌面端再下发「数据库启动通道」状态（`zcode:database-startup-state`，phase=ready 且
> startupId 对齐），否则界面停在「未能收到启动状态 / startup-channel-unavailable」。`web/bootstrap.js`
> 现按渲染层版本自动二选一（<=3.11 裸字符串，>=3.12 对象+启动状态），`SHIM_MAX_SUPPORTED` 已提到 3.15.3。
>
> 3.12 的 `zcode.cjs` 还需要 `<runtime>/agents/glm/provider/zcode-builtin.json`（官方只随桌面端分发），
> 缺了它登录和 agent 都起不来；server 启动与 host 握手后会自动从 `~/.zcode/v2/runtime/provider/bundled/`
> 复制过去（`ensureCliProviderConfig`），无需手工处理。
>
> 注意：3.12 起**模型可用性改为服务端 entitlement 校验**。若账号没有有效套餐（billing/balance 返回
> `plans: []`），界面会显示「当前没有可用模型」——用「管理模型 → 添加自定义模型」填本地 API key 即可，
> 或 `./zcode-update.sh --rollback` 退回 3.11.x（那一版直接信任本机 CLI 配置里的 key）。
>
> **3.15.3 已适配**（2026-10-19）：`./zcode-update.sh -v 3.15.3 --yes` 完成渲染层/运行时升级，
> smoke、headless 界面启动、守卫自检全部通过；旧版 3.14.3 保留在 `vendor/renderer.bak-3.14.3-*`
> 与 `~/.zcode/server.bak-3.14.3-*`，可随时回滚。

### ZCode 3.16+（新运行时布局）

3.16 起官方不再发布分平台组件清单，host 被打进桌面安装包（`resources/app.asar/out/host/*.js`），
所以 `zcode-update.sh` 的组件升级路径走不通。垫片本身两代都支持，按**运行时目录的布局**自动识别：

| 运行时目录里的特征 | 传输方式 |
|---|---|
| `zcode-server.cjs`（≤ 3.15） | 子进程 stdio + 13 字节帧（沿用原路径） |
| `app/out/host/index.js`（≥ 3.16） | `child_process.fork` + `process.parentPort` 控制面 + 转交的 MessagePort 承载协议 payload（`src/port-shim.mjs`） |

从官方整包安装 3.16 到**独立目录**（不动现有运行时）：

```bash
./scripts/install-316.sh ~/Downloads/ZCode-3.16.3-linux-x64.deb --renderer
# 运行时落在 ~/.zcode/server-3.16，旧渲染层保留为 vendor/renderer.bak-<版本>-<时间>

# 试跑（只影响这一次服务进程）：
ZCODE_SERVER_RUNTIME_ROOT=~/.zcode/server-3.16 ./zcode-service.sh restart
# 回滚：unset 该变量再 restart
```

确认稳定后再切成默认（保留旧目录随时可切回）：

```bash
mv ~/.zcode/server ~/.zcode/server-3.15
ln -s ~/.zcode/server-3.16 ~/.zcode/server
./zcode-service.sh restart
```

注意：3.16 首次启动会对 `~/.zcode/v2`（tasks-index 等）执行数据库迁移，并把旧会话镜像进
`v2/sessions`；**回滚到 3.15 前请确认旧版本能读新 schema**，升级前先备份 `~/.zcode`。
`/api/health` 的 `runtimeKind` 会显示当前实际使用的传输（`legacy` / `host16`）。

### 仓库内一键更新（git 部署 / 本机）

```bash
./zcode-update.sh              # 探测最新版本 → 拉包解包 → 原子替换 → 重启 → 校验（失败自动回滚）
./zcode-update.sh --check      # 只看当前 / 官网 / CDN 版本
./zcode-update.sh -v 3.15.3    # 指定版本
./zcode-update.sh --rollback   # 回滚到最近一次更新前的备份
```

与 `zcode-webui upgrade` 部署的东西完全一致（同一 CDN、同一组件清单、同样的
`~/.zcode/server` 布局与 `.asset-components` 标记），差别是纯 shell 实现 + 更严的校验：

1. 版本以 **CDN 为准**（官网页面常慢一步）：先读官网当基线，再探测 CDN 上真实存在（manifest + deb 都在）的最高版本；
2. 动服务之前先做**资源预检**（.deb / 全部组件 HEAD 一遍），避免升到一半 404；
3. 渲染层与运行时都在暂存目录组装、校验通过后才 `mv` 就位，旧版本各留 2 份备份；
4. 装完依次校验版本对齐、`/api/health`、`scripts/smoke-test.mjs`（WS/HTTP 协议桥）、
   `scripts/ui-boot-check.mjs`（headless Chromium 真跑渲染层）——任一项失败**自动回滚**。

## 官方 CLI 直连（可选）

WebUI 服务本身不需要 CLI 配置。若想在终端里 headless 使用官方 CLI（与 WebUI 共用凭据与会话库）：

```bash
cp cli-config.example.json ~/.zcode/cli/config.json && chmod 600 ~/.zcode/cli/config.json
# 把 provider.bigmodel.options.apiKey 换成你的 Coding Plan API Key（或直接 zcode login 生成）

~/.zcode/server/node ~/.zcode/server/agents/glm/zcode.cjs \
  --cwd /path/to/workspace --prompt '列出当前目录的文件' --max-turns 1
# 续跑某个会话：加 --resume sess_xxx --prompt '继续'
```

> 密钥文件保持 0600 且在仓库之外；需要代理时设 `ZCODE_HTTP_PROXY`/`ZCODE_NO_PROXY`。

## HTTP API

- `GET <base>/api/health` — 服务状态（版本 / renderer / 运行时 / 登录态 / 会话数 / 回收开关）
- `POST <base>/api/sessions/terminate` — 立即终止全部会话（含后台运行中的，慎用）
- `POST <base>/api/login/start` · `GET /api/login/status` · `POST /api/login/cancel` — OAuth 登录流
- `POST <base>/api/login/import` — 导入凭据 JSON（写入官方凭据库）
- `GET <base>/api/fs/list?path=<dir>` — Web 目录选择器的目录列表
- `POST <base>/bridge/open` · `GET /bridge/poll` · `POST /bridge/send` · `POST /bridge/close` — HTTP 长轮询桥
- `WS <base>/ws?token=<每次启动随机>` — 前端协议桥

## 安全须知

- 服务默认只监听 `127.0.0.1`；需要其它机器访问时用 `host: "0.0.0.0"`（或 `--host` / `ZCODE_WEBUI_HOST`）显式打开。
- 服务自身**默认不做用户鉴权**（本地信任模型）：任何能访问端口的人都能以服务器上的 ZCode 账号身份运行
  Agent。暴露到网络前二选一：**放反代/网关之后**（code-server 登录、SSO、basic auth 等），或配置
  `accessToken`（共享令牌门禁：首次访问在门禁页输入令牌换 Cookie，页面/API/WS 全覆盖，兼容剥前缀代理；
  令牌请用长随机串，Cookie 只存其 SHA-256，修改令牌立即令旧 Cookie 失效）。不要不做任何一种就暴露公网。
- `/api/fs/list` 只列出工作区与用户主目录之内的目录（无法再用它枚举全盘）；
  `/api/login/import`、`/api/sessions/terminate` 能写凭据库/终止任务，同样依赖上述门禁。
- 凭据写入 `~/.zcode/v2/credentials.json`（0600）；`config.json` 不入库，不要提交含密钥的配置。
- WS token 只是防误连其他 WS 服务，不是鉴权手段。
- 官方客户端的「工作区快照」后台上传（含 `.git` 全量历史）在本项目中**默认被禁用**，
  见「默认禁用：官方客户端的『工作区快照』静默上传」。

## 常见问题（FAQ）

**Q：关闭标签页后任务还会继续吗？**
会，后台持续执行到完成或等待输入；重开页面自动查看进度（见「任务生命周期」）。空闲后台会话默认 30 分钟回收，
`ZCODE_WEBUI_DETACHED_TTL_MS=0` 关闭回收，`POST /api/sessions/terminate` 立即清空。

**Q：界面缩放？** Ctrl+滚轮或双指捏合（50%–200%，按浏览器记忆）；Ctrl/⌘ +/- 是浏览器整页缩放，两者并存。

**Q：发送消息提示「当前没有可用的模型供应商和模型」？**
先确认 `/login` 已登录；再跑 `zcode-webui doctor` 看渲染层与运行时的**版本对齐**是否 ok（不一致就
`zcode-webui upgrade` 对齐）；仍报错说明是旧版本项目代码，请更新。

**Q：OAuth 一直卡在「等待端点响应」？模型调用不通但登录正常？**
前者设置 `oauthProxy`、后者设置 `hostProxy`（环境变量或 `config.json`，二者可同用），指向出口可达的 HTTP 代理后重启服务。

**Q：「添加项目 → 打开文件夹」没反应？** 允许本站弹窗即可；目录选择器是内置 Web 页面。

**Q：经 code-server 打开白屏？** 用带尾斜杠的 `/proxy/3102/`（会自动重定向）；WS 不通会自动降级长轮询；
可开 `<base>/debug` 自检页看桥接状态。

**Q：点击会话提示 "ZCode agent server command is not configured"？**
官方运行时找不到 agent 入口。新版本启动 host 时已自动注入定位环境变量，出现该报错先跑
`zcode-webui doctor`（看 `agent server` 是否 ok），然后**重启服务**让新代码生效；自定义路径可用
`ZCODE_AGENT_SERVER_COMMAND` / `ZCODE_AGENT_SERVER_ARGS_JSON` 覆盖。

**Q：官方界面怎么升级？** 直接 `zcode-webui upgrade`（见「一键升级」）。

**Q：切到其他 App 再回来，页面重连/要求手动重连？**
这是手机浏览器在后台冻结页面并回收网络连接所致（并非服务端超时）。新版对此透明：后台掉线**不再刷新
页面**，恢复时通过热重连直接接管同一个运行中的宿主——离线期间任务产生的输出会在恢复瞬间补投，
全程无感、无需任何点击。页面开着（含后台）会持续 presence 续租，宿主和补帧窗口不会被后台时长回收；
页面回前台即自动恢复。只有标签页关闭后租约过期，或宿主进程本身退出（如服务重启）才需要一次自动
刷新。服务端另加了 30 秒 ping/pong 保活，僵死连接会被及时清理、宿主干净转入后台。

**Q：服务器休眠/断网后，进行中的任务停了？**
分两种情况：

- **其实还在跑（常见）**：任何设备重新打开页面都会作为视图接入同一宿主——**实时进度无缝续看**，
  且多台设备可同时观看、互不刷新。只有「同时发任务指令」才可能双代理并发，请避免。
- **真的断了**：挂起/断网掐断流式连接会让该回合以失败告终（服务日志可见 `process stall of ~Ns`）。
  可用官方 CLI 无头续跑：
  `~/.zcode/server/node ~/.zcode/server/agents/glm/zcode.cjs --cwd <工作区> --resume <会话ID> --prompt '继续'`；
  刷新页面即加载最新落库状态。长任务期间请避免让服务器休眠。

**Q：定时/闲时任务能跑吗？** 该调度器属官方桌面端专属；可在服务器上用系统 cron 调官方 CLI 的
`--prompt/--resume` 实现，按订阅规则计费。

## 测试

```bash
npm run smoke                            # 静态服务 + base path + WS/HTTP 双桥全链路冒烟
bash scripts/docker/verify.sh            # Docker 真机全链路：npm 包 → 自动安装 → 服务 → 冒烟 → 真实模型调用
ZCODE_VERIFY_FRESH_RUNTIME=1 bash scripts/docker/verify.sh   # 更严苛：容器里只有凭据、无官方运行时，
                                                             # 验证 setup 从零自动安装（CDN 组件下载 + SHA256 校验）
```

Docker 验证会把本机 `~/.zcode` 复制进临时沙箱注入容器，用完即删；镜像层与仓库不含任何凭据。
可用 `ZCODE_VERIFY_SOURCE/PROXY/NETWORK/KEEP/SKIP_FETCH` 覆盖默认行为。`scripts/dev/` 下另有一组
Playwright 端到端脚本（真实登录态驱动官方界面的回归），可用 `ZCODE_WEBUI_TEST_URL/TEST_DIR` 指向自己的服务。

## 已知限制

- 不支持 SSH/WSL/Docker 远程工作区创建（服务本身就运行在你的工作区机器上）
- 手机 Remote Control、系统托盘、自动更新等桌面专属通道不可用（Browser Use 可走服务器无头 Chrome）
- 定时/闲时任务依赖桌面端调度器（见 FAQ）
- 服务进程重启会中断后台任务；HTTP 长轮询模式下重开页面不能无缝接管会话（结果仍可在任务面板看到）
- 官方界面随版本演进，个别新 UI 可能暂时兼容性问题；渲染层与运行时务必同版本

## 目录结构

```
src/server.mjs             HTTP 静态服务 + base path + WS 桥 + 登录 API + 会话管理
src/cli.mjs                zcode-webui 命令行（setup / start / stop / upgrade / doctor / status）
src/dirs.mjs               数据目录解析（ZCODE_WEBUI_HOME / 仓库模式）
src/frame.mjs              stdio 帧编解码（与官方运行时互通）
src/host.mjs               官方运行时进程拉起与握手
src/upgrade.mjs            版本探测 + 渲染层/官方运行时组件下载校验与原子替换
src/login.mjs              官方 CLI OAuth 登录子进程管理
src/rpclog.mjs             诊断日志（DEBUG_RPC 时使用）
web/bootstrap.js           浏览器侧：URL 参数、MessagePort↔WebSocket 桥、长轮询降级
web/zcode-bridge.js        window.zcode 浏览器适配层
web/{login,picker,debug}.html 等   登录页 / 目录选择器 / 自检页 / 凭据导出工具
config.example.json        服务配置模板（脱敏）
cli-config.example.json    官方 CLI 模型配置模板（脱敏）
scripts/fetch-renderer.sh  从官方 CDN 下载客户端并提取渲染层（vendor/renderer，不入库）
scripts/smoke-test.mjs     冒烟测试
scripts/docker/            Docker 真机全链路验证（verify.sh + container-verify.sh）
scripts/dev/*.mjs          Playwright 端到端联调脚本
```

## 许可证与声明

- 代码以 [MIT](./LICENSE) 开源；
- 官方 ZCode 名称、商标与客户端版权归其权利方所有；本项目不包含、不分发任何官方客户端文件；
- 参考：[ZCode 官方文档](https://zcode.z.ai/cn/docs) · [智谱开放平台](https://open.bigmodel.cn) ·
  [GLM Coding Plan](https://docs.bigmodel.cn/cn/coding-plan/overview)。
