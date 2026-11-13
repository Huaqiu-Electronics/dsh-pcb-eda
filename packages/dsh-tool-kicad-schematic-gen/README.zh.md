# @huaqiu/dsh-tool-kicad-schematic-gen

将四个原理图插件统一安装为一个插件，内部继续分为 components、modules、schematic 与设计技能。

| 模块 | 工具 |
| --- | --- |
| 器件模型与文档 | get_kicad_component_models、get_kicad_datasheet、import_kicad_component_symbol_and_footprint |
| 电路模块搜索下载 | eda_module_rag_search、eda_module_category_search、eda_module_precise_search、download_eda_module_schematic |
| 原理图工具 | list_kicad_hierarchical_ports、render_kicad_module_preview、create_kicad_hierarchy |
| 模块并行生成 | dispatch_kicad_module_tasks、review_kicad_module_candidate |

同时注册 kicad-schematic-design 技能。元件搜索由KiCad 内置的 @huaqiu/dsh-tool-part-search 提供，调用 search_hqsch_parts。该搜索插件随 KiCad 提供，可在插件管理器中启用；原理图插件本身不注册它的四个查询工具。两者间将搜索结果的 manufacturer.id 映射为 manufacturer_id，mpn 保持不变；公开工具统一要求 manufacturer_id 和 mpn，不再暴露 mfgId；统一导入工具额外支持可选 projectDir，默认工作区根目录。内部身份解析同样拒绝旧参数 mfgId，所有调用统一使用 manufacturer_id。

配置分为 components、modules.search、modules.download、schematic，使用原配置的默认限额。flatTemplateDir 默认指向本包技能模板。Node 22.19+，KiCad 10 CLI 路径可通过 schematic.kicadCliPath 配置。

模块下载按调用时的 HQ Edge 宿主与当前项目校验；没有 HQ Edge 时只让该下载调用失败，其它工具仍注册。符号导入继续使用会话文件系统及沙箱策略。工具不是自动电气验证；模型摘要不检查引脚焊盘匹配，手册文字可能被截断，构建库的放置和布线由设计脚本显式指定。

公开脚本入口是 lib/builder.js 或包的 ./builder 导出。设计技能、资源与模板位于 skills/kicad-schematic-design/。

生成迭代优化：电源规划使用已注册功能框并预留标题/说明，无法安放的位置一次列出。plan.diagnostics.stage=automatic；转换后 save().powerLayout（stage=final）按实际符号重新检查越框、越页和保守重叠，不将覆盖前的诊断视为最终结果。模板将布局放入 layout.mjs，stdout 只输出一个结果 JSON。启动器报告 summaryStatus/summaryError，兼容恢复唯一的多段 JSON 结果，保留完整日志及真实退出码；这些状态不代替交付或电气检查。

画法读取：技能提供 patternReaderPath，执行 `node <patternReaderPath> usb-c-device reset-rc` 返回所选完整说明、代码、去重依赖和参考图绝对路径。首次采用须再用 read_image 实际读对应 PNG；脚本返回路径不等于看过图片。同项目已读资源复用，不遍历全部 assets；不匹配的芯片/拓扑记录适配原因，不强套范例。

新导入器件库默认保存到 `project/libraries/symbols/` 和 `project/libraries/footprints/`，库表保留在 project 根目录，使用 `${KIPRJMOD}` 相对路径注册。相同器件重复导入复用原文件；不再复用工程根目录中的旧库；同名库表仍指向旧目录时明确报冲突，不自动迁移或覆盖。脚本使用导入返回的实际 libraryPath 和 footprintId；概览 ZIP 会递归收集 libraries 下的器件库。

复用下载模块时，平铺构建和层次组装自动匹配随包封装、校验引脚和焊盘编号、登记项目库，并按内容去重。封装缺失、冲突或编号不匹配时，选择其他模块。详见 [模块封装](skills/kicad-schematic-design/references/module-footprints.md)。

KiCad CLI 自动从当前运行时安装位置或 PATH 查找，也可通过 KICAD_CLI_PATH 或 schematic.kicadCliPath 指定。skill 加载时提供本机插件目录及符号库路径，脚本通过 DSH_SCHEMATIC_PLUGIN_DIR、KICAD_SYMBOL_DIR 使用这些路径。

路径发现由配置与 skill 共用缓存，环境变量变化后重新识别。模型已有 get_eda_host_info 返回结果时，可以把其中的 kicad-cli 绝对路径传给 render_kicad_module_preview 的可选 kicadCliPath；只影响当前调用，不修改默认配置。原理图文件生成和预览不要求 PCB IPC 诊断或 Python 路径查询。

正式概览快照默认保存到 `~/.hq-edge/plugin-data/dsh-tool-kicad-schematic-gen/overview-cache/`（`~` 为当前用户家目录，使用 `os.homedir()` 获取）；设置绝对路径 `HQ_EDGE_HOME` 时保存到该根目录下同一子目录。不会使用 `DSH_HOME`、`LOCALAPPDATA` 或插件安装目录作为新快照的默认存储位置。快照完整写入后才发布；不再兼容读取插件目录中的旧快照，相关旧会话卡片需重新生成正式概览。不会自动删除历史快照；手动清理对应快照后，旧会话中的下载和放置操作将失效。

在工作区根目录执行 pnpm --filter @huaqiu/dsh-tool-kicad-schematic-gen build、typecheck 或 test。使用配套 DSH CLI 注册本目录，替换旧四个插件，并重新打开 KiCad AI 助手。旧脚本须更新为当前接口，不提供历史调用兼容。

成套器件导入：`import_kicad_component_symbol_and_footprint({manufacturer_id, mpn, projectDir})` 同时下载符号与封装，登记两个项目库表，返回 `libId`、`libraryPath` 和 `footprintId`。可用单元不是单独的单元 1 时额外返回 `units`。放置时传 `footprint: imported.footprintId`。两种实际模型可用且引脚/焊盘编号集合匹配才成功；仍需手册核对尺寸与功能。公开调用只使用 `manufacturer_id`，内部解析层同样拒绝旧 `mfgId` 参数。

成套导入从同一次 `productDetail` 响应读取器件信息，为符号补充 MPN、Manufacturer、huaqiu_pn、Description、Datasheet（链接），以及接口实际返回的技术参数。参数名优先使用 shortName，缺失时使用名称；保留已有非空属性，重复参数的不同值用分号合并，不修改引脚或图形。`addSymbol` 将描述与自定义属性保留到原理图实例中，默认隐藏。无需新增入参，工具出参保持不变；已导入的旧库和已放置的旧实例不会自动升级，内容不同仍拒绝覆盖。

旧工程可使用技能提供的 `propertySyncPath` 脚本检查和补齐属性。默认只检查；`--apply` 按准确厂家/型号清单补齐库、图纸嵌入定义与实例，并备份原文件。保留布局、连线和非空属性，型号冲突时拒绝合并。详见器件与封装参考中的“旧工程属性检查与补齐”。

电源符号：在构建选项中声明实际共享网络 `requiredPowerSymbols`。`powerLabelCatalog(nets)` 返回本次标签 UUID、网络、坐标和导入模块名，按这些条件定位后生成 placements，不引用上一轮 UUID。`checkPowerSymbols()` 与 render/save 检查声明网络的标准符号和残留标签；未完成时拒绝保存。遮挡提示仍需局部预览确认，详见 [电源符号交付](skills/kicad-schematic-design/references/power-symbols.md)。

`planPowerPlacements({libraryPath, nets})` 在转换前批量规划方向、水平文字与短引出线，返回 placements 和剩余问题诊断；局部预览仍需确认。

含引脚的独立公共单元符号（如 SW-PTB-2_0_1）在项目副本中自动规范为单元 1，保留引脚与图形。符号查询通过 symbol.normalization 报告 common_only_to_unit_1；继承、空单元、异常命名及仅替代图形的符号不做自动规范。不支持的导入错误包含器件、符号、单元名称及源文件 URL。

最终概览卡片：正式预览传入 `delivery: true` 和包含全部本地库的 `projectDir`，显示页面切换、缩放、ZIP 下载。复用已有 PNG，不重新生成电路，无重新生成/详情按钮。需 KiCad Harness 的 webServer 与前端加载支持；不可用时仍返回本地预览路径。持久快照默认保存在当前用户家目录的 `.hq-edge/plugin-data/dsh-tool-kicad-schematic-gen/overview-cache/`，家目录通过 `os.homedir()` 动态获取；可用绝对路径 `HQ_EDGE_HOME` 覆盖 `.hq-edge` 根目录，不随 `DSH_HOME` 或插件版本变化。重启后可读取，手动删除快照后对应历史卡片下载将失效。工程、中间产物和预览保存在当前工作区；插件安装目录仅用于读取代码和模板，不读写概览快照。ZIP 为工程目录内相关设计文件与库的快照，不收集脚本、预览或外部库。
# 生成流程耗时优化

- 使用现有供应商符号缓存对齐逻辑读取模块；封装仅支持当前 `(footprint ...)` 格式，旧式 `(module ...)` 明确拒绝，不自动转换。编号核对不等于尺寸或电气验证。
- builder 新增 `attachPinLabel`，支持显式方向、引线长度与通道错列；不推断引脚方向或自动避障。
- 技能目录 `scripts/run-design.mjs` 使用参数数组启动生成脚本，将退出码、执行时间和完整输出保存为 UTF-8 JSON；终端仅返回摘要，避免 PowerShell 转义、输出截断和 BOM 返工。文档与脚本复用连接计划。


模块下载分析：有随包封装时，下载工具同时输出层次端口摘要，以及器件清单、BOM 和网表连接文件路径。缺封装时跳过分析并提示改选。下载和导出状态分别报告；修复导出问题后，使用相同 moduleId 和 targetDir 加 refreshAnalysis:true，在当前插件进程复用近期下载。详见 [模块分析](skills/kicad-schematic-design/references/module-analysis.md)。

预览与交付：`render_kicad_module_preview` 仅负责普通预览、局部截图和正式快照，不检查封装、格点或电气正确性。省略 `pageNames` 或传 `[]` 时一次生成全部页，传非空列表仅生成指定页，不再受 4 页限制；指定页全部成功不会因未选择其他页返回 partial。`regions` 省略时自动识别根页带标题矩形，`[]` 关闭局部图，显式区域以毫米指定，pageName 缺省为根页。`projectDir` 仅用于 delivery 打包范围，普通预览不使用。公开结果保留 status、renderStatus、deliveryStatus、revision、manifestPath、pageCount 和精简 pages；有根页、局部图、失败、概览或交付错误时才返回对应字段。pageCount 为全部导出页数，pages 为本次成功 PNG。完整路径、缓存状态、页面来源、区域坐标及诊断保存在 manifestPath；不再公开 footprintCheck、cached、outputDir、schematicPath、truncated、omittedPages、regionManifestPath 和固定 readImageInstruction。随包封装匹配在模块生成时完成。正式快照成功须 deliveryStatus:ready 且 overview 有效，不表示工程完整或电气正确；前端概览结构不变。schematic.previewMaxPages 配置已移除。旧调用方应按当前精简结构更新。

技能加载时提供 `pluginDir`、`skillDir`、`runtimePath`、`runnerPath`、`geometryPath` 等只读资源绝对路径，避免混淆插件根目录与技能根目录。资源安装目录不用于保存项目输出。失败恢复、有限重试及候选检查顺序见技能的 `references/troubleshooting.md`。

模块下载返回 moduleId、moduleName、schematicPath、schematicStatus、sourceProject、footprints 和 analysis。无随包封装时 footprints 为 null，analysis.status 为 skipped，同时返回改选提示。下载保留源图旁的封装索引和资源目录。

符号查询 get_kicad_component_models 只下载并解析符号，返回 part 和 symbol；正常摘要为 status、name、units、pins（unit 数字、number、name、type），去掉 footprint、validation、subsymbols、pinCount 和常规 builderCompatibility。缺失/无效保留明确状态，不支持单元返回 symbol.error，特殊公共单元规范化返回 symbol.normalization。成套导入的封装检查及返回结构不变。

器件导入工具 import_kicad_component_symbol_and_footprint 要求符号和封装均可用，并核对引脚与焊盘编号。缺少封装时返回 FOOTPRINT_NOT_AVAILABLE，包含厂家 ID 和型号，供设计 agent 重新搜索合适的替代料。

成套导入的封装命名与云库放置一致：`kicad_api_lib:<精确MPN>`，文件名为 `<MPN>.kicad_mod`。默认保存于 `libraries/footprints/kicad_api_lib.pretty`，已有同名项目本地库注册时复用；符号库默认 Footprint 同步绑定，脚本省略 footprint 也可继承。保留下载封装原文、引脚与属性；同名不同内容拒绝覆盖。已有工程实例不会在插件加载时自动改写。

新导入的项目本地符号采用独立文件：`kicad_lib_<厂商ID>_<处理后型号>_<型号哈希前12位>.kicad_sym`。库昵称、返回的 libId 和项目库表 URI 使用相同前缀。已有 DSH_ 库、注册项及原理图实例保持原样；重新导入相同器件时会创建新前缀的独立库。封装命名保持不变。

模块生成反馈优化：派发前按原生器件几何、框标题/说明与保守字段通道余量筛查空间。固定引脚几何放不下或无内容空间时集中报 MODULE_SPACE_INSUFFICIENT；tight 风险与 suggestedSize 仅供主 agent 结合页面确认，不自动扩框。检查工具返回有界 reviewPlan.issues（最多12项、条目正文6000字符预算）、完整 issueCount/counts、omittedIssues 和 repairPlan 阶段；遗漏内容仍须按 reportPath 定向读取，批量修复。重复诊断明细不再同时放在 report 和 reviewPlan，详细报告/历史仍保留。空间失败先请求统一扩框，近似重叠单独读图判断；最终全框视觉复查和连接检查保持。

新模块派发前检查 module-plan.json 中各模块的 reuse 选择记录：实际搜索工具/检索词、found/no_match/unavailable 结果及 reuse/adapt/new 决定和原因。失败接口不得记录为无候选；选中来源须实际下载到 sources/ 并列入 resources。缺失时集中返回 MODULE_REUSE_REQUIRED，不启动新任务；既有任务状态查询和修复不追补。该检查不自动搜索、判断电气适用或导入来源，并行 draw/region 仍不提供源图导入；实际复用沿用公开 importModule 平铺路线。
