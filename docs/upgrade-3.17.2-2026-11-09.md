# 升级到官方 3.17.2（2026-11-09）

## 起因

23:38–23:42 的宿主内存暴涨（见 `docs/memory-guard-2026-11-09.md`）发生在官方 **3.16.3** 上。
用户要求检查新版本并升级。核查结果：

- 官网最新：**3.17.2**（2026-11-03 发布）；本机线上是 3.16.3 + 3.16 运行时。
- 3.17.2 的 changelog 没有直接写「修复内存泄漏」，相关条目只有「长对话的流式回复卡顿明显减少、
  文档查看器/插件降低占用、无进展的重复执行自动结束」。外部取证（NodeLoc / 大佬说）显示
  「搜索/大工具输出把宿主吃满」是 ZCode 的**已知问题**，且「界面进程单调涨到 3.55GB」在桌面端也有报告，
  所以升级**不保证**消除该问题 —— 内存守卫与归因埋点因此仍然必要。

## 安装路径（3.16 起没有组件清单）

`zcode-update.sh` 走的是官方**分平台组件 manifest**，而 3.16+ 不再发布它
（3.17.2 的 `manifest-linux-x64.json` 仍是 404）。所以升级必须用整包安装器：

```bash
curl -fSL --http1.1 -C - -o /tmp/ZCode-3.17.2-linux-x64.deb \
  https://cdn-zcode.z.ai/zcode/electron/releases/3.17.2/linux-x64/ZCode-3.17.2-linux-x64.deb
# 206,818,476 字节；与 HEAD 的 content-length 一致才能装（CDN 偶发掐流，用 -C - 断点续传）
./scripts/install-316.sh /tmp/ZCode-3.17.2-linux-x64.deb \
  --dest ~/.zcode/server-3.17 --renderer --force
ln -sfn ~/.zcode/server-3.17 ~/.zcode/server      # 原子切换，server-3.16 保留作回滚
./zcode-service.sh restart
```

旧渲染层自动保留在 `vendor/renderer.bak-3.16.3-<ts>`，旧运行时原样留在 `~/.zcode/server-3.16`。

**回滚**（一条命令 + 一次重启）：

```bash
ln -sfn ~/.zcode/server-3.16 ~/.zcode/server
mv vendor/renderer vendor/renderer.broken-317
mv vendor/renderer.bak-3.16.3-* vendor/renderer
./zcode-service.sh restart
```

## 渲染层 API 差异（升级前预检）

对比 3.16.3 与 3.17.2 渲染层 `window.zcode.*` 的引用（3.16: 128 个，3.17: 133 个），
**只新增 5 个**：

| 方法 | 消费方行为 | 垫片处置 |
|---|---|---|
| `onBrowserViewDownloadStarted` / `onWebRemoteControlRendererAction`（另有 `browserViewLoadUrl`） | `on*` 走 Proxy 兜底（返回 unsubscribe 函数） | 无需处理 |
| `browserViewLoadUrl` | 内嵌浏览器专用，fire-and-forget | `ok()` |
| `getFileApplications` | 结果存进 `{apps: t}` 后渲染（可能 `map`） | `val([])` |
| `openFileWithApplication` | 读 `r.success`，失败时读 `r.error` | `val({success:false, error:'not supported in zcode-webui'})` |

`web/zcode-bridge.js` 已补这三个桩（客户端改动，刷新即生效）。另外两个真浏览器用例
（设置/使用统计、新建项目选文件夹）在 3.17.2 上复跑通过，未出现 error boundary / TypeError。

## 三个运行时补丁（3.16 → 3.17 锚点适配）

3.16 时代为了修掉「发消息卡 10–30 秒」打的三个运行时补丁，**在 3.17.2 上仍然需要**：
代码逻辑还在，只是压缩后的标识符变了（`XA`→`XE`、`Be`→`De`、`Jx`→`YO` 等）。
三个脚本已改成「字面量 + 结构化正则」双锚点：

- `scripts/patch-316-refresh.mjs`：`<a>.refreshRegistry&&await <a>.client.request(<b>.providerRefreshRegistry,…)`
  → 包成 1.5s 的 `Promise.race`，不再让 provider-registry 刷新阻塞发送。
- `scripts/patch-316-balance-cache.mjs`：`"evict"),<x>=1e3-(Date.now()-<y>);` → `45e3`，
  计费余额查询的去重窗口 1s → 45s（一次往返而不是四次 ×10 秒）。
- `scripts/patch-316-browser-ctx.mjs`：`async function XA|XE(e,t){…}` 的浏览器环境上下文抓取
  加 800ms 预算（无内嵌浏览器时它会一直挂到后端超时，约 30 秒）。

**事故与护栏（重要）**：第一次改造时把函数替换器写成了 `(m) => m[1] …`——`String.replace` 传给
替换函数的参数是 `(match, p1, p2, …)` 而不是数组，于是 `m[1]` 取到的是匹配串的**字符**，
把 bundle 写成了 `,"evict"),"=45e3-(Date.now()-e);` 这种非法 JS（服务当时仍能跑，因为内存里的宿主
加载的是旧内容，下一次 spawn 才会炸）。发现后从整包解出的原始 bundle 恢复（sha256 `31a0ba2d…`），
并给三个脚本都加了**写入前 `node --check` 语法门禁**（不通过直接 exit 4，不落盘）。
现在的幂等性：重跑输出 `already patched`。

## 顺带修掉的盲区

`scripts/dev/repo-snapshot-guard-status.mjs` 只认旧一代运行时 `zcode-server.cjs`；3.16 起宿主在
`app/out/host/index.js`，于是这条「官方运行时升级后必跑」的守卫自检**从 10-29 起一直打印
WARN 并跳过全部钩子检查**（等于没跑）。已改为按布局解析，同时对 `app/out/host/index.js`
识别宿主进程。3.17.2 复跑结果：`OK snapshot capture code absent from the runtime`。

## 验证记录（3.17.2 + 补丁后）

| 检查 | 结果 |
|---|---|
| `/api/health` | ok，`hostVersion 3.17.2`，`runtimeKind host16` |
| `scripts/ui-boot-check.mjs` | UI CHECK OK（startup-ready 7.7s，root 280KB，无页面错误） |
| `scripts/smoke-test.mjs` | SMOKE OK（WS + HTTP 桥往返） |
| `scripts/dev/repo-snapshot-guard-status.mjs` | 无 WARN（采集代码已从运行时不复存在） |
| `scripts/dev/pin-guard-test.mjs` | 全过 |
| `scripts/dev/mode-boost-test.mjs` | 46/46 |
| `scripts/dev/http-hardening-test.mjs` | 18/18 |
| `scripts/dev/memory-guard-test.mjs` | 24/24 |
| `scripts/dev/settings-usage-test.mjs`（真浏览器） | PASS（无 error boundary） |
| `scripts/dev/project-folder-picker-test.mjs`（真浏览器） | PASS（无 TypeError） |
| 内存守卫实时快照 | host RSS 266MB，MemAvailable 6.1GB，无 reclaim |

## 备注

- `zcode-update.sh` 的 `PINNED_VERSION` / `SHIM_MAX_SUPPORTED` 仍是 **3.15.3**：它们只约束
  「组件式自动升级」这条已经走不通的路径；3.16+ 由整包安装器负责，垫片按运行时**布局**识别两代传输。
- 三个补丁脚本的备份留在 `~/.zcode/server/app/out/host/index.js.bak-*`（每个脚本一份）。
