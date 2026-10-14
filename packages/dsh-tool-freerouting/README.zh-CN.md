# KiCad IPC 自动布线

[English](README.md) | [简体中文](README.zh-CN.md)

首期支持 Windows x64、KiCad 10。当前固定依赖使用 KiCad 自带的 Python 3.11，能力预检要求 **KiCad 10.0.6 或更新的 10.0 补丁版本**。其他 Python ABI、KiCad 版本和操作系统会明确报错。

## 使用

DSH 要求 **0.1.7-rc.2 或更新的兼容版本**。升级后需重启 DSH，并安装本次重新构建的插件包；旧版临时修改过的安装文件不能替代新版源码。

在 KiCad 中开启 IPC API，打开至少保存过一次的板子。未保存的板子修改会通过 IPC 纳入快照。只有一个可连接实例时自动选择；多个实例必须配置 `kicadApiSocket`。可通过 `kicadPythonPath` 指定所选安装目录的 `bin/python.exe`。

使用 KiCad 内置的 DSH 时，插件从该 KiCad 安装目录查找 Python。独立启动 DSH 时，请明确配置 `kicadPythonPath`；插件不再通过 PowerShell 扫描正在运行的程序来猜选安装目录。

```yaml
freeroutingBaseUrl: http://127.0.0.1:37864
autoLaunchFreerouting: true
kicadPythonPath: E:/path/to/KiCad/bin/python.exe
kicadApiSocket: ipc://C:/path/to/kicad/api.sock
```

`pcb_route` 默认路由全部需要连接的网络。当前 2.5.0 随包引擎缺少已验证的指定网络筛选能力：指定 `skip_nets` 或使用 `pcb_route_nets` 时，插件在启动前明确报错，不会扩大范围去布整板。当前内测请使用不跳过网络的整板入口。默认填充已有铜 zone；没有 zone 会报告跳过。任务卡片显示布线进度；默认在 KiCad PCB 编辑器中直接显示本轮过程走线和过孔。默认每 5 秒尝试更新，实际变化取决于布线引擎；刷新只替换本轮临时对象，原有走线和过孔保留。过程结果仍会变化，期间先不要编辑或保存板子。进入最终检查前清理临时走线，最终结果一次回导。完成后一次撤销可以恢复本轮最终新增走线和过孔；预览会留下额外撤销记录，继续多次撤销可能重新出现旧预览。需要只显示进度、最后添加结果时，可设置 `realtime: false`。默认最多等待 30 分钟，提前完成时立即处理结果；可通过 `pollTimeoutMs` 显式调整。达到时限时停止布线并清理本轮临时走线，明确说明未完成；无法确认清理时要求检查板子，停止自动重试。

关闭本次任务绑定的 PCB 编辑器后，插件会取消该板子的布线任务；没有其他板子的任务在使用引擎时，会关闭本插件启动的 Java 引擎。任务完成后关闭编辑器，也会释放空闲引擎。正在添加走线的操作不会被强杀；如果无法确认板子实际状态，会保留待确认提示。关闭 DSH 网页不会取消任务。

首期整个插件同时只处理一个布线任务；另一块板子发起请求也会明确拒绝，不排队。引擎退出失败时会有限重试，仍失败则保留；下次确认旧计算停止后才能复用。重新打开编辑器后，无需重启 DSH 即可再次布线。

DSH 单进程异常退出时，由 Windows 回收本插件启动的 Java 和离线规则检查程序。已经开始写板的 Python 保留事务保护；断电或强制结束整棵进程树仍需检查板子实际状态。

内测版有内存及结果容量保护：资源不足时停止计算，安全清理本轮过程走线，保留已有可用结果；无法确认清理时暂停该板子的自动布线。已有结果仍按原一小时有效期保留，结果容量不足时停止继续处理，不会提前删除旧结果。

首次发现布线规则问题时，助手会自行处理，并重新布线一次。仍有规则问题也会把结果添加到板子，但卡片会明确显示「布线已添加，仍有问题需要检查」，列出具体对象、位置和检查说明，并允许下载完整报告。请处理这些问题并检查未连接网络后再手动保存；「已添加」不代表「检查通过」或「全部布通」。

自动处理优先让新走线避开原板铜文字，不移动文字或删除原有走线。当前用文字外接矩形增加避让范围，可能减少可用布线空间。助手通过 `pcb_repair_route` 继续同一任务，只有一次重新布线机会；取消使用 `pcb_cancel_route`。目标板发生变化、检查未能完成或实际添加失败仍停止，规则放行不能跳过这些保护。

工具回复、后台任务通知和进度卡片使用同一份结果说明，先说明问题、板子受到的影响和下一步操作。具体冲突中的网络、铜文字和焊盘名称直接取自板子对象，位置采用检查报告的毫米坐标；原始检查说明可展开查看。连接失败不会被直接解释成未开启接口，无法确认添加结果时也不会声称板子未改变。

助手 30 秒内未继续时，插件会按默认避让方案接续，仍只重新布线一次。无需用户重复启动任务。

运行链路：DSH TypeScript → `spawn(kicad_helper.py)` → 固定版本 `kipy` → KiCad IPC API。每个 helper 完成一次命令后退出，Python 不常驻。FreeRouting 2.5.0 HTTP 引擎使用插件随包提供的完整 Java 25 JRE 和源码构建的 JAR，不需要安装系统 Java。极短走线与最终结果发布保护已纳入源码修复，构建输入、许可证和记录见 `engine/README.md`。

## 回导约束

- 开始时固定实例进程及启动时间、板子路径。同一板子只允许一个任务，重复请求返回已有任务标识。
- 导出使用当前编辑器内容；工程 `.kicad_pro` / `.kicad_dru` 只读复制到临时目录。有效网络类的线宽、间距、通孔直径和钻孔必须与 DSN 一致。
- 原有走线和过孔在离线 DSN 中标记 `fix`。当前 JAR 的 SES 不返回固定铜；回导仅新增铜，精确原铜副本过滤，部分重叠拒绝。
- 首期支持直线走线和普通通孔。不支持的圆弧走线、盲埋孔、自定义 `.kicad_dru` 规则或无法保真映射的输入在预检或回导校验时拒绝。
- 回导前及提交前检查完整快照、工程规则和有效网络类。发生任何变化则拒绝；提交后还核对新增对象和其余板子内容。
- 新增铜使用一次 `begin_commit` / `push_commit`；数量或对象内容不符时 `drop_commit` 并确认快照恢复。提交响应丢失或无法确认回滚时报告“回导状态待确认”，不自动重试。
- 成功回导只更新编辑器，用户手动保存。一次撤销覆盖本轮新增走线和过孔；后续铺铜是独立步骤。
- 铺铜失败保留走线，状态为 `partial`，明确报告“布线已回导，铺铜失败”。回导成功与全部布通分开；当前连通性标为未知。
- 回导前可以立即取消。回导过程中不强杀 helper，等待提交或回滚；已提交铜保留并反馈实际结果。

SES 在取得引擎结果后即可下载，包括等待助手处理、拒绝回导、回导失败和待确认状态。完整检查报告与结果具有相同权限和有效期。默认结果有效期为一小时；过期清理。任务、报告和 SES 不跨重启恢复。

待确认标记默认写入 `%APPDATA%/Huaqiu/dsh-freerouting/ipc-state`，也可配置 `ipcStateDirectory`。仅该最小标记跨重启保留，不包含板子内容、SES 或连接凭据。用户明确确认已检查所选目标板子后，调用 `pcb_confirm_board_checked(confirmed=true)` 解除；仍在运行的 helper 会阻止解除。

## 依赖与打包

源码仓库保留依赖锁文件、官方引擎源码归档、修复源码与构建脚本。`python/vendor`、`bundled/jre`、JAR 和本轮构建记录是生成目录，不提交 Git；最终插件包完整携带它们，用户安装插件不需要下载 Python 包或另装 Java。

开发者克隆后先安装 Node 22.19+ 或 24+、项目固定版本的 pnpm、KiCad 10.0.6+ 的 Windows x64 Python 3.11、完整 JDK 25 和开发用 Ruff。浏览器测试还需要安装 Playwright Chromium。首次依赖准备需要访问 Python 官方 wheel 下载地址、Temurin、Gradle 和 Maven 仓库。

```powershell
pnpm install --frozen-lockfile
python -m pip install -r packages/dsh-tool-freerouting/requirements-dev.txt
$env:DSH_IPC_TEST_PYTHON = '<KiCad 的 bin/python.exe>'
$env:DSH_ENGINE_TEST_JDK = '<完整 JDK 25 目录>'
pnpm --filter @huaqiu/dsh-tool-freerouting exec playwright install chromium
pnpm --filter @huaqiu/dsh-tool-freerouting package:plugin
```

`package:plugin` 自动执行依赖准备：按固定 URL 下载并校验 wheel，由 pip 使用完整带哈希清单安装到插件自己的 vendor；下载并校验完整 JRE；从固定官方源码和修复源码构建 JAR，运行上游回归，然后执行插件完整检查、TS 构建、打包和全新安装验证。不会向系统或 KiCad 安装运行依赖。

默认缓存位于包内 `.build-cache`，可通过 `DSH_BUILD_CACHE` 指定缓存目录。缓存每次使用前仍核对下载哈希；它不进入 Git 或发布包。可以单独运行 `pnpm --filter @huaqiu/dsh-tool-freerouting prepare:dependencies`。直接 `pnpm pack` 只检查已有准备结果，不自动下载；缺失、源码变更或 JAR 校验失败时拒绝打包。

`bundled/freerouting.build.json` 记录本轮源码锁、JAR SHA-256 和上游测试状态。官方构建包含时间戳，重新构建的 JAR 不要求等于旧发布包哈希；每个发布包必须与其本轮构建记录一致。不得手改记录绕过校验。

`python/vendor` 提供固定版本的 `kicad-python`、`protobuf`、`pynng` 和全部传递依赖。版本、原始 wheel URL 和 SHA-256 记录在 `python/dependencies.lock.json`；可复现的安装输入为 `python/requirements.lock.txt`。依赖只安装在插件内，不更改 KiCad 或系统 Python。

必须打包 `bundled/jre/lib/jvm.cfg` 和 `bundled/jre/lib/modules`。包内 `.gitignore` 只忽略包根的构建目录 `lib/`，不得忽略 `bundled/jre/lib/`。JRE 必须完整，缺失时报错。安装目录较长时，启动器将完整随包 JRE 和 JAR 复制到本轮临时目录后运行，退出后清理；不会使用系统 Java。

Windows bundled JRE 的 HTTP selector 在本机用户临时目录下出现 `connect EINVAL`，启动器使用 `%SystemRoot%/Temp` 放置短生命周期 selector socket。该目录无法写入时启动会失败；不会改用系统 Java。引擎使用独立临时配置和配置的本机端口，不覆盖已有 FreeRouting 配置。

## 验证

```powershell
cd <仓库根目录>
$env:DSH_IPC_TEST_PYTHON = '<所选 KiCad 的 bin/python.exe>'
$env:DSH_ENGINE_TEST_JDK = '<开发用 JDK 25 目录>'
pnpm install --frozen-lockfile
pnpm --filter @huaqiu/dsh-tool-freerouting check
pnpm --filter @huaqiu/dsh-tool-freerouting package:plugin
```

真实 IPC 测试必须使用生成的隔离 `fixture.kicad_pcb`，不能指向用户工作板子。启动隔离编辑器和 bundled HTTP 引擎后：

```powershell
$env:DSH_IPC_TEST_PYTHON = '<所选 KiCad 的 python.exe>'
$env:DSH_IPC_TEST_SOCKET = '<隔离测试板的 ipc:// 管道>'
$env:DSH_IPC_TEST_ROUTER = 'http://127.0.0.1:37865'
pnpm --filter @huaqiu/dsh-tool-freerouting test:ipc-live
```

编辑器关闭与 Java 回收的真实测试会自行生成临时板子并启动专用编辑器，不关闭已有工程。需要传入一份已完成首启设置的 KiCad `10.0` 配置目录（包含库表），测试只复制它，不修改原配置：

```powershell
$env:DSH_IPC_TEST_PYTHON = '<所选 KiCad 的 python.exe>'
$env:DSH_IPC_TEST_CONFIG = '<已初始化的测试配置/10.0>'
pnpm --filter @huaqiu/dsh-tool-freerouting test:editor-close-live
```

发布源为当前 `packages/dsh-tool-freerouting` 目录。压缩包输出到包内 `dist/huaqiu-dsh-tool-freerouting-0.5.20.tgz`。不包含 HQ Edge 回退入口，也不运行 HQ Edge 测试。真实宿主的临时数据与失败 SES 放在 `.dsh-host-smoke/`，该目录不会进入版本包。

DSH 安装该压缩包后使用随包 `cordis.patch.yml`，插件 ID 为 `huaqiu-dsh-tool-freerouting`。本机覆盖配置必须使用相同 ID。移除独立的 `dsh-plugin-freerouting` bundle 后再加入 `@huaqiu/dsh-tool-freerouting`，避免同时注册两套工具；安装目录切换后需重启 DSH。

## SES 重复铜

FreeRouting 的 SES 可能重复返回同一个分支线段。回导前仅在离线副本中合并网络、层、宽度和纳米坐标完全相同的线段（反向端点视为同一段），以及尺寸和位置完全相同的通孔。多段路径会在被移除的重复线段处拆分，保留其余分支和元数据。原始 SES 仍可下载。

规范化后仍严格核对唯一铜几何与 KiCad 原生导入结果。不同网络、层、宽度的对象不合并；零长度线段、未知映射、原铜部分重叠或混合原铜与新增铜的路径仍拒绝回导。

宿主 Cordis 的历史 peer 版本问题记录为 FR-IPC-DEPS-01。本包独立安装已使用完整 peer 依赖与 Cordis 4.0.4，不再跳过 peer 安装。当前开发依赖以 DSH 0.1.7-rc.2 与 Cordis 4.0.4 为基线，后台任务按会话编号绑定所属对话，并通过新版 result 字段交付完成结果。宿主兼容性必须使用真实后台任务服务验证，不能仅用模拟服务代替。

## 许可证

插件自有代码采用 [MIT 许可证](LICENSE)。FreeRouting 引擎及其修改保留 [GPL-3.0 许可证](engine/LICENSE)，不改为 MIT。第三方依赖保留各自许可证，详见[第三方说明](THIRD_PARTY_NOTICES.md)。内部设计及验收文档不随源码和插件包公开。
