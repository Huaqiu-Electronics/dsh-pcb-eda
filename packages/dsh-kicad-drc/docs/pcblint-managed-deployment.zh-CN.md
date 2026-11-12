# PCBLint 本地服务托管部署实施文档

日期：2026-11-10。状态：已实施（阶段 1–4）。适用仓库：`E:\dsh-pcb-eda\packages\dsh-kicad-drc`。

## 1. 目标与边界

把 `E:\pcblint-local` 从“用户手工双击 `start.bat`”改成“随 KiCad 安装、由 DRC 插件按需唤起、用完关闭”。参考实现是本机已落地的 FreeRouting 托管方式（`E:\dsh-tool-freerouting\src\proxy\runtime\`）。

必须满足：

1. `pcblint-local` 与 `freerouting.exe` 一样随 KiCad 安装包分发，用户不额外装 Java、不手工起服务。
2. 只有 DRC 插件真正执行检查时才启动服务；任务结束、插件卸载或宿主退出后服务必须退出，不留下常驻 JVM。
3. 没有孤儿进程：Java 及其派生的 `kicad-cli` 在停止后都不存在。
4. 不写入 KiCad 安装目录（`Program Files` 对普通用户只读），运行时数据放到用户可写目录。
5. 保留现有“可连接外部固定服务”的能力，且绝不结束不是自己启动的进程。

不在本次范围：修改 `pcblint.jar` 业务逻辑；生产环境 Nacos/MySQL 部署；单文件 exe 打包（见 9.2 决策点）。

### 1.1 对原始需求的校正

原始需求的三点方向都成立，但落地时有三个容易走偏的地方，先统一口径：

| 原始表述 | 校正 |
| --- | --- |
| “和 `freerouting.exe` 一样打包进 KiCad” | 相同的是**分发渠道**（随 KiCad 安装包到达用户机器），不是文件形态。`freerouting.exe` 是内嵌运行时的单文件包装；`pcblint-local` 首期是“jar + jre25 + 数据目录”。为了形态一致先做单文件包装属于本末倒置，见 9.2 |
| “运行时唤起服务” | 准确说是“**执行 DRC 检查时**”。插件加载、卡片渲染、`describe()` 探活都不启动 JVM，否则每开一次 DSH 就多一个常驻进程 |
| “用完关闭，防止内存泄露” | 关闭进程是回收内存最可靠的方式，但“每次用完立即杀”会让连续检查（改一版→再查一次）每次多等 8–15 秒冷启动。策略改为引用计数 + 空闲关闭，见 5.2、5.4。另外真正的泄漏风险在插件侧的计时器、子进程与日志流，不在 JVM 本身 |

还有一条硬约束容易被忽略：KiCad 安装在 `Program Files`，普通用户不可写。jar 可以放在安装目录，H2、日志、预览产物必须放用户可写目录（本仓库约定为 `HQ_EDGE_HOME` / `~/.hq-edge`），否则“打包进 KiCad”后第一次启动就会失败。

另外，“把 `pcblint-local` 放进 KiCad 安装包”需要修改 KiCad 的打包流水线（本仓库之外），本插件仓库只能约定目录结构并消费它。这条交付链路要单独确认负责人，见 4.1。

## 2. 现状

| 位置 | 现状 | 问题 |
| --- | --- | --- |
| `E:\pcblint-local\start.bat` | 手工启动；`set /a` 扫描 8096 起空闲端口；写 `runtime/pcblint.port`；轮询 `/api/s/health` | 需要用户操作；常驻内存；数据写在安装目录 |
| `src/remote-executor.ts` | 构造时固定 `baseUrl`，直接请求 `/api/s/upload` + `/api/s/lint-drc` | 不负责服务生命周期 |
| `src/pcblint-client.ts` | 固定 `baseUrl` 的 HTTP 客户端 | 端口变化后无法跟随 |
| `src/config.ts` / `src/index.ts` | `pcblintBaseUrl` 默认 `http://127.0.0.1:8096` | 默认值暗示“服务已在跑”，与按需启动冲突 |

现状下 `remote` 后端在服务未启动时只是健康检查失败并降级到 `local`，用户不会得到 pcblint 的语义规则结果。

## 3. 与 FreeRouting 的对应关系

| FreeRouting 做法 | PCBLint 对应做法 |
| --- | --- |
| `freerouting.exe`（单文件，内含 app image + runtime） | `pcblint-local\`（`pcblint\pcblint.jar` + `jre25\`），首期保持目录形态 |
| 位置：KiCad `bin\freerouting.exe` | 位置：KiCad `bin\pcblint-local\` |
| 定位：`DSH_FREEROUTING_EXE` → KiCad python 同目录 | 定位：`pcblintHome` 配置 → `DSH_PCBLINT_HOME` → `dirname(kicad-cli)\pcblint-local` |
| 临时 `--user_data_path` 隔离 | `HQ_EDGE_HOME`（默认 `~/.hq-edge`）下的 `plugin-data/dsh-kicad-drc/pcblint` 数据根（持久，含 H2） |
| 随机回环端口 + `/api/v1/system/status` 探活 | 随机回环端口 + `/api/s/health` 探活 |
| 启动参数写 `freerouting.json` | 启动参数用 `-D` 系统属性 |
| Job Object / 远程句柄托管 | Node `spawn` + 记录 PID + `taskkill /PID <pid> /T /F` |
| 全局单任务、结束即停 | 单实例 + 引用计数 + 空闲超时停止 |

## 4. 安装与数据布局

### 4.1 安装目录（由 KiCad 安装包写入）

```text
C:\Program Files\KiCad\10.0\bin\
  kicad-cli.exe
  freerouting.exe
  pcblint-local\
    pcblint\pcblint.jar
    pcblint\version.txt          # 新增：安装包写入的版本号，用于和 /api/s/health 对账
    jre25\bin\java.exe
    # 不再包含 runtime\，运行期数据不写这里
```

安装包要求：

- 复制整个 `pcblint-local` 目录，排除 `runtime\`、`*.pid`、`*.port`。
- 升级时整目录替换；不删除用户数据目录。
- 保留 JRE 许可证与第三方声明（Temurin GPLv2+CE）。
- 该目录由 KiCad 打包流水线写入（本仓库之外）；本仓库只约定路径并消费，不能独立完成“装进 KiCad”这一步。

### 4.2 运行时数据目录（插件创建，必须可写）

```text
%HQ_EDGE_HOME%\plugin-data\dsh-kicad-drc\pcblint\     # 默认 %USERPROFILE%\.hq-edge\...
  pcblintdb.mv.db
  pcblint\pcblint.log            # JVM 自身日志（-Dlogging.file.name）
  pcblint\launcher.log           # 插件重定向的 stdout/stderr（5MB 轮转）
  pcblint-files\
  pcblint-preview\
  shared\
  cli-runner-tmp\
```

**关键约束**：`Program Files` 下创建 H2 文件、日志、预览产物会因权限失败。所有 `-D` 路径必须指向该数据根，不能沿用 `start.bat` 里的 `%~dp0runtime`。

## 5. 生命周期设计

### 5.1 状态机

```text
stopped ──ensureUp()──> starting ──health 200──> running
   ^                        │                      │
   │                        └──超时/进程退出──> failed(冷却 60s)
   │                                               │
   └──────────── stop() 完成 <── stopping <── release() 且引用计数=0 且空闲到期
```

- `ensureUp()`：单飞。已有启动中的 Promise 时直接复用，不重复拉起。
- `running` 期间每次调用 `refCount++`；`run()` 结束 `refCount--`。
- `refCount=0` 时启动空闲计时器（`unref()`），到期 `stop()`。
- `stop()` 幂等；停止中再次 `ensureUp()` 先等停止完成再启动。
- 进程意外退出：清空 `child` 与端口，下一次调用自动重启；连续失败进入 60s 冷却，期间 `probe()` 报不可用，让自适应执行器降级到 `local`。

### 5.2 默认时序

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| 启动超时 | 90s | Spring Boot + H2 首次建库可能 20–40s |
| 健康轮询 | 500ms | 单次请求超时 1s |
| 空闲停止 | 60s | 0 表示每次用完立即停 |
| 失败冷却 | 60s | 与 `RemoteExecutor` 现有 `FAILURE_COOLDOWN_MS` 一致 |
| 停止等待 | 5s | 端口释放/进程消失的上限 |

首次调用会额外支付 JVM 启动时间（实测目标 8–15s）。这是“按需启动”的固有代价；`auto` 模式下启动失败仍会回退 `local`，不会让 DRC 失败。

为什么默认是 60 秒而不是 0：一次检查的典型节奏是“跑 DRC → 看结果 → 改板 → 再跑”，两次调用通常间隔几十秒。空闲关闭能在不拉长单次检查的前提下，在操作结束后释放 JVM；`pcblintIdleTimeoutMs=0` 保留给内存吃紧的机器，代价是每次检查都付一次冷启动。

### 5.3 与 `auto` 模式的关系

- `probe()` **绝不启动服务**（`src/index.ts` 启动 1.5s 后会 `describe()`，启动 JVM 会拖慢宿主）。
- 托管模式下 `probe()` 只判断：安装文件存在 + 不在失败冷却 + 运行中则真实探活。返回 `available: true` 表示“可以启动”，`reason` 写明“按需启动”。
- **组件不在磁盘但启用自下载（`pcblintAutoDownload` 非 false）时，`probe()` 必须判 `available: true`**，`reason` 写明“执行检查时会从云端自动下载”。否则 `auto` 会按“不可用”把 remote 过滤掉，`start()` 永远不执行，下载也就永远触发不了——这是一个只能靠显式 `mode: "remote"` 绕过的死锁。
- 下载完成后必须清掉 `resolveInstallation()` 缓存的解析失败，否则 60s 冷却期内的旧错误会让刚下载好的组件仍被判为不存在。
- 真正的启动只发生在 `RemoteExecutor.run()` 内。
- 不改 `backendPriority` 默认顺序（`remote → local → ipc`）；用户在低内存机器上可改为 `['local','ipc','remote']`。

### 5.4 内存与泄漏边界

- JVM 的常驻内存只由进程生命周期决定：`stop()` 后 Java、`kicad-cli` 子进程与监听端口都应消失，这部分不依赖垃圾回收。
- 插件侧必须自己释放的是：空闲计时器、`child` 的 `exit` 监听、stdout/stderr 流、启动中与停止中的 Promise 引用。任一项没清理，表现都是“服务已停但 DSH 内存不降”，这才是需要防的泄漏。
- 不做启动预热：预热与“按需、省内存”的目标冲突。若后续实测首次等待不可接受，再作为配置项引入，不默认开启。

## 6. 代码改造清单

### 6.1 新增 `src/pcblint-installation.ts`

```ts
export interface PcblintInstallation {
  home: string
  javaPath: string   // <home>/jre25/bin/java.exe
  jarPath: string    // <home>/pcblint/pcblint.jar
  version?: string   // <home>/pcblint/version.txt
}

export function resolvePcblintInstallation(input: {
  configuredHome?: string
  kicadCliPath?: string
  env?: NodeJS.ProcessEnv
}): PcblintInstallation
```

- 解析顺序：`configuredHome` → `DSH_PCBLINT_HOME` → `join(dirname(kicadCliPath), 'pcblint-local')`。
- `kicadCliPath` 取现有 `resolveKicadCli()` 的结果，只在使用时解析（首次启动时才可能触发 30s 全盘搜索）。
- 校验 `java.exe`、`pcblint.jar` 同时存在；缺失抛 `ExecutorError`，消息给出期望路径和“请安装随 KiCad 分发的 PCBLint 组件”。
- 只使用自带 JRE，不回退 `JAVA_HOME`/PATH 的系统 Java，避免 JRE 版本不一致。

### 6.2 新增 `src/pcblint-process.ts`

```ts
export interface PcblintLaunchInput {
  javaPath: string
  jarPath: string
  args: string[]
  cwd: string
  logFile: string
  onExit: () => void
}

export class PcblintProcess {
  static launch(input: PcblintLaunchInput): PcblintProcess
  readonly pid: number
  isAlive(): boolean
  stop(): Promise<void>       // taskkill /PID <pid> /T /F，等待退出
  readLogTail(lines: number): Promise<string>
}
```

实现要点：

- `spawn(javaPath, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })`，**不经过 cmd/shell**。
- stdout/stderr 用 `createWriteStream` 直接写 `<DATA>\pcblint\pcblint.log`，超过 5MB 轮转到 `.1`；内存里只保留最近 200 行环形缓冲，供失败时提示。
- 停止：`execFile('taskkill', ['/PID', String(pid), '/T', '/F'])`；随后轮询 `isAlive()` 与端口释放，最多 5s。
- `stop()` 失败不无限重试：返回错误并在下次启动前先确认旧进程已退出。

### 6.3 新增 `src/pcblint-launcher.ts`

```ts
export interface PcblintLauncherOptions {
  installation: PcblintInstallation
  dataRoot: string
  kicadCliPath: string
  startupTimeoutMs: number
  idleTimeoutMs: number
  javaOptions?: string
  port?: number            // 0/缺省=随机回环端口
  fetchImpl?: typeof fetch
}

export class PcblintLauncher {
  get baseUrl(): string                 // 未启动时为 ''
  get ownsProcess(): boolean
  ensureUp(signal?: AbortSignal): Promise<string>
  release(): void                       // 每次 run 结束调用
  describe(): { managed: true, running: boolean, home: string, version?: string, reason: string }
  dispose(): Promise<void>
}
```

- 端口：`getPort({ host: '127.0.0.1' })`；只允许 `127.0.0.1`。
- 健康：`GET http://127.0.0.1:<port>/api/s/health`，`status === 'ok'` 即就绪。
- 启动失败：停止进程、读日志尾部 30 行，抛 `ExecutorError('PCBLint 启动失败：…')`，消息里不带令牌。
- `dispose()`：取消启动、清空闲计时器、停止自有进程。
- 600ms 内多次 `release()`/`ensureUp()` 不能产生第二个 JVM（用 `launchInFlight` 与 `stopping` 两个 Promise 字段）。

### 6.4 修改 `src/remote-executor.ts`

1. `RemoteExecutorOptions` 增加 `launcher?: PcblintLauncher`，`baseUrl` 保留为外部固定服务模式。
2. `probe()`：有 `launcher` 时走托管判定，不启动服务；无 `launcher` 时保持现有健康检查逻辑。
3. `run()`：开头 `const baseUrl = this.launcher ? await this.launcher.ensureUp(options.signal) : this.baseUrl`；用 `baseUrl` 构造 `PcblintClient`（每次 run 新建客户端即可，无状态开销）。
4. `run()` 的 `finally` 里调用 `this.launcher?.release()`。
5. 把所有 `this.baseUrl` 的展示/上报改为本次的 `baseUrl`：错误消息、报告 `endpoint`、`command`、stdout 的 `endpoint`、`kicadCliPath: remote:${baseUrl}`。漏改会让报告指向旧端口。
6. 取消：保持现有 `options.signal.aborted → DrcAbortedError`，不要把“用户取消”算作服务失败（不进冷却）。

### 6.5 修改 `src/index.ts`

```ts
const managed = config.pcblintBaseUrl.trim() === ''
const launcher = managed
  ? new PcblintLauncher({
      // 惰性解析：首次 ensureUp / describe 时才定位 kicad-cli（全盘搜索不能放在插件加载路径）
      resolveInstallation: () => resolvePcblintInstallation({
        configuredHome: config.pcblintHome,
        // 已显式指定组件目录时无需再定位 kicad-cli
        kicadCliPath: config.pcblintHome.trim()
          ? undefined
          : resolveKicadCli(config.kicadCliPath || undefined),
      }),
      dataRoot: resolvePcblintDataRoot(),
      ...(config.kicadCliPath ? { kicadCliPath: config.kicadCliPath } : {}),
      resolveKicadCli: () => resolveKicadCli(),
      startupTimeoutMs: config.pcblintStartupTimeoutMs,
      idleTimeoutMs: config.pcblintIdleTimeoutMs,
      ...(config.pcblintJavaOptions ? { javaOptions: config.pcblintJavaOptions } : {}),
    })
  : undefined

const remote = new RemoteExecutor({
  ...(launcher ? { launcher } : { baseUrl: config.pcblintBaseUrl }),
  token: config.pcblintToken,
})

const onHostExit = (): void => { launcher?.disposeSync() }
process.once('exit', onHostExit)
ctx.effect(() => () => {
  process.removeListener('exit', onHostExit)
  void launcher?.dispose()
})
```

- 构造 `PcblintLauncher` 的配置错误（超时非正数）只让 remote 判不可用并降级，不让整个插件加载失败。
- 启动日志打印：托管/外部模式、数据根；安装目录在首次解析后随 `describe()` 进入后端状态，不阻塞加载。
- `ctx.effect` 的清理函数与 `process.once('exit')` 都要能停进程（`exit` 钩子内只能用同步 `execFileSync`）。

### 6.6 配置变更

| 配置 | 原默认 | 新默认 | 说明 |
| --- | --- | --- | --- |
| `pcblintBaseUrl` | `http://127.0.0.1:8096` | `''` | 空=托管（随机端口、自动启停）；非空=外部固定服务，只连接不管理 |
| `pcblintHome` | 无 | `''` | 安装目录覆盖，优先级最高 |
| `pcblintStartupTimeoutMs` | 无 | `90000` | 冷启动等待上限 |
| `pcblintIdleTimeoutMs` | 无 | `60000` | 空闲关闭；0=用完立即关闭 |
| `pcblintJavaOptions` | 无 | `''` | 追加 JVM 参数，如 `-Xmx1536m` |
| `pcblintToken` | `''` | 不变 | 外部生产服务才需要；本地托管固定免鉴权 |

**迁移说明**：升级后默认不再连接 8096。继续使用手工启动的服务，必须显式配置 `pcblintBaseUrl: http://127.0.0.1:8096`。README 的配置表要同步更新。

## 7. 启动参数（照搬 `start.bat`，路径全部改写）

`cwd = <DATA>`，参数数组直接交给 `spawn`，无 shell：

```text
-Xms256m
-Xmx1024m
-Dfile.encoding=UTF-8
-Duser.timezone=Asia/Shanghai
-Dserver.port=<port>
-Dserver.address=127.0.0.1
-Dspring.datasource.url=jdbc:h2:file:<DATA>\pcblintdb;MODE=MySQL;DATABASE_TO_LOWER=TRUE;AUTO_SERVER=TRUE
-Dspring.datasource.username=sa
-Dspring.datasource.password=
-Dspring.datasource.driver-class-name=org.h2.Driver
-Dspring.jpa.properties.hibernate.dialect=org.hibernate.dialect.H2Dialect
-Dpcblint.storage.file-base=<DATA>\pcblint-files
-Dpcblint.preview.output-base=<DATA>\pcblint-preview
-Dpcblint.preview.url-base=http://127.0.0.1:<port>/data/design/preview
-Dpcblint.drc.dru-output-base=<DATA>\shared
-Dpcblint.drc.cli-runner.work-dir-base=<DATA>\shared
-Dpcblint.drc.local-mode=true
-Dpcblint.drc.cli-executor.kicad-cli-path=<kicad-cli>
-Dpcblint.drc.cli-executor.work-dir=<DATA>\cli-runner-tmp
-Dpcblint.drc.cli-executor.allowed-work-roots[0]=<DATA>\shared
-Dpcblint.seed.system-rules.enabled=true
-Dpcblint.auth.local-bypass.enabled=true
-Dpcblint.auth.local-bypass.uid=local
-Dspring.cloud.nacos.config.enabled=false
-Dspring.cloud.nacos.discovery.enabled=false
-Dlogging.file.name=<DATA>\pcblint\pcblint.log
-jar <jarPath>
```

补充：

- 启动前递归创建 `pcblint\`、`pcblint-files\`、`pcblint-preview\`、`shared\`、`cli-runner-tmp\`。
- `-Xms` 调低到 256m 以降低常驻提交内存；`-Xmx1024m` 与原脚本一致。
- 若 `kicad-cli` 解析失败，仍可启动（服务端只跑规则引擎），但要在结果 `notes` 里保留现有“未执行 kicad-cli 原生检查”的警告。

## 8. 实施步骤与验收

### 阶段 1：安装目录与解析

- 新增 `pcblint-installation.ts` 与单测。
- 验收：配置覆盖、环境变量、kicad-cli 同级三种来源按序命中；缺 jar/jre 报错含具体路径。

### 阶段 2：进程与启动器

- 新增 `pcblint-process.ts`、`pcblint-launcher.ts`。
- 验收：真实启动一次，`/api/s/health` 返回 200；`stop()` 后 `java.exe` 与监听端口都消失；连续 3 次启动/停止无残留。

### 阶段 3：接入 RemoteExecutor

- 改造 `remote-executor.ts`、`config.ts`、`index.ts`、README 配置表。
- 验收：`mode=remote` 冷启动完成一次 DRC；报告 `endpoint` 是本次实际端口；空闲 60s 后进程退出。

### 阶段 4：故障与并发

- 启动中重复调用、运行中重复调用、服务中途退出、启动超时、端口占用、外部固定地址不被杀。
- 验收：全部有明确错误文案，且 `auto` 模式能回退 `local`。

### 阶段 5：随 KiCad 打包

- 在 KiCad 打包流程中加入目录复制与 `version.txt`；确认安装后 `bin\pcblint-local\` 结构正确。
- 验收：全新机器安装 KiCad 后无需任何手工步骤即可完成一次 DRC；卸载后 `HQ_EDGE_HOME` 下的插件数据按约定保留或清理。

每阶段结束运行：`pnpm typecheck && pnpm test && pnpm build`。

## 9. 决策点与风险

### 9.1 已定决策

1. **数据目录放用户可写目录**：按仓库约定使用 `HQ_EDGE_HOME`（默认 `~/.hq-edge`），否则普通用户无法在 `Program Files` 写 H2 与日志。
2. **`probe()` 不启动服务**：避免插件加载即拉起 JVM，违背“按需”。
3. **`pcblintBaseUrl` 为空表示托管**：与 FreeRouting 的 `freeroutingBaseUrl` 语义一致，用一个配置区分“自有进程”和“外部服务”。
4. **强制 `taskkill /T`**：Java 会派生 `kicad-cli`，只杀父进程会留下子进程。
5. **不自建 PID 文件做跨进程发现**：只管理自己 `spawn` 的 PID，避免误杀用户手工启动的服务。
6. **单实例 + 随机回环端口**：固定 8096 会与用户手工启动的服务撞端口，也存在误杀风险；随机端口 + 只管理自有 PID 最安全。
7. **只使用自带 JRE**：不回退 `JAVA_HOME`/PATH，避免 JRE 25 与系统 Java 17/21 混用时出现难以排查的问题。
8. **日志有界**：落盘轮转 5MB，内存只留最近 200 行，不使用无限增长的字符串缓冲。

### 9.2 待决策：单文件 exe

`freerouting.exe` 是带内嵌运行时的单文件包装。PCBLint 首期采用“目录 + jar + jre25”，原因是改动小、可直接用 `spawn(java)`。若后续要求同样只暴露一个可执行文件，可用 jpackage 生成 app-image 再套一层解压 wrapper，解压到 `HQ_EDGE_HOME` 下的插件数据目录。届时只需替换 `pcblint-installation.ts` 与启动参数组装，不影响生命周期代码。

本阶段明确不做：

- jlink 裁剪 JRE：能减体积，但需要逐模块验证 Spring Boot/H2 依赖，收益要等目录形态稳定后再评估。
- 启动预热：与“按需、省内存”冲突。
- 多插件共享一个服务进程：目前只有 DRC 一个消费者，提前共享只会增加归属与生命周期歧义。

### 9.3 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 首次调用多等 8–15s | 体验 | 空闲期复用；允许把 `backendPriority` 改为 local 优先 |
| 强制结束 JVM | H2 需崩溃恢复 | 停止后做一次真实启动验证；保留 `AUTO_SERVER=TRUE` |
| 两个 DSH 实例同时加载插件 | 两个 JVM / H2 竞争 | H2 `AUTO_SERVER` 容忍多进程；各自只管理自己的 PID；文档说明 |
| 安装目录只读 | 启动即失败 | 所有可写路径显式指向数据根，并有单测覆盖 |
| 杀毒软件拦截 java 启动 | 启动超时 | 错误信息附带日志尾部；文档给排查路径 |
| 插件升级但 KiCad 内组件未升级 | 参数/接口不匹配 | `version.txt` 与 `/api/s/health` 对账，不一致时日志警告并把原因写进 `probe().reason` |

## 10. 完成定义

- [ ] 全新 KiCad 安装后，无需手工启动即可完成一次 `mode=remote` 的 DRC。
- [ ] 空闲 60s（可配 0）后 `java.exe`、监听端口、`kicad-cli` 子进程全部消失。
- [ ] 连续 10 次调用后进程数与内存不增长；每次停止后可再次启动成功。
- [ ] 服务启动失败/中途崩溃时，`auto` 模式回退 `local`，且错误信息能定位（安装路径、日志尾部）。
- [ ] 配置了外部 `pcblintBaseUrl` 时，插件不会结束该进程。
- [ ] 插件侧计时器、子进程句柄、日志流在停止与卸载后全部释放，DSH 进程内存不随调用次数增长。
- [x] README 配置表、默认值迁移说明、许可证声明同步更新。

## 11. 实施与验证记录（2026-11-10）

阶段 1–4 已落地：

| 文件 | 内容 |
| --- | --- |
| `src/pcblint-installation.ts` | 组件定位（配置 → 环境变量 → kicad-cli 同级）、JRE/jar 校验、`version.txt` |
| `src/pcblint-process.ts` | `spawn(java)`、`taskkill /T /F` 停止、5MB 日志轮转、200 行内存尾部 |
| `src/pcblint-launcher.ts` | 单飞启动、随机回环端口、健康轮询、引用计数、空闲关闭、失败冷却、`disposeSync` |
| `src/remote-executor.ts` | `probe` 只读状态；`run` 按需启动并按实际端口重建客户端；`finally release`；组件版本与 `/health` 对账 |
| `src/index.ts` / `src/config.ts` | 配置项、生命周期钩子、`HQ_EDGE_HOME` 数据根解析 |
| `test/pcblint-*.test.ts` | 组件定位、参数组装、数据根、探测不启动、失败缓存、外部进程不被误杀与非法配置 |

验证：

- `pnpm typecheck`、`pnpm test`（146 用例）、`pnpm build` 通过。
- 版本对账：`version.txt` 与服务端 `/api/s/health` 不一致时 `console.warn`，并写入 `probe().reason`；一致时不告警。
- 外部进程边界：`dispose()` 不结束非自有进程（负向控制测试）。
- 实机（`E:\pcblint-local` + KiCad 10 的 `kicad-cli`）：冷启动 6.3s，`/api/s/health` 返回 `{"status":"ok"}`；`idleTimeoutMs=0` 时 `release()` 后自有进程退出，未残留 `java.exe`。
- 实机 DRC（`simple_led.kicad_pcb` 副本）：11.1s 完成，`kicadDrcUsed=true`，报告落盘为 `<pcb>_drc.pcblint.json`。
- 连续 10 次调用（默认 `idleTimeoutMs=60000`）：首次 12.0s（含 JVM + Spring + H2 冷启动），第 2–10 次 4.45–4.89s；10 次报告里的 `endpoint` 全部为同一地址（`127.0.0.1:61762`），每次自有 `java.exe` 均为 1 个，工作集 370–390MB 无持续增长。
- 默认空闲关闭：第 10 次结束后 60s 进程退出，`ownsProcess=false`，残留 `java.exe` 为 0；`dispose()` 后仍为 0。
- 回退到 local（真实 kicad-cli，`auto` 模式）：关闭自下载时组件目录缺失由 `probe()` 判不可用（reason 列出缺失的 JRE/jar 路径），直接选 local；组件齐全但 jar 损坏时远程真实启动失败（日志尾部 `Invalid or corrupt jarfile`），`verifiedBy.backend=local`、`fallbackFrom=remote`，且失败后不残留自有进程引用。两种情况结果均为 16 条违规、退出码 0。

尚未验证（不做“已验证”表述）：

- 全新 KiCad 安装包把组件落到 `bin\pcblint-local` 的实际安装流程。
- 外部固定服务的实机验证（代码上外部模式不持有 `launcher`，没有结束入口；仅单测覆盖 `dispose()` 不结束外部进程）。
