# @huaqiu/dsh-tool-kicad-schematic-gen

[中文](README.zh.md)

One installable plugin containing twelve tools and the kicad-schematic-design skill. Internal modules preserve the former component-library, module-catalog and schematic-tool contracts. Component search is provided by the KiCad built-in plugin @huaqiu/dsh-tool-part-search and its search_hqsch_parts tool.

布局交付：简单项目默认首版、一次集中修复、验证并交付；首版达标可直接交付。额外修复必须有具体阻塞缺陷，真实错误不受轮数限制。不为装饰偏好或清零保守警告重复重建。流程和验收条件见 [布局修复与交付停止条件](skills/kicad-schematic-design/references/layout-delivery.md)，启动器摘要返回 nextAction 提示，不自动宣称方案或电气验证通过。

Configuration is grouped under components, modules.search, modules.download and schematic. Templates ship under skills/kicad-schematic-design; the public scripting API is available at ./builder. Module downloads resolve the current HQ Edge host at execution time, so a missing host does not prevent other tools or the skill from loading.

Imports remain workspace scoped and use DSH sandbox policy. Model inspection reports pin/pad summaries; paired import checks unique pin/pad number sets, but does not verify electrical suitability or package dimensions. Placement and routing are explicitly authored in design scripts. Datasheet extraction preserves missing/truncated status.

Build, typecheck and test from the repository workspace. Restart the KiCad assistant after replacing the old bundles. See [merge notes](../../docs/SCHEMATIC-MERGE.md).

Paired import: `import_kicad_component_symbol_and_footprint({manufacturer_id, mpn, projectDir})` downloads a symbol and footprint, registers `sym-lib-table` and `fp-lib-table`, and returns `libId`, `libraryPath`, and `footprintId`. It also returns `units` when the available units are different from `[1]`. Place with `addSymbol({libraryPath, libId, footprint: footprintId, ...})`. Success requires both usable models and matching unique pin/pad number sets. Public tool arguments use required `manufacturer_id` and `mpn`, matching `@huaqiu/dsh-tool-part-search`; imports also accept optional `projectDir` (defaults to the workspace root). The obsolete `mfgId` parameter is rejected; all callers must use `manufacturer_id`. See the skill's [component and PCB reference](skills/kicad-schematic-design/references/component-pcb.md).

Power symbols: declare actual shared nets with the builder's `requiredPowerSymbols` option. `powerLabelCatalog(nets)` returns current-build label UUIDs, coordinates and imported-module names for reproducible placement. `checkPowerSymbols()` and render/save reject missing symbols or unconverted labels for declared nets. Layout warnings still require visual review. See [power-symbol delivery](skills/kicad-schematic-design/references/power-symbols.md).

`planPowerPlacements({libraryPath, nets})` plans bounded rotations, horizontal text placement and short straight leads before conversion. Diagnostics list unresolved overlaps and unmeasured objects; visual review remains required.

Standalone common-only symbols with pins (e.g. SW-PTB-2_0_1) are automatically normalized in project copies to unit 1 without changing pins or graphics. Symbol queries report symbol.normalization=common_only_to_unit_1. Inherited, empty, malformed or alternate-only definitions are not normalized. Unsupported imports report part, symbol, sections and source URL.

最终概览卡片：正式预览传入 `delivery: true` 和包含全部本地库的 `projectDir`，待本轮正常完成后，在最终回复后的轮次尾部显示页面切换、缩放、ZIP 下载；工具执行期间不展示正式卡片。正式概览必须是本轮最后一个工具操作，之后调用其他工具或普通预览时须重新正式交付；失败、取消、中断的轮次不显示正式卡片。卡片从所属轮次的工具记录恢复，切换会话无需全局缓存。复用已有 PNG，不重新生成电路，无重新生成/详情按钮。需 KiCad Harness 的 webServer、conversation.chat.turnTail 和 useChat（ChatSnapshot 的 locations/nodes）支持；不可用时仍返回本地预览路径。持久快照默认保存在当前用户家目录的 `.hq-edge/plugin-data/dsh-tool-kicad-schematic-gen/overview-cache/`，家目录通过 `os.homedir()` 动态获取；可用绝对路径 `HQ_EDGE_HOME` 覆盖 `.hq-edge` 根目录，不随 `DSH_HOME` 或插件版本变化。重启后可读取，手动删除快照后对应历史卡片下载将失效。工程、中间产物和预览保存在当前工作区；插件安装目录仅用于读取代码和模板，不读写概览快照。ZIP 为工程目录内相关设计文件与库的快照，不收集脚本、预览或外部库。

模块下载分析：有随包封装时，下载工具同时输出层次端口摘要，以及器件清单、BOM 和网表连接文件路径。缺封装时跳过分析并提示改选。下载和导出状态分别报告；修复导出问题后，使用相同 moduleId 和 targetDir 加 refreshAnalysis:true，在当前插件进程复用近期下载。详见 [模块分析](skills/kicad-schematic-design/references/module-analysis.md)。

方案先行：先保存硬件方案，用 `scripts/run-design.mjs --read-plan <方案.md>` 读回，再按文档编写脚本。运行时必须传 `--plan <path> --plan-sha256 <sha256>`；构建库直接调用也要求 `designPlan:{path,sha256}`。脚本构建与层次生成工具同样检查方案。缺失、空文档或版本变化时阻止生成；只读模块分析和预览不受影响。构建报告保存方案全文、方案 hash 和脚本 hash。此检查保证文件和版本前置，不代替方案电气完整性及文图一致性审查。

电气栅格：默认 50 mil（1.27 mm）。构建器吸附器件放置、导线坐标、标签和模块平移量；`gridPoint/snapGrid` 可用于脚本规划。引脚库必须兼容同一格点，原理图构建检查实际引脚及连接点；预览和快照打包不重复执行格点检查。已有工程需从脚本重新构建，不通过独立舍入引脚/连线修补。

预览与交付：`render_kicad_module_preview` 仅负责普通预览、局部截图和正式快照，不检查封装、格点或电气正确性。省略 `pageNames` 或传 `[]` 时一次生成全部页，传非空列表仅生成指定页，不再受 4 页限制；指定页全部成功不会因未选择其他页返回 partial。`regions` 省略时自动识别根页带标题矩形，`[]` 关闭局部图，显式区域以毫米指定，pageName 缺省为根页。`projectDir` 仅用于 delivery 打包范围，普通预览不使用。公开结果保留 status、renderStatus、deliveryStatus、revision、manifestPath、pageCount 和精简 pages；有根页、局部图、失败、概览或交付错误时才返回对应字段。pageCount 为全部导出页数，pages 为本次成功 PNG。完整路径、缓存状态、页面来源、区域坐标及诊断保存在 manifestPath；不再公开 footprintCheck、cached、outputDir、schematicPath、truncated、omittedPages、regionManifestPath 和固定 readImageInstruction。随包封装匹配在模块生成时完成。正式快照成功须 deliveryStatus:ready 且 overview 有效，不表示工程完整或电气正确；前端概览结构不变。schematic.previewMaxPages 配置已移除。旧调用方应按当前精简结构更新。

技能加载时提供 `pluginDir`、`skillDir`、`runtimePath`、`runnerPath`、`geometryPath` 等只读资源绝对路径，避免混淆插件根目录与技能根目录。资源安装目录不用于保存项目输出。失败恢复、有限重试及候选检查顺序见技能的 `references/troubleshooting.md`。

Component import: import_kicad_component_symbol_and_footprint requires both a symbol and a footprint. If the exact candidate has no footprint, FOOTPRINT_NOT_AVAILABLE identifies the candidate so the design agent can search for a suitable alternative.

Both import modes reuse product detail to fill missing symbol properties: MPN, Manufacturer, huaqiu_pn, Description, Datasheet URL and available technical attributes (shortName preferred, otherwise name). Existing nonempty properties and geometry are preserved; distinct duplicate attribute values are joined with semicolons. `addSymbol` retains description/custom fields as hidden instance properties. No new tool parameters or output fields are required. Existing libraries and placed instances are not upgraded automatically; differing library content still requires explicit resolution.

For existing projects, the skill's `propertySyncPath` script audits an explicit exact-part manifest by default. `--apply` backs up and fills missing library, embedded-definition and instance properties while retaining geometry, connectivity and nonempty values. Conflicting MPNs are rejected. See the component reference for the manifest contract.

Paired import matches cloud-placement naming: `kicad_api_lib:<exact MPN>` with `<MPN>.kicad_mod`. The default shared library is `libraries/footprints/kicad_api_lib.pretty`; existing project-local registrations are reused. The symbol default Footprint is bound to the same ID, so addSymbol can inherit it. Downloaded model bytes are retained; same-name different-content files are rejected. Existing placed instances are not automatically rewritten.

New project-local symbol imports use independent `kicad_lib_<manufacturer ID>_<sanitized MPN>_<12-character MPN hash>.kicad_sym` libraries. The nickname, returned libId and project table URI use the same prefix. Existing DSH_ libraries, registrations and placed instances are preserved; reimporting a part under the new prefix creates a separate library. Footprint naming is unchanged.

Module generation feedback is bounded and staged: pre-dispatch native-geometry space screening rejects frames that cannot contain the fixed pin geometry or have no usable content area; tight-space estimates and suggested sizes remain advisory. The review tool keeps full reports on disk, returns counts, omissions and up to 12 compact issues (6000-character item budget), and directs batch repair through structure/resize/layout/visual_review stages. Read omitted diagnostics via reportPath; full-frame visual review and connectivity checks remain required.

新模块派发前检查 module-plan.json 中各模块的 reuse 选择记录：实际搜索工具/检索词、found/no_match/unavailable 结果及 reuse/adapt/new 决定和原因。失败接口不得记录为无候选；选中来源须实际下载到 sources/ 并列入 resources。缺失时集中返回 MODULE_REUSE_REQUIRED，不启动新任务；既有任务状态查询和修复不追补。该检查不自动搜索、判断电气适用或导入来源，并行 draw/region 仍不提供源图导入；实际复用沿用公开 importModule 平铺路线。
