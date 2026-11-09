# 宿主内存暴涨 / 内存守卫（2026-11-09）

## 事故

23:38–23:42（本地时间），`zcode-host`（官方 3.16.3 utility host，pid 1682346）在 10 分钟内从
**402MB 涨到 3.75GB 匿名内存**：`process.memoryUsage().external` = 2.67GB（Buffer/ArrayBuffer 池），
JS 堆只有 ~340MB。本机 15.8GB 内存 + 10GB swap 双双打满（swap 剩 260KB），整机进入换页抖动：

- `/api/health` 响应 **11.2 秒**（正常 8ms），页面入口 19 秒，`/__zcode_webui/zcode-bridge.js` 直接超时；
- server 主线程卡在 `folio_wait_bit_common`（等页 I/O），`ps` 状态 `D`；
- `[mux] reaped 30 pending call(s) with no response in 600s`，30+ 个 `resyncControllerV4` 挂住；
- 当时 recabyss 的文学评审任务正跑 3 个子代理，`agent.pendingPermissions=6`。

外部实证这属于 ZCode 已知的内存撑爆模式（无边界递归搜索/超大工具输出把宿主进程吃满），
不是本垫片引入的：

- <https://www.nodeloc.com/t/topic/104751> — ZCode 的 ugrep 搜索把内存撑爆导致死机
- <https://www.locdd.com/t/topic/91052> — 桌面端界面进程内存单调涨到 3.55GB 必崩

处置：先 `kill -TERM` 掉 3.7GB 的宿主（内存立刻释放、健康检查回到 7.8ms），再
`./zcode-service.sh restart` 完整重启。**没有任何东西看护宿主内存**：reaper 只回收「空闲」，
内核 OOM killer 要等整机已经卡死才动手——这是本轮补上的缺口。

## 1. 归因埋点（host 侧 preload）

`src/memory-attribution-guard.cjs`，由 `src/host.mjs` 的**两个** env builder（`buildHostEnv` 与
`buildHost16Env`）注入，随 `NODE_OPTIONS` 覆盖宿主及其子进程。

- 只对 **≥1MB** 的 `Buffer.alloc/allocUnsafe/allocUnsafeSlow/from/concat` 记账（按调用栈归因，
  60s 滚动窗口），小分配零记账——稳态开销可以忽略；
- 每 15s 采样 `process.memoryUsage()`；`external` 增量 ≥192MB（或窗口内记账量 ≥192MB）时输出
  一份报告到 stderr：
  - 内存数字（rss / heapUsed / heapTotal / external / arrayBuffers）；
  - 窗口内 top 分配点（调用栈，最多 8 条）；
  - `process._getActiveHandles()` 的积压字节摘要（`writableLength`/`bufferSize`）——用来区分
    「大 Buffer 泄漏」与「管道/流积压（下游不读）」两种形态；没有大 Buffer 记账时会明确打出
    「no tracked Buffer … growth is likely small-buffer/stream queueing」。
- 报告节流 60s；日志前缀 `[host16:stderr] [zcode-webui] mem-attribution:`。
- 开关：`ZCODE_WEBUI_MEM_ATTR=0` 关闭（默认开）；
  `ZCODE_WEBUI_MEM_ATTR_MIN_MB`(1) / `_INTERVAL_MS`(15000) / `_SPIKE_MB`(192) /
  `_REPORT_MS`(60000) / `_VERBOSE=1`（每次采样都打）。

## 2. 内存守卫（server 侧）

`src/memory-guard.mjs` + `src/server.mjs` 的 15s tick。只读 `/proc/<pid>/status` 的 `VmRSS` 与
`/proc/meminfo`（每个 host 一次读），请求路径零成本。

阈值**按宿主机内存总量成比例**计算（`resolveMemoryThresholds()`，每次采样用 `/proc/meminfo`
的 MemTotal / SwapTotal 现算），绝对值只作为小内存机器的兜底下限，不再写死 MB：

| 量 | 比例 | 兜底下限 | 本机（15480MB RAM + 10240MB swap） |
|---|---|---|---|
| warn（只记日志） | RAM 的 6% | 768MB | 929MB |
| kill（算「大户」） | RAM 的 8% | 768MB | 1238MB |
| hard（单宿主离谱） | RAM 的 20% | 2048MB | 3096MB |
| minAvail（可用余量下限） | RAM+swap 的 10% | 512MB | 2572MB |
| softAvail（紧张但未死） | RAM+swap 的 18% | 1024MB | 4630MB |

- **warn**（只记日志，永不杀）：单 host RSS ≥ warn，`WARN_REPEAT_MS`(300000) 复写；
- **reclaim**（回收宿主，二选一）：
  1. 可用内存（`MemAvailable + SwapFree`）≤ minAvail **且** 最大 host RSS ≥ kill；或
  2. 单个 host RSS ≥ hard **且** 可用内存 < softAvail。
  一次只回收**最大**的那台，冷却 `COOLDOWN_MS`(300000)。`/proc/meminfo` 读不到时 fail-safe 只 warn。
- 回收走既有的 `terminateSession`（摘 view + SIGTERM，3s 后 SIGKILL），**不动会话历史**；
  下一次页面连接自动起一个新宿主（页面可能整页刷新重建——整机可用的优先级更高）。
- 日志 `[mem-guard] WARN …` / `[mem-guard] RECLAIM …`；`/api/health` → `guards.memory`
  （比例策略、**本机算出来的实际阈值**、机器总量/可用/百分比、各 host RSS、最近决策、累计 reclaims）。
  session 新增 `spawnedAt` 供日志。
- 开关：`ZCODE_WEBUI_MEM_GUARD=0` 关闭。比例可用 `ZCODE_WEBUI_MEM_GUARD_{AVAIL,SOFT_AVAIL,WARN_RSS,KILL_RSS,HARD_RSS}_PCT`
  调整；`ZCODE_WEBUI_MEM_GUARD_*_MB`（旧名）仍可显式钉死某一项绝对值，优先级高于比例。

> 为什么按比例而不是固定值：同一份阈值在 64GB 机器上等于「永远不触发」，在 8GB 机器上等于
> 「动不动就杀」。按总量留 10%~18% 余量，小机器再压兜底下限，才既保护整机又不误杀。
> 本机常态 host 只有 250–400MB，so 1.2GB 的 kill 线已经意味着「明显异常」。

## 3. 自检

`node scripts/dev/memory-guard-test.mjs`（24 项，全离线）：

- 决策矩阵：健康/警告/紧急/硬上限/冷却/最大 host 选择/meminfo 不可读 fail-safe；
- 守卫实例：注入 readers 的 tick、snapshot 形状、禁用开关；
- procfs 读取：`MemAvailable`、活/死 pid 的 `VmRSS`、`collectHostPids` 去重与跳过已退出；
- 归因 preload：大 Buffer 出报告并带分配点、小分配静默、`ZCODE_WEBUI_MEM_ATTR=0` 失效、
  Buffer 语义（alloc/from/concat/allocUnsafe/isBuffer）不被破坏。

服务端与 preload 改动都需**重启服务**生效。
