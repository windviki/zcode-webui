# AGENTS.md — zcode-webui 项目约定

## 发布流程（GitHub + npm，已验证可用）

发布 = 版本号 bump + release 提交 + 推送 GitHub + npm 发布。按顺序执行：

1. **确认工作区干净**：`git status --short` 必须为空（运行时文件已被 .gitignore 覆盖）。
2. **跑发布前检查**：`npm run prepublishOnly`（各入口文件的语法检查）。
3. **bump 版本号**：改 `package.json` 的 `version`。含新功能升 minor，纯修复升 patch。
4. **release 提交**：`git commit -m "chore: release vX.Y.Z"`。
5. **推送 GitHub**：`git push origin main`（remote 是 windviki/zcode-webui）。
6. **npm 发布**（scoped 包，镜像源发不出去，必须切官方源，发完切回来）：
   ```bash
   nrm use npm            # 切到官方 registry（当前日常用的是 taobao 镜像）
   npm whoami             # 确认登录态（应为 windviki）
   npm publish --access public   # scoped 包必须 --access public，否则发不出去
   nrm use taobao         # 发布完切回镜像，否则日常安装会走官方源变慢
   npm view @aixyzstudio/zcode-webui version   # 确认线上版本
   ```
7. （本机部署时）`./zcode-service.sh restart` 让服务跑新代码。注意 `/api/health`
   的 `version` 字段是进程启动时读的，重启后才会显示新版本号。

## 自我点火重启（标准流程，用户说「自我点火」即指此流程）

场景：agent 会话本身就跑在要重启的 server 里（server → zcode-server → zcode-cli → 工具 shell 全是一条
进程树）。**直接跑 `./zcode-service.sh restart` 会出事**：stop 杀掉 server 时，作为它后代的 agent、
shell、以及正在执行的 restart 脚本会一起死，`start` 永远执行不到，服务就此挂掉。

正确做法是把重启脚本本身脱离进程树，让它替我们"点火"：

1. **确认安全窗口**：无进行中任务——`/api/background` 的 `activeCount` 为 0，且
   `~/.zcode/v2/tasks-index.sqlite` 的 `tasks.task_status` 无 running 类状态。用户明说重启时可跳过。
2. **写延迟重启脚本**（如 `/tmp/zwebui-selfrestart.sh`）：
   ```bash
   #!/usr/bin/env bash
   sleep 30        # 留时间让最终消息送达浏览器
   cd /home/coder/dsh-projects/zcode-webui || exit 1
   ./zcode-service.sh restart
   ```
3. **setsid 脱离启动**（关键步骤）：
   ```bash
   setsid nohup bash /tmp/zwebui-selfrestart.sh > /tmp/zwebui-selfrestart.log 2>&1 < /dev/null &
   ```
4. **验证脱离**：`ps -o pid,ppid,sess,cmd -p <pid>` 必须显示 `PPID=1` 且 `SESS` 等于自身 pid
   （独立 session）。不满足则不得继续。
5. **立即发出最终消息**：当前会话会随旧服务一起被终止，这是预期行为，消息里要提醒用户
   重启完成后刷新页面（拿到新渲染层）。`zcode-service.sh start` 本身也用 `setsid nohup`
   拉起新服务，所以重启后的服务天然脱离旧树。

配套经验：升级官方渲染层/运行时用 `./zcode-update.sh`（见下节；`node src/cli.mjs upgrade --yes`
是 npm 安装形态下的等价入口）；旧运行时自动备份在 `~/.zcode/server.bak-*`，渲染层备份在
`vendor/renderer.bak-*`，回滚改名或跑 `./zcode-update.sh --rollback` 即可。

## 官方组件更新（标准流程，用户说「更新/升级」即指此流程）

`./zcode-update.sh` 把「拉包 → 解包 → 校验 → 原子替换 → 重启 → 校验」整条链路做在一个 sh 脚本里
（与 `src/upgrade.mjs` 部署的东西完全一致，只是纯 shell 实现）：

```bash
./zcode-update.sh              # 探测最新版本并更新，装完自动重启 + 校验
./zcode-update.sh --check      # 只看版本（当前 / 官网 / CDN）
./zcode-update.sh -v 3.12.3    # 指定版本（显式指定会绕过「shim 支持上限」的判断）
./zcode-update.sh --stable     # 只跟官网公布版本，不采用 CDN 上更新的构建
./zcode-update.sh --rollback   # 回滚到最近一次更新前的备份
```

要点：

1. **版本以 CDN 为准**：官网 changelog/install 页常比 CDN 慢一步，脚本先读官网当基线，再向上探测
   CDN 上真实存在（manifest + deb 都在）的最高版本，不一致时会提示。
2. **资源预检**：动服务之前先把本次要用的 .deb / 组件全部 HEAD 一遍，避免升到一半才发现 404。
   组件 tarball 路径里的 `+` 必须编码成 `%2B`，否则 CDN 按空格处理直接 404。
3. **原子替换 + 备份**：渲染层 `vendor/renderer.bak-<旧版本>-<ts>`，运行时
   `~/.zcode/server.bak-<旧版本>-<ts>`（各留 2 份），staged 目录校验通过才 `mv` 就位。
4. **强制校验**：版本对齐 → `/api/health` → `scripts/smoke-test.mjs`（WS/HTTP 协议桥）→
   `scripts/ui-boot-check.mjs`（headless Chromium 真跑官方渲染层）。任一失败，**默认自动回滚**并再校验一次
   （`--no-auto-rollback` 可关）。
5. **shim 支持上限**：`SHIM_MAX_SUPPORTED`（脚本与 `src/upgrade.mjs` 各一份）为 **3.12.3**，
   超过它的版本不自动升，只提示（显式 `-v` 可试装，装完照样校验界面）。

### 3.12.x 适配（2026-09-17 完成）

官方 3.12 起渲染层的启动条件变了，两处都要对上，否则界面停在「未能收到启动状态
/ 诊断 ID: startup-channel-unavailable」：

1. **服务端口消息改成对象**：`{type:'zcode:service-port', databaseStartupId}`（3.11 及更早只认裸字符串
   `'zcode:service-port'`）。
2. **必须再收到「数据库启动通道」状态**：`{type:'zcode:database-startup-state', state}`，其中
   `state.phase === 'ready'` 且 `state.startupId === databaseStartupId`（schema 是 strict object：
   schemaVersion/startupId/attemptId/sequence/startedAt/updatedAt/phase/disk 必填）。
   桌面端主进程负责开库/迁移并上报进度；本项目里数据库由官方运行时自己管，所以直接报 ready。

`web/bootstrap.js` 按 `cfg.rendererVersion`（server.mjs 注入）二选一，3.11 与 3.12 都能跑；
`state` 连发两次躲开「监听器与 `__ZCODE_RENDERER_START__` 同一次模块执行」的竞态。
协议桥本身没变（smoke 测试对 3.12 也是全绿），所以**必须靠 `scripts/ui-boot-check.mjs` 真跑浏览器**才看得出好坏。

### 3.12.x 的 CLI 依赖：内置 provider 配置（关键）

官方 3.12 的 `zcode.cjs` 启动时会解析「CLI ZCode Built-in Provider Config」，只认两处：

1. `<runtime>/agents/glm/provider/zcode-builtin.json`（桌面端把它跟 CLI 一起打包，**服务器运行时组件不含**）
2. `<entry 上溯 5 级的父目录>/config/provider/zcode-builtin.json`（本机解析成 `/home/config/...`，用不上）

缺了这个文件，`zcode.cjs login` 与 `zcode.cjs app-server`（host 起 agent 用的入口）都会**直接退出**：
`无法定位 CLI ZCode Built-in Provider Config：…`。换句话说 3.12 上登录做不了、agent 也起不来
（协议往返类测试发现不了——continuity/smoke 都不跑 agent）。

修法：`src/host.mjs` 的 `ensureCliProviderConfig()` 把 host 自己物化出来的
`<dataRoot>/v2/runtime/provider/bundled/zcode-builtin.json` 复制到 CLI 期望的位置，
只在该文件缺失时写（不覆盖官方自带的）。调用点两处：server 启动时、以及每次 host 握手成功后
（agent 一定在握手之后才 spawn），所以换运行时、清 v2 目录都能自愈。

### 3.12.x 的模型可用性（不是 bug，是官方新行为）

3.12 起模型可用性走**服务端 entitlement 校验**（provider 身份变成 `account:*`）：

- 3.11.2：直接信任本机 `~/.zcode/cli/config.json` 里的 API key（日志 `codingPlanApiKey:builtin:...`），
  所以界面能列出 GLM-5.3。
- 3.12.3：先查 `https://zcode.z.ai/api/v1/zcode-plan/billing/balance`，本机账号返回
  `plans: []`（`hasActiveStartPlan:false`）→ 日志 `[usage-stats] 读取 BigModel entitlement 未找到可用授权`
  → 界面显示「当前没有可用模型。请开通编程套餐或配置自定义模型。」（模型列表为空）。

**处理办法**：在界面「管理模型 → 添加自定义模型」里填本地 API key（官方给的路子），或续费/绑定套餐；
想回到「认本地 key」的旧行为就 `./zcode-update.sh --rollback` 退回 3.11.2（备份已在，一条命令）。
另外 3.12 渲染层还会请求 `window-controller` 通道（桌面端主进程服务，本项目不提供，日志里会刷
`Unknown channel: window-controller`）——已确认不影响启动与协议往返。

### 版本钉位

- 本机部署：**3.12.3**（`zcode-update.sh` 的 `PINNED_VERSION`、`scripts/fetch-renderer.sh` 的
  `ZCODE_VERSION` 默认值、`src/upgrade.mjs` 的 `DEFAULT_VERSION`、README 里的默认值，四处一起改）。
- shim 支持上限：**3.12.3**（`SHIM_MAX_SUPPORTED`，两处：`zcode-update.sh` 与 `src/upgrade.mjs`）。
  超过上限的版本默认不升，只提示；显式 `-v` 仍可试装，装完照常校验、起不来自动回滚。

### 会话置顶（pin）禁用（2026-09-18）

官方渲染层把置顶会话移进「已置顶」分组，宿主侧也从 `listTasks` 里剔除（走 `listPinnedTasks`/
`listPinnedTaskIds`），而本项目只渲染普通列表 —— 误点行内那个 hover 才出现的置顶小图标，会话就从
任务列表里彻底消失。现在置顶按钮被禁用，置顶请求直接吞掉（不落库）：

- `web/zcode-bridge.js`：注入 `#__zcode_webui_pin_kill` 样式隐藏行内按钮与「更多」菜单项，
  并在捕获阶段拦掉 click/mousedown/mouseup/focusin（老标签页 / 合成点击也打不通）。
- `src/pin.mjs`：宿主侧 no-op 守卫，**两台传输都要过**——WS（`writeToHost`）与 HTTP 长轮询
  （`/bridge/send`，这条以前绕过了守卫，是 pins 仍然落库的真正原因）。命中时日志
  `[bridge] pin no-op (…)`，并本地伪造 201 给渲染层；`pinned:false` 一律放行，方便恢复。
- **线上通道名是 `zcode-task`**（渲染层的 `ServiceChannels.ZCodeTask`），本地服务对象只是**叫**
  `zcodeTaskService`，按那个名字匹配永远不命中（旧实现就是这么失效的）。参数按宿主约定包成
  单元素数组 `[{taskId, workspacePath, pinned}]`（宿主是 `handler.apply(ctx, arg)`）。
- 恢复置顶造成的“会话消失”：`node scripts/dev/unpin-tasks.mjs 3102 <workspacePath> <taskId…>`
  （先 `listPinnedTaskIds` 打印现状，再逐个解置顶，全程走官方 RPC，不直接改库）。
- 自检：`node scripts/dev/pin-guard-test.mjs`（守卫单测）、
  `node scripts/dev/pin-relay-probe.mjs <port> <taskId> <workspacePath> 1`（HTTP 传输必须 201 假响应）、
  `node scripts/dev/pin-kill-verify.mjs`（真浏览器里确认无可见置顶控件）。
- 注意：守卫是**服务端代码**，改动后要重启服务才生效（客户端 CSS 部分刷新页面即可）。

### 仓库快照（repo-snapshot）静默上传禁用（2026-09-18）

官方 3.x 客户端在每次 prompt 前后会做「工作区快照」：先向 `GET /api/v1/snapshot/upload-credential`
申请上传凭证，再按筛选规则扫描工作区打包，**AES + 服务端 RSA 公钥信封加密**后上传到厂商 OSS，
并在 `~/.zcode/v2/checkpoints/<workspace-hash>/` 留下明文 manifest 与密文。问题有三：
`.git/` 排在所有排除规则之前（密钥过滤、1MB 体积上限对 `.git/**` 永不生效，历史里出现过的凭据会原样出去）、
解密私钥只在服务端（本地打不开，不是备份是采集）、以及**没有开关**——设置项 `repoSnapshotIndexingEnabled`
只是 schema 默认值 + 设置名列表，不参与采集判定（本机它为 `false`，快照照采）。外部取证见
`blog.ferstar.org/posts/zcode-silent-workspace-snapshot-upload/`。

垫片层的处置（默认开启，`ZCODE_WEBUI_ALLOW_REPO_SNAPSHOT=1` 可恢复厂商行为）：

- `src/repo-snapshot-guard.cjs`：宿主进程 preload，四层拦截——① 凭证请求本地回
  `{code:0,data:null}`（运行时把 null 当「服务端没发凭证」，`captureBeforePromptUnsafe` 在扫描/打包
  **之前**就 return，`zcode-server.cjs` 里 `getUploadKey() === null => return`）；② 快照密文的对象上传
  按 OSS 表单特征（`file=repo-snapshot.tar.gz.enc` / `key=repo-snapshot*` / `x-oss-signature` 头）拒 403，
  覆盖「设置了 `settings.httpProxy` 走运行时内置 undici、绕过 globalThis.fetch」以及内存里已缓存的凭证；
  **②b** 产物读取拒绝：`checkpoints/*/{pending,tmp}/*` 经 `openAsBlob`（POST 上传体）与
  `createReadStream`（PUT 变体）的读取直接失败——**3.12.3 起对象上传改走运行时内置 undici**
  （`objectUploadFetch ?? import_undici.fetch`，preload 补不到），这一层与传输实现解耦：拿不到产物就拼不出
  上传体。③ 拦截 `~/.zcode/v2/checkpoints/*/{pending,tmp,manifests,extra-manifests}/` 的写入
  （`state.json` 保持可写，状态仓库与宿主不受影响）。每次拦截都写 stderr → `zcode-webui.log` 里的
  `[host:stderr] [zcode-webui] repo-snapshot-guard: ...`，可审计。采集失败被运行时
  `void scheduled.catch(()=>{})` 吞掉，不会打断对话。
- `src/host.mjs`：`buildHostEnv()` 注入 `NODE_OPTIONS=--require <guard>`（宿主 spawn 的子进程默认继承；
  采集本身就跑在宿主进程里，所以覆盖面不依赖继承）。
- **每次官方运行时升级后必跑**：`node scripts/dev/repo-snapshot-guard-status.mjs` —— 一把梭检查
  ①当前 app/运行时/渲染层版本 ②守卫的各个钩子是否仍能对上官方 bundle（凭证端点、`!uploadKey` 提前返回、
  产物名/OSS 表单字段、`openAsBlob`/`createReadStream`、checkpoint 目录、`globalThis.fetch` 传输，
  以及对象上传是否已换成内置 undici）③线上宿主是否真的加载了 preload、最近拦了多少次、
  有没有"守卫武装之后才出现的产物"。任何一项 WARN 都必须先修守卫再继续用。
- 盘点现状：`node scripts/dev/repo-snapshot-audit.mjs [--json]`（逐工作区列出上次快照时间、是否已被接受、
  manifest 里 `.git` 占比、残留密文）。自检：`node scripts/dev/repo-snapshot-guard-test.mjs`（20 项）。
- 本机 2026-09-18 的现状：12 个工作区有快照记录，10 份上传已被服务端接受（含 `writing/recabyss`
  今天 05:30Z 那份，`.git` 21.5MiB / 39.3%）；`vBookmarks`、`vbookmarkspro` 两份共 177MiB 密文
  已挪到 `~/.zcode/v2/repo-snapshot-quarantine-20260918T1030Z/`（确认无用可直接删），
  `~/.zcode/v2/checkpoints` 与其下各工作区的 `pending|tmp|manifests|extra-manifests` 目录已置为 `r-x`
  作为进程外兜底（新工作区也建不出来；要重新启用厂商行为得先 `chmod u+w` 回来）。
- 注意：守卫在宿主进程启动时注入，**改完要重启服务**（`./zcode-service.sh restart`）才对新宿主生效；
  重启窗口照旧看 `/api/background` 的 `activeCount` 为 0。

### 计费/配额查询缓存 + 429 退避（2026-09-18）

现象：设置 → 模型供应商 → 编程套餐 面板显示「套餐查询失败，重试」（渲染层文案 `purchase.entry.retry`）。
本机日志实证：`GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance` 返回 **HTTP 429**（约 3 小时内 12 次，
同期 698 次成功）；渲染层与宿主的 usage-stats / coding-plan-availability 都会在面板打开时高频轮询该接口，
而渲染层把「非 `no_plan` 的 unavailableReason」也判为错误，于是整块面板报错。

处置：`src/api-cache-guard.cjs`（宿主 preload，`src/host.mjs` 与 repo-snapshot 守卫一起注入）：

- 命中 `/api/v1/zcode-plan/billing/(balance|current)`、`/api/monitor/usage/quota/limit`、
  `/api/biz/subscription/list` 的 GET：**TTL 缓存（默认 30s）+ 并发合并**，UI 反复查询不再逐个打到上游；
- 上游 429 时进入**指数退避**（60s 起、上限 10min）：窗口内优先回放上一次成功响应（`x-zcode-webui-cache: stale`，
  页面保持可用），没有缓存才原样透传；恢复后自动复位；
- 只碰上述只读路径，其余请求原样透传；动作写 stderr → `[host:stderr] [zcode-webui] api-cache-guard: ...`，
  每 15 分钟打一次 `stats hits=/misses=/coalesced=/backoffSkips=`。
- 关闭：`ZCODE_WEBUI_BILLING_CACHE_TTL_MS=0`；改路径：`ZCODE_WEBUI_BILLING_CACHE_PATTERN`；
  退避基数：`ZCODE_WEBUI_BILLING_BACKOFF_BASE_MS`。自检：`node scripts/dev/api-cache-guard-test.mjs`（10 项）。
- 注：BigModel 侧「未找到可用授权」是运行时**本地**解析授权返回 null（snapshot 落 `not_configured`），
  3.12.3 下已基本正常（偶发单次），与 429 无关，也不由本守卫处理；本机凭据（`credentials.json`）是
  AES-256-GCM 加密落盘，裸探针用不了，验证要走运行时自己的 RPC/日志。

## 网络面加固 / 静态缓存 / 日志治理（2026-09-18，v0.6.0）

一批「修复 + 优化 + 加固」，全部有自检（`node scripts/dev/http-hardening-test.mjs`，18 项）：

- **监听地址默认 `127.0.0.1`**（`host` / `--host` / `ZCODE_WEBUI_HOST` 显式改 `0.0.0.0`）。本机 code-server
  同容器代理 3102，对端全是 loopback，默认收紧无影响。
- **可选 accessToken 门禁**（`accessToken` / `ZCODE_WEBUI_ACCESS_TOKEN`，默认关）：未认证的 HTML 请求
  **原地**返回 `web/access.html` 门禁页（200、不重定向——剥前缀代理下绝对路径重定向会跳出 `/proxy/<port>`，
  这是设计点）；`/api/*`、`/bridge/*`、静态资源、WS upgrade 一律 401/403；`/api/health` 对探测返回
  最小 `{ok:true,authRequired:true}`（zcode-service.sh / zcode-update.sh 的健康检查不受影响）。
  Cookie 存令牌的 SHA-256（`zwebui_access`，30 天），改令牌即全部失效。
- **`/api/fs/list` 限根**：只列 workspace 与 `$HOME` 之内，向上导航在根处截断（picker 的 `..` 行自然消失）。
- **静态资源缓存**：`/assets|/material-icons|/pdfjs/` 发 `immutable`（文件名带内容哈希），其余发 ETag
  （304 再验证）；注入脚本 `?v=` 改为进程启动时固定。刷新不再全量重下 58MB 渲染层。
- **日志治理**：① `zcode-service.sh` start 时按大小轮转（>50MB，留 3 份）；② `src/host.mjs` 的 stderr
  relay 对 60s 内的完全重复块计数抑制、超 4KB 截断（`stderrTail` 仍留原始尾部供退出诊断）；
  ③ `[http]` 访问日志跳过轮询类 GET（background/process-metrics/bridge-poll/health/update-check/login-status）；
  ④ server 每 15min 检查日志 >200MB（`ZCODE_WEBUI_LOG_MAX_MB`）时留 8MiB 尾巴到 `.overflow` 后 truncate
  （O_APPEND 下安全）。
- **host 生成合并**：`handleUpgrade` 用 `pendingSpawns`（userKey → in-flight Promise）合并并发首连，
  消除「同账号两标签页同时首开 → 双 host，被覆盖者脱离 sessions、reaper 永远扫不到」的僵尸泄漏；
  合并进来的晚到视图按 adopted 处理（Initialize 回放 + hold 门控）。
- **HOST_PROXY 修复**：`createSession`（WS 主通道）此前漏传 `ZCODE_HTTP_PROXY`，只有 HTTP 回退通道的
  host 走代理；现在两条通道共用 `hostExtraEnv()`。
- **pin 守卫先查 RPC 头**（channel/method 不匹配直接 return），大帧不再为拦截判断付全量 JSON.parse。
- **`/bridge/send` 体积上限** 32MB（`ZCODE_WEBUI_BRIDGE_MAX_BODY_MB`）；`/bridge/poll` 新 waiter 覆盖前先
  结算旧 waiter；mux pending 10min TTL 清理；bootstrap 的 4001/takeover 死代码移除；HTTP 降级定时器
  对 CONNECTING 状态的 ws 多给两个 3s 窗口。
- **guard stats 进 `/api/health`**：`guards.apiCache`（api-cache-guard 经
  `ZCODE_WEBUI_GUARD_STATS_DIR` 落盘的 JSON，宿主进程写、server 读）。
- **`zcode-update.sh` 校验链加了第五步**：`guard_check`（跑 repo-snapshot-guard-status.mjs，任一 WARN
  视为失败走回滚路径；`--no-guard-check` 跳过）。AGENTS 里「升级后必跑」从此自动执行。

## 后台回来连不上 / 会话列表不更新 / 侧栏折叠点不开（2026-09-28，v0.8.0）

用户报的两个体感问题，拆开是五条根因，全部修掉：

**问题一「浏览器放后台没多久回来很难连上、不刷新看不到最新会话」**，日志实证（含 51 次
`send 410` 未处理拒绝、12 次 `client unresponsive`、`bridge-open-failed | Failed to fetch` 现场）：

1. **服务端 keepalive 太狠**：一次 30s ping 没回 pong 就 `terminate()`。后台标签页（浏览器节流/代理
   缓发 pong）经常一分钟内中招，而此刻任务可能正在跑。现在默认容忍 **2 次**连续未回
   （约 60~90s 才判死），`ZCODE_WEBUI_WS_PING_MS`（默认 30000，下限 5000）与
   `ZCODE_WEBUI_WS_PING_MAX_MISS`（默认 2）可调。terminate 仍然只是 detach，host 照旧后台续跑。
2. **断线帧无重放**（`resumeBuf` 声明了但从没实现）：热重连成功后，断线窗口里的任务列表事件/
   呼叫响应全部被丢——「不刷新就看不到最新会话」的直接原因。现在每个**渲染层时代（era）**在
   停靠期间把发给它的下行帧缓冲（默认 2048 帧 / 16MB，`ZCODE_WEBUI_RESUME_BUF_MAX_FRAMES`/
   `_MB`），resume=1 热重连时按序重放（本地 id 已还原）；缓冲溢出则下次 resume 直接 close 4000
   走整页刷新（比静默漏帧诚实）。停靠超时（默认 10min，`ZCODE_WEBUI_RESUME_PARK_MS`，0=关闭缓冲）
   会 `disposeViewEvents` + 清缓冲 + 删 eraByTab 条目——**顺带修掉了标签页永不回来时宿主侧
   ghost 事件订阅无限堆积的存量泄漏**。
3. **上行帧静默丢弃**：socket 断开期间渲染层发的服务调用（文件树展开、列表刷新等）直接蒸发，
   对应 UI promise 永远挂起。bootstrap 现在把断线期间的上行帧排队（256 帧 / 4MB），传输恢复
   （ws verify 或 http open 成功）时冲刷。测试钩子 `window.__zwebui_send(data)` 等价于渲染层发帧。
4. **HTTP 回退死路**（三条）：① 页面已引导成功后，一次 ws open 失败就永久切到 http 长轮询——
   对着**全新 host** 说话、era 丢失；现在引导后要连续 5 次 open 失败才降级，期间一直热重试 ws。
   ② `/bridge/open` 失败只报一次错就躺平（无重试、visibilitychange 也不救）；现在带退避重试，
   回到前台优先走 ws 热重连（`recoverTransport()`）。③ relay 被回收后 `pollLoop` 对着 410 每秒
   空转永不恢复；现在 410 → 清 session → 尝试 ws 热重连（era 还在就续上，不在则服务端 4000 →
   刷新）。附带修掉 `bridge/send 410` 抛进 promise 链造成的未处理拒绝风暴（51 次的那批）。
5. **服务端 `/api/health` 补回 `sessions.detached`**（早前重构弄丢，reattach-test 一直在等它）。

**问题二「左侧工作区目录折叠了点不开」**：shim 的左下角错误横幅（`#zcode-webui-error`）此前
**永不消失、可吃点击、不限高**——任何 console.error（渲染层噪声、上述 410 风暴）都会常驻一块
盖住侧栏底部的横幅，折叠分组/文件树落在下面就「点不开」，刷新（横幅清掉）才恢复。现在：
`pointer-events:none`（只有通知按钮可点）、限高 132px、普通报错 20s 自动消失（服务端日志仍全量
留存）、`ResizeObserver loop completed` 这类浏览器噪声只记日志不出横幅、活动通知（带按钮）不会被
后续报错覆盖。渲染层黑盒内部若有自己的卡死无法从垫片修——但垫片侧的挡点击因素已清零。

自检：`node scripts/dev/resume-replay-test.mjs`（13 项，协议级：可编程假 host 验证断线补帧重放 +
keepalive 宽限；沙箱会显式钉 `ZCODE_SERVER_RUNTIME_ROOT` 并清 `NODE_OPTIONS`，避免从生产进程树
继承环境串台）、`node scripts/dev/hot-reconnect-test.mjs`（11 项，真浏览器：热重连不刷新、上行
冲刷、ws 失败不退 http、横幅穿透 + 自动消失）。注意 `scripts/dev/reattach-test.mjs` 是**过时存量**
（断言的是多视图重构前的「每渲染层一个 host」架构，case 2 起必失败），现行覆盖以
hot-reconnect/resume-replay 为准。

## 官方源码对照与垫片强化（2026-09-28，v0.8.1）

官方已开源 ZCode（`github.com/zai-org/ZCode`，HEAD 与线上 v3.14.3 一致），克隆在
**`/home/coder/dsh-projects/zcode-src`**（pnpm monorepo：`packages/rpc` 协议层、`packages/server`
宿主、`packages/services` 服务面、`packages/ui` 渲染层、`apps/zcode-cli` Agent CLI 与运行时）。
六路对照（协议/快照/配额/pin+mode/引导握手/任务索引+侧栏）已把历史黑盒结论逐条验证，要点：

**证实（不再需要猜）**：13 字节帧头与 preset 0-6；100~104/200~204 消息类型；stdio 握手
zcode-hello/hello-ack；cancel/dispose 引用调用方原始 id 且宿主对未知 id 静默忽略；
`zcode-task` 通道、`setTaskPinned`/`setMode` 单元素数组参数、`handler.apply(ctx, args)` 解包；
yolo 放行（`permission/service.ts`："Yolo mode bypasses permission prompts"，例外：requiresUser
Interaction/alwaysAsk 工具仍弹窗、planEnabled 优先）；quota/limit 口径（usage=额度、percentage=
已用%、number 是身份键非除数）；reset 幂等键在 **body 字段 `idempotency_key`**（uuid，≤64 字符）；
双 JWT 头（`Authorization` + `X-Bigmodel-Authorization` + `Bigmodel-Target-Type`，仅 reset 与
official-MCP 通道带，模型调用只带单 Authorization）；3.12+ 引导握手（service-port 对象形式 +
database-startup-state strict schema + 30s 超时合成 `startup-channel-unavailable`）；`window.zcode`
共 114 个方法（非 130）。

**勘误（黑盒结论与源码不符）**：
1. **202=PromiseError（结构化 Error）、203=PromiseErrorObj**，不是"further/cancelled"——我们
   routeDownstream 把 201/202/203 一律按"响应"路由，行为正确，注释已正。
2. **`fault.connection.clientChanged` 是每连接 scope 级**（每条 WS/MessagePort 一个
   connectionScope，stdio hello 层的 clientId 只记日志不校验），不是"一个 host 只认一个
   clientId"；共享 deviceId 的做法仍安全。
3. **官方没有「1308=5h、1310=周」的 scope 二分**（workflow-model-failure-policy.ts 把全家当同一种
   quota 停机）——该二分是我们从上游文案推断的启发式，保留为精确映射；守卫已扩到官方全集
   {1005,1308,1310,1313,1316~1321,2056,20097}（其余→ANY，按实际耗尽的池施救），正则补
   `error_code` 字段变体。
4. **`billing/current` 已废弃**（v3.14.3 无调用方）；api-cache-guard 模式里保留属防御性兼容。
5. localStorage 键拼接：drafts 键带 `encodeURIComponent(wsKey)`，recent 键无 `:v1` 后缀。
6. **开源树里没有 repo 快照上传功能**（captureBeforePromptUnsafe/upload-credential/checkpoints
   目录均不存在）——发行 bundle 与 OSS 树**不同源**；但开源树证实宿主 API 层走内置 undici、
   OSS 类上传走 node:http/https，**globalThis.fetch 补丁对官方两大出口都不可见**。守卫已加
   layer 1b：`node:http/https.request` 层拦 `/api/v1/snapshot/upload-credential`（构造真实
   ClientRequest 后 nextTick destroy，对调用方表现为网络错误；`http.get` 同步覆盖）。
7. tasks-index 的 `task_status` 合法值只有 **running/completed/error**（无 pending；可空）；
   **error 行在重试期间不刷新 updated_at**（zcodeTaskIndexSyncer 只在首次可见/终态/标题变化/
   用户操作时写库）——quota-reset 守卫的 busy 检测已补「error 行 10 分钟内更新也算忙」
   （`ZCODE_WEBUI_QUOTA_RESET_ERROR_FRESH_MS`）；官方 UI 自己也不信 sqlite 的 running
   （只采信 sessions-index 的实时 phase）。
8. 源码有而未用的信号，留档：`POST /reset/opportunity`（官方每次 status 轮询后顺带申请资格，
   3301=denied+next_try_at、HTTP 429=throttled——若后端改为「机会需主动申请才发放」，纯观察
   会拿不到机会）；`has_unread_history`（他端用过重置的免费信号）；429 的 `Retry-After` 头
   （比 nextResetTime 轮询更及时）。

**侧栏折叠点不开——真凶修正**（接上节问题二）：线上 web 构建其实**有**左上角 28×28 官方切换
按钮（实测在 (13,15)，折叠后仍在），但两个真实卡点依旧：**R1** 会话区 <360px 时任何去抖 resize
都会自动收起侧栏（WorkspaceShellLayout 的 conversation-auto-collapse：点开→下个 resize 立刻收回
＝「点不开」；刷新后无 resize 事件所以「好了」）；**R3** 侧栏子树的 ScopedErrorBoundary resetKeys
不含可见性（渲染报错后冻结到刷新）。处置：⚡/♻ 浮窗新增 **◧ 侧栏 chip**——代发官方
`toggleSidebar` 快捷键（Cmd/Ctrl+B，`SHORTCUT_COMMANDS` 默认绑定；快捷键内核监听 window 捕获
阶段、不查 isTrusted，合成 KeyboardEvent 可触发），直接驱动命令通道，不经过可能已坏掉的侧栏
子树渲染；折叠时 label 变「◧ 展开侧栏」并高亮（hint 样式）。测试钩子
`window.__zwebui_sidebarHidden/__zwebui_sidebarToggle`；自检
`node scripts/dev/sidebar-toggle-test.mjs [base]`（默认打生产，ZOOM_TEST_ALLOW_PROD=1 确认；
已在生产真机验证折叠/展开全链路）。

**其余强化**：pin 伪造应答 body 从 undefined 改为**完整 ZCodeTaskMeta 形状**（渲染层会把返回值
upsert 进置顶 store，undefined/瘦对象会写脏数据；响应头也按官方改为 2 元素 `[201,id]`、body
为返回值本身不包数组）；`normalizeBoostMode` 补 `自动→auto`、`autoedit→autoEdit`（官方
ZCodeTaskMode 六值：yolo/plan/edit/auto/autoEdit/build；auto 走宿主旧 op、autoEdit 被宿主映射
为 build，均放行由宿主裁决）；桥的官方模式下拉映射补「自动」；bootstrap 应答渲染层的
`zcode:database-startup-control {action:'snapshot'}` 请求（官方 reload 竞态解法：main 进程重放
最新 state；此前我们不答，靠 500ms 主动重发覆盖）。

自检增量：`pin-guard-test`（+2：meta 形状、workspaceIdentity 透传）、`mode-boost-test`（46 项，含
新别名）、`quota-reset-guard-test`（+8：官方码族、error_code 变体、error 行 busy）、
`repo-snapshot-guard-test`（+4：node:http request/get 拦截与放行）、新增
`sidebar-toggle-test`（6 项）。hot-reconnect 11 项复跑全绿。

## 「完全访问」模式的官方语义（2026-09-18 排查结论）


用户反馈「选了完全访问也不管用，每次都问」。受控复现（`scripts/dev/mode-switch-repro.mjs`，
真浏览器跑官方渲染层）证明**垫片层没有问题**——空闲时或回合流式输出中切换都正常：
`switchCollaborationMode` 经桥往返成功、mode=yolo 落 localStorage（`zcode-v4-composer-drafts:v1:<ws>`
的 session scope + `zcode-model-selection-recent-v1:<ws>` 工作区默认）、后续写命令不再弹框、
刷新保持。造成体感「不管用」的是官方语义：

1. **模式按「会话 × 浏览器」记忆**，不是全局/账号级设置。每个会话各自记（composer 草稿），
   存在浏览器 localStorage，不随账号走——换设备/换浏览器回到默认「变更前确认(build)」。
   其它已存在的会话也不会跟随新选择（tasks 表里 recabyss 全部 mode=build，尽管其 session
   permission 五天前就是 yolo）。
2. **权限确认卡挂起时会取代整个输入区**：正被问的时刻模式下拉根本不可见；且切换动作若撞上
   挂起的权限请求会被回滚（复现：切成功显示完全访问 → 权限卡一出现 → 重开已回退 build）。
   卡上只有 允许(仅此一次)/始终允许本项目(**仅同一条命令**免问)/拒绝/告诉模型。
3. **正确用法**：会话空闲（无挂起确认）时点输入框旁模式下拉 → 完全访问。该会话即不再问，
   同工作区**新会话**在该设备默认继承 yolo。老会话/其它设备需各自切一次。

## 模式快车道（mode-boost，2026-09-25）

接上节：build 模式的多步任务里用户被锁死在「逐条允许」循环——2026-09-25 真浏览器实测
（3 条写命令 = 3 张卡，允许后 **2~5 秒**内下一张卡就把输入区再次替换），**模式下拉在整个回合中
几乎无窗口可点**；而 agent 侧其实即时生效（v4 `switchCollaborationMode` 处理器就是
`await app.setMode(mode)`，且**每个 tool call 权限评估实时读 `app.getMode()`**，
`mode==="yolo"` 直接放行 "Yolo mode bypasses permission prompts"）。瓶颈只在「切换意图传不到 agent」。

处置（默认开启，无需 env）：

- **`src/mode-boost.mjs`**：构造 `zcode-task` 通道的 `setMode` 调用（args 单元素数组
  `[{taskId, mode}]`，与 setTaskPinned 同通道同形状；宿主内部 `switchCollaborationModeViaProtocol`
  → v4 命令 + CAS stale 重试 → agent `app.setMode`）。附带 `scanCommandSessionId`/
  `scanTopicSessionId`（从渲染层命令 envelope / 宿主 conversation topic 帧里提取当前活跃会话，
  512KB 预筛 + 字节 indexOf，不做全量 JSON.parse）。
- **server**（`src/server.mjs`）：`writeToHost`/`routeDownstream` 记录 `activeConvSession`/
  `lastTopicSession`；新端点 `POST /api/mode-boost {mode, taskId?}`——mode 收渲染层全值域
  + 中文标签（`normalizeBoostMode`），缺省 taskId 用最近活跃会话；注入调用用独立 id 段
  （`0x60000000+`，mux pending 登记 `injected` 标记，响应回来记日志即丢，不路由给 view）。
- **桥**（`web/zcode-bridge.js`）：输入框右上角外缘的浮动面板（可整体拖动/回停靠，localStorage 记忆位置），
  内含两枚 chip：**⚡ 切完全访问**（localStorage 记忆，即本节主角）与 **♻ 自动重置**
  （quota-reset 守卫的 UI 开关，状态在服务端，见「重置机会自动使用」一节）。
  **ON** → POST `/api/mode-boost {mode:'yolo'}`（不经过官方 composer，权限卡挂起时也能点）→
  成功后立即替用户点掉挂起卡的「允许(仅允许这一次)」按钮（找按钮：innerText 规整后
  含 `允许仅允许这一次` 且不含 `始终`/`本会话`——**卡上按钮带 "1." 序号前缀**，按开头匹配会漏），
  并用 MutationObserver（350ms 节流）自动放行 ON 期间漏网的新卡（覆盖 setMode 生效前的亚秒竞态）。
  **OFF** → 把官方下拉当前显示的模式推给 agent，停止自动放行。官方下拉照常工作，
  仍是**下一个 prompt** 会话配置的权威来源；开关只是「让当前回合立即生效」的加速器。
- **注意**：自动放行仅在用户显式点开⚡后生效、点 OFF 即停，语义等同官方 yolo（无差别放行），
  日志 `[mode-boost] pushed/auto-allowed` 可审计。server 侧改动要重启服务才生效（桥部分刷新即可）。
- 自检：`node scripts/dev/mode-boost-test.mjs`（45 项离线）；重启后
  `node scripts/dev/mode-boost-verify.mjs`（真浏览器 e2e：build 任务 → 第 1 张卡挂起时点⚡ →
  断言卡自动放行、后续零卡、三文件写齐、tasks 表 mode=yolo）。

## 重置机会自动使用（quota-reset-guard，2026-09-18；口径修复 2026-09-19）

官方编程套餐偶尔发放「重置额度」机会（5 小时池 / 周额度各一种，`/api/v1/coding-plan/reset/status`
里的 `available_five_hour_resets`/`available_week_resets`，各带 `expire_at`）。本项目让宿主进程
自动**择机**使用（`src/quota-reset-guard.cjs`，host.mjs 注入 preload，与另两个 guard 并列）：

- **池数据口径（0.7.1 踩过坑，务必按这个来）**：池余量只能从
  `GET {bigmodel.cn|api.z.ai}/api/monitor/usage/quota/limit` 的 `data.limits[]` 读：
  `{type, unit, number, usage, currentValue, remaining, percentage, nextResetTime}`，其中
  **`usage` 才是窗口额度（12000 / 60000），`currentValue` 是已用，`remaining = usage - currentValue`，
  `percentage` 是已用百分比**（官方 UI 的「剩余 %」= `100 - percentage`，见渲染层 `kL()`）。
  池身份按 `type` + `unit` 匹配（`TOKENS_LIMIT|CREDIT_LIMIT` × `unit:3` = 5h，× `unit:6` = 周；
  `TIME_LIMIT` × `unit:5` 是月度 MCP 额度，任何重置机会都不补它）。**`number`（5 / 1）不是额度**：
  0.7.1 把 `remaining ÷ number` 当余量比例，于是「60000 额度只剩 2」被算成 200% 余量，
  ≤5% 触发点实际只在恰好归零时成立——也就是任务已经撞墙死掉之后（见下）。
- **策略**（原则：留到最需要、不浪费）：
  1. 有任务活跃（tasks-index 有 `running` 行，窗口 2h，与 webui reaper 的
     `ZCODE_WEBUI_RUNNING_TASK_STALE_MS` 一致）**且**对应池余量 ≤5% → 用；
  2. **耗尽硬信号**（模型调用返回 HTTP 429 + 业务码 `1310`=周/月、`1308`=5h；兼容 402）→
     对应池立即挽救，**空闲也发**（前提：该池用量 ≥30% 或池数据未知）；
  3. **池已用尽**（≈100%）且该池自然重置还在 30min（周 2h）之外、机会仍有效 → 空闲也发
     （等着什么也保不住，只会让下一轮直接失败）；
  4. 机会自身即将过期（5h≤30min / 周≤2h）**且**池用量 ≥30%（重置有实际价值）→ 挽救性使用；
  5. 池的**自然重置就在眼前**（5h≤30min / 周≤2h）→ 一律不用（马上免费回满，花了就是浪费）；
  6. 空闲、池健康、机会不过期 → 一律不用；每日上限 6 次；用后必须等 `/status` 确认才允许下一次。
- **机制**：观察运行时自己的 fetch（`/reset/status`、billing/balance、quota/limit——从中解析机会与
  池余量）；捕获运行时请求里的双 JWT 头（`Authorization` + `X-Bigmodel-Authorization` + scope 头）
  **重放**给自己发起的只读 `/status` 轮询（10min 一次）与 `/use`（uuid 幂等键，用后轮询确认）。
  凭据不落盘。子进程（agent）把「配额耗尽」写成带 scope 的信号行，宿主每 tick 收取。
- **开关（2026-09-28 改为 UI 开关，默认关）**：⚡ 浮窗里的「♻ 自动重置」chip——
  `GET/POST /api/quota-reset {mode:'on'|'off'|'dry-run'}`，server 原子写
  `<dataHome>/data/guard-stats/quota-reset-switch.json`，宿主里的守卫每 ≤10s 轮询该文件，
  **运行中即时生效，无需重启/重拉宿主**（守卫现在即使 off 也照常装载，就是为了让开关能随时唤醒它）。
  优先级：开关文件 > env `ZCODE_WEBUI_QUOTA_RESET=on|dry-run|off`（仅作无开关文件时的基线，默认 off）。
  `/api/health` → `guards.quotaReset.switch` 显示意图状态、`mode` 显示守卫实际生效模式。其余阈值 env 见文件头
  （比例/过期窗口/冷却/日上限/头最大年龄/活跃窗口/余额新鲜度/
  信号有效期 `_EXHAUSTION_SIGNAL_MS`/自然重置地板 `_NATURAL_RESET_FLOOR_*`/`_DRY_IDLE`/
  池子自主刷新 `_LIMIT_REFRESH_MS`/盲区判定 `_REVIVE_GAP_MS`/恢复宽限 `_RETURN_GRACE_MS`/决策复写 `_LOG_EVERY_MS`）。
- **实时观测**：`node scripts/dev/quota-reset-watch.mjs [pollSec]`——打印守卫全景（开关/模式/两池/机会/busy/
  决策/统计），之后每次变化打一行，并实时 tail 日志里的 quota-reset 行（含里程碑行）。撞墙现场用它盯着；
  注意本机 Node 的 `readFileSync` 忽略 `{start,end}`，脚本里是 fd 定位读，别改回 readFileSync。
- **观测**：stderr `[zcode-webui] quota-reset-guard:`（决策行带 chances / pools 已用% / busy，
  未变化的决策每 5min 复写一次 `_LOG_EVERY_MS`；池子**里程碑行**——`entering the trigger zone`（跨入 ≤5% 阈值）、
  `POOL … HIT THE WALL`（余量归零）、`refilled`（重置生效回满））；
  状态 JSON 在 `<dataHome>/data/guard-stats/quota-reset-guard.json`，`/api/health` → `guards.quotaReset`
  （机会数、两池 `usedPct/remaining/naturalResetAt`、信号时间、最近决策、当日使用次数、busy）。
- **注意**：授权头只能从运行时真实请求捕获——**界面长期不打开时头会过期**（默认 12h 窗口），
  引擎会安全停摆并在日志说明；打开一次页面即恢复。`dry-run` 先跑一段时间观察决策是否符合预期
  是安全的验证方式。自检：`node scripts/dev/quota-reset-guard-test.mjs`（82 项，全离线 mock，
  绝不触真实 API；含 09-19 线上真实 payload 与 429 撞墙回放、开关文件优先级与运行中唤醒、
  09-28 事故重放：盲区自主刷新/宽限期/busy 不受宽限）。
- **2026-09-28 事故复盘（开关后首战翻车，已修）**：用户 14:51 开启开关时 5h 池 92%，随后离开；任务把池子烧穿撞墙，
  守卫全程无动作，直到 15:20 用户回来打开页面才开火——**比用户点关闭开关还早 6 秒**，体感「点了关闭反而马上用了」。
  两个叠加原因：①池子余量只从运行时自己的 billing/quota 响应**被动观察**，UI 不开就没流量，引擎自己的刷新循环只刷
  `/reset/status`（机会数）不刷池子——离开的 29 分钟里引擎一直拿 92%/剩 920 的旧数据判「不紧急」；
  ②430 耗尽信号零捕获：agent 的模型调用走**运行时内置 undici**（与 repo-snapshot 守卫「preload 补不到」同一个问题），
  globalThis.fetch 包装根本看不到，`stats.signals` 恒 0。修复（都在 `src/quota-reset-guard.cjs`）：
  - **池子自主刷新**：`fetchLimit()` 用重放头主动 GET `quota/limit`（端点域名按部署不同，
    bigmodel.cn / api.z.ai 双候选自动发现：先试已学到的，失败换另一个，成功即记住，厂商迁移域名会自愈），
    开关开着时数据龄超过 `_LIMIT_REFRESH_MS`（默认 90s；busy 时一个 tick）就刷新——UI 不打开也能看到池子在烧穿，
    撞墙后 ≤1-2 个 tick 内就会出手；UI 开着时基本命中 api-cache-guard 的 30s 缓存，不加上游压力。off 状态不轮询。
  - **盲区恢复宽限**：数据龄超过 `_REVIVE_GAP_MS`（默认 10min）算「盲」，首次拿到新数据后 `_RETURN_GRACE_MS`
    （默认 60s）内**只挂起空闲路径**的自动重置（日志 `pool data revived after a blind gap`）——用户刚回来先拿到
    控制权；busy 触发、耗尽信号、机会临期路径不受影响。盲区判定用上一 tick 记录的 `lastTickPoolAt`
    （页面加载的被动刷新发生在两 tick 之间时，只看当前值会漏判）。
  - 信号通路维持现状（best-effort）：模型 429 走内置 undici 补不到，但池子 remaining=0 本身就是墙，靠自主刷新可见。
- **2026-09-28 二次事故复盘（宽限期误伤 deliberate 开启，已修）**：用户重启后点亮 ♻（此刻周池 99.96% 用尽、4 个机会在手），
  唤醒 tick 判 busy=false（「继续」回合的任务行还没登记）+ 宽限期把**空闲救援按住了 60 秒**（日志 `pool data revived
  after a blind gap`——把「宿主刚启动的第一瞥」误判成「用户刚回来」）；期间 agent 回合烧掉最后 23 点、15:55:20 撞墙
  报错（任务行卡在 error，恢复重试期间 busy 也读不到 running），用户 ~15:55:3x 手动重置救场（周机会 4→3）。
  修复：**宽限只在「引擎曾有数据 → 断流 >10min → 数据恢复」时触发**（`wasBlind` 要求 `lastTickPoolAt > 0`，
  第一瞥不触发）；开关 off→on 的主动唤醒由 watcher 显式清零 `lastTickPoolAt/revivedAt`——**deliberate 开启立即生效，
  宽限不得替用户「再想想」**。决策行在挂起时会标注 `[idle hold Ns — data revived after a blind gap]`。
  附带：①撞墙报错的回合恢复重试期间任务行停在 error、且 running 写入滞后回合开始约 1 分钟——busy 检测对这种回合有盲区，
  `refreshBusy` 读取失败时改为**保留上一次 busy 值**并打日志（原来吞错置 false）；②现场抓到
  `pool refresh failed: HTTP 200 (unparsed body)`——重放请求被上游以 200+非预期正文拒绝（疑 WAF/鉴权差异），
  fetchLimit 现在把失败正文前 160 字符打进日志，待下次现场确诊。
- **2026-09-19 事故复盘**：周额度撞墙（`[1310]您已达到每周/每月使用上限…2026-09-22 21:55 重置`），
  手上 1 个周机会（10-18 到期）+ 1 个 5h 机会全没用，服务停摆 3.6 天。三个叠加原因：
  ①`remaining ÷ number` 口径错 → 撞墙前池看着「200% 健康」，≤5% 规则形同虚设；
  ②耗尽信号只认 402，而厂商实际返回 429+`1310/1308` → `stats.signals` 恒为 0，挽救通道是死代码；
  ③主规则强制要求 `busy`，而额度撞墙后任务立刻变 `error`，`busy=false` 且机会还有 30 天才过期
  → 永久不动。修复即上面 2/3 两条 + 口径按 `percentage`/`usage`；`busy` 窗口同时从 10min 放到 2h
  （长回合期间索引行不会每分钟重写，10min 会把正在跑的任务判成空闲）。

## 其他约定

- 提交信息风格：`feat:` / `fix:` / `chore:` 前缀，正文写动机和要点（参考 `git log`）。
- 运行时产物（`*.log*`、`*.pid`、`config.json`、`data/`、`vendor/renderer/`）均已 gitignore，不要提交。
- 服务由 `zcode-service.sh {start|stop|restart|status|health|logs}` 管理，PID 记录在 `.service.pid`。
  该脚本可直接 `source`（`zcode-update.sh` 就是这么复用端口解析与启停函数的），被 source 时不分发子命令。
