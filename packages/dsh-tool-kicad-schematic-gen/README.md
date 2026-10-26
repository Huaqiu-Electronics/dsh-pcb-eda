# @huaqiu/dsh-tool-kicad-schematic-gen

[中文](README.zh.md)

One installable plugin containing twelve tools and the kicad-schematic-design skill. Internal modules preserve the former component-library, module-catalog and schematic-tool contracts. Component search is provided by the KiCad built-in plugin @huaqiu/dsh-tool-part-search and its search_hqsch_parts tool.

布局交付：简单项目默认首版、一次集中修复、验证并交付；首版达标可直接交付。额外修复必须有具体阻塞缺陷，真实错误不受轮数限制。不为装饰偏好或清零保守警告重复重建。流程和验收条件见 [布局修复与交付停止条件](skills/kicad-schematic-design/references/layout-delivery.md)，启动器摘要返回 nextAction 提示，不自动宣称方案或电气验证通过。

Configuration is grouped under components, modules.search, modules.download and schematic. Templates ship under skills/kicad-schematic-design; the public scripting API is available at ./builder. Module downloads resolve the current HQ Edge host at execution time, so a missing host does not prevent other tools or the skill from loading.

Imports remain workspace scoped and use DSH sandbox policy. Model inspection reports pin/pad summaries; paired import checks unique pin/pad number sets, but does not verify electrical suitability or package dimensions. Placement and routing are explicitly authored in design scripts. Datasheet extraction preserves missing/truncated status.

Build, typecheck and test from the repository workspace. Restart the KiCad assistant after replacing the old bundles. See [merge notes](../../docs/SCHEMATIC-MERGE.md).

Paired import: `import_kicad_component({manufacturer_id, mpn, projectDir})` downloads a symbol and footprint, registers `sym-lib-table` and `fp-lib-table`, and returns `footprintId`. Place with `addSymbol({libraryPath, libId, footprint: footprintId, ...})`. Success requires both usable models and matching unique pin/pad number sets. Public tool arguments use required `manufacturer_id` and `mpn`, matching `@huaqiu/dsh-tool-part-search`; imports also accept optional `projectDir` (defaults to the workspace root). The obsolete `mfgId` parameter is rejected; all callers must use `manufacturer_id`. See the skill's [component and PCB reference](skills/kicad-schematic-design/references/component-pcb.md).

Power symbols: declare actual shared nets with the builder's `requiredPowerSymbols` option. `powerLabelCatalog(nets)` returns current-build label UUIDs, coordinates and imported-module names for reproducible placement. `checkPowerSymbols()` and render/save reject missing symbols or unconverted labels for declared nets. Layout warnings still require visual review. See [power-symbol delivery](skills/kicad-schematic-design/references/power-symbols.md).

`planPowerPlacements({libraryPath, nets})` plans bounded rotations, horizontal text placement and short straight leads before conversion. Diagnostics list unresolved overlaps and unmeasured objects; visual review remains required.

Standalone common-only symbols with pins (e.g. SW-PTB-2_0_1) are automatically normalized in project copies to unit 1 without changing pins or graphics. Model summaries and import results report builderCompatibility.normalization=common_only_to_unit_1. Inherited, empty, malformed or alternate-only definitions are not normalized. Unsupported imports report part, symbol, sections and source URL.

最终概览卡片：正式预览传入 `delivery: true` 和包含全部本地库的 `projectDir`，待本轮正常完成后，在最终回复后的轮次尾部显示页面切换、缩放、ZIP 下载；工具执行期间不展示正式卡片。正式概览必须是本轮最后一个工具操作，之后调用其他工具或普通预览时须重新正式交付；失败、取消、中断的轮次不显示正式卡片。卡片从所属轮次的工具记录恢复，切换会话无需全局缓存。复用已有 PNG，不重新生成电路，无重新生成/详情按钮。需 KiCad Harness 的 webServer、conversation.chat.turnTail 和 useChat（ChatSnapshot 的 locations/nodes）支持；不可用时仍返回本地预览路径。持久快照默认保存在当前用户家目录的 `.hq-edge/plugin-data/dsh-tool-kicad-schematic-gen/overview-cache/`，家目录通过 `os.homedir()` 动态获取；可用绝对路径 `HQ_EDGE_HOME` 覆盖 `.hq-edge` 根目录，不随 `DSH_HOME` 或插件版本变化。重启后可读取，手动删除快照后对应历史卡片下载将失效。工程、中间产物和预览保存在当前工作区；插件安装目录仅用于读取代码和模板，不读写概览快照。ZIP 为工程目录内相关设计文件与库的快照，不收集脚本、预览或外部库。

Module analysis queries use `analyze_kicad_module({schematicPath, view, reference?, pin?, net?, offset?, kicadCliPath?})`, with explicit `view`. Downloads already return a summary: query only needed components, grouped nets or grouped BOM. CLI/project options are resolved internally; optional absolute `kicadCliPath` is for recovery using the existing `get_eda_host_info` result. On `CLI_START_FAILED`, retry analysis with that path and `view:summary`, without downloading again. Successful paths are reused; default CLI command names preserve automatic discovery. Probe errors return `error:{code,executable}` and retain causes; capability failures are distinct from startup failures. Matching same-stem projects and downloaded `.source.kicad_pro` files are discovered. Detail output contains `status`, `items`, and optional `nextOffset`/`warnings`; missing `nextOffset` means completion. Component custom fields require a reference filter. Partial results are reused for detail queries; after fixing configuration use `view:summary` to retry. Full local artifacts are preserved. This replaces the previous analysis query arguments and response contract; existing callers must migrate. See [module analysis](skills/kicad-schematic-design/references/module-analysis.md).

方案先行：先保存硬件方案，用 `scripts/run-design.mjs --read-plan <方案.md>` 读回，再按文档编写脚本。运行时必须传 `--plan <path> --plan-sha256 <sha256>`；构建库直接调用也要求 `designPlan:{path,sha256}`。平铺 create 与层次生成工具同样检查方案。缺失、空文档或版本变化时阻止生成；只读模块分析和预览不受影响。构建报告保存方案全文、方案 hash 和脚本 hash。此检查保证文件和版本前置，不代替方案电气完整性及文图一致性审查。

电气栅格：默认 50 mil（1.27 mm）。构建器吸附器件放置、导线坐标、标签和模块平移量；`gridPoint/snapGrid` 可用于脚本规划。引脚库必须兼容同一格点，原理图生成与正式交付检查实际引脚及连接点，偏离时阻止交付。已有工程需从脚本重新构建，不通过独立舍入引脚/连线修补。

候选预览与交付状态：普通 `render_kicad_module_preview` 可传 `projectDir`，在首版预览时校验全部页的本地封装，无需先复制库到候选目录。`footprintCheck` 返回逐页的实际解析结果，缺库时顶层 `status:error`，已渲染图片仍保留。`renderStatus` 单独表示渲染结果；`deliveryStatus` 为 `not_requested`、`ready` 或 `blocked`。正式交付失败不会返回整体成功；只有 `deliveryStatus:ready` 和有效概览才代表正式快照已创建，这仍不代表电气验证通过。

技能加载时提供 `pluginDir`、`skillDir`、`runtimePath`、`runnerPath`、`geometryPath` 等只读资源绝对路径，避免混淆插件根目录与技能根目录。资源安装目录不用于保存项目输出。失败恢复、有限重试及候选检查顺序见技能的 `references/troubleshooting.md`。
