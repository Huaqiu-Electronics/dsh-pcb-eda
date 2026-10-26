# @huaqiu/dsh-tool-kicad-schematic-gen

将四个原理图插件统一安装为一个插件，内部继续分为 components、modules、schematic 与设计技能。

| 模块 | 工具 |
| --- | --- |
| 器件模型与文档 | get_kicad_component_models、get_kicad_datasheet、import_kicad_symbol、import_kicad_component |
| 电路模块搜索下载 | eda_module_rag_search、eda_module_category_search、eda_module_precise_search、download_eda_module_schematic |
| 原理图工具 | get_kicad_module_ports、render_kicad_module_preview、create_kicad_hierarchy、edit_kicad_flat_schematic |

同时注册 kicad-schematic-design 技能。元件搜索由KiCad 内置的 @huaqiu/dsh-tool-part-search 提供，调用 search_hqsch_parts。该搜索插件随 KiCad 提供，可在插件管理器中启用；原理图插件本身不注册它的四个查询工具。两者间将搜索结果的 manufacturer.id 映射为 manufacturer_id，mpn 保持不变；公开工具统一要求 manufacturer_id 和 mpn，不再暴露 mfgId；两个导入工具额外支持可选 projectDir，默认工作区根目录。内部身份解析同样拒绝旧参数 mfgId，所有调用统一使用 manufacturer_id。

配置分为 components、modules.search、modules.download、schematic，使用原配置的默认限额。flatTemplateDir 默认指向本包技能模板。Node 22.19+，KiCad 10 CLI 路径可通过 schematic.kicadCliPath 配置。

模块下载按调用时的 HQ Edge 宿主与当前项目校验；没有 HQ Edge 时只让该下载调用失败，其它工具仍注册。符号导入继续使用会话文件系统及沙箱策略。工具不是自动电气验证；模型摘要不检查引脚焊盘匹配，手册文字可能被截断，构建库的放置和布线由设计脚本显式指定。

公开脚本入口是 lib/builder.js 或包的 ./builder 导出。设计技能、资源与模板位于 skills/kicad-schematic-design/。

新导入器件库默认保存到 `project/libraries/symbols/` 和 `project/libraries/footprints/`，库表保留在 project 根目录，使用 `${KIPRJMOD}` 相对路径注册。相同器件重复导入复用原文件；不再复用工程根目录中的旧库；同名库表仍指向旧目录时明确报冲突，不自动迁移或覆盖。脚本使用导入返回的实际 libraryPath 和 footprintId；概览 ZIP 会递归收集 libraries 下的器件库。

复用模块的封装通过 `localize_kicad_module_footprints` 的 list/import/check 流程本地化。模块下载现在保留 ZIP 中的 `.kicad_mod` 并返回 footprints 列表；缺失时使用明确选择的 manufacturer_id/mpn 查询在线封装。原嵌入符号、引脚和布线不替换，编号集合不匹配时拒绝导入。映射存入 `libraries/mappings/`，在设计脚本中使用 `importModule({...,footprintMappingPath})` 持久应用；来源变化后旧映射会拒绝使用。正式 delivery 在生成概览前验证根图和子页的本地封装引用。映射和封装一并进入项目 ZIP；尺寸、电气功能及 3D 完整性仍需单独确认。已有工程不会在插件加载时自动选择或替换器件。

KiCad CLI 自动从当前运行时安装位置或 PATH 查找，也可通过 KICAD_CLI_PATH 或 schematic.kicadCliPath 指定。skill 加载时提供本机插件目录及符号库路径，脚本通过 DSH_SCHEMATIC_PLUGIN_DIR、KICAD_SYMBOL_DIR 使用这些路径。

路径发现由配置与 skill 共用缓存，环境变量变化后重新识别。模型已有 get_eda_host_info 返回结果时，可以把其中的 kicad-cli 绝对路径传给 render_kicad_module_preview 的可选 kicadCliPath；只影响当前调用，不修改默认配置。原理图文件生成和预览不要求 PCB IPC 诊断或 Python 路径查询。

正式概览快照默认保存到 `~/.hq-edge/plugin-data/dsh-tool-kicad-schematic-gen/overview-cache/`（`~` 为当前用户家目录，使用 `os.homedir()` 获取）；设置绝对路径 `HQ_EDGE_HOME` 时保存到该根目录下同一子目录。不会使用 `DSH_HOME`、`LOCALAPPDATA` 或插件安装目录作为新快照的默认存储位置。快照完整写入后才发布；不再兼容读取插件目录中的旧快照，相关旧会话卡片需重新生成正式概览。不会自动删除历史快照；手动清理对应快照后，旧会话中的下载和放置操作将失效。

在工作区根目录执行 pnpm --filter @huaqiu/dsh-tool-kicad-schematic-gen build、typecheck 或 test。使用配套 DSH CLI 注册本目录，替换旧四个插件，并重新打开 KiCad AI 助手。旧脚本须更新为当前接口，不提供历史调用兼容。

成套器件导入：`import_kicad_component({manufacturer_id, mpn, projectDir})` 同时下载符号与封装，登记两个项目库表，返回 `footprintId`。放置时传 `footprint: imported.footprintId`。两种实际模型可用且引脚/焊盘编号集合匹配才成功；仍需手册核对尺寸与功能。公开调用只使用 `manufacturer_id`，内部解析层同样拒绝旧 `mfgId` 参数。

电源符号：在构建选项中声明实际共享网络 `requiredPowerSymbols`。`powerLabelCatalog(nets)` 返回本次标签 UUID、网络、坐标和导入模块名，按这些条件定位后生成 placements，不引用上一轮 UUID。`checkPowerSymbols()` 与 render/save 检查声明网络的标准符号和残留标签；未完成时拒绝保存。遮挡提示仍需局部预览确认，详见 [电源符号交付](skills/kicad-schematic-design/references/power-symbols.md)。

`planPowerPlacements({libraryPath, nets})` 在转换前批量规划方向、水平文字与短引出线，返回 placements 和剩余问题诊断；局部预览仍需确认。

含引脚的独立公共单元符号（如 SW-PTB-2_0_1）在项目副本中自动规范为单元 1，保留引脚与图形。模型摘要和导入结果通过 builderCompatibility.normalization=common_only_to_unit_1 报告；继承、空单元、异常命名及仅替代图形的符号不做自动规范。不支持的导入错误包含器件、符号、单元名称及源文件 URL。

最终概览卡片：正式预览传入 `delivery: true` 和包含全部本地库的 `projectDir`，显示页面切换、缩放、ZIP 下载。复用已有 PNG，不重新生成电路，无重新生成/详情按钮。需 KiCad Harness 的 webServer 与前端加载支持；不可用时仍返回本地预览路径。持久快照默认保存在当前用户家目录的 `.hq-edge/plugin-data/dsh-tool-kicad-schematic-gen/overview-cache/`，家目录通过 `os.homedir()` 动态获取；可用绝对路径 `HQ_EDGE_HOME` 覆盖 `.hq-edge` 根目录，不随 `DSH_HOME` 或插件版本变化。重启后可读取，手动删除快照后对应历史卡片下载将失效。工程、中间产物和预览保存在当前工作区；插件安装目录仅用于读取代码和模板，不读写概览快照。ZIP 为工程目录内相关设计文件与库的快照，不收集脚本、预览或外部库。
# 生成流程耗时优化

- 模块封装 `import` 返回 `stage: prepared`，仅表示本地库和映射准备完成；源文件默认不改写。`check_mapping` 验证来源应用映射后的状态，`check` 检查实际候选或最终原理图，避免混淆。
- 封装准备最多 4 并发；项目库表按项目串行写入。批次验证失败不写库，错误返回失败 assignment 索引；已验证下载在当前进程缓存 15 分钟（最多 128 项、16 MiB），退出进程后清空。瞬时网络/429/5xx 错误内部最多重试一次，格式和编号错误不自动重试。
- 使用现有供应商符号缓存对齐逻辑读取模块；封装仅支持当前 `(footprint ...)` 格式，旧式 `(module ...)` 明确拒绝，不自动转换。编号核对不等于尺寸或电气验证。
- builder 新增 `attachPinLabel`，支持显式方向、引线长度与通道错列；不推断引脚方向或自动避障。
- 技能目录 `scripts/run-design.mjs` 使用参数数组启动生成脚本，将退出码、执行时间和完整输出保存为 UTF-8 JSON；终端仅返回摘要，避免 PowerShell 转义、输出截断和 BOM 返工。模块封装准备提前进行，文档与脚本复用连接计划。


模块分析查询：`analyze_kicad_module({schematicPath, view, reference?, pin?, net?, offset?, kicadCliPath?})`。`view` 必填；下载已给分析摘要，直接查询所需 `components`、`nets` 或 `bom`。CLI/源工程默认内部解析；路径或启动失败 `CLI_START_FAILED` 时，复用 `get_eda_host_info` 返回的 kicad-cli 绝对路径，通过可选 `kicadCliPath` + `view:summary` 直接重试分析，不重新下载。成功路径后续复用，默认命令名不会覆盖自动发现；探测失败返回 `error:{code,executable}` 并区分启动、能力不支持、超时和命令失败。任意本地图采用同名 `.kicad_pro`，下载模块重启后可识别同名 `.source.kicad_pro`。详情返回 `status`、`items`、可选 `nextOffset`/`warnings`；网络按组分块，BOM 按全部物料字段与装配状态合并，器件自定义字段在指定 `reference` 时返回。部分失败结果供详情查询复用，修复后用 `view:summary` 重试。缺失 `nextOffset` 表示结束；不可用数据会明确警告。完整本地分析文件仍保留，详见 [模块分析](skills/kicad-schematic-design/references/module-analysis.md)。此接口替换旧版分析查询参数及返回结构，旧调用需同步更新。

候选预览与交付状态：普通 `render_kicad_module_preview` 可传 `projectDir`，在首版预览时校验全部页的本地封装，无需先复制库到候选目录。`footprintCheck` 返回逐页的实际解析结果，缺库时顶层 `status:error`，已渲染图片仍保留。`renderStatus` 单独表示渲染结果；`deliveryStatus` 为 `not_requested`、`ready` 或 `blocked`。正式交付失败不会返回整体成功；只有 `deliveryStatus:ready` 和有效概览才代表正式快照已创建，这仍不代表电气验证通过。

技能加载时提供 `pluginDir`、`skillDir`、`runtimePath`、`runnerPath`、`geometryPath` 等只读资源绝对路径，避免混淆插件根目录与技能根目录。资源安装目录不用于保存项目输出。失败恢复、有限重试及候选检查顺序见技能的 `references/troubleshooting.md`。
