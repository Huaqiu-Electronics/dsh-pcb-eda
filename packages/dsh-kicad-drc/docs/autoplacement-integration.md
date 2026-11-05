# 自动布局接入 `kicadDrc` 服务

面向 `@huaqiu/dsh-tool-pcb-autoplacement` 的接入说明。目标：把候选布局的 DRC 检查
从「插件内部自己直连 pcblint」改成「调用宿主服务 `kicadDrc`」。

服务契约本身见 [`../README.md`](../README.md) 的「宿主服务：`kicadDrc`」一节。
本文只讲接入怎么做、哪里会踩坑。

---

## 1. 为什么不是「改个地址就行」

现有实现（`src/placement/pcblint-client.ts`）自己发两个请求：

```
POST /api/s/upload   → 拿到 sessionToken
POST /api/s/lint-drc → 拿到违规列表
```

pcblint-local（`127.0.0.1:8096`）的端点与公网版完全一致，所以**只改 `pcblintBaseUrl`
确实能连上**。但连上 ≠ 结果可用，中间少了一步：

```
POST /api/s/upload
PUT  /api/s/dru        ← 把工程规则注入会话（缺这一步，服务端用 KiCad 默认阈值）
POST /api/s/lint-drc
```

服务端拿不到你的 `.kicad_pro`，只能按自己的默认工程判定。同一块板的实测差异：

| 场景 | 违规条数 |
|---|---|
| 不注入规则（服务端默认参数） | 1139 |
| 注入板级约束后 | 126 |
| 本地 kicad-cli | 126（与上一行逐项一致） |

差的 1013 条全是「正常的细走线被判 ERROR」。所以接入时必须把规则源传进来。

## 2. 安装与启用

| 项 | 内容 |
|---|---|
| 包名 | `@huaqiu/dsh-kicad-drc` |
| 版本 | 必须包含 `kicadDrc` 服务的版本（当前 **0.9.0**） |
| 安装形态 | 与 `@huaqiu/dsh-tool-pcb-autoplacement` **在同一 profile 的 bundles 里** |

**两个包是独立安装单位**：装上布局插件不会自动带上 DRC 插件，`cordis.patch.yml` 也只
挂载各自那一个包。缺了 DRC 插件，`ctx.get('kicadDrc')` 返回 `undefined`。

> 注意：npm registry 上 `@huaqiu/dsh-kicad-drc` 最新只到 `0.6.x`，**没有这个服务**。
> 0.9.0 目前需要本地打包安装：
>
> ```bash
> cd packages/dsh-kicad-drc
> pnpm pack:tgz                 # 产出 huaqiu-dsh-kicad-drc-0.9.0.tgz
> pnpm add file:/path/to/huaqiu-dsh-kicad-drc-0.9.0.tgz
> ```

## 3. 最小接入

```ts
// 拿服务：延迟取，不要缓存在模块顶层
const drc = ctx.get('kicadDrc') as DrcService | undefined
if (!drc) {
  // 服务没装/没启用：把候选标记为「未完成」，不要填 0
  return { status: 'drc-not-completed' }
}

const result = await drc.check({
  pcbPath: candidateBoardPath,          // 绝对路径
  ruleSources: {                        // 必传，见第 4 节
    projectFile: frozenProjectContent,  // .kicad_pro 文本
    drcFile: frozenDruContent,          // .kicad_dru 文本，有则传
    name: 'board.kicad_pro',
  },
  drcRuleOverrides: {                   // 建议显式打开要评分的内置规则，见第 5 节
    silk_edge_clearance: 'error',
    lib_footprint_issues: 'error',
  },
  mode: 'remote',                       // 建议固定；不传也默认 remote（见下）
  timeoutSeconds: 120,
  signal,
})
```

`ruleSources` / `drcRuleOverrides` 只有 remote 认，所以**给了这两个参数却没给 `mode` 时，
`check()` 默认按 `remote` 执行**（并在 `notes` 里留一条说明），不会退到 auto 去碰运气：
落到 local/ipc 时规则会被静默丢弃，调用方以为按冻结规则判了，实际是另一套口径——
这比 remote 不可用直接抛错更糟。要真的自适应选择，显式传 `mode: 'auto'`。

对应原来的调用：

```ts
// 旧：自己上传字节、自己鉴权、自己解析
const remote = await value.pcblint.check(projected.bytes, projected.fileName, signal)

// 新：只给路径和规则源
const remote = await drc.check({ pcbPath: projected.filePath, ruleSources, mode: 'remote', signal })
```

注意两点：

- **不再需要传文件内容**。候选板已经落盘（`receipt.pcbExport.filePath`），服务按路径读。
- **不再需要鉴权**。token/`huaqiuAuth` 由 DRC 插件侧处理。

## 4. 规则源从哪来

候选板是投影出来的临时文件，**同目录没有 `.kicad_pro`**，所以必须显式传。
现有证据快照里已经有：`<证据目录>/project-sources.json`，结构为

```json
{ "files": [{ "name": "board.kicad_pro", "content": "...", "status": "present" }] }
```

取 `status === 'present'` 且后缀匹配的项即可。要读冻结快照而不是重读用户工程——
评估期间用户改了规则，检查结果就对应另一份规则了。

读之前建议校验 `projectSourceCoverage.sha256`，不一致直接失败，不要用旧规则继续跑。

**没有 `.kicad_pro` 的情况**（只有单块 PCB、无工程上下文）不要静默继续：按默认参数跑出来
的是第 1 节那 1139 条，不是有效结论。至少要打一条 warn 或在结果里标记降级。

## 5. 校验开关：局部 DRC 的规则维度

pcblint 新版提供了 KiCad 内置规则的开关面板（`/api/s/drc-rules`，`key → error/warning/ignore`）。
以下几条都在**已部署的新版服务上实测过**，按实测口径写：

### 5.1 默认开什么

59 条内置规则里，默认只有 **`clearance` 是 `enabled: true`**，且 `locked: true`；其余 58 条全是
`ignore`。`clearance` 被锁是因为注入的 `.kicad_dru` 里有 `(constraint clearance …)`——自定义
DRU 规则继承该约束类型的严重级别，允许关掉会连带把 pcblint 自己的规则静默掉，所以服务端强制
`error` 并忽略对它的修改（`PUT` 返回 200 但不生效）。

`clearance` 之外的项（`silk_edge_clearance`、`lib_footprint_issues`、`courtyards_overlap`…）
默认不参与判定：即使板上真实存在违规，`violations` 里也不会有。

### 5.2 开关只对 kicad-cli 通道生效

这是最容易踩空的一条：**内置规则的判定走 kicad-cli 通道**，`kicadDrcUsed=false`（服务端
kicad-cli 跑不起来，比如 `KICAD_CLI` 指了不存在的路径）时，开关改了也没有任何效果。

实测（同一块板、同一会话）：

| 开关状态 | `enabled` 条数 | `drcRulesCount` | 违规数 | 违规来源 |
|---|---|---|---|---|
| 默认 | 1 | 6 | 15 | 全 NATIVE |
| 打开 `silk_edge_clearance` + `lib_footprint_issues` | 3 | 6 | 15 | 全 NATIVE |
| 全部 58 条非锁定项设为 `error` | 59 | 6 | 15 | 全 NATIVE |

三行完全一致——因为 `kicad-cli` 没跑，内置规则条目全部被丢弃。**先看 `complete` / `kicadDrcUsed`，
再谈开关**，否则会以为"打开了规则却没有违规"是板子干净。

### 5.3 开关是按板持久化的

服务端把 `rule_severities` 落到 `<basename>.kicad_pro`，把"用户显式打开过哪些"落到
`<basename>.pcblint-drc.json` sidecar，**跨会话保留**。所以：

- 不传 `drcRuleOverrides` ≠ 回到默认状态，而是沿用这块板上次的状态；
- 想要确定口径，**每次显式传全你要的开关**，别依赖"上次设过了"；
- 响应里的 `overrides: true` 表示这块板被显式保存过。

### 5.4 怎么用

局部 DRC（`region` 过滤坐标）+ 规则维度（`drcRuleOverrides` 过滤检查项）要一起用：

```ts
const result = await drc.check({
  pcbPath: candidateBoardPath,
  ruleSources,
  // 只打开布局评分真正计分的内置规则；其余保持服务端当前值
  drcRuleOverrides: {
    silk_edge_clearance: 'error',
    lib_footprint_issues: 'error',
    unconnected_items: 'ignore',     // 评分不看的直接关掉，少传结果也少跑检查
  },
  region: { x, y, width, height },   // 坐标维度
  mode: 'remote',
  signal,
})
```

落地状态在 `result.drcRules` 里回传：

| `drcRules.status` | 含义 | 调用方怎么处理 |
|---|---|---|
| `applied` | 本次写入了开关，`enabledKeys` 是写入后的真实集合 | 正常用 |
| `observed` | 没传开关，只读取了服务端当前状态（**每次 remote 检查都会读数**） | 用 `enabledKeys` 判断内置规则覆盖度 |
| `unsupported` | 服务端太旧，没有 `/api/s/drc-rules` 接口（404），开关没生效 | 结果按服务端当前开关集算——内置规则缺失不是"没有违规"；评分口径要记录这次降级 |
| `failed` | 读取/写入失败（网络/服务端 5xx） | 同上 |

`drcRules` 里除 `enabledCount` 外还有 `enabledKeys`（当前启用的全部 key）和 `lockedKeys`
（其中被强制锁定的）。**判断"内置规则有没有参与判定"要用这两个集合，不能用 `drcRulesCount`**：
实测把开关从 1 条改到 59 条再改回 1 条，`drcRulesCount` 始终是 6，与开关无关。

开关失败**不会中断 DRC**：它是"收窄口径"的手段，不是检查的前提。失败只体现在
`drcRules` 与 `notes` 里，`violations` 照常返回。

旧版服务（`E:\pcblint-local` 0.1.0）没有该接口，行为就是 `unsupported`；新版部署后同一份
调用不需要改代码。

### 5.5 局部 DRC 实测数据（`simple_led`，15 条违规）

| 入参 | `scope` | `counts.total` | `outsideRegion` |
|---|---|---|---|
| 不传 `region` | `full` | 15 | 0 |
| `{x: 8, y: 20, width: 27, height: 28}` | `region` | 10 | 5 |
| `{x: 0, y: 0, width: 5, height: 5}` | `region` | 0 | 15 |

条数守恒（区域内 + 区域外 = 整板），说明过滤是纯结果过滤、整板照常检查。

## 6. 失败与降级语义

| 现象 | 含义 | 调用方应该怎么处理 |
|---|---|---|
| `ctx.get('kicadDrc')` 为 `undefined` | DRC 插件没装/没启用 | 标记未完成，不要填 0 |
| `describe()` 里 `remote.available === false` | pcblint 服务没起（看 `endpoint`、`reason`） | 同上；把地址和原因写进日志 |
| `check()` 抛错 | 检查本身失败 | 标记未完成，保留错误信息 |
| 返回 `backend: 'local'` | 远端不可用，退回了本地 kicad-cli | 结果可用，但规则口径与 remote 不同 |
| `complete === false` | kicad-cli 没跑（`kicadDrcUsed=false`），或内置规则里只有被锁定的项在参与 | **不是完整 DRC 结论**，别当最终数据 |
| `drcRules.status` 为 `unsupported` / `failed` | 校验开关没写进去，结果按服务端当前开关集算 | 内置规则缺失≠没有违规；评分口径记录这次降级，见第 5 节 |
| `projectRules.status` 为 `skipped` / `failed` | 规则没进去，本次按服务端默认工程判定 | 线宽/过孔/间距类结论不可采信，见第 9 节 |
| 抛 `DrcAbortedError` | 本次是**你取消的**，不是检查失败 | 按取消处理，不要计入失败率，也不要重试 |

`projectRules`（0.9.0 起）是结构化字段，不必再去读 `notes` 文本判断规则有没有生效；
`notes` 仍然保留，给人看细节（注入了哪几条、抑制了多少条）。

结果完整性直接看 `complete`，`false` 有两种来源，都有明确证据：
`kicadDrcUsed === false`（服务端没跑 kicad-cli），或内置规则里只有被锁定的项在参与
（`drcRules.enabledKeys` 全部落在 `lockedKeys` 里，见第 5.1、5.4 节）。后端没给口径
（`kicadDrcUsed: null`、或拿不到规则开关状态）按完整处理——不完整是有证据的判定，不靠猜。

**不要用 `drcRulesCount` 判完整性**：实测把 59 条规则的开关从 1 条改到 59 条再改回 1 条，
它始终是 6，与开关和违规数都无关。

**取消**：`check()` 的 `signal` 会真正传到执行器（远程断 HTTP、本地/ipc 杀子进程）。
取消不会触发后端回退——否则取消一次会换来另一个后端再跑 13 秒。

## 7. 建议加一次探测

`describe()` 会返回各后端可用性。建议**在第一批候选开跑之前**探一次，而不是插件启动时——
Cordis 不保证 DRC 插件先加载，启动瞬间取不到服务是正常现象。

```ts
const backends = await drc.describe()          // 0.9.0 起提供
const remote = backends.find((b) => b.backend === 'remote')
if (remote && !remote.available) {
  warn(`远端不可用（${remote.endpoint}）：${remote.reason}`)
}
```

探测失败不要阻断检查，让 `check()` 去试——`describe()` 可能滞后于真实状态。

`remote.reason` 里会带 kicad-cli 的状态，但要读准：

- `kicad-cli 配置: <路径>` —— 服务端配了 runner，**只代表配置存在**，不代表能跑；
- `⚠️ kicad-cli 路径本机不存在（<路径>），结果将只有规则引擎` —— 插件在服务端跑在本机时
  顺手做了 `existsSync` 校验，看到这句基本可以断定 `kicadDrcUsed` 会是 false；
- `⚠️ 服务端未配置 kicad-cli` —— `available: false`。

服务端的 `drc-status` 里 `available: true` 只表示"配了 runner"：实测 `KICAD_CLI` 指向不存在的
路径时它照样回 `true`。所以别拿 `available` 当"能有完整结果"的依据。

## 8. 已知限制

| 限制 | 说明 |
|---|---|
| 局部检查是客户端过滤 | pcblint 服务端没有区域参数。传 `region` 后整板仍会被完整检查，只是结果按坐标过滤，用 `scope: 'region'` 和 `outsideRegion` 如实标注 |
| 每个候选都付整板成本 | 实测单次约 13.8s；3 候选并行总耗时 14.3s（服务端串行），不会 3 倍计费 |
| 网络类只注入 clearance | 网络类的 `track_width` / `via_diameter` **不注入**——注入后 KiCad 原生不把它们算作 DRC 约束，会凭空多出 31/87 条。所以宽度、孔径两项的远端结论与本地 KiCad 不等价 |
| 网络类条件按网络名写 | 服务端没有网络类概念，`A.NetClass == 'X'` 永不成立，必须展开成 `A.NetName` 列表 |
| 本地与服务端尚有少量差异 | 同一份注入规则下，本地 70 条 / 服务端 78 条 clearance 未逐条归因，判断来自服务端自有语义规则叠加 |
| 新旧服务默认口径不同 | 旧版（0.1.0，无开关面板）内置规则全跑；新版默认只启用被锁定的 `clearance`，其余 58 条 `ignore`。同一份代码对着两个版本，remote 的内置规则条数会完全不同——判断依据是 `drcRules.status` 与 `drcRules.enabledKeys`，不是服务版本号 |
| 开关受 kicad-cli 通道限制 | `kicadDrcUsed=false` 时，打开内置规则开关不会带来任何新条目（实测 1→59→1 条开关，违规恒为 15 条）。此时"打开了规则却没违规"不能当作板子干净 |
| 开关按板持久化 | 服务端把状态落到 `<basename>.kicad_pro` 与 `.pcblint-drc.json` sidecar，跨会话保留。不传 `drcRuleOverrides` 是"沿用上次"，不是"回到默认" |

## 9. 统计口径

**先看 `complete` 与 `projectRules.status`**：`complete === false`（kicad-cli 没跑，或
内置规则只剩锁定项在参与）时结果缺了 kicad-cli 那半边，先按第 6 节处理降级；`projectRules` 只有
`injected`（或 local/ipc 的 `not-applicable`）时，这次违规数才是"按本板规则"算出来的；
`skipped` / `failed` 时远端用的是一份默认工程，条数可以看趋势，不能用来判断这块板到底过没过。

结果里的 `violations` 是全量（含 warning/info）。布局评分只看：

```ts
const soft = result.violations.filter(
  (v) => v.severity === 'error' && ['HIGH', 'MEDIUM'].includes(v.confidence ?? ''),
)
```

`confidence` 只有 pcblint 后端有；`local` 后端（kicad-cli）没有这个字段，此时：
要么只统计 `severity === 'error'` 的总数，要么把本次结果标记为口径不同，不要与 remote 的
HIGH/MEDIUM 数直接横比。

另外两个跨后端比较的坑：

- **KiCad 内置规则的条目**（`clearance`、`silk_edge_clearance` 等）只在 remote 里被
  `drcRuleOverrides` 打开、且 kicad-cli 真的跑起来时才出现；local 永远全量跑。拿 remote 的这些
  key 与 local 比条数，先确认两边口径（`drcRules.enabledKeys` 里有非锁定项，且 `complete === true`）。
- pcblint 新版里 KiCad 内置规则的 `ruleId` 是 `null`，检查项 key 在 `message` 冒号前
  （`violationsFromPcblint` 已兼容，直接读归一化后的 `DrcViolation.ruleId` 即可）。
