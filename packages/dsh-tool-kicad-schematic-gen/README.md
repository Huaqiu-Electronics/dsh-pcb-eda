# @local/dsh-tool-kicad-schematic-gen

[中文](README.zh.md)

One installable plugin containing twelve tools and the kicad-schematic-design skill. Internal modules preserve the former component-library, module-catalog and schematic-tool contracts. Component search is provided by the KiCad built-in plugin @huaqiu/dsh-tool-part-search and its search_hqsch_parts tool.

Configuration is grouped under components, modules.search, modules.download and schematic. Templates ship under skills/kicad-schematic-design; the public scripting API is available at ./builder. Module downloads resolve the current HQ Edge host at execution time, so a missing host does not prevent other tools or the skill from loading.

Imports remain workspace scoped and use DSH sandbox policy. Model inspection reports pin/pad summaries; paired import checks unique pin/pad number sets, but does not verify electrical suitability or package dimensions. Placement and routing are explicitly authored in design scripts. Datasheet extraction preserves missing/truncated status.

Build, typecheck and test from the repository workspace. Restart the KiCad assistant after replacing the old bundles. See [merge notes](../../docs/SCHEMATIC-MERGE.md).

Paired import: `import_kicad_component({manufacturer_id, mpn, projectDir})` downloads a symbol and footprint, registers `sym-lib-table` and `fp-lib-table`, and returns `footprintId`. Place with `addSymbol({libraryPath, libId, footprint: footprintId, ...})`. Success requires both usable models and matching unique pin/pad number sets. Public tool arguments use required `manufacturer_id` and `mpn`, matching `@huaqiu/dsh-tool-part-search`; imports also accept optional `projectDir` (defaults to the workspace root). `mfgId` is retained only by the internal identity parser for legacy direct callers; schema-validated tool calls must use `manufacturer_id`. See the skill's [component and PCB reference](skills/kicad-schematic-design/references/component-pcb.md).

Power symbols: declare actual shared nets with the builder's `requiredPowerSymbols` option. `powerLabelCatalog(nets)` returns current-build label UUIDs, coordinates and imported-module names for reproducible placement. `checkPowerSymbols()` and render/save reject missing symbols or unconverted labels for declared nets. Layout warnings still require visual review. See [power-symbol delivery](skills/kicad-schematic-design/references/power-symbols.md).

`planPowerPlacements({libraryPath, nets})` plans bounded rotations, horizontal text placement and short straight leads before conversion. Diagnostics list unresolved overlaps and unmeasured objects; visual review remains required.

Standalone common-only symbols with pins (e.g. SW-PTB-2_0_1) are automatically normalized in project copies to unit 1 without changing pins or graphics. Model summaries and import results report builderCompatibility.normalization=common_only_to_unit_1. Inherited, empty, malformed or alternate-only definitions are not normalized. Unsupported imports report part, symbol, sections and source URL.

最终概览卡片：正式预览传入 `delivery: true` 和包含全部本地库的 `projectDir`，显示页面切换、缩放、ZIP 下载。复用已有 PNG，不重新生成电路，无重新生成/详情按钮。需 KiCad Harness 的 webServer 与前端加载支持；不可用时仍返回本地预览路径。快照保存在插件 `.overview-cache/`，重启后可读取；移除该目录后历史卡片下载将失效。ZIP 为工程目录内相关设计文件与库的快照，不收集脚本、预览或外部库。

Module analysis queries use `analyze_kicad_module({schematicPath, view, reference?, pin?, net?, offset?, kicadCliPath?})`, with explicit `view`. Downloads already return a summary: query only needed components, grouped nets or grouped BOM. CLI/project options are resolved internally; optional absolute `kicadCliPath` is for recovery using the existing `get_eda_host_info` result. On `CLI_START_FAILED`, retry analysis with that path and `view:summary`, without downloading again. Successful paths are reused; default CLI command names preserve automatic discovery. Probe errors return `error:{code,executable}` and retain causes; capability failures are distinct from startup failures. Matching same-stem projects and downloaded `.source.kicad_pro` files are discovered. Detail output contains `status`, `items`, and optional `nextOffset`/`warnings`; missing `nextOffset` means completion. Component custom fields require a reference filter. Partial results are reused for detail queries; after fixing configuration use `view:summary` to retry. Full local artifacts are preserved. This replaces the previous analysis query arguments and response contract; existing callers must migrate. See [module analysis](skills/kicad-schematic-design/references/module-analysis.md).
