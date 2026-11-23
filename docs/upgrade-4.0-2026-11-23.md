# ZCode 4.0.0 适配与升级（2026-11-23）

## 结论

ZCode 4.0.0 **无需新的协议/通道适配**即可跑在现有垫片上：官方运行时仍是 3.16 起的
bundled-host 布局（`app/out/host/index.js`，host16 transport），3.18 引入的
credential-cipher 桥、3.12 起的 service-port/database-startup 握手都继续有效。
本轮只补了 4.0 渲染层新增的 4 个 `window.zcode.*` API 的显式桩，并把三个 3.16+ 运行时
补丁重新打到 4.0 bundle 上（锚点全部命中）。

- 官方包：`https://cdn-zcode.z.ai/zcode/electron/releases/4.0.0/linux-x64/ZCode-4.0.0-linux-x64.deb`
  - 大小 211,248,136 B；sha512(base64) `rl0Q2ZO0W9gxf7oi7PjAgyBw+3ivnVYzXF9VdBWAs2Ie7KtzNLV6yv3wJkz/fvr35TWOFUr2wLodUS/PqxfhBA==`
  - build-meta：`appVersion 4.0.0`、commit `3bc8a247`、buildTime `2026-11-22T11:30:02.578Z`
- 运行时安装：`scripts/install-316.sh <deb> --dest ~/.zcode/server-4.0 --force`
- 渲染层暂存：`~/.zcode/renderer-4.0.0`（从 `~/.zcode/server-4.0/app/out/renderer` 复制，`.version=4.0.0`）

## 沙箱验证（隔离端口 3199，未触碰生产）

沙箱：`~/.zcode/sandbox-4.0`，`HOME=$SB/home`、`ZCODE_HOME=$SB/zcode`、
`ZCODE_WEBUI_HOME=$SB/data`、`ZCODE_SERVER_RUNTIME_ROOT=$SB/zcode/server`；
生产 `~/.zcode/v2` 只读复制（排除 quarantine/checkpoints）。因为沙箱 HOME 变了，
credential-cipher 的 fallback key 会不同，显式设
`ZCODE_CREDENTIAL_SECRET=zcode-credential-fallback:linux:/home/coder:coder` 才能读生产凭据。

| 检查 | 结果 |
| --- | --- |
| `scripts/smoke-test.mjs`（WS/HTTP 协议桥） | SMOKE OK，hostVersion 4.0.0 |
| `scripts/ui-boot-check.mjs` | PASS：startup-ready 4.0s、root≈300KB、composer=1、无页面错误 |
| `scripts/dev/settings-usage-test.mjs` | PASS：设置页 / 使用统计无 error boundary |
| 真实回合（GLM-5.4） | 任务 `sess_51af9e52…`；上游 5 次 529 `[1305] 该模型当前访问量过大` 后自动重试成功，`model.request.completed` + `turn.completed` |
| `window.zcode.*` 面 | 3.17.2 133 → 3.18.2 142 → 4.0.0 146；新增 4 个（见下） |
| 三个运行时补丁 dry-run | refresh / balance-cache / browser-ctx 锚点全部命中，已应用且幂等 |
| 守卫 preload | repo-snapshot / api-cache / quota-reset 均 armed |
| 4.0 bundle 的快照采集代码 | `repoSnapshot`/`captureBeforePrompt`/`upload-credential`/`repo-snapshot.tar.gz.enc` 均 0 处 → 守卫无钩子可打，属正常 |
| 离线回归（pin/mode/repo-snapshot/credential/api-cache/quota/memory/proc-reaper） | 全过 |

### 4.0 渲染层新增 API（已补显式桩）

`getPreinstalledToolsState`、`executePreinstalledToolsCommand`、`onPreinstalledToolsState`、
`setReplyLanguage`。

Proxy 兜底会给未知方法 `Promise.resolve(undefined)`：`getPreinstalledToolsState` 的结果会被
`r.tools.map(...)` 读取，undefined 会让设置页的「预装工具」区停在 loading；`execute…` 则
看起来成功但什么也没做。`web/zcode-bridge.js` 现在返回 `{autoInstallEnabled:false, tools:[]}`，
并让 `executePreinstalledToolsCommand` 明确 reject（UI 显示命令失败），
`setReplyLanguage` / `onPreinstalledToolsState` 为 no-op / unsub。

## 生产切换步骤

1. 确认空闲：`node scripts/dev/activity-check.mjs` 返回 `active:false`（本机任务
   `sess_1e2adc92…` 已 `interrupted`，只剩 CLI DB 的 10 分钟 busy 窗口）。
2. 备份凭据：`cp -a ~/.zcode/v2/credentials.json ~/.zcode/v2/credentials.json.bak-manual-4.0-<ts>`
   （host16 首次启动还会自动留 `.bak-pre318`；4.0 会把 `enc:v1:` 迁移成 `enc:v2:env:`）。
3. 换渲染层：`mv vendor/renderer vendor/renderer.bak-3.17.2-<ts> && cp -a ~/.zcode/renderer-4.0.0 vendor/renderer`
4. 换运行时：`ln -sfn ~/.zcode/server-4.0 ~/.zcode/server`（原指向 `server-3.17`）。
5. `./zcode-service.sh restart`；`/api/health` 应显示 `hostVersion:4.0.0`。
6. 复验：`smoke-test`、`ui-boot-check`、`repo-snapshot-guard-status.mjs`、
   `settings-usage-test.mjs`，并打开页面确认任务列表/模型选择正常。

### 执行结果（2026-11-23 14:33）

- 切换时间 `2026-11-23 14:33:34`；渲染层备份 `vendor/renderer.bak-3.17.2-20261123-143334`；
  凭据备份 `~/.zcode/v2/credentials.json.bak-manual-4.0-20261123-143334`（host 另留了
  `.bak-pre318`）。
- `/api/health`：`hostVersion 4.0.0`、`runtimeKind host16`、`login.loggedIn true`；
  `~/.zcode/server -> ~/.zcode/server-4.0`，`vendor/renderer/.version = 4.0.0`。
- `smoke-test` SMOKE OK（host pid 731192，hostVersion 4.0.0）。
- `ui-boot-check` PASS：startup-ready 3.9s、root 291,737B、composer=1、无页面错误。
- `settings-usage-test`（生产）PASS：设置页 / 使用统计无 error boundary。
- `repo-snapshot-guard-status.mjs` 全 OK：4.0 bundle 无快照采集代码、宿主已加载 preload、
  守卫已 armed、无 arming 之后的新 checkpoint 产物。
- 打开一条历史会话能正常渲染历史消息（旧会话仍显示 GLM-5.3）。
- 已知无害噪声：打开会话时浏览器会对 `/material-icons/text.svg` 报一次 404——4.0 官方包
  `material-icons/` 里本来就没有这个图标（与垫片无关），只影响一个图标，不挡任何操作。

> 4.0 起 `/proc/<pid>/cmdline` 被宿主改写成进程标题 `zcode-host`，
> `repo-snapshot-guard-status.mjs` 的宿主定位已补 `comm === 'zcode-host'`；
> 新日志轮转后「armed」行没有时间戳前缀，脚本改用首条带时间戳的 host 行近似，
> 否则升级校验会误报 WARN（本次已修）。

### 备份清理（2026-11-23）

生产稳定后按「只留当前版 + 上一版」清理了更早的升级备份：

- 删除渲染层：`renderer.bak-3.12.3-*`、`renderer.bak-3.14.3-*`、`renderer.bak-3.15.3-*`、
  `renderer.bak-3.16.3-*`
- 删除运行时：`~/.zcode/server-3.15`、`~/.zcode/server-3.16`、`~/.zcode/server.bak-3.14.3-*`
- 保留：当前 4.0.0，以及回滚用的 `vendor/renderer.bak-3.17.2-20261123-143334` 与
  `~/.zcode/server-3.17`；`server-3.18` / `renderer-3.18.2` 作为兼容性参考未动。
- 共释放约 1.1GB；README / AGENTS 的备份策略同步为「当前版 + 上一版」。
- 本项目 v0.10.0 已提交并推送到 GitHub，并已发布到 npm
  （`@aixyzstudio/zcode-webui@0.10.0`，2026-11-23）。

## 回滚

```bash
ln -sfn /home/coder/.zcode/server-3.17 /home/coder/.zcode/server
mv vendor/renderer vendor/renderer.failed-4.0.0-$(date +%s)
mv vendor/renderer.bak-3.17.2-<ts> vendor/renderer
# 若凭据已被迁移成 enc:v2 且要退回 3.17：
cp -a ~/.zcode/v2/credentials.json.bak-pre318 ~/.zcode/v2/credentials.json
./zcode-service.sh restart
```

## 备注

- 4.0 默认选中 GLM-5.4；发布当天该模型频繁返回 529 `[1305] 当前访问量过大`，运行时会在
  11 次内退避重试，通常几十秒后成功。若不想等，可在模型下拉里选 GLM-5.3。
- `zcode-update.sh` 的组件式自动升级仍只覆盖到 3.15.3；3.16+ 继续走
  `scripts/install-316.sh` 整包路径（本页步骤）。`PINNED_VERSION`/`SHIM_MAX_SUPPORTED`
  保持 3.15.3 是刻意为之，避免组件路径被误用于 host16。
