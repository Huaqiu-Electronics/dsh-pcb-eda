---
name: kicad-schematic-design
description: Generate a hardware design document with hardware-design-brief before starting a new schematic. Read the completed plan, inspect HQ EDA modules, adapt suitable circuits and script missing circuits with online component symbols. Default to a flat sheet; use hierarchy when appropriate or requested.
---

# KiCad 统一原理图设计

在当前 KiCad 项目交付可编辑的完整原理图。需要启用 `@huaqiu/dsh-tool-part-search` 和 `@local/dsh-tool-kicad-schematic-gen`；工具关闭时不绕过开关访问同一服务。确认会话工作目录与目标项目一致，处理编辑器中相关文件的未保存改动。

脚本使用本 skill 末尾运行时提供的安装目录设置 `DSH_SCHEMATIC_PLUGIN_DIR`、`KICAD_SYMBOL_DIR`；参考示例统一通过 assets/runtime.mjs 加载库和模板，不写死其他电脑的目录。复制 assets 示例时保留其相对结构。

环境信息按需获取：已有 `get_eda_host_info` 返回值时复用，不因读取另一张预览、重跑脚本或导入另一个器件而重复查询。正常生成、读取和渲染原理图不依赖 PCB IPC，不运行 `kicad_ipc_diagnose`，也不查找 Python。只有开始通过 IPC 操作 PCB 时才执行相应诊断。CLI 使用插件默认配置；已有宿主返回的 `kicad-cli` 绝对路径时，可传给 `render_kicad_module_preview.kicadCliPath`。仅在路径缺失、命令无法启动或宿主环境变更时重新查询；不要另写目录扫描脚本。

自动分析若报 CLI_START_FAILED，复用 get_eda_host_info 的 installation.executables 中名为 kicad-cli 的 path，传入 analyze_kicad_module({schematicPath,view:"summary",kicadCliPath}) 重试；没有已有宿主信息才获取一次。不要重新下载模块、扫描配置目录或把不支持的导出命令当作路径问题。后续查询复用成功路径，省略 kicadCliPath。

## 1. 明确需求与原理图形式

方案阶段的器件、BOM 和电气网络问题优先用 `analyze_kicad_module`，已有结果直接复用。`edit_kicad_flat_schematic` 不作为方案检查的固定步骤：调用前应有一个现有分析无法回答的具体问题；只有缺少必要图纸备注等信息时，定向 `list` 并指定 types/references。不得用 connections 重复核对已有网表网络，也不为将来绘图提前收集全图坐标/UUID。纯方案任务不调用 create；几何查询及生成修改副本留到实际原理图适配阶段。网表提取不能替代数据手册与计算，缺少证据时记录未决条件，不反复调用几何工具补证。

完整新项目先调用 `hardware-design-brief`，按该技能原有规范生成并保存硬件设计方案，之后才进入本技能的原理图模块检索、适配和绘制。方案阶段可按原技能需要核实资料、选型和计算，不限制为简短初稿，不降低其电路、接口、预算和交付深度，也不另行改写其章节结构或工作方式。用户已有合格方案时直接读取；仅讨论、单模块诊断或已有设计的局部修改不重做全套方案。技能不可用时说明条件，依据用户已有方案继续；确无方案且需生成时，在授权范围按同等设计深度形成方案，不伪称已调用该技能。

主流程在进入原理图设计前读取实际保存的方案相关章节，确认器件、电源、接口、关键外围、预算依据及未决范围足以指导将要实现的部分。目录、todo、口头说明或后台文档任务不等于方案完成。允许委派时仍须等待所依赖的方案完成并读回，不能在后台写文档的同时先画依赖它的电路。未闭合部分按原方案限制处理，不用虚构结论填满文档，也不增加用户审批节点。方案目录与文件名沿用 hardware-design-brief 或用户现有约定。

明确功能、芯片型号、供电、接口电平、负载和器件约束。用户指定平铺或层次时遵循用户要求；否则默认平铺，多功能模块可用规则外框组织在同一页。只有电路非常复杂、跨区连接密集或单页难以阅读维护时采用层次结构，并说明选择依据。不能只因使用多个下载模块就改成层次工程。

创建唯一 ASCII 名称的 `designs/<name>/`，保留 `sources/` 下载来源、`work/` 修改副本、`scripts/` 模型编写程序、`project/` 正式工程、`previews/` 预览和 `.candidate/<run-id>/` 本轮候选。按需要创建目录。只交付一个固定正式工程路径，不创建可打开的 revN 历史工程或在不同版本间改变会话工作目录。

## 2. 优先搜索、下载和检查已有模块

按需求拆分功能，先通过原理图插件的模块工具 搜索现有电路：准确型号用 `eda_module_precise_search`，功能用 `eda_module_rag_search`，已有分类用 `eda_module_category_search`。首次搜索不合适时换型号别名、功能或分类搜索；避免原样重复查询。保留少量候选并记录选择依据。对供电、主控、通信、驱动等各个实际需要设计的功能分别搜索，不只搜索主控就将其他功能直接转入器件级设计。独立功能的查询可并行；已有结果不重复获取。确认模块不能直接使用或修改满足需求后，再设计该功能。

用 `download_eda_module_schematic` 下载到预先创建的 sources/，以返回的实际路径为准。下载原文件和源工程保持不变。下载后先使用返回的 analysis 摘要，不重复查 summary；按 [模块网表与器件清单](references/module-analysis.md) 用 analyze_kicad_module 显式选择 components/bom/nets，仅查询所需器件、装配状态和关键网络并复用已有结果。修复失败分析后才用 summary 重试。再按需读取端口及布局预览。结合真实元件、引脚、导线、标签、注释和必要的数据手册判断功能、接口与适用条件。搜索命中、模块描述或端口名本身不算检查通过。端口工具只列层次标签；空列表不代表没有外部接口。连接不以 input/output/bidirectional 类型为阻断条件。详细操作见 [模块选择](references/module-selection.md)。

每个功能分别决定直接复用、修改复用或从零设计；一个完整工程可混合这三种来源。满足需求时直接复用，基本匹配时优先修改副本；明确无法满足或搜索无合适候选时再从零设计缺少的模块或完整电路，不重新绘制适用的已有电路。

检查后将模块来源、实际器件/装配状态、供电接口、已有外围、限制、适配修改及跨模块接点写回同一方案文档，按 [模块选择](references/module-selection.md) 的记录结构整理。原理图电路模块的内部器件属于本项目 PCB；外购成品模块按实际商品及接口处理，不能混淆或重复计价。以这些结果更新电源树、连接计划与新增电路，形成实施方案后生成对应电路；无依据的部分注明限制，不为套用模块修改用户硬约束。已有上拉/保护/复位等先核对 DNP 和实际接法，再决定是否新增。模块判断和器件信息复用于后续脚本及文档，不重新设计已确认内容。

## 3. 修改与器件获取

对选定的复用模块完成[模块封装本地化](references/module-footprints.md)：先 list 原实例，优先利用模块下载返回的 footprints，缺失时搜索精确器件并只下载对应封装；保存 mappingPath，并在设计脚本的 importModule 中传 footprintMappingPath。已有符号和电路保持不变。最终 project 中每个需要上板的实例都必须指向实际存在的本地封装，不能保留未注册的 kicad_api_lib 引用；电源符号不要求封装。来源内容变化时重新生成映射，布局重跑时复用记录。

封装准备从模块确定后开始，与布局工作交错推进，不留到交付前集中补齐。`import.stage=prepared` 只表示库与映射就绪，来源未改写时用 `check_mapping` 检查准备状态；`check` 留给已应用映射的实际候选/最终原理图，避免把源文件 resolved:0 当成下载失败。先利用 list 的 dnp、端口工具和器件引脚信息明确真实接法，再共用连接计划生成脚本与文档引脚表。

项目本地器件库统一归类：符号写入 `project/libraries/symbols/*.kicad_sym`，封装写入 `project/libraries/footprints/*.pretty/`；`sym-lib-table` 和 `fp-lib-table` 保留在 project 根目录，通过 `${KIPRJMOD}/libraries/...` 注册。复用导入工具返回的 libraryPath、libId、footprintId，不另在根目录创建副本。设计脚本使用相对于自身文件位置的路径定位 project，并保留整个 libraries 目录用于打包和后续 PCB。旧项目已有根目录库时，工具仍可复用；整理旧项目须同步库表和脚本路径，不改变库昵称或实例关联。

专门的器件搜索由 KiCad 内置插件 `@huaqiu/dsh-tool-part-search` 提供。用 `search_hqsch_parts({query, page, page_size, require_eda_model: true, requirements: {symbol: true, footprint: true}})` 搜索型号或功能规格，结果在 `items` 中，支持分页。需要完整参数、分类、文档或标签时，用选定器件的 `manufacturer.id` 和精确型号调用 `get_hqsch_part({manufacturer_id, mpn})`。`get_hqsch_part_models({manufacturer_id, mpn})` 只返回符号、封装、3D 等模型链接，不下载或解析；检查实际引脚和焊盘仍用原理图插件的 `get_kicad_component_models({manufacturer_id, mpn})`。仅在需要采购信息时调用 `get_hqsch_supply_chain({parts: [{manufacturer_id, mpn}]})`，空报价不代表市场无库存。搜索中的模型标记可能由筛选条件推导，不能据此认定模型一定存在或不存在；以详情、模型链接及实际解析结果核对。搜索插件关闭或不可用时说明条件，不绕过开关；可继续检查已有模块，缺少在线符号的部分按本节回退规则处理。

进入实际原理图适配后，结构化局部编辑用 `edit_kicad_flat_schematic` 的 list/create，读取 UUID、引用和引脚信息，明确指定删除、数值、标签、导线和说明改动。先读 [编辑参考](references/editing.md)。首次 list 集中获取本次编辑实际需要的对象，复用返回对象与 UUID；只有具体缺少信息或分页被截断时再查询，不按每种对象类型反复读同一模块。该工具不新增或移动符号；需要新增器件时使用构建库的 importModule 保留修改后的电路，再用 addSymbol 添加实际符号并明确布线。禁止固定行号删改、全局字符串替换或重写符号解析器。

修改缺少器件或 symbol、以及从零设计时，均优先 `@huaqiu/dsh-tool-part-search` 和 `@local/dsh-tool-kicad-schematic-gen`：`search_hqsch_parts` → 选定候选的 `get_kicad_component_models` → `import_kicad_component`。符号和封装成套导入最终 project/，便于两个库表与正式工程一致；导入本身不会放置器件。搜索 items 中的 manufacturer.id 映射为后续工具的 manufacturer_id（公开工具统一使用 manufacturer_id，不传旧别名），mpn 保持精确型号不变。搜索 hasSymbol/hasFootprint/has3dModel 是筛选推导标记，必须以实际模型解析结果为准。按需用同一 manufacturer_id/mpn 调用 `get_kicad_datasheet`。复用已有查询和导入结果。模型检查与导入按依赖执行，先确认各候选摘要再导入；同一失败 sourceUrl/符号结构不因换 MPN 而重复尝试，改选不同模型。先查看模型摘要/导入结果的 builderCompatibility：ready 表示支持列出的 availableUnits；normalization=common_only_to_unit_1 表示独立公共单元符号可自动规范为单元 1，直接导入并放置 unit 1，无需换器件或手改库。unsupported_units 时按照 nextAction 换候选，不先编写放置脚本再反复试 unit 1。正常生成按编程接口和范例调用，不读取 builder 实现或另写解析器来发现引脚；只有明确的库内部错误且调用参考不足时才查对应实现。使用 list 返回的 pins 或 sch.pinCatalog 一次读取实际引脚坐标，布线用 sch.pin；不要另写正则提取程序。模型摘要中 symbol/footprint 分别为 parsed、missing 或 invalid；invalid 按 code/sourceUrl/nextAction 更换该模型，不原样重试，也不丢弃另一个正常模型。格式兼容不代表器件型号、封装或物理引脚一致，不能仅改 Value 就把替代符号当作目标器件。

用于后续 PCB 的实际器件默认执行成套导入 `import_kicad_component({manufacturer_id, mpn, projectDir})`，具体用法见 [器件与封装交付](references/component-pcb.md)。只有成功返回的 `hasSymbol: true`、`hasFootprint: true` 和 `validation.pinPadMatch: number_sets_match` 才表示实际双模型已下载并通过编号集合核对；搜索标记不是这个保证。缺模型、模型无效或编号不匹配时换候选，不能退回只导入符号并声称 PCB 已就绪。用户明确只做原理图或使用经过核实的本地封装时才用旧 `import_kicad_symbol`，并说明封装来源或未完成部分。电源标记、GND 等绘图符号不要求实体封装。生成 `addSymbol` 时必须显式传 `footprint: imported.footprintId`，保留 `.pretty/`、`fp-lib-table`、`.kicad_sym`、`sym-lib-table` 一起交付。编号集合相同不等于尺寸、引脚功能和电气兼容，仍按精确型号与手册确认；已有复用模块也检查实体器件的 Footprint 属性与项目可用封装，不自动把模块都标为已验证。

首次线上搜索无合适结果时，至少再进行一次有实质差异的查询，例如型号别名、替代型号或功能规格；确认仍无合适器件或 symbol 才采用本地 KiCad 符号，并说明查询与回退原因。通用阻容器件同样线上优先；GND、电源标记等绘图符号可直接用本地库。线上服务失败或插件关闭时说明条件，不能宣称已确认库中无结果，也不原样重复失败调用。

## 4. 生成与整合

开始编写生成脚本前，主流程读取本项目方案中最新的模块适配、供电及连接计划，确认检查结果已写入；子代理的完成消息不能代替此回读。若仍只有初步建议，先补齐将要实现的部分；其他未闭合范围保持草案，不影响独立部分。新发现的脚号、网络接法、器件与 DNP 修正，须在同一轮修复中同步更新对应文档，下一轮构建前核对，不把旧结论留到最后统一补写。只读相关章节，不为每次构建重复读取整份方案。

生成脚本采用方案及模块适配后已核实的连接计划；具体来源和参考位号以实际文件为准，不按未经核实的假设强行替换来源实现。模块与原方案有差异时核对硬约束，记录必要修改或换选，保留原有技术深度与有效依据，不为适配模块随意降低要求。交付前回填来源到最终位号映射、实际器件/封装及 DNP，文档器件清单不能继续使用被弃用的候选。沿用原方案的章节与证据状态，不强制套用“初步方案→实施方案”的新模板或另建文档。

平铺路线读取 [平铺复用与整合](references/flat-reuse.md)：单个符合需求的模块直接创建工程副本；多个模块用构建库 importModule 整体平移、隔离内部网络、统一编号/UUID/缓存，显式映射跨模块网络，再补充所需电路。最终所有实际器件在同一页，每个功能区域保留无填充外框、短标题和简短说明。清理来源中的冗余说明时保留必要接法、额定限制和警告；不删除器件属性、电气标签或引脚文字。

从零编写或补充电路时读取 [编程接口](references/programming.md) 与 [模块脚本组织](references/modular-scripts.md)。模型决定器件、连接和布局，现有 builder.js 处理文件格式与真实引脚坐标。多功能电路采用 design.mjs 主入口和 modules/ 下每框独立脚本，共享器件数据与引用编号；先放置全部器件，再布线，最后统一保存。下载复用模块和新编写模块可同时进入同一个 Schematic；此组合优先按 [混合整合范例](references/mixed-design.md) 编写主入口，导入模块后将返回的目标引用编号登记到共享分配器，再放置新增器件。只修受影响模块和连接，避免重新读取全部代码。默认不创建 smoke.mjs 或单电阻测试工程；直接生成实际候选并调用预览。只有库接口发生变化或明确的内部错误才做最小复现。先用生成器返回的全部外框坐标检查页面范围与框间重叠，集中调整一次后再预览，不为打印坐标重复生成候选。

新增 LED、上拉按键、去耦电容或 LDO 外围等局部电路，或排列芯片/连接器的信号标签时，先按需读取 [局部电路画法索引](references/drawing-patterns.md)，选择已确认拓扑匹配的简短代码；不熟悉画法才读取对应参考图。局部单元放在现有功能框内，共用编号和两阶段 place/connect，不各自建框或保存工程。代码依照实际导入符号的引脚、方向和属性调整，不能照抄范例取值或用画法替代电气设计。复用模块布局已经清楚时保留，不为套范例重画。绘制复位/使能 RC 或并列启动按键时，读取 [复位与启动画法](references/drawing-patterns/reset-enable.md)：上拉与按键竖向对齐，对地电容放节点右下方、地向下，避免横放按键的回绕线；BOOT 不自动复制复位电容。LDO 输入电容放在 VIN 一侧、输出电容放在 VOUT 一侧，优先短导线直接连接，不把所属外围集中到框下方；芯片去耦同样归属到供电脚附近。先组织框内主信号流向、对齐器件和属性，再调整外框与整页位置；同一画法与图片在本轮已经读过就复用结论。

同侧多个信号优先用编程接口中的 attachPinLabels 批量短直引出：左右水平、上下竖排，导线外端同列/同行，名称默认排在引线上方或沿竖线排列；不随名称长度逐根改变线长，也不默认把上下引脚扇出成阶梯。电源、地、NC 和已有连接单独处理；普通单点或确需折线时才用 attachPinLabel。执行用 scripts/run-design.mjs 保存 UTF-8 构建报告，正常项目不读取编译库源码猜接口。同一问题连续两轮仍未改善时，改用更宽外框或不同引线通道，集中处理明确遮挡；不跳过电气问题或无法辨认的内容。

平铺整合或从零设计时，明确共享的 GND 和电源网络使用标准 KiCad 电源符号，普通信号保留标签。在创建 Schematic 时把本设计实际使用的共享电源声明为 requiredPowerSymbols；先调用 sch.planPowerPlacements({libraryPath: POWER_LIB, nets: powerNets}) 批量规划方向、水平文字位置和有限短引出线，再在同一次构建中用 plan.placements 调用 sch.replacePowerLabels。不统一覆写所有 angle=0 或固定上下文字偏移。集中处理 diagnostics.unresolved 和未测量对象，结合局部预览只修实际剩余遮挡；需要手动覆盖时用 sch.powerLabelCatalog(Object.keys(powerNets)) 获取本次 UUID、网络、整页坐标和导入模块名，按模块/网络/坐标选取目标后覆盖对应 plan.placements。完整接口与例子见 [电源符号交付](references/power-symbols.md)。不得复制上一轮 UUID；UUID 变化不构成取消电源符号的理由。出现遮挡时优先修改 valueAt，再按需调整符号位置、angle 和正交 via，保持原接点连接；GND 优先向下。不得为消除重叠删除转换调用、撤掉 requiredPowerSymbols 或改回纯电源标签。保存前 checkPowerSymbols 核对声明的网络；render/save 自动执行同一检查，POWER_SYMBOLS_REQUIRED 按缺失符号/残留标签修复。确实无法完成时报告具体未解决位置，不宣称完成交付。layoutWarnings 是保守提示，集中处理后查看局部预览；编号与结构检查不代替电气验证。不自动合并 AGND/DGND、隔离电源或未确认的 VBAT，也不自动添加 PWR_FLAG。

层次路线读取 [层次组织](references/hierarchy.md)：每个功能子页可复用、修改或从零设计。子页必须有实际接入电路的明确层次标签。规划所有端口的 connections/unconnectedPorts，使用 create_kicad_hierarchy 生成根图与子页。端口方向统一 passive，方向冲突作为来源提示，不阻断连接。层次文件格式仅在手工处理或诊断失败时读取 [KiCad 10 参考](references/kicad10-hierarchy.md)。

## 5. 检查、预览与交付

依据模块真实接口和连接计划检查供电、共地、电压域、极性、使能、复位、必要上拉与负载条件；层次路线检查每个端口映射或明确未连接，平铺路线检查共享网络映射与实际接入引脚。缺少依据时标记待确认。设计过程的接口检查不扩展成额外端点核对脚本、几何审计或 XML 网表比对。

在唯一候选目录生成工程，渲染并读取工具返回的真实图片路径；局部改动优先查看相关区域，交付前看完整平铺图或根图及必要子页。检查外框、标题、属性、引脚、导线和可读性。工具默认从带标题的矩形外框生成 regionImages；局部检查直接读取对应 pngPath，必要时用 regions 指定已规划的毫米范围，不编写 crop.mjs/zoom.mjs。先汇总各区域的可读性问题，再集中修改一轮；只有明确的遮挡、错连或无法辨认仍存在时继续修正，不为了字号或装饰偏好反复重建。同一版本不重复渲染或读取同一张图片。先使用结构化接口读取器件、引脚与网络信息，图片用于检查实际布局和可读性。已有 regionImages 时按问题区域读取，不一次性读取所有模块整图；区域不足或交付前确需整体检查时再读取整图。模型请求可能缩小图像，细字看不清时读取已有局部区域图，不猜测连接。已检查图片会从后续模型请求中移出，沿用检查结论；确需重新核对才重新 read_image。概览卡片供用户观看，不因显示卡片额外 read_image。错误按 code/stage/diagnostics/nextAction 修复，不原样重试、不猜图片路径、不因预览失败重建已生成工程；见 [错误处理](references/troubleshooting.md)。

候选通过后发布到固定 project/，只替换本设计生成的工程文件和已列明子页，保留符号库、来源和其他工程文件。正式工程使用相对子页路径，再生成正式预览；安全清理本轮候选。交付正式原理图、工程配置、所需符号库、脚本、来源与预览，说明复用/修改/新设计的模块及未核实条件。允许为模块理解只读提取并缓存网表/BOM；默认不运行 ERC、不额外进行网表接线比对、不编写端点审计、不生成 PCB；用户明确要求时再执行。预览和连接计划不能称为电气验证通过。

先在候选上完成最后一次读图、修复、封装检查和发布，再生成正式概览；不要先 delivery 再读取图片继续布局修改。若发现新问题，使用普通预览修复完成后再正式交付。同一工程重复正式交付时界面只保留最新卡片，旧 ZIP 快照仍保留。最终正式工程的预览调用 `render_kicad_module_preview({schematicPath: 正式原理图路径, projectDir: 正式project目录, delivery: true})`，可复用同版本渲染缓存，在对话中显示原理图概览、页面切换、缩放和工程 ZIP 下载卡片。中间布局检查不传 delivery。projectDir 必须同时包含根图、子页和工程所需本地库；ZIP 收集该目录内原理图、工程配置、符号、封装、库表及3D模型，不包含脚本、来源、预览或工作区外的库。返回 overviewError 时说明卡片或打包不可用，保留已生成工程和现有本地预览，不因此重建电路。卡片不提供重新生成、详情或自动放置按钮。概览不代表电气验证通过。
