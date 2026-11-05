# @huaqiu/dsh-kicad-drc

DeepSeek Harness (DSH) 插件：为 AI agent 注册 `kicad_drc_run` 工具，对 `.kicad_pcb` 文件执行 KiCad DRC（设计规则检查）并返回结构化结果；Web GUI 中还会在对话轮次尾部渲染**分页报告卡片**。

## 功能

- 一次工具调用执行 `kicad-cli pcb drc --format json`，返回：
  - `drcSummary` — 错误/警告/排除数量、按类型分类计数、前 5 条示例错误、已忽略检查项
  - `drcJsonPath` — 完整报告持久化在 PCB 文件同目录（`<pcb名>_drc.json`；remote 为 `<pcb名>_drc.pcblint.json`，两种格式不互相覆盖），可直接读取
  - `verifiedBy` — 本次实际由哪个后端执行、耗时、选择原因（跨后端结果不可直接比较，必读）
  - `drcJson` — 原始 JSON，**默认不回传**（可能数百 KB），传 `includeFullJson=true` 才包含
- 三个后端 + 运行时自适应（`mode` 参数可覆盖，默认 `auto`）：
  - **local** — 本地 subprocess 直接调 kicad-cli；可执行文件多级自动探测（插件配置 → `KICAD_CLI_PATH`/`KICAD_PATH` 环境变量 → PATH → Windows 注册表 → 常见安装目录扫描 → PowerShell 全盘浅层搜索）
  - **remote** — PCB 文件 multipart 上传到 **pcblint DRC 服务**（本地单机版见 `E://pcblint-local`，生产版同源）：`POST /api/s/upload` → `POST /api/s/lint-drc`。服务端跑「语义规则引擎（`backend=NATIVE`）+ 本地 kicad-cli 原生检查（`backend=EDA_DRC`）」后合并返回；本机无需安装 KiCad，每条违规带 `confidence`（HIGH/MEDIUM/LOW）与 `ruleId`。上传后若 PCB 同目录存在 `.kicad_pro`，插件会先把其中的**板级约束**注入服务端会话的 `.kicad_dru`（`GET/PUT /api/s/dru`），避免服务端用 KiCad 默认阈值误判。传 `drcRules` 参数时还会把 **KiCad 内置规则开关**写进会话（`PUT /api/s/drc-rules`，pcblint 新版接口）：**该版本默认只启用被锁定的 `clearance`**（59 条里其余 58 条 `ignore`），要检查 `silk_edge_clearance`、`lib_footprint_issues` 等内置项必须显式打开；内置规则走 kicad-cli 通道，`kicadDrcUsed=false` 时打开开关不产生任何条目。旧版服务没有此接口（404），插件降级为不设开关并在结果里标注 `drcRules.status = 'unsupported'`
  - **ipc** — 通过 IPC 让**正在运行的 KiCad** 执行 DRC 并取回结构化结果（作用于内存中的板，含未保存修改；不产生 marker、不写盘）；结果接口 `RunDrc` 由华秋定制版 KiCad 提供，官方版没有这条命令时该后端会自动判为不可用
- auto 模式先按 `backendPriority` 分层（默认 `remote → local → ipc`），前一层不可用或执行失败才降级；同一层内才按历史耗时排序，失败自动回退，实际后端写进 `verifiedBy`
- 本地默认使用隔离的 `KICAD_CONFIG_HOME`，规避 KiCad 默认配置发现路径的开销（实测 6.1s → 1.2s）
- 同一块板（路径 + mtime + 大小）在会话内粘滞于首次成功的后端，保证多次结果可比
- `kicad_drc_backends` 工具可探测各后端可用性与预计耗时，便于有依据地指定 `mode`
- HTTP 瞬时失败自动重试一次（网络错误 / 5xx；超时中止不重试）；远程失败后 60s 冷却期内降级
- kicad-cli 懒解析：本机没装 KiCad 不会拖垮插件启动（失败结果缓存 60s，避免每次调用重跑全盘搜索）

## 工具：kicad_drc_run

| 参数 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `pcbPath` | string | ✅ | `.kicad_pcb` 文件绝对路径（必须存在于本机文件系统） |
| `mode` | string | – | `auto` / `local` / `remote` / `ipc`，默认取插件配置 `executorMode`（默认 auto） |
| `severityAll` | boolean | – | 报告所有严重级别，默认 true |
| `refillZones` | boolean | – | DRC 前重绘填充区，默认 true |
| `allTrackErrors` | boolean | – | 报告所有走线错误，默认 false |
| `drcRules` | string | – | KiCad 内置规则开关，`"key=severity,..."`（severity ∈ error/warning/ignore），仅 remote 生效；pcblint 新版默认内置规则全关，需要内置检查项时必须显式打开。非法项跳过并留日志 |
| `includeFullJson` | boolean | – | 输出中包含 drc.json 原始 JSON（可能很大），默认 false |
| `timeoutSeconds` | number | – | 超时秒数，默认 600 |

输出字段：`success`、`exitCode`、`timedOut`、`elapsedMs`、`stdout`、`stderr`、`kicadCliPath`、`command`、`verifiedBy`，以及可选的 `drcJsonPath` / `drcSummary` / `drcJson` / `viewUrl`（未生成报告时省略）、`reportComplete`（false = 结果只有规则引擎条目：kicad-cli 没跑或内置规则开关全关）、`drcRules`（传了 `drcRules` 参数才出现）。

> **`success` 语义**：表示 DRC 运行是否正常完成（KiCad 10 实测：有无违规退出码都是 0），**不代表板子没有违规**——有无违规请判断 `drcSummary.totalIssues`。

## 自适应选择与实测数据

选择顺序（见 `src/adaptive-executor.ts`）：

1. **硬约束** — 探测不可用（本机无 kicad-cli / 远程处于失败冷却）的后端直接出局
2. **优先级分层** — `backendPriority` 决定先试谁，默认 `remote → local → ipc`；前一个不可用或执行失败，才降级到下一个
3. **稳定打分** — 只在**同一层内**做次序：基础成本（local 1.5s / remote 9s）+ 上传体积惩罚 + 历史耗时；同分按固定顺序，**不随机**，保证同一块板两次调用结果可比
4. **失败回退** — 仅 auto 模式；显式指定 `mode` 时不回退，直接报错（意图明确，静默换后端会掩盖问题）
5. **同板粘滞** — 10 分钟内同一块板固定用首次成功的后端（优先于分层）

> **口径差异**：在线只上传单个 `.kicad_pcb`，工程级 DRC 规则/网络类带不过去，违规条数可能与 local/ipc 不同。跨后端比较前先看 `verifiedBy`，别直接拿两个数字相减。

实测（KiCad 10.0.6 / Windows / 405KB 板）：

| 场景 | 耗时 | 结果 |
|------|------|------|
| 本地，默认配置 | 5.8s | 3 violations + 17 unconnected |
| 本地，隔离配置 | **1.1s** | 逐字段一致（仅 `date` 不同） |
| 远程 | 8~20s | 取决于上传与排队 |

> 这 5s 差距来自 KiCad 的默认配置发现流程，而非 DRC 计算：`pcb export svg` 同样的板只要 0.6s，把 `KICAD_CONFIG_HOME` 显式指向原配置目录也只要 0.6s。隔离配置会失去用户的全局封装库表，依赖库比对的检查可能退化为默认结果——该板实测无差异，真实工程建议回归一次；可用 `isolatedConfig: false` 关闭。

## 宿主服务：`kicadDrc`（给自动布局插件用）

> 接入步骤、迁移对照与失败语义见 [`docs/autoplacement-integration.md`](docs/autoplacement-integration.md)。

除了给模型用的工具，插件还以 **Cordis 服务** `kicadDrc` 的形式暴露同一套执行能力，
供 `@huaqiu/dsh-tool-pcb-autoplacement` 在候选布局评估时调用：

```ts
// 布局插件侧
const drc = ctx.get('kicadDrc') as DrcService | undefined
const result = await drc.check({
  pcbPath: candidateBoardPath,
  ruleSources: { projectFile, drcFile, name: 'frozen-board.kicad_pro' }, // 冻结的工程规则源
  drcRuleOverrides: { silk_edge_clearance: 'error' },                     // 可选：内置规则开关
  region: { x, y, width, height },                                      // 可选：局部
  mode: 'remote',
  signal,
})
```

为什么走服务而不是工具：自动布局一次评估 3 个候选、由插件代码自动驱动，不经过模型，
调不了 `kicad_drc_run`；直接 `import` 执行器又会把两个插件在运行时绑死。

`check()` 只做三件事，不重复实现检查逻辑：

1. 交给自适应执行器跑一次（复用后端选择与回退）
2. 把 `pcblint` 与 `kicad-cli` 两种报告格式归一成同一份违规列表（`severity` 统一小写、
   `ruleId` 从 `ruleId`/`type`/`message` 前缀推导、位置统一到 `location`)
3. 按 `region` 过滤

| 请求字段 | 说明 |
|---|---|
| `pcbPath` | 候选板绝对路径 |
| `ruleSources.projectFile` | 调用方冻结的 `.kicad_pro` 内容。候选板是投影出来的临时文件，目录里没有 `.kicad_pro`，不给就会按服务端默认工程判定，线宽/过孔/间距全线误报 |
| `ruleSources.drcFile` | 工程自带的 `.kicad_dru`，追加在生成规则之后（KiCad 里后出现的规则优先，工程自定义规则据此覆盖板级默认值） |
| `drcRuleOverrides` | KiCad 内置规则开关（`key → error/warning/ignore`），对应 pcblint 新版 `/api/s/drc-rules`。**该版本默认只启用被锁定的 `clearance`**（依赖 `.kicad_dru` 的 constraint，不可关闭），其余 58 条 `ignore`——要按 `silk_edge_clearance`/`lib_footprint_issues` 等内置项评分必须显式打开；未提到的 key 保持服务端当前值。状态回传在 `drcRules`（applied / observed=仅读取未写入 / unsupported=服务端太旧 / failed），失败不中断 DRC。注意开关**按板持久化**，不传是"沿用上次"而非"回到默认" |
| `region` | 矩形区域（mm，含边界）。**服务端没有区域参数**，这里只是整板跑完再过滤，结果用 `scope: 'region'` 与 `outsideRegion` 如实标注 |
| `mode` | 默认 `auto`；但**给了 `ruleSources` 或 `drcRuleOverrides` 却没给 `mode` 时默认 `remote`**——这两个参数只有 remote 认，落到 local/ipc 会被静默丢弃。`auto` 还可能选到需要打开 KiCad 的 ipc 后端 |
| `signal` | 取消信号。取消后远程中断 HTTP、本地/ipc 杀掉子进程，并抛出 `DrcAbortedError`；**取消不会触发后端回退**（用户已经不要结果了，换后端重跑没有意义） |

返回：`backend`、`reportFormat`、`violations[]`、`counts`、`scope`、`outsideRegion`、
`unknownRegion`、`suppressedCount`、`kicadDrcUsed`、`rulesExecuted`、`projectRules`、
`drcRules`（remote 后端总是出现，`status: 'observed'` 表示只读取未写入）、`complete`、
`elapsedMs`、`reportPath`、`notes`（口径提示，原样透传执行器 stderr）。

`complete` 为 `false` 只有两类证据：`kicadDrcUsed === false`（kicad-cli 没跑），或
`drcRules.enabledKeys` 全部落在 `lockedKeys` 里（内置规则只有锁定项参与）。
**不要用 `drcRulesCount` 判**：实测开关从 1 条改到 59 条再改回 1 条，它始终是 6。

`projectRules` 是结果可信度的判据（别只看 `notes` 里那句话）：

| `projectRules.status` | 含义 |
|---|---|
| `injected` | 已按工程板级约束检查；`applied` 为注入条数，`skipped` 列出未注入项，`druMerged` 表示工程 `.kicad_dru` 已合并 |
| `skipped` | 规则源里没有可注入的约束，本次按服务端默认工程判定 |
| `failed` | 规则注入失败（接口报错、JSON 坏），本次按服务端默认工程判定 |
| `not-applicable` | local/ipc 后端：kicad-cli 直接读工程目录，不存在注入这一步 |

后两种（`skipped` / `failed`）意味着线宽、过孔、间距类结论用的是服务端默认值，不能直接采信。

没有坐标的违规在区域过滤时**保留并计入 `unknownRegion`**，避免局部检查静默漏报。

## 工具：kicad_drc_backends

无参数，返回 `backends[]`：`backend` / `available` / `endpoint` / `estimatedMs` / `reason`。不执行 DRC、无副作用。一般无需先调用——留着是为了让 AI 在需要固定环境时能先看清能力边界。

## kicad-ipc 后端（`mode: 'ipc'`）

直接让运行中的 KiCad 跑 DRC：板子已在内存里，不用重新解析、不用存盘，也自动沿用当前工程规则——理论上是最快的一条路。

**前置条件**（缺一不可，`kicad_drc_backends` 会逐条报出缺哪个）：

1. KiCad 正在运行，且在 **Preferences → Plugins** 勾选 **启用 KiCad API**（写入 `kicad_common.json` 的 `api.enable_server`）；
2. **KiCad 里已经打开了目标 PCB** —— 只有工程管理器窗口时，`GetOpenDocuments` 会返回 `no handler available`；
3. `ipcPythonPath` 指向的 Python 能 `import kipy`（KiCad 自带解释器已内置）；
4. 服务端是**华秋定制版 KiCad**，提供了 `kiapi.board.commands.RunDrc`（官方版没有这条命令）。

**能力边界**：

| 能力 | 官方 10.0.6 | 华秋定制版 |
|---|---|---|
| 连接 / `ping` / `GetVersion` / `GetOpenDocuments` | ✅ | ✅ |
| 执行 DRC 并取回结构化结果（`RunDrc`） | ❌ `no handler available` | ✅ |
| 读取 DRC marker | ❌ | ❌（不需要，结果直接从 `RunDrcResponse` 来） |

探测阶段用一个**空的 `DocumentSpecifier`** 发一次 `RunDrc`：定制版会先校验文档、回 `the requested document is not open`，官方版则根本没有 handler、回 `no handler available`。据此判定能力，不跑真 DRC、无副作用。

判定失败时 `probe()` 直接返回不可用（原因写进 `reason`，60s 冷却），于是 `auto` 自动退化成 local/remote 二选一。目标板与 KiCad 当前打开的板不一致时直接报错，绝不把别的板结果当答案。

### 更新 IPC 协议（`board/drc_commands.proto` 改动后）

脚本不依赖预生成的 `*_pb2.py`：它把该 proto 的 `FileDescriptorProto` 在运行时注册进默认 descriptor pool，再用 `message_factory` 取消息类。所以改了 proto 只需重新导出那段 base64（`src/kicad-ipc-executor.ts` 的 `DRC_DESCRIPTOR_B64`）：

```bash
# 1. 生成含依赖的 descriptor set
python -m grpc_tools.protoc -I api/proto \
  --descriptor_set_out=/tmp/drc.desc --include_imports board/drc_commands.proto

# 2. 只取 drc_commands.proto 这一个文件（依赖由 kipy 导入时已注册），转 base64
python - <<'EOF'
import base64
from google.protobuf import descriptor_pb2
fds = descriptor_pb2.FileDescriptorSet()
fds.ParseFromString(open('/tmp/drc.desc', 'rb').read())
target = next(f for f in fds.file if f.name == 'board/drc_commands.proto')
print(base64.b64encode(target.SerializeToString()).decode())
EOF
```

约束：**不要**复用 `kiapi.board.commands` 里已存在的符号名。`DrcSeverity` 已被官方 `board_commands.proto`（`InjectDrcError`）占用，所以本仓库的枚举叫 `DrcViolationSeverity` / `DRCVS_*`；撞名会让两个文件无法同时加载。

## Web GUI 报告卡片

DRC 成功生成报告后，工具输出会附带一个 `viewUrl`（形如 `/drc-report/api/report?key=…`）。Web GUI 的浏览器半边（`lib/client.js`，经 `exports["./client"]` + `dsh.client` 声明加载）会：

1. 遍历会话树，把每轮 `kicad_drc_run` 成功的结果索引到对应 turn；
2. 在该轮对话尾部渲染一张报告卡片：错误/警告计数、级别筛选（全部 / 错误 / 警告）、**分页表格**（每页 10 行：序号 / 级别 / 类型 / 描述 / 坐标）；
3. 表格数据经 `viewUrl` 从 host 端 `/drc-report` 路由拉取（仅信任 localhost 来源），报告全文不进会话上下文。

兼容 KiCad 旧版（按检查类型分顶层数组）与 KiCad 10（统一 `violations` 数组，坐标在 `items[0].pos`）两种报告格式。headless / 无 webServer 环境下自动降级：不注册路由、输出省略 `viewUrl`，工具功能不受影响。

## 插件配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `executorMode` | `auto` | 默认执行模式：`auto` / `local` / `remote` / `ipc`（非 auto 时不再自动回退） |
| `backendPriority` | `['remote','local','ipc']` | auto 模式下的后端优先顺序（越靠前越优先）；前一个不可用或执行失败才降级到下一个。内网离线环境可改成 `['local','ipc','remote']` |
| `kicadCliPath` | `''` | local 后端：kicad-cli 绝对路径，留空自动探测 |
| `isolatedConfig` | `true` | local 后端：使用隔离的 `KICAD_CONFIG_HOME`（实测省约 5s；关闭后用用户默认配置，库比对类检查更完整） |
| `ipcPythonPath` | `''` | kicad-ipc 后端使用的 Python 解释器（需装 `kipy`）；留空读 `DSH_KICAD_DRC_PYTHON`，再兜底 `python3`。与 `dsh-kicad` 的 `DSH_KICAD_PYTHON` **刻意分开**：两个插件可能部署在不同机器、对着不同 KiCad 版本 |
| `pcblintBaseUrl` | `http://127.0.0.1:8096` | remote 后端：pcblint 服务地址（端口以 `E://pcblint-local//start.bat` 启动时打印的为准，参考 `runtime/pcblint.port`） |
| `pcblintToken` | `""` | remote 后端：`x-token` 鉴权令牌。生产环境必填；本地部署开了 `pcblint.auth.local-bypass` 时留空即可 |
| `defaultTimeoutSeconds` | `600` | DRC 默认超时秒数 |

> 用户已显式设置 `KICAD_CONFIG_HOME` 环境变量时，插件不会覆盖它。隔离目录位于 `<系统临时目录>/dsh-kicad-drc/kicad-config`。

## 开发

```bash
pnpm install        # 安装依赖
pnpm run typecheck  # 类型检查（tsc --noEmit，含 src/client React 代码）
pnpm test           # 单元测试（node:test，零额外依赖；129 用例）
pnpm run build      # tsdown 双入口编译 → lib/index.js（host ESM）+ lib/client.js（浏览器 CJS factory）
pnpm pack           # 打包 tgz（prepack 自动触发 build）
```

client bundle 是 `window.__ModuleLoader__.load({id, factory})` 包装的 CJS（与 `@huaqiu/dsh-tool-pcb-viewer` 同机制）；`react` / `react/jsx-runtime` 不打进 bundle，运行时从 DSH 模块表 require。

## 已知限制

- 隔离配置会失去用户的全局封装库表，依赖库比对的 DRC 检查可能退化为默认结果（`isolatedConfig: false` 可关）
- 三个后端的结果**不可直接比较**：remote 会把同目录 `.kicad_pro` 的板级约束与网络类间距注入会话规则文件，但其余规则（`min_silk_clearance`、`min_text_*` 等）仍按服务端默认；比较两次 DRC 前先看 `verifiedBy` 与 `reportFormat`
- remote 的报告是 **pcblint 格式**（`reportFormat: 'pcblint'`）：顶层 `violations`、`severity` 大写、带 `confidence`/`ruleId`/`backend`；local/ipc 是 kicad-cli 原生格式（`reportFormat: 'kicad-cli'`）。摘要与卡片对两种格式都能解析，但两边的违规数不能互相加减
- remote 依赖外部 pcblint 服务，两类情况都会让结果缺掉 kicad-cli 那半边：① 服务没起或没配 `KICAD_CLI`（`kicadDrcUsed=false`）；② 内置规则只剩被锁定的 `clearance` 在参与（默认状态，其余 58 条 `ignore`）。此时工具输出会置 `reportComplete=false`、摘要第一行给出警示、`verifiedBy.reasons` 留一条说明（服务层对应 `complete: false`），别当成完整 DRC 结论；要内置项用 `drcRules` 参数显式打开。**`kicadDrcUsed=false` 时打开开关也不会有新条目**——开关走 kicad-cli 通道
- `--refill-zones` 已在 KiCad 10.0 实测**不会写回原 .kicad_pcb 文件**（仅内存重绘用于检查），但其他版本行为未逐一验证；remote 后端由服务端决定是否重绘，该参数不生效
- 工程规则注入覆盖 `design_settings.rules` 里的 8 类板级约束：`clearance`、`track_width`、`via_diameter`、`annular_width`、`hole_size`、`hole_clearance`、`hole_to_hole`、`edge_clearance`，以及**网络类的 clearance**（见下条）。`min_silk_clearance` / `min_text_*` / `min_microvia_*` **故意不注入**：实测注入 `silk_clearance` 会让 silk 违规从 13 涨到 199（本地引擎读同一工程只有 126），属于语义不一致导致的凭空放大；注入结果会写进 `stderr`（`工程规则已注入…`）与 `stdout.projectRules`
- 网络类只注入 `clearance`，且条件按**网络名**写：远端 pcblint 用它自己那份默认工程跑检查，那里没有本工程的网络类，`A.NetClass == 'Power'` 永远不成立（实测注入后仍是 126 条，本地原生是 720）。改为按 `netclass_patterns` / `netclass_assignments` 把类成员解析成具体网络、再用 `A.NetName == '…' || B.NetName == '…'` 表达，实测与原生 netclass 逐项一致（720 条 / clearance 499）。网络类的 `track_width` / `via_diameter` **不注入**：KiCad 原生不把它们当 DRC 约束，注入后会凭空多出 31 / 87 条
- 注入失败（没有 `.kicad_pro`、JSON 损坏、接口不可用）不会中断 DRC，只会在 `stderr` 标注"按服务端默认工程判定"——此时线宽/过孔/间距类结果可能与本地不同
- 并发对同一块 PCB 跑 DRC 会互相覆盖 `<pcb名>_drc.json`
- kicad-cli 的 stdout 按 UTF-8 解码，中文 Windows 下摘要行可能乱码（不影响 JSON 报告）
- dsh-tools 的类型声明引用了未声明为依赖的 `@deepseek-ai/dsh-llm` 等包，pnpm 布局下部分类型退化为 `any`（靠 `skipLibCheck` 掩盖）；工具名因此用本仓库的 `TOOL_NAME` 常量而非 `tool.name`

## License

MIT
